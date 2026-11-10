//! Runs the Assistant against the real `codex app-server` installed on this machine. Ignored by
//! default, because it needs Codex signed in and the second test spends a model turn:
//!
//!   cargo test -p schema-assistant --test real_codex -- --ignored --nocapture --test-threads=1

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

fn runtime() -> (Runtime, Workspace, Arc<Mutex<Vec<Value>>>, String, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite");
    let workspace = Workspace::open(WorkspaceOptions::new(&path, Arc::new(|| Box::new(Empty)))).unwrap();
    let state = workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let design_id = state["activeDesignId"].as_str().unwrap().to_owned();
    workspace.request("addTable", json!({ "designId": design_id, "name": "orders" })).unwrap();
    workspace.request("addTable", json!({ "designId": design_id, "name": "customers" })).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let runtime = Runtime::new(
        Options {
            workspace: workspace.clone(),
            files: None,
            folder: None,
            push: Arc::new(move |message| sink.lock().unwrap().push(message["payload"]["event"].clone())),
            codex_executable: None,
            codex_args: Options::standard_codex_args(),
        },
        Arc::new(AssistantStore::open(&path, || 1).unwrap()),
    );
    let project_id = state["project"]["id"].as_str().unwrap().to_owned();
    (runtime, workspace, events, project_id, directory)
}

#[test]
#[ignore = "needs the Codex CLI"]
fn codex_is_found_signed_in_and_lists_models() {
    let (runtime, _workspace, _events, _project, _directory) = runtime();
    let connections = runtime.list_connections().unwrap();
    println!("connections: {connections}");
    assert_eq!(connections[0]["id"], CODEX_CONNECTION_ID);
    assert_eq!(connections[0]["connected"], true, "sign in with `codex login` first");
    let models = runtime.list_models().unwrap();
    println!("models: {}", models.as_array().unwrap().iter().map(|model| model["id"].as_str().unwrap().to_owned()).collect::<Vec<_>>().join(", "));
    assert!(models.as_array().unwrap().len() > 1, "discovery should list Codex's own models beside the default entry");
}

#[test]
#[ignore = "needs the Codex CLI and spends one model turn"]
fn a_real_turn_reads_the_project_through_the_tool() {
    let (runtime, _workspace, events, project_id, _directory) = runtime();
    let conversation = runtime.create_conversation(&project_id).unwrap()["id"].as_str().unwrap().to_owned();
    runtime
        .send_message(&conversation, "Call the read_project tool once, then answer in one short sentence naming the tables of this design. Do not change anything.", CODEX_MODEL_ID, "low", None)
        .unwrap();
    let started = Instant::now();
    loop {
        let seen = events.lock().unwrap().clone();
        for event in &seen {
            if event["type"] == "assistant_error" {
                panic!("the turn failed: {}", event["error"]);
            }
        }
        if seen.iter().any(|event| event["type"] == "assistant_turn_ended") {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(240), "no end of turn; saw {:?}", seen.iter().map(|event| event["type"].clone()).collect::<Vec<_>>());
        std::thread::sleep(Duration::from_millis(200));
    }
    let seen = events.lock().unwrap().clone();
    println!("events: {:?}", seen.iter().map(|event| event["type"].as_str().unwrap_or("?").to_owned()).collect::<Vec<_>>());
    let tool = seen.iter().find(|event| event["type"] == "tool_execution_end" && event["toolName"] == "read_project").expect("Codex called read_project");
    assert_eq!(tool["isError"], false);
    let record = runtime.load_conversation(&conversation).unwrap();
    let answer = record["messages"].as_array().unwrap().iter().rev().find(|message| message["role"] == "assistant" && message["payload"]["content"][0]["type"] == "text").expect("an answer");
    let text = answer["payload"]["content"][0]["text"].as_str().unwrap().to_lowercase();
    println!("answer: {text}");
    assert!(text.contains("orders") && text.contains("customers"), "{text}");
}
