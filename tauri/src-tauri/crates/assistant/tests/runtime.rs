use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use schema_assistant::runtime::{Options, Runtime, CODEX_CONNECTION_ID, CODEX_MODEL_ID};
use schema_assistant::store::AssistantStore;
use schema_sandbox::{ApplyResult, Sandbox};
use schema_workspace::{Options as WorkspaceOptions, Workspace};
use serde_json::{json, Value};

struct Empty;

impl Sandbox for Empty {
    fn apply(&mut self, _sql: &str) -> ApplyResult {
        ApplyResult::Applied { tables: vec![], relationships: vec![] }
    }
}

struct Fixture {
    runtime: Runtime,
    workspace: Workspace,
    events: Arc<Mutex<Vec<Value>>>,
    project_id: String,
    _directory: tempfile::TempDir,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite");
    let workspace = Workspace::open(WorkspaceOptions::new(&path, Arc::new(|| Box::new(Empty)))).unwrap();
    let state = workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let project_id = state["project"]["id"].as_str().unwrap().to_owned();
    let design_id = state["activeDesignId"].as_str().unwrap().to_owned();
    workspace.request("addTable", json!({ "designId": design_id, "name": "orders" })).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let store = Arc::new(AssistantStore::open(&path, || 1).unwrap());
    let runtime = Runtime::new(
        Options {
            workspace: workspace.clone(),
            files: None,
            folder: None,
            push: Arc::new(move |message| sink.lock().unwrap().push(message["payload"].clone())),
            codex_executable: Some(env!("CARGO_BIN_EXE_fake_codex").into()),
            codex_args: vec![],
        },
        store,
    );
    Fixture { runtime, workspace, events, project_id, _directory: directory }
}

