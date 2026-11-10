use std::sync::Arc;

use schema_assistant::read_tools::ToolContext;
use schema_assistant::store::AssistantStore;
use schema_assistant::system_tools::{EditSystemDesign, ReadSystemDesign};
use schema_assistant::tools::ProjectTool;
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
    read: ReadSystemDesign,
    edit: EditSystemDesign,
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
    let store = Arc::new(AssistantStore::open(&path, || 1).unwrap());
    let conversation = store.create_conversation(&project_id, &json!({ "role": "system", "payload": {} }), &json!({ "id": "c1" })).unwrap()["id"].as_str().unwrap().to_owned();
    let context = Arc::new(ToolContext {
        reads: Default::default(),
        turn_id: Box::new(|| Some("turn-1".to_owned())),
        workspace: workspace.clone(),
        store,
        files: None,
        conversation_id: conversation,
        target: (project_id, design_id.clone()),
    });
    Fixture { workspace, read: ReadSystemDesign(context.clone()), edit: EditSystemDesign(context), design_id, _directory: directory }
}

fn run(tool: &dyn ProjectTool, arguments: Value) -> Result<Value, String> {
    tool.execute("c", &arguments).map(|result| serde_json::from_str(&result.content[0]).unwrap())
}

fn batch(operations: Value) -> Value {
    json!({ "operations": operations })
}

#[test]
fn one_batch_builds_an_architecture_and_the_read_reports_it() {
    let fixture = fixture();
    let summary = run(
        &fixture.edit,
        batch(json!([
            { "op": "add_service", "id": "backend", "name": "Backend", "x": 0, "y": 0 },
            { "op": "add_component", "id": "api", "kind": "api", "name": "API", "ownerServiceId": "backend", "x": 40, "y": 40 },
            { "op": "add_component", "id": "db", "kind": "database", "name": "Primary", "x": 400, "y": 40 },
            { "op": "add_connection", "id": "reads", "sourceId": "api", "targetId": "db", "label": "reads", "protocol": "SQL" },
            { "op": "add_group", "id": "core", "name": "Core", "memberIds": ["api", "db"] },
        ])),
    )
    .unwrap();
    assert_eq!(summary["status"], "applied");
    assert_eq!(summary["operations"], 5);
    assert_eq!(summary["components"][0]["ownerServiceId"], "backend");
    assert_eq!(summary["connections"][0]["protocol"], "SQL");
    let read = run(&fixture.read, json!({})).unwrap();
    assert_eq!(read["services"][0]["ownedComponentIds"], json!(["api"]));
    assert_eq!(read["components"][1]["groupIds"], json!(["core"]));
    assert_eq!(read["groups"][0]["memberIds"], json!(["api", "db"]));
    assert_eq!(read["connections"][0]["attachment"], json!({ "fromSide": "auto", "toSide": "auto" }));
    assert_eq!(read["designs"][0]["id"], fixture.design_id);
    // A database component with no linked design is something the designer would want fixed.
    assert!(read["diagnostics"].as_array().unwrap().iter().any(|note| note.as_str().unwrap().starts_with("Database component \"Primary\" (db) has no linked database design.")));
    // The whole batch is one Undo step.
    assert_eq!(fixture.workspace.state().undo_action_name.as_deref(), Some("Assistant turn"));
}

#[test]
fn a_new_item_without_a_position_gets_a_free_spot() {
    let fixture = fixture();
    run(&fixture.edit, batch(json!([{ "op": "add_component", "id": "a", "name": "A" }, { "op": "add_component", "id": "b", "name": "B" }]))).unwrap();
    let read = run(&fixture.read, json!({})).unwrap();
    assert_eq!(read["components"][0]["position"], json!({ "x": 120, "y": 120 }));
    assert_ne!(read["components"][0]["position"], read["components"][1]["position"]);
}

