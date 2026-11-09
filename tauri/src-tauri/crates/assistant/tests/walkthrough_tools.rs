use std::sync::Arc;

use schema_assistant::read_tools::ToolContext;
use schema_assistant::store::AssistantStore;
use schema_assistant::tools::ProjectTool;
use schema_assistant::walkthrough_tools::{EditWalkthroughs, ReadWalkthroughs};
use schema_sandbox::{ApplyResult, Sandbox};
use schema_workspace::{Options, Workspace};
use serde_json::{json, Value};

struct Empty;

impl Sandbox for Empty {
    fn apply(&mut self, _sql: &str) -> ApplyResult {
        ApplyResult::Applied { tables: vec![], relationships: vec![] }
    }
}

struct Fixture {
    workspace: Workspace,
    read: ReadWalkthroughs,
    edit: EditWalkthroughs,
    connection: String,
    design_id: String,
    _directory: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite");
    let workspace = Workspace::open(Options::new(&path, Arc::new(|| Box::new(Empty)))).unwrap();
    let created = workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let project_id = created["project"]["id"].as_str().unwrap().to_owned();
    let design_id = created["activeDesignId"].as_str().unwrap().to_owned();
    workspace.request("addSystemComponent", json!({ "x": 0, "y": 0, "kind": "api", "name": "API", "id": "api" })).unwrap();
    workspace.request("addSystemComponent", json!({ "x": 300, "y": 0, "kind": "database", "name": "DB", "id": "db" })).unwrap();
    let with_connection = workspace.request("addSystemConnection", json!({ "sourceId": "api", "targetId": "db", "label": "reads", "id": "reads" })).unwrap();
    let connection = with_connection["systemDesign"]["connections"][0]["id"].as_str().unwrap().to_owned();
    let store = Arc::new(AssistantStore::open(&path, || 1).unwrap());
    let conversation = store
        .create_conversation(&project_id, &json!({ "role": "system", "payload": { "text": "x" } }), &json!({ "id": "c1" }))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let context = Arc::new(ToolContext {
        reads: Default::default(),
        turn_id: Box::new(|| Some("turn-1".to_owned())),
        workspace: workspace.clone(),
        store,
        files: None,
        conversation_id: conversation,
        target: (project_id, design_id.clone()),
    });
    Fixture { workspace, read: ReadWalkthroughs(context.clone()), edit: EditWalkthroughs(context), connection, design_id, _directory: directory }
}

fn run(tool: &dyn ProjectTool, arguments: Value) -> Result<Value, String> {
    tool.execute("c", &arguments).map(|result| serde_json::from_str(&result.content[0]).unwrap())
}

#[test]
fn a_batch_creates_a_walkthrough_with_a_step_and_reports_it() {
    let fixture = fixture();
    let before = run(&fixture.read, json!({})).unwrap();
    assert_eq!(before["walkthroughs"], json!([]));
    let summary = run(
        &fixture.edit,
        json!({ "operations": [
            { "op": "create_walkthrough", "id": "w1", "name": "Checkout" },
            { "op": "add_step", "walkthroughId": "w1", "id": "s1", "connectionId": fixture.connection, "title": "Read orders", "action": "send" },
            { "op": "add_block", "walkthroughId": "w1", "id": "b1", "kind": "repeat" },
        ] }),
    )
    .unwrap();
    assert_eq!(summary["status"], "applied");
    assert_eq!(summary["operations"], 3);
    let walkthrough = &summary["walkthroughs"][0];
    assert_eq!((walkthrough["id"].as_str(), walkthrough["name"].as_str()), (Some("w1"), Some("Checkout")));
    assert_eq!(walkthrough["blocks"][0]["kind"], "step");
    assert_eq!(walkthrough["blocks"][0]["status"], "ok");
    assert_eq!(walkthrough["blocks"][1], json!({ "kind": "repeat", "id": "b1", "count": 2, "body": [] }));
    assert_eq!(summary["diagnostics"], json!([]));
    assert_eq!(walkthrough["version"].as_str().unwrap().len(), 12);
    // It is in the Project, saved as one Assistant action, so one Undo takes the whole batch back.
    let state = fixture.workspace.state();
    assert_eq!(state.walkthroughs.len(), 1);
    assert_eq!(state.undo_action_name.as_deref(), Some("Assistant turn"));
    let undone = fixture.workspace.request("undo", json!({ "designId": fixture.design_id })).unwrap();
    assert_eq!(undone["walkthroughs"], json!([]));
}

