//! The Codex app-server protocol (`src/bun/codex-app-server.ts`): newline-delimited JSON-RPC over
//! the stdio of a `codex app-server` process the app starts for itself. It never changes the
//! user's Codex configuration.
//!
//! The client is blocking and thread-based, like the rest of the backend: one reader thread routes
//! responses to the callers waiting for them, notifications to a handler, and requests the server
//! makes of us (tool calls, approvals) to handler threads whose answer is sent back.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

type Result<T> = std::result::Result<T, String>;

pub type NotificationHandler = Arc<dyn Fn(&str, &Value) + Send + Sync>;
/// Answers a request the server makes of us; the error text goes back as a JSON-RPC error.
pub type RequestHandler = Arc<dyn Fn(&str, &Value) -> Result<Value> + Send + Sync>;
pub type CloseHandler = Arc<dyn Fn(&str) + Send + Sync>;

/// GUI launchers may have a smaller PATH than an interactive shell.
pub fn find_codex_executable() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|dir| dir.join("codex")).find(|candidate| candidate.is_file()));
    if on_path.is_some() {
        return on_path;
    }
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    [
        home.join(".local/bin/codex"),
        home.join(".local/share/mise/command-wrappers/bin/codex"),
        home.join(".local/share/mise/shims/codex"),
        home.join(".cargo/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

type Pending = Arc<Mutex<HashMap<i64, Sender<Result<Value>>>>>;

/// JSON-RPC transport for one app-owned Codex process.
pub struct CodexClient {
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pending: Pending,
    next_id: AtomicI64,
    closed: Arc<AtomicBool>,
    on_close: CloseHandler,
}

impl CodexClient {
    /// Starts reading `reader` and writing to `writer`. Used by `start_codex_app_server` and by tests.
    pub fn connect(
        reader: impl std::io::Read + Send + 'static,
        writer: impl Write + Send + 'static,
        on_notification: NotificationHandler,
        on_request: RequestHandler,
        on_close: CloseHandler,
    ) -> Arc<Self> {
        let client = Arc::new(Self {
            writer: Arc::new(Mutex::new(Box::new(writer))),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicI64::new(0),
            closed: Arc::new(AtomicBool::new(false)),
            on_close,
        });
        let reading = client.clone();
        std::thread::spawn(move || {
            let mut lines = BufReader::new(reader).split(b'\n');
            while let Some(Ok(bytes)) = lines.next() {
                let line = String::from_utf8_lossy(&bytes);
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    reading.close("Invalid JSON from Codex app-server");
                    return;
                };
                if !message.is_object() {
                    reading.close("Invalid message from Codex app-server");
                    return;
                }
                reading.route(message, &on_notification, &on_request);
            }
            reading.close("Codex app-server exited");
        });
        client
    }

    fn route(self: &Arc<Self>, message: Value, on_notification: &NotificationHandler, on_request: &RequestHandler) {
        if let Some(method) = message["method"].as_str().map(str::to_owned) {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            match message.get("id") {
                None => on_notification(&method, &params),
                Some(id) => {
                    let (id, client, handler) = (id.clone(), self.clone(), on_request.clone());
                    std::thread::spawn(move || {
                        let reply = match handler(&method, &params) {
                            Ok(result) => json!({ "id": id, "result": result }),
                            Err(error) => json!({ "id": id, "error": { "code": -32603, "message": error } }),
                        };
                        if !client.closed.load(Ordering::SeqCst) {
                            let _ = client.send(&reply);
                        }
                    });
                }
            }
        } else if let Some(id) = message["id"].as_i64() {
            let Some(waiting) = self.pending.lock().expect("pending").remove(&id) else { return };
            let _ = waiting.send(match message.get("error") {
                Some(error) if !error.is_null() => Err(error["message"].as_str().unwrap_or("Codex request failed").to_owned()),
                _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            });
        }
    }

    fn send(&self, message: &Value) -> Result<()> {
        let mut writer = self.writer.lock().expect("writer");
        writer.write_all(format!("{message}\n").as_bytes()).and_then(|()| writer.flush()).map_err(|error| error.to_string())
    }

    /// A request and its id, so a caller can cancel it; `wait` blocks for the answer.
    pub fn request_tracked(&self, method: &str, params: Value) -> (i64, impl FnOnce() -> Result<Value>) {
        let (answer, answered) = mpsc::channel();
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let failure = if self.closed.load(Ordering::SeqCst) {
            Some("Codex app-server is closed".to_owned())
        } else {
            self.pending.lock().expect("pending").insert(id, answer.clone());
            self.send(&json!({ "id": id, "method": method, "params": params })).err().inspect(|_| {
                self.pending.lock().expect("pending").remove(&id);
            })
        };
        let timeout = Duration::from_secs(if method == "userVerification/verify" { 120 } else { 30 });
        let (method, pending) = (method.to_owned(), self.pending.clone());
        (id, move || {
            if let Some(error) = failure {
                return Err(error);
            }
            answered.recv_timeout(timeout).unwrap_or_else(|_| {
                pending.lock().expect("pending").remove(&id);
                Err(format!("Codex request {method} timed out"))
            })
        })
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value> {
        (self.request_tracked(method, params).1)()
    }

    pub fn notify(&self, method: &str, params: Option<Value>) -> Result<()> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Codex app-server is closed".into());
        }
        self.send(&json!({ "method": method, "params": params }))
    }

    pub fn initialize(&self) -> Result<()> {
        self.request(
            "initialize",
            json!({ "clientInfo": { "name": "schema_designer", "title": "Schema Designer", "version": "1.0.0" }, "capabilities": { "experimentalApi": true } }),
        )?;
        self.notify("initialized", None)
    }

    /// Fails everything waiting and tells the owner once.
    pub fn close(&self, reason: &str) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        for (_, waiting) in self.pending.lock().expect("pending").drain() {
            let _ = waiting.send(Err(reason.to_owned()));
        }
        (self.on_close)(reason);
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

/// A tool the Project offers a harness thread.
#[derive(Debug, Clone, PartialEq)]
pub struct DynamicTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Default)]
struct SessionState {
    thread_id: Option<String>,
    turn_id: Option<String>,
    configured_model: Option<String>,
    completion: Option<Sender<Result<()>>>,
}

