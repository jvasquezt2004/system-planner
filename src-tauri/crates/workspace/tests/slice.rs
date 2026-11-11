use std::sync::{Arc, Mutex};
use std::time::Duration;

use schema_domain::geometry::CanvasPoint;
use schema_domain::system_design::SystemViewName;
use schema_sandbox::{ApplyResult, PgliteSandbox, Sandbox};
use schema_workspace::{Options, SandboxFactory, Workspace, WorkspaceState};
use serde_json::{json, Value};

/// A sandbox that accepts everything instantly, for tests of the workspace's own behaviour.
struct Accepting;
impl Sandbox for Accepting {
    fn apply(&mut self, _sql: &str) -> ApplyResult {
        ApplyResult::Applied { tables: vec![], relationships: vec![] }
    }
}

fn accepting() -> SandboxFactory {
    Arc::new(|| Box::new(Accepting))
}

fn options(directory: &tempfile::TempDir, sandbox: SandboxFactory) -> Options {
    let mut options = Options::new(directory.path().join("workspace.sqlite"), sandbox);
    options.preview_delay = Duration::from_millis(20);
    options
}

/// Every state the workspace pushes, in order.
fn record(workspace: &Workspace) -> Arc<Mutex<Vec<Value>>> {
    let states = Arc::new(Mutex::new(Vec::new()));
    let sink = states.clone();
    workspace.subscribe(Arc::new(move |state: &WorkspaceState| sink.lock().unwrap().push(serde_json::to_value(state).unwrap())));
    states
}

fn status<'a>(state: &'a Value, field: &str) -> &'a str {
    state[field]["status"].as_str().unwrap_or("?")
}

#[test]
fn a_new_project_opens_on_the_system_overview_and_survives_a_restart() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    assert!(workspace.state().project.is_none());

    let state = workspace.create_project("  Shop  ").unwrap();
    assert_eq!(state.project.as_ref().unwrap().name, "Shop", "the name is trimmed");
    assert_eq!(state.revision, 1);
    assert_eq!(state.active_view, SystemViewName::System);
    assert_eq!(state.save["status"], "saved");
    assert!(workspace.create_project("   ").is_err());

    // A fresh workspace on the same database reopens the most recent Project, as the original does.
    let reopened = Workspace::open(options(&directory, accepting())).unwrap();
    assert_eq!(reopened.state().project.unwrap().name, "Shop");
    assert_eq!(reopened.state().projects.len(), 1);
}

#[test]
fn an_edit_pushes_saving_then_saved_then_the_preview_in_order() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    let states = record(&workspace);

    let result = workspace.add_table(&design_id, "orders", None).unwrap();

    // The response is the settled state, so a late response can never overwrite a newer push.
    assert_eq!(result.revision, 2);
    assert_eq!(result.sql["status"], "current");
    assert_eq!(result.sandbox["status"], "applied");
    assert_eq!(result.save["status"], "saved");
    let table = &result.design.as_ref().unwrap().tables[0];
    assert_eq!((table.name.as_str(), table.position), ("orders", CanvasPoint { x: 40.0, y: 40.0 }));
    assert_eq!(table.columns[0].name, "id");

    let pushed = states.lock().unwrap().clone();
    let trail: Vec<String> = pushed.iter().map(|s| format!("{}/{}/{}", status(s, "save"), status(s, "sql"), status(s, "sandbox"))).collect();
    assert_eq!(trail.first().unwrap(), "saving/checking/idle", "the draft shows at once: {trail:?}");
    assert!(trail.contains(&"saved/checking/idle".to_string()), "then it is saved: {trail:?}");
    assert!(trail.contains(&"saved/current/applying".to_string()), "then the SQL is ready: {trail:?}");
    assert_eq!(trail.last().unwrap(), "saved/current/applied", "and the sandbox confirms it: {trail:?}");
    assert!(pushed.iter().all(|s| s["revision"].as_i64().unwrap() >= 1));
}

#[test]
fn the_database_is_authoritative_so_edits_survive_a_restart() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    let table_id = workspace.add_table(&design_id, "orders", None).unwrap().design.unwrap().tables[0].id.clone();
    workspace.add_column(&design_id, &table_id, Some("total"), Some("numeric")).unwrap();
    workspace.move_table(&design_id, &table_id, CanvasPoint { x: 12.345, y: -0.005 }).unwrap();

    let reopened = Workspace::open(options(&directory, accepting())).unwrap();
    let design = reopened.state().design.unwrap();
    let table = &design.tables[0];
    assert_eq!(table.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "total"]);
    assert_eq!(table.columns[1].column_type, "numeric");
    assert_eq!(table.position, CanvasPoint { x: 12.35, y: 0.0 }, "positions round like Math.round(x * 100) / 100, ties toward +infinity");
}