#[test]
fn a_batch_applies_in_full_or_not_at_all() {
    let fixture = fixture();
    let error = run(
        &fixture.edit,
        batch(json!([
            { "op": "add_component", "id": "a", "name": "A", "x": 0, "y": 0 },
            { "op": "add_connection", "id": "c", "sourceId": "a", "targetId": "ghost" },
        ])),
    )
    .unwrap_err();
    assert_eq!(error, "Operation 2 (add_connection): targetId \"ghost\" does not match a Component or Service.");
    assert!(fixture.workspace.state().system_design.unwrap().components.is_empty());
    assert_eq!(run(&fixture.edit, batch(json!([]))).unwrap_err(), "At least one System design operation is required.");
    assert_eq!(run(&fixture.edit, batch(json!([{ "op": "teleport" }]))).unwrap_err(), "Operation 1 (teleport): Unsupported operation \"teleport\".");
    assert_eq!(run(&fixture.edit, batch(json!([{ "op": "add_component" }]))).unwrap_err(), "Operation 1 (add_component): A new id is required.");
    assert_eq!(run(&fixture.edit, batch(json!([{ "op": "update_service", "serviceId": "nope", "name": "x" }]))).unwrap_err(), "Operation 1 (update_service): serviceId \"nope\" does not match a Service.");
    assert_eq!(run(&fixture.edit, batch(json!([{ "op": "move_component", "componentId": "a", "x": 1 }]))).unwrap_err(), "Operation 1 (move_component): componentId \"a\" does not match a Component.");
    assert_eq!(run(&fixture.edit, batch(json!([{ "op": "add_component", "id": "a", "linkedDesignId": "nope" }]))).unwrap_err(), "Operation 1 (add_component): linkedDesignId \"nope\" does not match a database design in this Project.");
}

#[test]
fn linking_a_database_design_and_unlinking_it() {
    let fixture = fixture();
    run(&fixture.edit, batch(json!([{ "op": "add_component", "id": "db", "kind": "database", "name": "Primary", "x": 0, "y": 0, "linkedDesignId": fixture.design_id }]))).unwrap();
    assert_eq!(run(&fixture.read, json!({})).unwrap()["components"][0]["linkedDesignId"], fixture.design_id);
    run(&fixture.edit, batch(json!([{ "op": "update_component", "componentId": "db", "linkedDesignId": null }]))).unwrap();
    assert_eq!(run(&fixture.read, json!({})).unwrap()["components"][0]["linkedDesignId"], Value::Null);
    assert_eq!(run(&fixture.edit, batch(json!([{ "op": "update_component", "componentId": "db" }]))).unwrap_err(), "Operation 1 (update_component): Give at least one field to change.");
}

#[test]
fn removing_a_service_reports_what_else_it_did() {
    let fixture = fixture();
    run(
        &fixture.edit,
        batch(json!([
            { "op": "add_service", "id": "s", "name": "S", "x": 0, "y": 0 },
            { "op": "add_component", "id": "a", "name": "A", "ownerServiceId": "s", "x": 10, "y": 10 },
            { "op": "add_component", "id": "b", "name": "B", "x": 400, "y": 10 },
            { "op": "add_connection", "id": "ab", "sourceId": "s", "targetId": "b", "label": "calls" },
            { "op": "add_connection", "id": "aa", "sourceId": "a", "targetId": "b", "label": "also" },
        ])),
    )
    .unwrap();
    run(&fixture.read, json!({})).unwrap();
    let summary = run(&fixture.edit, batch(json!([{ "op": "remove_service", "serviceId": "s" }]))).unwrap();
    let impacts: Vec<&str> = summary["impacts"].as_array().unwrap().iter().map(|note| note.as_str().unwrap()).collect();
    assert!(impacts.contains(&"Removed Connection \"calls\" (ab) because one of its endpoints was removed."), "{impacts:?}");
    assert!(impacts.contains(&"Released 1 Component to system scope: a."), "{impacts:?}");
    assert_eq!(summary["components"].as_array().unwrap().len(), 2);
}

