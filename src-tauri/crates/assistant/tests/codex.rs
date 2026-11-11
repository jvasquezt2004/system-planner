use std::sync::{Arc, Mutex};
use std::time::Duration;

use schema_assistant::codex::*;
use serde_json::{json, Value};

struct Harness {
    process: CodexProcess,
    session: Arc<CodexSession>,
    notifications: Arc<Mutex<Vec<(String, Value)>>>,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    closed: Arc<Mutex<Option<String>>>,
}

fn start(tool_answer: &'static str) -> Harness {
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let closed = Arc::new(Mutex::new(None));
    let session_slot: Arc<Mutex<Option<Arc<CodexSession>>>> = Arc::new(Mutex::new(None));
    let (seen, slot) = (notifications.clone(), session_slot.clone());
    let on_notification: NotificationHandler = Arc::new(move |method, params| {
        if let Some(session) = slot.lock().unwrap().as_ref() {
            session.accept_notification(method, params);
        }
        seen.lock().unwrap().push((method.to_owned(), params.clone()));
    });
    let asked = requests.clone();
    let on_request: RequestHandler = Arc::new(move |method, params| {
        asked.lock().unwrap().push((method.to_owned(), params.clone()));
        if method == "item/tool/call" {
            return Ok(json!({ "success": true, "contentItems": [{ "type": "inputText", "text": tool_answer }] }));
        }
        Err(format!("Unsupported Codex request: {method}"))
    });
    let (ended, slot) = (closed.clone(), session_slot.clone());
    let on_close: CloseHandler = Arc::new(move |reason| {
        *ended.lock().unwrap() = Some(reason.to_owned());
        if let Some(session) = slot.lock().unwrap().as_ref() {
            session.close(reason);
        }
    });
    let process = start_codex_app_server(Some(env!("CARGO_BIN_EXE_fake_codex").into()), &[], ".", on_notification, on_request, on_close).unwrap();
    let session = CodexSession::new(process.client.clone());
    *session_slot.lock().unwrap() = Some(session.clone());
    Harness { process, session, notifications, requests, closed }
}

fn tool() -> DynamicTool {
    DynamicTool { name: "read_project".into(), description: "Reads the Project".into(), input_schema: json!({ "type": "object", "properties": {} }) }
}

#[test]
fn a_thread_runs_a_turn_and_streams_its_message() {
    let harness = start("unused");
    let thread = harness.session.start("/tmp", "Be careful", &[tool()], None).unwrap();
    assert_eq!(thread, "thread-1");
    assert_eq!(harness.session.default_model().as_deref(), Some("fake-model"));
    harness.session.send("hello", None, Some("high")).unwrap();
    let seen = harness.notifications.lock().unwrap().iter().map(|(method, _)| method.clone()).collect::<Vec<_>>();
    assert_eq!(seen, ["item/started", "item/agentMessage/delta", "item/completed", "turn/completed"]);
    let completed = harness.notifications.lock().unwrap().iter().find(|(method, _)| method == "item/completed").unwrap().1.clone();
    assert_eq!(completed["item"]["text"], "Echo: hello");
    // The session can run another turn on the same thread.
    harness.session.send("again", None, None).unwrap();
    assert_eq!(harness.session.target(), Some(("thread-1".into(), None)));
    harness.process.close();
}

#[test]
fn the_server_can_call_a_project_tool_during_a_turn() {
    let harness = start("{\"tables\":2}");
    harness.session.start("/tmp", "x", &[tool()], None).unwrap();
    harness.session.send("use the tool", None, None).unwrap();
    let requests = harness.requests.lock().unwrap().clone();
    assert_eq!(requests[0].0, "item/tool/call");
    assert_eq!(requests[0].1["tool"], "read_project");
    let completed = harness.notifications.lock().unwrap().iter().filter(|(method, _)| method == "item/completed").last().unwrap().1.clone();
    assert_eq!(completed["item"]["text"], "Tool said: {\"tables\":2}");
    harness.process.close();
}

#[test]
fn a_turn_can_be_stopped() {
    let harness = start("unused");
    harness.session.start("/tmp", "x", &[], None).unwrap();
    let session = harness.session.clone();
    let waiting = std::thread::spawn(move || session.send("please hang", None, None));
    // Wait for the turn to be running, then interrupt it.
    for _ in 0..200 {
        if harness.session.target().is_some_and(|(_, turn)| turn.is_some()) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    harness.session.interrupt().unwrap();
    assert_eq!(waiting.join().unwrap(), Err("Codex turn interrupted".to_owned()));
    // Nothing is left running: a new turn is accepted.
    harness.session.send("after the stop", None, None).unwrap();
    harness.process.close();
}

#[test]
fn resuming_a_thread_checks_it_is_the_same_one() {
    let harness = start("unused");
    assert!(harness.session.resume("thread-1", "/tmp", "x", Some("saved-model")).is_ok());
    assert_eq!(harness.session.default_model().as_deref(), Some("saved-model"));
    assert!(harness.session.start("/tmp", "x", &[], None).is_err());
    harness.process.close();
    let other = start("unused");
    assert_eq!(other.session.resume("thread-9", "/tmp", "x", None), Err("Codex resumed an unexpected thread".to_owned()));
    other.process.close();
}

#[test]
fn a_dead_server_fails_the_waiting_call() {
    let harness = start("unused");
    harness.session.start("/tmp", "x", &[], None).unwrap();
    harness.process.close();
    assert!(harness.closed.lock().unwrap().is_some());
    assert_eq!(harness.session.send("anything", None, None), Err("Codex app-server is closed".to_owned()));
}

#[test]
fn starting_without_a_codex_executable_says_so() {
    let error = start_codex_app_server(Some("/definitely/not/codex".into()), &[], ".", Arc::new(|_, _| {}), Arc::new(|_, _| Ok(Value::Null)), Arc::new(|_| {})).err().unwrap();
    assert!(error.starts_with("Could not start Codex:"), "{error}");
}
