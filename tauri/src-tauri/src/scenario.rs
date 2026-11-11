//! Scenario runs for the Assistant: the Scenario's code runs in the view, so the backend asks the
//! view to run it (`assistantScenarioRunRequest`) and waits for it to report
//! (`assistantScenarioRunCompleted`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use schema_assistant::scenario_tools::ScenarioRunner;
use serde_json::{json, Value};

type Answer = Result<Option<Value>, String>;

pub struct ViewScenarioRunner {
    push: Arc<dyn Fn(Value) + Send + Sync>,
    pending: Mutex<HashMap<String, Sender<Answer>>>,
    next: AtomicU64,
}

impl ViewScenarioRunner {
    pub fn new(push: Arc<dyn Fn(Value) + Send + Sync>) -> Self {
        Self { push, pending: Mutex::new(HashMap::new()), next: AtomicU64::new(1) }
    }

    /// The view reported a run (or an error) for a request.
    pub fn completed(&self, request_id: &str, run: Value, error: Option<String>) {
        let sender = self.pending.lock().expect("pending runs").remove(request_id);
        if let Some(sender) = sender {
            let _ = sender.send(match error.filter(|error| !error.is_empty()) {
                Some(error) => Err(error),
                None if run.is_null() => Ok(None),
                None => Ok(Some(run)),
            });
        }
    }

    fn cancel(&self, request_id: &str) {
        self.pending.lock().expect("pending runs").remove(request_id);
        (self.push)(json!({ "method": "assistantScenarioRunCancel", "payload": { "requestId": request_id } }));
    }
}

impl ScenarioRunner for ViewScenarioRunner {
    fn run(&self, project_id: &str, design_id: &str, scenario: &Value, aborted: &dyn Fn() -> bool, timeout: Duration) -> Answer {
        let request_id = format!("scenario-run-{}", self.next.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().expect("pending runs").insert(request_id.clone(), sender);
        (self.push)(json!({ "method": "assistantScenarioRunRequest", "payload": { "requestId": request_id, "projectId": project_id, "designId": design_id, "scenario": scenario } }));
        let deadline = Instant::now() + timeout;
        loop {
            if aborted() {
                self.cancel(&request_id);
                return Err("The Assistant turn stopped the Scenario run.".into());
            }
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(answer) => return answer,
                Err(RecvTimeoutError::Timeout) if Instant::now() >= deadline => {
                    self.cancel(&request_id);
                    return Err("The view did not report the Scenario run result in time.".into());
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err("The view did not report the Scenario run result in time.".into()),
            }
        }
    }
}
