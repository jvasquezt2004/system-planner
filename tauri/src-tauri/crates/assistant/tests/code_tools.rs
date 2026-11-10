use std::sync::Arc;

use schema_assistant::code_tools::ManageCode;
use schema_assistant::read_tools::{ReadProject, ToolContext};
use schema_assistant::store::AssistantStore;
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
    context: Arc<ToolContext>,
    code: ManageCode,
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
    Fixture { workspace, context: context.clone(), code: ManageCode(context), design_id, _directory: directory }
}

fn run(tool: &dyn ProjectTool, arguments: Value) -> Result<Value, String> {
    tool.execute("c", &arguments).map(|result| serde_json::from_str(&result.content[0]).unwrap())
}

#[test]
fn a_scenario_is_created_written_edited_renamed_and_removed() {
    let fixture = fixture();
    let created = run(&fixture.code, json!({ "action": "create", "kind": "scenario", "name": "  Happy path " })).unwrap();
    assert_eq!((created["action"].as_str(), created["name"].as_str()), (Some("created"), Some("Happy path")));
    let id = created["id"].as_str().unwrap().to_owned();
    let written = run(&fixture.code, json!({ "action": "write", "kind": "scenario", "id": id, "source": "const a = 1;\nconst b = 2;\n" })).unwrap();
    assert_eq!(written["action"], "write");
    assert_eq!(fixture.workspace.state().scenarios[0]["source"], "const a = 1;\nconst b = 2;\n");
    run(&fixture.code, json!({ "action": "edit", "kind": "scenario", "id": id, "oldText": "const b = 2;", "newText": "const b = 3;" })).unwrap();
    assert_eq!(fixture.workspace.state().scenarios[0]["source"], "const a = 1;\nconst b = 3;\n");
    assert_eq!(run(&fixture.code, json!({ "action": "edit", "kind": "scenario", "id": id, "oldText": "missing", "newText": "x" })).unwrap_err(), "Exact-string edit expected exactly one match; found 0.");
    assert_eq!(run(&fixture.code, json!({ "action": "edit", "kind": "scenario", "id": id, "oldText": "const", "newText": "let" })).unwrap_err(), "Exact-string edit expected exactly one match; found 2.");
    assert_eq!(run(&fixture.code, json!({ "action": "edit", "kind": "scenario", "id": id, "oldText": "", "newText": "x" })).unwrap_err(), "Exact-string edit expected exactly one match; found 0.");
    assert_eq!(run(&fixture.code, json!({ "action": "edit", "kind": "scenario", "id": id, "oldText": "x" })).unwrap_err(), "Exact-string edit requires oldText and newText.");
    run(&fixture.code, json!({ "action": "rename", "kind": "scenario", "id": id, "name": "Checkout" })).unwrap();
    assert_eq!(fixture.workspace.state().scenarios[0]["name"], "Checkout");
    let removed = run(&fixture.code, json!({ "action": "remove", "kind": "scenario", "id": id })).unwrap();
    assert_eq!(removed["action"], "removed");
    assert!(fixture.workspace.state().scenarios.is_empty());
    // Every step above is the Assistant turn's, so the turn is one Undo step, named for its first change.
    assert_eq!(fixture.workspace.state().undo_action_name.as_deref(), Some("Add scenario “Happy path”"));
}

#[test]
fn a_create_that_carries_source_is_one_call() {
    let fixture = fixture();
    let created = run(&fixture.code, json!({ "action": "create", "kind": "edge-function", "name": "hello", "source": "Deno.serve(() => new Response('hi'));" })).unwrap();
    assert_eq!((created["action"].as_str(), created["kind"].as_str(), created["name"].as_str()), (Some("write"), Some("edge-function"), Some("hello")));
    assert_eq!(fixture.workspace.state().edge_functions[0]["source"], "Deno.serve(() => new Response('hi'));");
    assert_eq!(created["diagnostics"], json!([]));
    assert_eq!(run(&fixture.code, json!({ "action": "create", "kind": "edge-function", "name": "Bad Name" })).unwrap_err(), "Edge function names must use lowercase letters, digits, hyphens, or underscores.");
}

