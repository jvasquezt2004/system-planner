use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use schema_assistant::store::AssistantStore;
use schema_store::{DesignSave, ProjectSummary, Store};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/data/assistant-store.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("missing fixture {} ({error})", path.display()))).unwrap()
}

fn lenient(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": value }),
        Err(error) => json!({ "error": error }),
    }
}

/// JSON equality where numbers compare by value.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same(a, b)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| same(a, b))),
        _ => a == b,
    }
}

#[test]
fn the_store_matches_the_typescript_store() {
    let mut failures = Vec::new();
    for session in fixture().as_array().unwrap() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("assistant.sqlite");
        {
            let mut projects = Store::open(&path).unwrap();
            for id in ["p1", "p2"] {
                let design = json!({ "tables": [], "relationships": [], "manyToManyRelationships": [], "viewport": { "x": 0, "y": 0, "zoom": 1 } });
                projects.create_project(&ProjectSummary { id: id.into(), name: id.into() }, &design, DesignSave { revision: 1, document_revision: 1, saved_at: 1 }, &format!("d-{id}")).unwrap();
            }
        }
        let clock = Arc::new(AtomicI64::new(5000));
        let store = AssistantStore::open(&path, { let clock = clock.clone(); move || clock.fetch_add(7, Ordering::SeqCst) + 7 }).unwrap();
        let mut ids: Vec<String> = Vec::new();
        for (index, step) in session["steps"].as_array().unwrap().iter().enumerate() {
            let args = &step["args"];
            let text = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
            let result = match step["op"].as_str().unwrap() {
                "createConversation" => {
                    let created = store.create_conversation(args["project"].as_str().unwrap(), &args["first"], &args["options"]);
                    if let Ok(created) = &created {
                        let id = created["id"].as_str().unwrap().to_owned();
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                    created
                }
                "appendMessage" => store.append_message(args["id"].as_str().unwrap(), &args["message"]).map(Value::String),
                "renameConversation" => store.rename_conversation(&text("id"), &text("title")).map(Value::Bool),
                "deleteConversation" => store.delete_conversation(&text("id")).map(Value::Bool),
                "updateConversationSelection" => store.update_conversation_selection(&text("id"), args["connectionId"].as_str(), &text("model"), &text("thinking")).map(Value::Bool),
                "updateDefaultSelection" => store.update_default_selection(args["connectionId"].as_str(), &text("model"), &text("thinking")).map(|()| Value::Null),
                "setMaxRequestsPerTurn" => store.set_max_requests_per_turn(args["limit"].as_f64().unwrap()).map(|()| Value::Null),
                "observeProjectRevision" => store.observe_project_revision(&text("id"), args["revision"].as_i64().unwrap()).map(|previous| previous.map_or(Value::Null, |revision| json!(revision))),
                "observeProjectSnapshot" => store.observe_project_snapshot(&text("id"), &text("snapshot"), args["revision"].as_i64().unwrap()).map(|previous| previous.unwrap_or(Value::Null)),
                "saveTurnUsage" => store.save_turn_usage(&text("id"), &text("turnId"), &args["usage"]).map(|()| Value::Null),
                other => panic!("unknown op {other}"),
            };
            let projects: Vec<Value> = ["p1", "p2"]
                .iter()
                .map(|project| {
                    json!({
                        "project": project,
                        "conversations": store.list_conversations(project).unwrap(),
                        "latest": store.get_latest_conversation(project).unwrap().map_or(Value::Null, |latest| latest["id"].clone()),
                    })
                })
                .collect();
            let records: Vec<Value> = ids.iter().map(|id| store.load_conversation(id).unwrap().unwrap_or(Value::Null)).collect();
            let state = json!({ "projects": projects, "records": records, "defaults": store.get_default_selection().unwrap(), "cap": store.get_max_requests_per_turn().unwrap() });
            let result = lenient(result);
            if !same(&result, &step["result"]) {
                failures.push(format!("{} step {index} {}: result\n  expected {}\n  actual   {result}", session["name"], step["op"], step["result"]));
                break;
            }
            if !same(&state, &step["state"]) {
                let (expected, actual) = (step["state"].to_string(), state.to_string());
                let at = expected.bytes().zip(actual.bytes()).position(|(a, b)| a != b).unwrap_or(0);
                failures.push(format!("{} step {index} {}: state differs near byte {at}\n  expected …{}\n  actual   …{}", session["name"], step["op"], &expected[at.saturating_sub(60)..(at + 100).min(expected.len())], &actual[at.saturating_sub(60)..(at + 100).min(actual.len())]));
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} sessions diverge:\n{}", failures.len(), failures.join("\n"));
}
