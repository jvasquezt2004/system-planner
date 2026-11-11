use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use schema_assistant::tools::*;
use serde_json::{json, Value};

struct Echo {
    running: Arc<AtomicUsize>,
    overlap: Arc<AtomicBool>,
}

impl ProjectTool for Echo {
    fn name(&self) -> &str {
        "echo"
    }
    fn description(&self) -> &str {
        "Echoes its text"
    }
    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"], "additionalProperties": false })
    }
    fn execute(&self, _call_id: &str, arguments: &Value) -> Result<ToolResult, String> {
        if self.running.fetch_add(1, Ordering::SeqCst) > 0 {
            self.overlap.store(true, Ordering::SeqCst);
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
        self.running.fetch_sub(1, Ordering::SeqCst);
        match arguments["text"].as_str() {
            Some("explode") => Err("The tool failed.".into()),
            Some(text) => Ok(ToolResult::text(text)),
            None => unreachable!("validated"),
        }
    }
}

fn bridge(aborted: Arc<AtomicBool>, events: Arc<Mutex<Vec<String>>>, overlap: Arc<AtomicBool>) -> ToolBridge {
    let (start, end) = (events.clone(), events);
    ToolBridge::new(
        vec![Arc::new(Echo { running: Arc::new(AtomicUsize::new(0)), overlap })],
        || Some(("thread-1".into(), Some("turn-1".into()))),
        move || aborted.load(Ordering::SeqCst),
        move |call| start.lock().unwrap().push(format!("start {}", call.call_id)),
        move |call, result| {
            end.lock().unwrap().push(format!("end {} error={}", call.call_id, result.is_error));
            result
        },
    )
}

fn call(id: &str, tool: &str, arguments: Value) -> Value {
    json!({ "threadId": "thread-1", "turnId": "turn-1", "callId": id, "tool": tool, "namespace": null, "arguments": arguments })
}

#[test]
fn a_call_runs_and_answers_as_the_harness_expects() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let bridge = bridge(Arc::new(AtomicBool::new(false)), events.clone(), Arc::new(AtomicBool::new(false)));
    assert_eq!(bridge.specs()[0].name, "echo");
    let answer = bridge.call(&call("c1", "echo", json!({ "text": "hi" }))).unwrap();
    assert_eq!(answer, json!({ "success": true, "contentItems": [{ "type": "inputText", "text": "hi" }] }));
    let failed = bridge.call(&call("c2", "echo", json!({ "text": "explode" }))).unwrap();
    assert_eq!(failed, json!({ "success": false, "contentItems": [{ "type": "inputText", "text": "The tool failed." }] }));
    assert_eq!(*events.lock().unwrap(), ["start c1", "end c1 error=false", "start c2", "end c2 error=true"]);
}

#[test]
fn bad_calls_are_refused_before_anything_runs() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let aborted = Arc::new(AtomicBool::new(false));
    let bridge = bridge(aborted.clone(), events.clone(), Arc::new(AtomicBool::new(false)));
    assert_eq!(bridge.call(&json!("nope")), Err("Malformed Codex tool request".into()));
    assert_eq!(bridge.call(&json!({ "threadId": "thread-1" })), Err("Malformed Codex tool request".into()));
    let mut namespaced = call("c", "echo", json!({ "text": "x" }));
    namespaced["namespace"] = json!("mcp");
    assert_eq!(bridge.call(&namespaced), Err("Malformed Codex tool request".into()));
    let mut other_thread = call("c", "echo", json!({ "text": "x" }));
    other_thread["threadId"] = json!("thread-2");
    assert_eq!(bridge.call(&other_thread), Err("Tool call belongs to another Codex turn".into()));
    let mut other_turn = call("c", "echo", json!({ "text": "x" }));
    other_turn["turnId"] = json!("turn-2");
    assert_eq!(bridge.call(&other_turn), Err("Tool call belongs to another Codex turn".into()));
    assert_eq!(bridge.call(&call("c", "missing", json!({}))), Err("Unknown project tool: missing".into()));
    assert_eq!(bridge.call(&call("c", "echo", json!({ "text": 5 }))), Err("Invalid arguments for echo".into()));
    assert_eq!(bridge.call(&call("c", "echo", json!({ "text": "x", "extra": 1 }))), Err("Invalid arguments for echo".into()));
    aborted.store(true, Ordering::SeqCst);
    assert_eq!(bridge.call(&call("c", "echo", json!({ "text": "x" }))), Err("Codex turn was stopped".into()));
    assert!(events.lock().unwrap().is_empty(), "nothing ran");
}

#[test]
fn calls_never_overlap() {
    let overlap = Arc::new(AtomicBool::new(false));
    let bridge = Arc::new(bridge(Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new())), overlap.clone()));
    let threads: Vec<_> = (0..6)
        .map(|index| {
            let bridge = bridge.clone();
            std::thread::spawn(move || bridge.call(&call(&format!("c{index}"), "echo", json!({ "text": "x" }))).unwrap())
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert!(!overlap.load(Ordering::SeqCst));
}