/// Owns one app-scoped thread. Calls into the application stay on this connection.
pub struct CodexSession {
    client: Arc<CodexClient>,
    state: Mutex<SessionState>,
}

fn text_input(text: &str) -> Value {
    json!([{ "type": "text", "text": text, "text_elements": [] }])
}

impl CodexSession {
    pub fn new(client: Arc<CodexClient>) -> Arc<Self> {
        Arc::new(Self { client, state: Mutex::new(SessionState::default()) })
    }

    /// The thread, and the turn when one is running.
    pub fn target(&self) -> Option<(String, Option<String>)> {
        let state = self.state.lock().expect("session");
        state.thread_id.clone().map(|thread| (thread, state.turn_id.clone()))
    }

    pub fn default_model(&self) -> Option<String> {
        self.state.lock().expect("session").configured_model.clone()
    }

    pub fn start(&self, cwd: &str, instructions: &str, tools: &[DynamicTool], model: Option<&str>) -> Result<String> {
        if self.state.lock().expect("session").thread_id.is_some() {
            return Err("Codex thread already started".into());
        }
        let mut params = json!({
            "cwd": cwd,
            "developerInstructions": instructions,
            "dynamicTools": tools.iter().map(|tool| json!({ "type": "function", "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema })).collect::<Vec<_>>(),
        });
        if let Some(model) = model {
            params["model"] = json!(model);
        }
        let result = self.client.request("thread/start", params)?;
        let Some(thread_id) = result["thread"]["id"].as_str().map(str::to_owned) else { return Err("Codex did not return a thread ID".into()) };
        let mut state = self.state.lock().expect("session");
        state.thread_id = Some(thread_id.clone());
        state.configured_model = result["model"].as_str().map(str::to_owned);
        Ok(thread_id)
    }

    pub fn resume(&self, thread_id: &str, cwd: &str, instructions: &str, default_model: Option<&str>) -> Result<()> {
        if self.state.lock().expect("session").thread_id.is_some() {
            return Err("Codex thread already started".into());
        }
        let result = self.client.request("thread/resume", json!({ "threadId": thread_id, "cwd": cwd, "developerInstructions": instructions }))?;
        if result["thread"]["id"].as_str() != Some(thread_id) {
            return Err("Codex resumed an unexpected thread".into());
        }
        let mut state = self.state.lock().expect("session");
        state.thread_id = Some(thread_id.to_owned());
        state.configured_model = default_model.map(str::to_owned);
        Ok(())
    }

    /// Sends a message and waits until the turn ends. `Err` carries why a turn did not complete,
    /// including being stopped.
    pub fn send(&self, text: &str, model: Option<&str>, effort: Option<&str>) -> Result<()> {
        let (answer, completed) = mpsc::channel();
        let (thread_id, configured) = {
            let mut state = self.state.lock().expect("session");
            let Some(thread_id) = state.thread_id.clone() else { return Err("Codex thread has not started".into()) };
            if state.completion.is_some() {
                return Err("Codex turn already running".into());
            }
            // The process may exit before turn/start returns, so the completion is attached first.
            state.completion = Some(answer);
            (thread_id, state.configured_model.clone())
        };
        let outcome = (|| {
            let mut params = json!({ "threadId": thread_id, "input": text_input(text) });
            if let Some(model) = model.map(str::to_owned).or(configured) {
                params["model"] = json!(model);
            }
            if let Some(effort) = effort {
                params["effort"] = json!(effort);
            }
            let result = self.client.request("turn/start", params)?;
            let Some(turn_id) = result["turn"]["id"].as_str().map(str::to_owned) else { return Err("Codex did not return a turn ID".to_owned()) };
            self.state.lock().expect("session").turn_id = Some(turn_id);
            completed.recv().unwrap_or_else(|_| Err("Codex session closed".into()))
        })();
        let mut state = self.state.lock().expect("session");
        state.completion = None;
        state.turn_id = None;
        outcome
    }

    /// Routes `turn/completed` to the turn waiting for it; ignores everything else.
    pub fn accept_notification(&self, method: &str, params: &Value) {
        if method != "turn/completed" {
            return;
        }
        let mut state = self.state.lock().expect("session");
        if params["threadId"].as_str() != state.thread_id.as_deref() {
            return;
        }
        let Some(completion) = state.completion.as_ref() else { return };
        if state.turn_id.is_some() && params["turn"]["id"].as_str() != state.turn_id.as_deref() {
            return;
        }
        let status = params["turn"]["status"].as_str().unwrap_or("failed");
        let _ = completion.send(if status == "completed" {
            Ok(())
        } else {
            Err(params["turn"]["error"]["message"].as_str().map_or_else(|| format!("Codex turn {status}"), str::to_owned))
        });
    }

    pub fn interrupt(&self) -> Result<()> {
        let (thread_id, turn_id) = {
            let state = self.state.lock().expect("session");
            (state.thread_id.clone(), state.turn_id.clone())
        };
        match (thread_id, turn_id) {
            (Some(thread_id), Some(turn_id)) => self.client.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).map(|_| ()),
            _ => Ok(()),
        }
    }

    pub fn steer(&self, text: &str) -> Result<()> {
        let (thread_id, turn_id) = {
            let state = self.state.lock().expect("session");
            (state.thread_id.clone(), state.turn_id.clone())
        };
        let (Some(thread_id), Some(turn_id)) = (thread_id, turn_id) else { return Err("Codex turn is not ready for steering yet".into()) };
        self.client.request("turn/steer", json!({ "threadId": thread_id, "expectedTurnId": turn_id, "input": text_input(text) })).map(|_| ())
    }

    /// Ends a waiting turn because the connection is gone.
    pub fn close(&self, reason: &str) {
        if let Some(completion) = self.state.lock().expect("session").completion.as_ref() {
            let _ = completion.send(Err(reason.to_owned()));
        }
    }
}

impl crate::harness::HarnessSession for CodexSession {
    fn target(&self) -> Option<(String, Option<String>)> {
        CodexSession::target(self)
    }
    fn default_model(&self) -> Option<String> {
        CodexSession::default_model(self)
    }
    fn send(&self, text: &str, model: Option<&str>, effort: Option<&str>) -> Result<()> {
        CodexSession::send(self, text, model, effort)
    }
    fn interrupt(&self) -> Result<()> {
        CodexSession::interrupt(self)
    }
    fn steer(&self, text: &str) -> Result<()> {
        CodexSession::steer(self, text)
    }
    fn close(&self, reason: &str) {
        CodexSession::close(self, reason)
    }
    fn accept_notification(&self, method: &str, params: &Value) {
        CodexSession::accept_notification(self, method, params)
    }
}

/// A running app-server process and its client.
pub struct CodexProcess {
    pub client: Arc<CodexClient>,
    child: Arc<Mutex<Child>>,
}

impl CodexProcess {
    pub fn close(&self) {
        self.client.close("Codex session closed");
        let _ = self.child.lock().expect("child").kill();
    }
}

/// Starts a private stdio connection and initializes it.
pub fn start_codex_app_server(
    executable: Option<PathBuf>,
    args: &[&str],
    cwd: &str,
    on_notification: NotificationHandler,
    on_request: RequestHandler,
    on_close: CloseHandler,
) -> Result<CodexProcess> {
    let executable = executable.or_else(find_codex_executable).unwrap_or_else(|| PathBuf::from("codex"));
    let mut child = Command::new(&executable)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not start Codex: {error}"))?;
    let (stdin, stdout) = (child.stdin.take().ok_or("Codex has no input")?, child.stdout.take().ok_or("Codex has no output")?);
    let child = Arc::new(Mutex::new(child));
    let killer = child.clone();
    let on_close: CloseHandler = Arc::new(move |reason| {
        on_close(reason);
        let _ = killer.lock().expect("child").kill();
    });
    let client = CodexClient::connect(stdout, stdin, on_notification, on_request, on_close);
    // A server that never answers is given up on after 15 seconds.
    let watchdog = client.clone();
    let initialized = Arc::new(AtomicBool::new(false));
    let flag = initialized.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        if !flag.load(Ordering::SeqCst) {
            watchdog.close("Codex app-server did not initialize within 15 seconds");
        }
    });
    let outcome = client.initialize();
    initialized.store(true, Ordering::SeqCst);
    if let Err(error) = outcome {
        let _ = child.lock().expect("child").kill();
        return Err(error);
    }
    Ok(CodexProcess { client, child })
}