#[test]
fn a_batch_applies_in_full_or_not_at_all() {
    let fixture = fixture();
    let error = run(
        &fixture.edit,
        json!({ "operations": [
            { "op": "create_walkthrough", "id": "w1", "name": "One" },
            { "op": "add_step", "walkthroughId": "w1", "id": "s1", "connectionId": "no-such-connection" },
        ] }),
    )
    .unwrap_err();
    assert_eq!(error, "Operation 2 (add_step): connectionId \"no-such-connection\" does not match a Connection in the System design. Read the System design and use one of its Connection ids, or add the Connection first.");
    assert!(fixture.workspace.state().walkthroughs.is_empty());
    assert_eq!(run(&fixture.edit, json!({ "operations": [] })).unwrap_err(), "At least one Walkthrough operation is required.");
    assert_eq!(run(&fixture.edit, json!({ "operations": [{ "op": "teleport" }] })).unwrap_err(), "Operation 1 (teleport): Unsupported operation \"teleport\".");
    assert_eq!(run(&fixture.edit, json!({ "operations": [{ "op": "create_walkthrough" }] })).unwrap_err(), "Operation 1 (create_walkthrough): id is required.");
    assert_eq!(run(&fixture.edit, json!({ "operations": [{ "op": "move_walkthrough", "walkthroughId": "w", "toIndex": -1 }] })).unwrap_err(), "Operation 1 (move_walkthrough): toIndex must be a whole number, 0 or more.");
}

#[test]
fn an_edit_is_refused_when_the_walkthrough_changed_after_it_was_read() {
    let fixture = fixture();
    run(&fixture.edit, json!({ "operations": [{ "op": "create_walkthrough", "id": "w1", "name": "Checkout" }] })).unwrap();
    run(&fixture.read, json!({})).unwrap();
    // The designer renames it before the Assistant edits it.
    fixture.workspace.request("renameWalkthrough", json!({ "walkthroughId": "w1", "name": "Renamed by hand" })).unwrap();
    let error = run(&fixture.edit, json!({ "operations": [{ "op": "rename_walkthrough", "walkthroughId": "w1", "name": "Mine" }] })).unwrap_err();
    assert_eq!(error, "These changed after you read the Walkthroughs: Walkthrough \"Checkout\". Read the Walkthroughs again before editing them.");
    // After reading again, the edit goes through.
    run(&fixture.read, json!({})).unwrap();
    assert!(run(&fixture.edit, json!({ "operations": [{ "op": "rename_walkthrough", "walkthroughId": "w1", "name": "Mine" }] })).is_ok());
}

#[test]
fn removing_a_connection_leaves_a_step_dangling_and_the_read_says_so() {
    let fixture = fixture();
    run(&fixture.edit, json!({ "operations": [
        { "op": "create_walkthrough", "id": "w1", "name": "Checkout" },
        { "op": "add_step", "walkthroughId": "w1", "id": "s1", "connectionId": fixture.connection, "title": "Read orders" },
    ] })).unwrap();
    fixture.workspace.request("removeSystemConnection", json!({ "connectionId": fixture.connection })).unwrap();
    let read = run(&fixture.read, json!({})).unwrap();
    assert_eq!(read["walkthroughs"][0]["blocks"][0]["status"], "dangling");
    assert_eq!(read["diagnostics"][0], format!("Walkthrough \"Checkout\" step \"Read orders\" (s1) plays Connection {}, which no longer exists. Repair it with repair_step, or remove the step. Its explanation is kept.", fixture.connection));
}

#[test]
fn the_tool_schema_accepts_what_the_original_accepts() {
    let fixture = fixture();
    let schema = fixture.edit.parameters();
    let validator = jsonschema::validator_for(&schema).unwrap();
    assert!(validator.is_valid(&json!({ "operations": [{ "op": "add_step", "walkthroughId": "w", "id": "s", "connectionId": "c", "durationMs": null, "sequence": { "blockId": null, "branch": 1 } }] })));
    assert!(!validator.is_valid(&json!({ "operations": [{ "op": "teleport" }] })));
    assert!(!validator.is_valid(&json!({ "operations": [{ "op": "add_step", "action": "dance" }] })));
    assert!(!validator.is_valid(&json!({})));
    assert!(!validator.is_valid(&json!({ "operations": [{ "id": "no op" }] })));
}
