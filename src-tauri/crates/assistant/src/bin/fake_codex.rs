//! A stand-in for `codex app-server`, for tests: speaks just enough of the protocol to start a
//! thread, run a turn with a tool call and a streamed message, and be interrupted.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn send(message: Value) {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{message}").unwrap();
    out.flush().unwrap();
}

fn main() {
    let stdin = std::io::stdin();
    let mut turn = 0;
    let mut waiting_for_tool: Option<String> = None;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let method = message["method"].as_str().unwrap_or_default().to_owned();
        let id = message.get("id").cloned();
        match (method.as_str(), id) {
            ("initialize", Some(id)) => send(json!({ "id": id, "result": { "userAgent": "fake" } })),
            ("thread/start", Some(id)) => send(json!({ "id": id, "result": { "thread": { "id": "thread-1" }, "model": "fake-model", "tools": message["params"]["dynamicTools"] } })),
            ("thread/resume", Some(id)) => send(json!({ "id": id, "result": { "thread": { "id": "thread-1" } } })),
            ("turn/start", Some(id)) => {
                turn += 1;
                let turn_id = format!("turn-{turn}");
                send(json!({ "id": id, "result": { "turn": { "id": turn_id } } }));
                let text = message["params"]["input"][0]["text"].as_str().unwrap_or_default();
                send(json!({ "method": "item/started", "params": { "threadId": "thread-1", "item": { "id": "m1", "type": "agentMessage" } } }));
                send(json!({ "method": "item/agentMessage/delta", "params": { "delta": "Looking " } }));
                if text.contains("hang") {
                    continue; // stays in the turn until interrupted
                }
                if text.contains("tool") {
                    waiting_for_tool = Some(turn_id.clone());
                    send(json!({ "id": 900, "method": "item/tool/call", "params": { "threadId": "thread-1", "turnId": turn_id, "callId": "c1", "tool": "read_project", "namespace": null, "arguments": {} } }));
                    continue;
                }
                send(json!({ "method": "item/completed", "params": { "threadId": "thread-1", "item": { "id": "m1", "type": "agentMessage", "text": format!("Echo: {text}") } } }));
                send(json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": turn_id, "status": "completed" } } }));
            }
            ("turn/interrupt", Some(id)) => {
                send(json!({ "id": id, "result": {} }));
                send(json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": message["params"]["turnId"], "status": "interrupted" } } }));
            }
            ("", Some(id)) if id == json!(900) => {
                let turn_id = waiting_for_tool.take().unwrap_or_default();
                let answered = message["result"]["contentItems"][0]["text"].as_str().unwrap_or("no result").to_owned();
                send(json!({ "method": "item/completed", "params": { "threadId": "thread-1", "item": { "id": "m1", "type": "agentMessage", "text": format!("Tool said: {answered}") } } }));
                send(json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": turn_id, "status": "completed" } } }));
            }
            (_, Some(id)) => send(json!({ "id": id, "error": { "code": -32601, "message": format!("unknown method {method}") } })),
            _ => {}
        }
    }
}