#[test]
fn bad_calls_say_what_is_missing() {
    let fixture = fixture();
    assert_eq!(run(&fixture.code, json!({ "action": "create", "kind": "function-body", "name": "x" })).unwrap_err(), "Function bodies cannot be created; define a Function in the schema SQL.");
    assert_eq!(run(&fixture.code, json!({ "action": "create", "kind": "scenario" })).unwrap_err(), "A name is required to create a code item.");
    assert_eq!(run(&fixture.code, json!({ "action": "rename", "kind": "scenario" })).unwrap_err(), "An item id is required to rename or remove a code item.");
    assert_eq!(run(&fixture.code, json!({ "action": "rename", "kind": "scenario", "id": "x" })).unwrap_err(), "A new name is required to rename a code item.");
    assert_eq!(run(&fixture.code, json!({ "action": "rename", "kind": "function-body", "id": "x", "name": "y" })).unwrap_err(), "Function bodies cannot be renamed or removed through code tools.");
    assert_eq!(run(&fixture.code, json!({ "action": "write", "kind": "scenario" })).unwrap_err(), "An item id is required to write code.");
    assert_eq!(run(&fixture.code, json!({ "action": "write", "kind": "scenario", "id": "x", "source": "" })).unwrap_err(), "That Scenario could not be found in the bound project.");
    assert_eq!(run(&fixture.code, json!({ "action": "write", "kind": "edge-function", "id": "x", "source": "" })).unwrap_err(), "That Edge function could not be found in the bound project.");
    assert_eq!(run(&fixture.code, json!({ "action": "write", "kind": "function-body", "id": "x", "source": "" })).unwrap_err(), "That Function could not be found in the bound project.");
}

#[test]
fn a_function_body_is_written_through_the_assistants_design_change() {
    let fixture = fixture();
    let design = &fixture.design_id;
    fixture.workspace.request("addTable", json!({ "designId": design, "name": "orders" })).unwrap();
    fixture
        .workspace
        .request("updateFunctions", json!({ "designId": design, "functions": [{ "id": "f1", "name": "total", "arguments": [], "returnType": "integer", "returnsSet": false, "language": "sql", "volatility": "stable", "security": "invoker", "body": "SELECT 1" }] }))
        .unwrap();
    let written = run(&fixture.code, json!({ "action": "edit", "kind": "function-body", "id": "f1", "oldText": "1", "newText": "42" })).unwrap();
    assert_eq!(written["diagnosticsNote"], "TypeScript diagnostics do not apply to SQL Function bodies.");
    let state = fixture.workspace.state();
    assert_eq!(state.design.unwrap().functions.unwrap()[0].body, "SELECT 42");
    assert_eq!(state.undo_action_name.as_deref(), Some("Assistant turn"));
}

#[test]
fn code_changed_after_it_was_read_is_refused() {
    let fixture = fixture();
    let created = run(&fixture.code, json!({ "action": "create", "kind": "scenario", "name": "One" })).unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    run(&ReadProject(fixture.context.clone()), json!({})).unwrap();
    fixture.workspace.request("updateScenarioSource", json!({ "designId": fixture.design_id, "scenarioId": id, "source": "by hand" })).unwrap();
    assert_eq!(
        run(&fixture.code, json!({ "action": "write", "kind": "scenario", "id": id, "source": "mine" })).unwrap_err(),
        "Stale relevant content: Scenario \"One\" changed since last read. Re-read the project before writing code."
    );
    fixture.workspace.request("createScenario", json!({ "designId": fixture.design_id, "name": "Two" })).unwrap();
    assert_eq!(
        run(&fixture.code, json!({ "action": "create", "kind": "scenario", "name": "Two" })).unwrap_err(),
        "Stale relevant content: Scenario \"Two\" was created since last read. Re-read the project before creating it."
    );
    fixture.workspace.request("removeScenario", json!({ "designId": fixture.design_id, "scenarioId": id })).unwrap();
    assert_eq!(
        run(&fixture.code, json!({ "action": "rename", "kind": "scenario", "id": id, "name": "x" })).unwrap_err(),
        "Stale relevant content: Scenario \"One\" was removed since last read. Re-read the project before writing code."
    );
}