fn wait_for(events: &Arc<Mutex<Vec<Value>>>, kind: &str) -> Vec<Value> {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(10) {
        let seen = events.lock().unwrap().clone();
        if seen.iter().any(|event| event["event"]["type"] == kind) {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("no {kind} event; saw {:?}", events.lock().unwrap().iter().map(|event| event["event"]["type"].clone()).collect::<Vec<_>>());
}

fn conversation(fixture: &Fixture) -> String {
    let created = fixture.runtime.create_conversation(&fixture.project_id).unwrap();
    assert_eq!(created["connection_id"], CODEX_CONNECTION_ID);
    assert_eq!(created["model"], CODEX_MODEL_ID);
    created["id"].as_str().unwrap().to_owned()
}

#[test]
fn a_turn_streams_its_message_stores_the_transcript_and_names_the_conversation() {
    let fixture = fixture();
    let id = conversation(&fixture);
    let started = fixture.runtime.send_message(&id, "  Add   an orders table\n", CODEX_MODEL_ID, "high", Some(CODEX_CONNECTION_ID)).unwrap();
    assert_eq!(started, json!({ "started": true }));
    let events = wait_for(&fixture.events, "assistant_turn_ended");
    let types: Vec<String> = events.iter().map(|event| event["event"]["type"].as_str().unwrap().to_owned()).collect();
    assert_eq!(types, ["message_start", "message_update", "message_end", "assistant_turn_ended"]);
    let record = fixture.runtime.load_conversation(&id).unwrap();
    assert_eq!(record["title"], "Add an orders table");
    let roles: Vec<(String, Option<String>)> = record["messages"].as_array().unwrap().iter().map(|message| (message["role"].as_str().unwrap().to_owned(), message["kind"].as_str().map(str::to_owned))).collect();
    assert_eq!(roles[0].1.as_deref(), Some("assistant-context"));
    assert!(roles.contains(&("system".into(), Some("codex-thread".into()))));
    let last = record["messages"].as_array().unwrap().last().unwrap();
    assert_eq!((last["role"].as_str(), last["payload"]["content"][0]["text"].as_str()), (Some("assistant"), Some("Echo:   Add   an orders table\n")));
    // The turn is over, so a second one starts on the same thread.
    assert!(!fixture.runtime.is_turn_running(&id));
    fixture.events.lock().unwrap().clear();
    fixture.runtime.send_message(&id, "again", CODEX_MODEL_ID, "medium", None).unwrap();
    wait_for(&fixture.events, "assistant_turn_ended");
}

#[test]
fn the_harness_can_read_the_project_through_the_tool() {
    let fixture = fixture();
    let id = conversation(&fixture);
    fixture.runtime.send_message(&id, "use the tool", CODEX_MODEL_ID, "medium", None).unwrap();
    let events = wait_for(&fixture.events, "assistant_turn_ended");
    let start = events.iter().find(|event| event["event"]["type"] == "tool_execution_start").expect("a tool started");
    assert_eq!(start["event"]["toolName"], "read_project");
    let end = events.iter().find(|event| event["event"]["type"] == "tool_execution_end").expect("a tool ended");
    assert_eq!(end["event"]["isError"], false);
    let answer: Value = serde_json::from_str(end["event"]["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(answer["project"]["name"], "Shop");
    assert_eq!(answer["design"]["tables"][0]["name"], "orders");
    assert!(answer["generatedSql"].as_str().unwrap().contains("CREATE TABLE \"orders\""));
    assert_eq!(answer["policies"][0]["table"], "orders");
    // The harness's last message echoes the tool's answer, and the whole exchange is in the transcript.
    let record = fixture.runtime.load_conversation(&id).unwrap();
    let kinds: Vec<&str> = record["messages"].as_array().unwrap().iter().map(|message| message["payload"]["role"].as_str().or(message["role"].as_str()).unwrap_or("")).collect();
    assert!(kinds.contains(&"toolResult") && kinds.contains(&"assistant"));
    // Reading is recorded, so the next turn can say what changed since.
    let state = fixture.workspace.state();
    assert_eq!(state.revision, answer["revision"].as_i64().unwrap());
}

#[test]
fn a_tool_refuses_once_another_design_is_open() {
    use schema_assistant::read_tools::{ReadProject, ToolContext};
    use schema_assistant::tools::ProjectTool;
    let fixture = fixture();
    let id = conversation(&fixture);
    let first = fixture.workspace.state().active_design_id.unwrap();
    let store = Arc::new(AssistantStore::open(fixture._directory.path().join("app.sqlite"), || 1).unwrap());
    let tool = ReadProject(Arc::new(ToolContext { workspace: fixture.workspace.clone(), store, files: None, conversation_id: id, target: (fixture.project_id.clone(), first) }));
    assert!(tool.execute("c1", &json!({})).is_ok());
    // Opening another Design makes the turn's tools refuse, rather than act on whatever is shown.
    fixture.workspace.request("createDesign", json!({ "name": "Other" })).unwrap();
    assert_eq!(tool.execute("c2", &json!({})).unwrap_err(), "This Assistant turn works on another design. Open that design to continue it.");
}

#[test]
fn a_turn_can_be_stopped() {
    let fixture = fixture();
    let id = conversation(&fixture);
    fixture.runtime.send_message(&id, "please hang", CODEX_MODEL_ID, "medium", None).unwrap();
    wait_for(&fixture.events, "message_update");
    assert!(fixture.runtime.is_turn_running(&id));
    fixture.runtime.stop(&id);
    wait_for(&fixture.events, "assistant_turn_ended");
    assert!(!fixture.runtime.is_turn_running(&id));
    assert_eq!(fixture.runtime.turn_status(&id)["running"], false);
}

#[test]
fn switching_between_harness_and_other_connections_after_a_message_is_refused() {
    let fixture = fixture();
    let id = conversation(&fixture);
    fixture.runtime.send_message(&id, "hello", CODEX_MODEL_ID, "medium", None).unwrap();
    wait_for(&fixture.events, "assistant_turn_ended");
    let error = fixture.runtime.update_conversation_selection(&id, Some("opencode-harness"), "x", "medium").unwrap_err();
    assert_eq!(error, "Start a new Conversation to switch between Codex, OpenCode, and provider connections.");
    assert!(fixture.runtime.update_conversation_selection(&id, Some(CODEX_CONNECTION_ID), "gpt-5", "high").is_ok());
    let selection = fixture.runtime.load_conversation(&id).unwrap();
    assert_eq!((selection["model"].as_str(), selection["thinking"].as_str()), (Some("gpt-5"), Some("high")));
}

#[test]
fn a_message_needs_the_conversations_project_to_be_open() {
    let fixture = fixture();
    let id = conversation(&fixture);
    fixture.workspace.request("createProject", json!({ "name": "Elsewhere" })).unwrap();
    let error = fixture.runtime.send_message(&id, "hello", CODEX_MODEL_ID, "medium", None).unwrap_err();
    assert_eq!(error, "This conversation requires its project and an active Design to use project tools.");
}
