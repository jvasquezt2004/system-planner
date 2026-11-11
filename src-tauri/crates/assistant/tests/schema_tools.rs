//! `apply_schema`: a harness edits a Design's schema.sql and the Design follows it.

use std::path::PathBuf;
use std::sync::Arc;

use schema_assistant::read_tools::ToolContext;
use schema_assistant::runtime::ProjectFolderSync;
use schema_assistant::schema_tools::ApplySchema;
use schema_assistant::store::AssistantStore;
use schema_assistant::tools::ProjectTool;
use schema_domain::sql::render_schema_file;
use schema_sandbox::{ApplyResult, PgliteSandbox, Sandbox};
use schema_workspace::{Options, Workspace};
use serde_json::{json, Value};

struct Pglite;

impl Sandbox for Pglite {
    fn apply(&mut self, sql: &str) -> ApplyResult {
        PgliteSandbox.apply(sql)
    }
}

struct Folder {
    file: PathBuf,
    syncs: std::sync::Mutex<u32>,
}

impl ProjectFolderSync for Folder {
    fn sync(&self, _force: bool) -> Option<PathBuf> {
        *self.syncs.lock().unwrap() += 1;
        None
    }

    fn schema_file(&self, _design_id: &str) -> Option<PathBuf> {
        Some(self.file.clone())
    }
}

struct Fixture {
    workspace: Workspace,
    tool: ApplySchema,
    folder: Arc<Folder>,
    _directory: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite");
    let workspace = Workspace::open(Options::new(&path, Arc::new(|| Box::new(Pglite)))).unwrap();
    let created = workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let project_id = created["project"]["id"].as_str().unwrap().to_owned();
    let design_id = created["activeDesignId"].as_str().unwrap().to_owned();
    let store = Arc::new(AssistantStore::open(&path, || 1).unwrap());
    let conversation = store.create_conversation(&project_id, &json!({ "role": "system", "payload": {} }), &json!({ "id": "c1" })).unwrap()["id"].as_str().unwrap().to_owned();
    let folder = Arc::new(Folder { file: directory.path().join("schema.sql"), syncs: Default::default() });
    let context = Arc::new(ToolContext {
        reads: Default::default(),
        turn_id: Box::new(|| Some("turn-1".to_owned())),
        workspace: workspace.clone(),
        store,
        files: None,
        folder: Some(folder.clone()),
        scenario_runner: None,
        abort: Default::default(),
        conversation_id: conversation,
        target: (project_id, design_id),
    });
    Fixture { workspace, tool: ApplySchema(context), folder, _directory: directory }
}

fn write_current(fixture: &Fixture) {
    let design = fixture.workspace.state().design.unwrap();
    std::fs::write(&fixture.folder.file, render_schema_file(&design).unwrap()).unwrap();
}

fn call(fixture: &Fixture) -> Result<Value, String> {
    fixture.tool.execute("c", &json!({})).map(|result| serde_json::from_str(&result.content[0]).unwrap())
}

const SHOP: &str = "create table customers (id uuid primary key default gen_random_uuid(), name text not null);\n\
create table orders (id bigint generated always as identity primary key, customer_id uuid not null references customers(id), total numeric(10,2) default 0.0);\n\
create index orders_customer_idx on orders (customer_id);\n\
create view open_orders as select * from orders;";

#[test]
fn a_file_that_matches_the_design_changes_nothing() {
    let fixture = fixture();
    write_current(&fixture);
    let result = call(&fixture).unwrap();
    assert_eq!(result["status"], "unchanged");
}

#[test]
fn an_edited_file_becomes_the_design_and_keeps_identity() {
    let fixture = fixture();
    std::fs::write(&fixture.folder.file, SHOP).unwrap();
    let applied = call(&fixture).unwrap();
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["tablesAdded"], json!(["customers", "orders"]));
    assert_eq!(applied["keptAsRawSql"], json!(["create view open_orders as select * from orders"]));
    assert_eq!(applied["sql"], "current");
    let design = fixture.workspace.state().design.unwrap();
    assert_eq!(design.tables.len(), 2);
    assert_eq!(design.relationships.len(), 1);
    assert!(*fixture.folder.syncs.lock().unwrap() >= 1);

    // The designer moves a table and writes a note; the Assistant then edits the file again.
    let customers = design.tables.iter().find(|table| table.name == "customers").unwrap().clone();
    fixture.workspace.request("moveTable", json!({ "designId": fixture.workspace.state().active_design_id, "tableId": customers.id, "position": { "x": 500, "y": 70 } })).unwrap();
    write_current(&fixture);
    let edited = std::fs::read_to_string(&fixture.folder.file).unwrap().replace("\"name\" text NOT NULL", "\"name\" text NOT NULL,\n  \"email\" text");
    std::fs::write(&fixture.folder.file, edited).unwrap();
    let second = call(&fixture).unwrap();
    assert_eq!(second["tablesAdded"], json!([]));
    assert_eq!(second["tablesChanged"], json!(["customers"]));
    let after = fixture.workspace.state().design.unwrap();
    let kept = after.tables.iter().find(|table| table.name == "customers").unwrap();
    assert_eq!(kept.id, customers.id);
    assert_eq!((kept.position.x, kept.position.y), (500.0, 70.0));
    assert_eq!(kept.columns.len(), 3);

    // Both file edits are the one Assistant turn: a single Undo takes back all of it.
    assert_eq!(fixture.workspace.state().undo_action_name.as_deref(), Some("Assistant turn"));
}

#[test]
fn a_file_with_no_statements_cannot_delete_the_schema() {
    let fixture = fixture();
    std::fs::write(&fixture.folder.file, SHOP).unwrap();
    call(&fixture).unwrap();
    std::fs::write(&fixture.folder.file, "-- everything is gone\n").unwrap();
    let error = call(&fixture).unwrap_err();
    assert!(error.starts_with("schema.sql has no SQL statements (only comments or nothing), which would delete the whole schema. Nothing was applied."), "{error}");
    assert_eq!(fixture.workspace.state().design.unwrap().tables.len(), 2);
}

#[test]
fn postgresql_rejecting_the_file_changes_nothing() {
    let fixture = fixture();
    std::fs::write(&fixture.folder.file, "create table a (id int primary key, b int references nowhere(id));").unwrap();
    let error = call(&fixture).unwrap_err();
    assert!(error.starts_with("PostgreSQL rejected schema.sql, so nothing was applied: "), "{error}");
    assert!(fixture.workspace.state().design.unwrap().tables.is_empty());
}

#[test]
fn unreadable_sql_and_a_missing_file_are_reported() {
    let fixture = fixture();
    assert_eq!(call(&fixture).unwrap_err(), "schema.sql could not be read. Do not delete or move it.");
    std::fs::write(&fixture.folder.file, "create tabel a (id int);").unwrap();
    assert_eq!(call(&fixture).unwrap_err(), "schema.sql could not be read: syntax error at or near \"tabel\"");
    // Data statements are not part of a Design.
    std::fs::write(&fixture.folder.file, "insert into a values (1);").unwrap();
    assert!(call(&fixture).unwrap_err().starts_with("schema.sql could not be read: INSERT statements change data"));
}