#[test]
fn layout_and_notes_do_not_touch_the_schema_revision_or_the_sql() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    let table_id = workspace.add_table(&design_id, "orders", None).unwrap().design.unwrap().tables[0].id.clone();
    let settled = workspace.state();
    let column_id = settled.design.as_ref().unwrap().tables[0].columns[0].id.clone();

    let moved = workspace.move_table(&design_id, &table_id, CanvasPoint { x: 300.0, y: 200.0 }).unwrap();
    assert_eq!(moved.revision, settled.revision);
    assert_eq!(moved.sql, settled.sql, "the generated SQL is untouched");
    assert_eq!(moved.sandbox, settled.sandbox, "and so is the applied sandbox");

    let noted = workspace.update_column(&design_id, &table_id, &column_id, &json!({ "notes": "  surrogate key  " })).unwrap();
    assert_eq!(noted.revision, settled.revision);
    assert_eq!(noted.design.unwrap().tables[0].columns[0].notes, "surrogate key");

    let viewport = workspace.set_viewport(&design_id, 10.0, 20.0, 99.0).unwrap();
    assert_eq!(viewport.design.unwrap().viewport.zoom, 2.5, "zoom is clamped");
    assert_eq!(viewport.revision, settled.revision);

    let schema = workspace.update_column(&design_id, &table_id, &column_id, &json!({ "name": "order_id" })).unwrap();
    assert_eq!(schema.revision, settled.revision + 1, "a schema edit moves the revision");
}

#[test]
fn an_invalid_draft_stays_saved_and_keeps_the_last_good_sql() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    let table_id = workspace.add_table(&design_id, "orders", None).unwrap().design.unwrap().tables[0].id.clone();
    let good_sql = workspace.state().sql["sql"].as_str().unwrap().to_owned();

    // A column named like another is an error PostgreSQL would refuse; the draft is kept regardless.
    let state = workspace.add_column(&design_id, &table_id, Some("id"), None).unwrap();
    assert_eq!(state.save["status"], "saved", "the work is saved even though it cannot be built");
    assert_eq!(state.sql["status"], "stale");
    assert_eq!(state.sql["sql"], good_sql, "the last SQL that could be generated stays visible");
    assert!(state.sql["errors"][0].as_str().unwrap().contains("used more than once"));
}

#[test]
fn bad_requests_are_refused_with_the_original_messages() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    assert_eq!(workspace.add_table("x", "t", None).unwrap_err(), "Open a project before editing its design.");
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    assert_eq!(workspace.add_table("other", "t", None).unwrap_err(), "Target database design 'other' is not the active design.");
    assert_eq!(workspace.add_table(&design_id, "   ", None).unwrap_err(), "Table name is required.");
    assert_eq!(workspace.rename_table(&design_id, "missing", "x").unwrap_err(), "That table could not be found.");
    let table_id = workspace.add_table(&design_id, "t", None).unwrap().design.unwrap().tables[0].id.clone();
    assert_eq!(workspace.add_column(&design_id, &table_id, Some("c"), Some("nonsense")).unwrap_err(), "That column type is not supported.");
    let column_id = workspace.state().design.unwrap().tables[0].columns[0].id.clone();
    assert_eq!(workspace.update_column(&design_id, &table_id, &column_id, &json!({ "nullable": "yes" })).unwrap_err(), "Column nullable must be true or false.");
    assert_eq!(workspace.update_column(&design_id, &table_id, &column_id, &json!({ "default": { "kind": "expression" } })).unwrap_err(), "That column default is not supported.");
    assert_eq!(workspace.open_project("nope").unwrap_err(), "That project could not be found.");
}

#[test]
fn choosing_a_new_primary_key_demotes_the_previous_one() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = Workspace::open(options(&directory, accepting())).unwrap();
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    let table_id = workspace.add_table(&design_id, "t", None).unwrap().design.unwrap().tables[0].id.clone();
    let second = workspace.add_column(&design_id, &table_id, Some("code"), Some("text")).unwrap().design.unwrap().tables[0].columns[1].id.clone();
    let state = workspace.update_column(&design_id, &table_id, &second, &json!({ "primaryKey": true })).unwrap();
    let columns = &state.design.unwrap().tables[0].columns;
    assert_eq!((columns[0].primary_key, columns[1].primary_key), (false, true));
}

#[test]
fn the_real_sandbox_reports_what_postgresql_built() {
    let directory = tempfile::tempdir().unwrap();
    let real: SandboxFactory = Arc::new(|| Box::new(PgliteSandbox));
    let mut options = options(&directory, real);
    options.preview_delay = Duration::from_millis(20);
    let workspace = Workspace::open(options).unwrap();
    let design_id = workspace.create_project("Shop").unwrap().active_design_id.unwrap();
    let table_id = workspace.add_table(&design_id, "orders", None).unwrap().design.unwrap().tables[0].id.clone();
    let state = workspace.add_column(&design_id, &table_id, Some("total"), Some("numeric")).unwrap();

    assert_eq!(state.sandbox["status"], "applied", "{}", state.sandbox);
    let columns = state.sandbox["tables"][0]["columns"].as_array().unwrap();
    assert_eq!(columns.iter().map(|c| c["name"].as_str().unwrap()).collect::<Vec<_>>(), ["id", "total"]);
    assert_eq!(columns[0]["isIdentity"], true);
    assert_eq!(columns[1]["dataType"], "numeric");
    assert!(state.sql["sql"].as_str().unwrap().contains("CREATE TABLE \"orders\""));
}