#[test]
fn an_edit_is_refused_when_an_item_changed_after_it_was_read() {
    let fixture = fixture();
    run(&fixture.edit, batch(json!([{ "op": "add_component", "id": "a", "name": "A", "x": 0, "y": 0 }, { "op": "add_component", "id": "b", "name": "B", "x": 300, "y": 0 }]))).unwrap();
    run(&fixture.read, json!({})).unwrap();
    // The designer moves A by hand after the Assistant read; B is untouched.
    fixture.workspace.request("moveSystemComponent", json!({ "componentId": "a", "x": 99, "y": 99 })).unwrap();
    assert_eq!(
        run(&fixture.edit, batch(json!([{ "op": "update_component", "componentId": "a", "name": "Mine" }]))).unwrap_err(),
        "These items changed after you read the project: component a. Read the project again before editing them."
    );
    assert!(run(&fixture.edit, batch(json!([{ "op": "update_component", "componentId": "b", "name": "Bee" }]))).is_ok());
    // After its own edit the Assistant's read is current again, and an arrangement depends on everything it read.
    run(&fixture.read, json!({})).unwrap();
    fixture.workspace.request("moveSystemComponent", json!({ "componentId": "b", "x": 500, "y": 500 })).unwrap();
    assert!(run(&fixture.edit, batch(json!([{ "op": "arrange_layout" }]))).unwrap_err().contains("component b"));
    run(&fixture.read, json!({})).unwrap();
    let arranged = run(&fixture.edit, batch(json!([{ "op": "arrange_layout" }]))).unwrap();
    assert!(arranged["impacts"].as_array().unwrap().iter().any(|note| note == "Arranged layout for 2 Components."));
}

#[test]
fn the_tool_schema_lists_what_the_original_lists() {
    let fixture = fixture();
    let schema = fixture.edit.parameters();
    let validator = jsonschema::validator_for(&schema).unwrap();
    assert!(validator.is_valid(&json!({ "operations": [{ "op": "add_component", "kind": "database", "ownerServiceId": null, "linkedDesignId": "d", "x": 1, "y": 2 }] })));
    assert!(validator.is_valid(&json!({ "operations": [{ "op": "update_connection", "fromSide": "left", "labelOffset": null, "bendPoints": [{ "x": 1, "y": 2 }] }] })));
    assert!(!validator.is_valid(&json!({ "operations": [{ "op": "add_component", "kind": "spaceship" }] })));
    assert!(!validator.is_valid(&json!({ "operations": [{ "op": "update_connection", "fromSide": "diagonal" }] })));
    assert!(!validator.is_valid(&json!({ "operations": [{ "op": "add_component", "icon": "star" }] })));
}

#[test]
fn reverting_a_turn_takes_back_its_changes_and_keeps_the_designers_own_edits() {
    let fixture = fixture();
    run(&fixture.edit, batch(json!([
        { "op": "add_service", "id": "backend", "name": "Backend", "x": 0, "y": 0 },
        { "op": "add_component", "id": "api", "name": "API", "ownerServiceId": "backend", "x": 40, "y": 40 },
    ]))).unwrap();
    // The turn also changes the schema, as one change with the rest.
    fixture.workspace.request("addTable", json!({ "designId": fixture.design_id, "name": "orders", "assistantTurnId": "turn-1" })).ok();
    // The designer keeps working after the turn.
    fixture.workspace.request("addSystemComponent", json!({ "id": "mine", "name": "Mine", "x": 700, "y": 0 })).unwrap();
    fixture.workspace.request("addTable", json!({ "designId": fixture.design_id, "name": "customers" })).unwrap();
    assert!(fixture.workspace.has_assistant_turn("turn-1"));
    let reverted = fixture.workspace.revert_assistant_turn(&fixture.design_id, "turn-1").unwrap();
    let system = reverted.system_design.unwrap();
    assert_eq!(system.services.len(), 0, "the Service the turn added is gone");
    assert_eq!(system.components.iter().map(|component| component.id.as_str()).collect::<Vec<_>>(), ["mine"], "the designer's Component stays");
    assert_eq!(reverted.undo_action_name.as_deref(), Some("Revert Assistant turn"));
    // Reverting is itself one step, which Undo takes back.
    let undone = fixture.workspace.request("undo", json!({ "designId": fixture.design_id })).unwrap();
    assert_eq!(undone["systemDesign"]["components"].as_array().unwrap().len(), 2);
    assert_eq!(fixture.workspace.revert_assistant_turn(&fixture.design_id, "no-such-turn").unwrap_err(), "This Assistant turn is no longer available to revert.");
}
