mod support;

use schema_domain::project_history::*;
use serde_json::{json, Value};
use support::read_json;

fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn tuple(entry: &ProjectHistoryEntry<Value>) -> Value {
    let change = &entry.change;
    json!([
        change.name,
        serde_json::to_string(&change.before).unwrap(),
        serde_json::to_string(&change.after).unwrap(),
        change.structural,
        change.assistant_turn_id,
        change.coalesce_key,
        entry.recorded_at,
    ])
}

fn fingerprint(history: &ProjectHistory<Value>) -> String {
    let entries: Vec<Value> = history.entries.iter().map(tuple).collect();
    fnv(&serde_json::to_string(&json!([history.cursor, entries])).unwrap())
}

fn describe(history: &ProjectHistory<Value>) -> Value {
    let description = describe_project_history(Some(history));
    let mut value = json!({ "canUndo": description.can_undo, "canRedo": description.can_redo });
    if let Some(name) = description.undo_action_name {
        value["undoActionName"] = json!(name);
    }
    if let Some(name) = description.redo_action_name {
        value["redoActionName"] = json!(name);
    }
    value
}

#[test]
fn the_history_matches_the_typescript_history() {
    let sessions = read_json("history.json");
    let mut failures = Vec::new();
    for session in sessions.as_array().unwrap() {
        let mut history = ProjectHistory::<Value>::default();
        for (index, step) in session["steps"].as_array().unwrap().iter().enumerate() {
            let op = &step["op"];
            let mut crossed: Option<String> = None;
            if op["type"] == "record" {
                let change = &op["change"];
                record_project_change(
                    &mut history,
                    ProjectHistoryChange {
                        name: change["name"].as_str().unwrap().to_owned(),
                        before: change["before"].clone(),
                        after: change["after"].clone(),
                        structural: change["structural"].as_bool().unwrap(),
                        assistant_turn_id: change["assistantTurnId"].as_str().map(str::to_owned),
                        coalesce_key: change["coalesceKey"].as_str().map(str::to_owned),
                    },
                    op["at"].as_i64().unwrap(),
                );
            } else {
                let direction = if op["direction"] == "undo" { Direction::Undo } else { Direction::Redo };
                crossed = step_project_history(&mut history, direction).map(|entry| fnv(&serde_json::to_string(&tuple(entry)).unwrap()));
            }
            let expected_crossed = step["crossed"].as_str().map(str::to_owned);
            if fingerprint(&history) != step["state"].as_str().unwrap() || describe(&history) != step["describe"] || crossed != expected_crossed {
                failures.push(format!("{} step {index}: {}", session["name"].as_str().unwrap(), op["type"]));
                break;
            }
        }
    }
    assert!(failures.is_empty(), "{} sessions diverge:\n{}", failures.len(), failures.join("\n"));
}
