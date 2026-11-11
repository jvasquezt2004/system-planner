//! OpenCode as a harness (`src/bun/opencode-harness.ts`, `opencode-mcp.ts`).
//!
//! OpenCode runs as a private `opencode serve` on loopback. The Project tools reach it through a
//! small MCP server this module also runs, on loopback too, guarded by a random bearer token that
//! lives only as long as the harness. OpenCode's events are translated into the notifications Codex
//! sends, so the runtime shows both harnesses the same way.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::codex::{DynamicTool, NotificationHandler, RequestHandler};
use crate::harness::HarnessSession;
use crate::tools::ToolBridge;

type Result<T> = std::result::Result<T, String>;

/// The name OpenCode prefixes onto the Project tools it receives from the app's MCP server.
pub const OPENCODE_PROJECT_SERVER: &str = "schema-designer";

/// GUI launchers may have a smaller PATH than an interactive shell.
pub fn find_opencode_executable() -> Option<PathBuf> {
    let usable = |path: &PathBuf| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            path.metadata().is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        }
        #[cfg(not(unix))]
        {
            path.is_file()
        }
    };
    if let Some(found) = crate::platform::find_on_path("opencode").filter(|path| usable(path)) {
        return Some(found);
    }
    if cfg!(windows) {
        return None;
    }
    let home = crate::platform::home_dir();
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = &home {
        for relative in [".opencode/bin/opencode", ".local/bin/opencode", ".local/share/mise/shims/opencode", ".cargo/bin/opencode"] {
            candidates.push(home.join(relative));
        }
    }
    candidates.push("/usr/local/bin/opencode".into());
    candidates.push("/opt/homebrew/bin/opencode".into());
    candidates.into_iter().find(usable)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModelInfo {
    /// `providerID/modelID`: the id the Assistant stores and sends back.
    pub id: String,
    pub provider_id: String,
    pub model_id: String,
    pub name: String,
    /// OpenCode reasoning variants, such as `low` or `high`.
    pub variants: Vec<String>,
}

const KNOWN_LEVELS: [&str; 8] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/// OpenCode names "no reasoning" `none`; the Assistant calls it `off`.
pub fn variant_to_level(variant: &str) -> Option<String> {
    let level = if variant == "none" { "off" } else { variant };
    KNOWN_LEVELS.contains(&level).then(|| level.to_owned())
}

fn level_to_variant(level: Option<&str>, model: Option<&ModelInfo>) -> Option<String> {
    let (level, model) = (level?, model?);
    let wanted = if level == "off" { "none" } else { level };
    model.variants.iter().any(|variant| variant == wanted).then(|| wanted.to_owned())
}

/// The usable chat models in OpenCode's catalog.
pub fn parse_models(response: &Value) -> Vec<ModelInfo> {
    response["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| {
            (model["type"].is_null() || model["type"] == "chat")
                && model["enabled"] != false
                && (model["status"].is_null() || model["status"] == "active")
                && model["providerID"].is_string()
                && model["modelID"].is_string()
        })
        .map(|model| {
            let (provider, id) = (model["providerID"].as_str().unwrap_or_default(), model["modelID"].as_str().unwrap_or_default());
            ModelInfo {
                id: format!("{provider}/{id}"),
                provider_id: provider.to_owned(),
                model_id: id.to_owned(),
                name: model["name"].as_str().filter(|name| !name.is_empty()).unwrap_or(id).to_owned(),
                variants: model["variants"].as_array().map(|variants| variants.iter().map(|variant| variant["id"].as_str().map_or_else(|| variant["id"].to_string(), str::to_owned)).collect()).unwrap_or_default(),
            }
        })
        .collect()
}

/* ------------------------------------------------------------------ the server */

/// A private loopback `opencode serve`. Its config is passed by environment, never written to disk.
pub struct OpenCodeServer {
    base: String,
    authorization: String,
    agent: ureq::Agent,
    child: Arc<Mutex<Child>>,
    closed: Arc<AtomicBool>,
}

enum Startup {
    Listening(String),
    Exited(String),
}

impl OpenCodeServer {
    pub fn start(cwd: &str, executable: Option<PathBuf>, config: Option<&Value>, on_exit: Arc<dyn Fn(String) + Send + Sync>) -> Result<Arc<Self>> {
        let password = uuid::Uuid::new_v4().to_string();
        let executable = executable.or_else(find_opencode_executable).unwrap_or_else(|| PathBuf::from("opencode"));
        let mut command = Command::new(&executable);
        crate::platform::hide_console(&mut command);
        command.args(["serve", "--hostname", "127.0.0.1", "--port", "0"]).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).env("OPENCODE_SERVER_PASSWORD", &password);
        if let Some(config) = config {
            command.env("OPENCODE_CONFIG_CONTENT", config.to_string());
        }
        let mut child = command.spawn().map_err(|error| format!("Could not start OpenCode: {error}"))?;
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
        let child = Arc::new(Mutex::new(child));
        let closed = Arc::new(AtomicBool::new(false));
        let (startup, started) = mpsc::channel::<Startup>();
        // Both streams are drained for the life of the process; the first line that says where it listens is the answer.
        for stream in [stdout.map(|stream| Box::new(stream) as Box<dyn Read + Send>), stderr.map(|stream| Box::new(stream) as Box<dyn Read + Send>)].into_iter().flatten() {
            let startup = startup.clone();
            std::thread::spawn(move || {
                let (mut tail, mut announced) = (String::new(), false);
                let mut reader = BufReader::new(stream);
                let mut buffer = [0u8; 2048];
                while let Ok(read) = reader.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    if announced {
                        continue;
                    }
                    tail.push_str(&String::from_utf8_lossy(&buffer[..read]));
                    if tail.len() > 4000 {
                        tail = tail[tail.len() - 4000..].to_owned();
                    }
                    if let Some(found) = tail.find("listening on http://127.0.0.1:") {
                        let rest = &tail[found + "listening on ".len()..];
                        let url: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.' || *c == ':' || "htp/".contains(*c)).collect();
                        if url.rsplit(':').next().is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit())) {
                            announced = true;
                            let _ = startup.send(Startup::Listening(url));
                        }
                    }
                }
            });
        }
        let (watched, watcher_closed) = (child.clone(), closed.clone());
        let exit_startup = startup;
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(200));
            let status = watched.lock().expect("child").try_wait();
            match status {
                Ok(None) => continue,
                Ok(Some(status)) => {
                    let message = format!("OpenCode exited ({})", status.code().map_or_else(|| "signal".to_owned(), |code| code.to_string()));
                    let _ = exit_startup.send(Startup::Exited(message.clone()));
                    if !watcher_closed.load(Ordering::SeqCst) {
                        on_exit(message);
                    }
                    return;
                }
                Err(error) => {
                    let message = format!("Could not start OpenCode: {error}");
                    let _ = exit_startup.send(Startup::Exited(message.clone()));
                    if !watcher_closed.load(Ordering::SeqCst) {
                        on_exit(message);
                    }
                    return;
                }
            }
        });
        let base = match started.recv_timeout(Duration::from_secs(20)) {
            Ok(Startup::Listening(base)) => base,
            Ok(Startup::Exited(message)) => return Err(message),
            Err(_) => {
                let _ = child.lock().expect("child").kill();
                return Err("OpenCode did not start within 20 seconds".into());
            }
        };
        let agent: ureq::Agent = ureq::Agent::config_builder().http_status_as_error(false).build().into();
        Ok(Arc::new(Self { base, authorization: format!("Basic {}", base64_encode(format!("opencode:{password}").as_bytes())), agent, child, closed }))
    }

    pub fn request(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        let url = format!("{}{}", self.base, path);
        let failed = |error: ureq::Error| format!("OpenCode {method} {path} failed: {error}");
        let response = match (method, body) {
            ("GET", _) => self.agent.get(&url).header("authorization", &self.authorization).call(),
            ("DELETE", _) => self.agent.delete(&url).header("authorization", &self.authorization).call(),
            ("POST", Some(body)) => self.agent.post(&url).header("authorization", &self.authorization).header("content-type", "application/json").send(body.to_string()),
            ("POST", None) => self.agent.post(&url).header("authorization", &self.authorization).send_empty(),
            ("PUT", Some(body)) => self.agent.put(&url).header("authorization", &self.authorization).header("content-type", "application/json").send(body.to_string()),
            ("PUT", None) => self.agent.put(&url).header("authorization", &self.authorization).send_empty(),
            _ => return Err(format!("Unsupported method {method}")),
        };
        let mut response = response.map_err(failed)?;
        let status = response.status().as_u16();
        let text = response.body_mut().read_to_string().map_err(failed)?;
        if !(200..300).contains(&status) {
            let message = serde_json::from_str::<Value>(&text).ok().and_then(|value| value["message"].as_str().map(str::to_owned)).unwrap_or(text);
            return Err(format!("OpenCode {method} {path} failed ({status}): {message}"));
        }
        if text.is_empty() { Ok(Value::Null) } else { serde_json::from_str(&text).map_err(|error| format!("OpenCode {method} {path} answered something that is not JSON: {error}")) }
    }

    /// Streams OpenCode's events to `handle` until the stream ends, `handle` says stop or the server closes.
    pub fn events(&self, mut handle: impl FnMut(&str, &Value) -> bool) -> Result<()> {
        let mut response = self.agent.get(format!("{}/api/event", self.base)).header("authorization", &self.authorization).call().map_err(|error| format!("OpenCode event stream failed: {error}"))?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(format!("OpenCode event stream failed ({status})"));
        }
        let reader = BufReader::new(response.body_mut().as_reader());
        let mut data: Option<String> = None;
        for line in reader.lines() {
            let line = line.map_err(|error| format!("OpenCode event stream failed: {error}"))?;
            if line.is_empty() {
                if let Some(frame) = data.take() {
                    if let Ok(event) = serde_json::from_str::<Value>(&frame) {
                        if let Some(kind) = event["type"].as_str() {
                            let payload = if event["data"].is_null() { json!({}) } else { event["data"].clone() };
                            if !handle(kind, &payload) {
                                return Ok(());
                            }
                        }
                    }
                }
            } else if let Some(rest) = line.strip_prefix("data: ") {
                data.get_or_insert_with(String::new).push_str(rest);
            }
        }
        Ok(())
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = self.child.lock().expect("child").kill();
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (index, byte)| acc | (u32::from(*byte) << (16 - 8 * index)));
        for index in 0..4 {
            if index <= chunk.len() {
                out.push(ALPHABET[((n >> (18 - 6 * index)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/* ------------------------------------------------------------------ the Project tool server */

type ToolCallHandler = Arc<dyn Fn(&str, &Value) -> Result<Value> + Send + Sync>;

const SUPPORTED_PROTOCOLS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// A minimal MCP server (Streamable HTTP, JSON responses) that exposes the app's Project tools. It
/// listens on loopback only, requires a random bearer token, and lives only as long as the harness
/// that owns it, so the tools exist for no other client.
pub struct ProjectToolServer {
    pub url: String,
    closed: Arc<AtomicBool>,
    port: u16,
}

fn same_bytes(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

struct HttpRequest {
    method: String,
    authorization: String,
    body: Vec<u8>,
}

fn read_http_request(stream: &mut TcpStream) -> Option<HttpRequest> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line).ok()?;
    let method = request_line.split_whitespace().next()?.to_owned();
    let (mut authorization, mut length, mut chunked) = (String::new(), 0usize, false);
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':')?;
        match name.trim().to_ascii_lowercase().as_str() {
            "authorization" => authorization = value.trim().to_owned(),
            "content-length" => length = value.trim().parse().ok()?,
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).ok()?;
            let size = usize::from_str_radix(size_line.trim().split(';').next()?, 16).ok()?;
            if size == 0 {
                let mut trailer = String::new();
                let _ = reader.read_line(&mut trailer);
                break;
            }
            let mut chunk = vec![0u8; size];
            reader.read_exact(&mut chunk).ok()?;
            body.extend(chunk);
            let mut crlf = String::new();
            reader.read_line(&mut crlf).ok()?;
        }
    } else if length > 0 {
        if length > 16 * 1024 * 1024 {
            return None;
        }
        body = vec![0u8; length];
        reader.read_exact(&mut body).ok()?;
    }
    Some(HttpRequest { method, authorization, body })
}

fn respond(stream: &mut TcpStream, status: u16, reason: &str, extra_headers: &[(&str, &str)], body: Option<&Value>) {
    let payload = body.map(Value::to_string).unwrap_or_default();
    let mut head = format!("HTTP/1.1 {status} {reason}\r\nconnection: close\r\ncontent-length: {}\r\n", payload.len());
    if body.is_some() {
        head.push_str("content-type: application/json\r\n");
    }
    for (name, value) in extra_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(payload.as_bytes());
}

fn handle_mcp(request: HttpRequest, expected: &str, tools: &[DynamicTool], call: &ToolCallHandler, stream: &mut TcpStream) {
    if !same_bytes(request.authorization.as_bytes(), expected.as_bytes()) {
        let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 12\r\n\r\nUnauthorized");
        return;
    }
    if request.method != "POST" {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nallow: POST\r\nconnection: close\r\ncontent-length: 18\r\n\r\nMethod not allowed");
        return;
    }
    let message: Value = match serde_json::from_slice(&request.body) {
        Ok(message) => message,
        Err(_) => return respond(stream, 400, "Bad Request", &[], Some(&json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } }))),
    };
    if !message.is_object() {
        return respond(stream, 400, "Bad Request", &[], Some(&json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32600, "message": "Invalid request" } })));
    }
    // Notifications and client responses carry no id (or no method) and get no body.
    if message["id"].is_null() || !message["method"].is_string() {
        return respond(stream, 202, "Accepted", &[], None);
    }
    let id = message["id"].clone();
    let reply = |stream: &mut TcpStream, result: Value| respond(stream, 200, "OK", &[], Some(&json!({ "jsonrpc": "2.0", "id": id, "result": result })));
    let fail = |stream: &mut TcpStream, code: i64, text: String| respond(stream, 200, "OK", &[], Some(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": text } })));
    match message["method"].as_str().unwrap_or_default() {
        "initialize" => {
            let requested = message["params"]["protocolVersion"].as_str().unwrap_or_default();
            let version = if SUPPORTED_PROTOCOLS.contains(&requested) { requested } else { SUPPORTED_PROTOCOLS[0] };
            reply(stream, json!({ "protocolVersion": version, "capabilities": { "tools": { "listChanged": false } }, "serverInfo": { "name": "schema-designer", "version": "1.0.0" } }));
        }
        "ping" => reply(stream, json!({})),
        "tools/list" => reply(stream, json!({ "tools": tools.iter().map(|tool| json!({ "name": tool.name, "description": tool.description, "inputSchema": tool.input_schema })).collect::<Vec<_>>() })),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            if !tools.iter().any(|tool| tool.name == name) {
                return fail(stream, -32602, format!("Unknown tool: {}", if message["params"]["name"].is_null() { "undefined".to_owned() } else { message["params"]["name"].to_string() }));
            }
            let arguments = if message["params"]["arguments"].is_null() { json!({}) } else { message["params"]["arguments"].clone() };
            match call(name, &arguments) {
                Ok(result) => {
                    let content: Vec<Value> = result["contentItems"].as_array().into_iter().flatten().map(|item| json!({ "type": "text", "text": item["text"] })).collect();
                    reply(stream, json!({ "content": content, "isError": result["success"] != true }));
                }
                Err(error) => reply(stream, json!({ "content": [{ "type": "text", "text": error }], "isError": true })),
            }
        }
        other => fail(stream, -32601, format!("Method not found: {other}")),
    }
}

impl ProjectToolServer {
    pub fn start(token: &str, tools: Vec<DynamicTool>, call: ToolCallHandler) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("Could not start the Project tool server: {error}"))?;
        let port = listener.local_addr().map_err(|error| error.to_string())?.port();
        let closed = Arc::new(AtomicBool::new(false));
        let (flag, expected, tools) = (closed.clone(), format!("Bearer {token}"), Arc::new(tools));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                let (expected, tools, call) = (expected.clone(), tools.clone(), call.clone());
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
                    if let Some(request) = read_http_request(&mut stream) {
                        handle_mcp(request, &expected, &tools, &call, &mut stream);
                    }
                });
            }
        });
        Ok(Self { url: format!("http://127.0.0.1:{port}/mcp"), closed, port })
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Wakes the accept loop so it notices.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

/* ------------------------------------------------------------------ the session */

#[derive(Default)]
struct SessionState {
    session_id: Option<String>,
    turn_id: Option<String>,
    configured_model: Option<String>,
    applied_model: Option<(String, Option<String>)>,
    completion: Option<Sender<Result<()>>>,
    models: Vec<ModelInfo>,
}

pub struct OpenCodeSession {
    server: Arc<OpenCodeServer>,
    cwd: String,
    state: Mutex<SessionState>,
}

fn wait_for_project_tools(server: &OpenCodeServer) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(list) = server.request("GET", "/api/mcp", None) {
            if let Some(entry) = list["data"].as_array().and_then(|entries| entries.iter().find(|entry| entry["name"] == OPENCODE_PROJECT_SERVER)) {
                match entry["status"]["status"].as_str() {
                    Some("connected") => return Ok(()),
                    Some("failed") => return Err(format!("OpenCode could not reach the Project tools: {}", entry["status"]["error"].as_str().unwrap_or("connection failed"))),
                    _ => {}
                }
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("OpenCode did not connect to the Project tools in time".into())
}

fn default_model_id(server: &OpenCodeServer) -> Option<String> {
    let fallback = server.request("GET", "/api/model/default", None).ok()?;
    let (provider, model) = (fallback["data"]["providerID"].as_str()?, fallback["data"]["modelID"].as_str()?);
    Some(format!("{provider}/{model}"))
}

impl OpenCodeSession {
    pub fn new(server: Arc<OpenCodeServer>, cwd: &str) -> Arc<Self> {
        Arc::new(Self { server, cwd: cwd.to_owned(), state: Mutex::new(SessionState::default()) })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, SessionState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn id(&self) -> Option<String> {
        self.state().session_id.clone()
    }

    /// Opens a new OpenCode session, or resumes `thread_id`, once the Project tools are connected.
    pub fn start(&self, instructions: &str, tool_names: &[String], thread_id: Option<&str>, default_model: Option<&str>) -> Result<String> {
        // OpenCode connects MCP servers in the background; a prompt sent earlier would not see the Project tools.
        wait_for_project_tools(&self.server)?;
        let models = parse_models(&self.server.request("GET", "/api/model", None)?);
        self.state().models = models.clone();
        match thread_id {
            Some(thread) => {
                self.server.request("GET", &format!("/api/session/{}", encode(thread)), None)?;
                let mut state = self.state();
                state.session_id = Some(thread.to_owned());
                state.configured_model = default_model.map(str::to_owned);
            }
            None => {
                let default_id = default_model_id(&self.server);
                let model = default_id.as_ref().and_then(|id| models.iter().find(|model| &model.id == id));
                let mut body = json!({ "location": { "directory": self.cwd } });
                if let Some(model) = model {
                    body["model"] = json!({ "providerID": model.provider_id, "id": model.model_id });
                }
                let created = self.server.request("POST", "/api/session", Some(&body))?;
                let Some(id) = created["data"]["id"].as_str().map(str::to_owned) else { return Err("OpenCode did not return a session ID".into()) };
                let mut state = self.state();
                state.session_id = Some(id);
                state.configured_model = default_id;
                if let Some(model) = model {
                    state.applied_model = Some((model.id.clone(), None));
                }
            }
        }
        let session = self.id().expect("the session was just set");
        // Session-scoped instructions: other OpenCode sessions never see them.
        let names: Vec<String> = tool_names.iter().map(|name| format!("{OPENCODE_PROJECT_SERVER}_{name}")).collect();
        let value = format!(
            "{instructions}\n\nThe Project tools come from the \"{OPENCODE_PROJECT_SERVER}\" MCP server and are called directly as {OPENCODE_PROJECT_SERVER}_<tool> ({}). Call them by those exact names; do not search for them or wrap them in code.",
            names.join(", ")
        );
        self.server.request("PUT", &format!("/api/experimental/session/{session}/instructions/entries/{OPENCODE_PROJECT_SERVER}"), Some(&json!({ "value": value })))?;
        Ok(session)
    }

    pub fn models(&self) -> Vec<ModelInfo> {
        self.state().models.clone()
    }

    /// Called by the event loop when OpenCode reports the end of the running execution.
    pub fn finish(&self, outcome: &str, message: Option<&str>) {
        let state = self.state();
        let Some(completion) = state.completion.as_ref() else { return };
        let _ = completion.send(if outcome == "succeeded" { Ok(()) } else { Err(message.map_or_else(|| format!("OpenCode turn {outcome}"), str::to_owned)) });
    }
}

fn encode(segment: &str) -> String {
    segment.bytes().map(|byte| if byte.is_ascii_alphanumeric() || b"-_.~".contains(&byte) { (byte as char).to_string() } else { format!("%{byte:02X}") }).collect()
}

impl HarnessSession for OpenCodeSession {
    fn target(&self) -> Option<(String, Option<String>)> {
        let state = self.state();
        state.session_id.clone().map(|session| (session, state.turn_id.clone()))
    }

    fn default_model(&self) -> Option<String> {
        self.state().configured_model.clone()
    }

    fn send(&self, text: &str, model: Option<&str>, effort: Option<&str>) -> Result<()> {
        let (answer, completed) = mpsc::channel();
        let (session, chosen, models, applied) = {
            let mut state = self.state();
            let Some(session) = state.session_id.clone() else { return Err("OpenCode session has not started".into()) };
            if state.completion.is_some() {
                return Err("OpenCode turn already running".into());
            }
            state.completion = Some(answer);
            (session, model.map(str::to_owned).or_else(|| state.configured_model.clone()), state.models.clone(), state.applied_model.clone())
        };
        let outcome = (|| -> Result<()> {
            let info = chosen.as_ref().and_then(|chosen| models.iter().find(|model| &model.id == chosen));
            if let (Some(chosen), None) = (&chosen, info) {
                return Err(format!("OpenCode does not offer the model {chosen}. Pick another model."));
            }
            let variant = level_to_variant(effort, info);
            if let Some(info) = info {
                if applied.as_ref() != Some(&(info.id.clone(), variant.clone())) {
                    let mut model = json!({ "providerID": info.provider_id, "id": info.model_id });
                    if let Some(variant) = &variant {
                        model["variant"] = json!(variant);
                    }
                    self.server.request("POST", &format!("/api/session/{session}/model"), Some(&json!({ "model": model })))?;
                    self.state().applied_model = Some((info.id.clone(), variant));
                }
            }
            self.state().turn_id = Some(uuid::Uuid::new_v4().to_string());
            self.server.request("POST", &format!("/api/session/{session}/prompt"), Some(&json!({ "text": text })))?;
            completed.recv().unwrap_or_else(|_| Err("OpenCode session closed".into()))
        })();
        let mut state = self.state();
        state.completion = None;
        state.turn_id = None;
        outcome
    }

    fn interrupt(&self) -> Result<()> {
        let (session, turn) = {
            let state = self.state();
            (state.session_id.clone(), state.turn_id.clone())
        };
        match (session, turn) {
            (Some(session), Some(_)) => self.server.request("POST", &format!("/api/session/{session}/interrupt"), None).map(|_| ()),
            _ => Ok(()),
        }
    }

    fn steer(&self, text: &str) -> Result<()> {
        let (session, turn) = {
            let state = self.state();
            (state.session_id.clone(), state.turn_id.clone())
        };
        let (Some(session), Some(_)) = (session, turn) else { return Err("OpenCode turn is not ready for steering yet".into()) };
        self.server.request("POST", &format!("/api/session/{session}/prompt"), Some(&json!({ "text": text, "delivery": "steer" }))).map(|_| ())
    }

    fn close(&self, reason: &str) {
        if let Some(completion) = self.state().completion.as_ref() {
            let _ = completion.send(Err(reason.to_owned()));
        }
    }
}

/* ------------------------------------------------------------------ forms and permissions */

fn finite(value: &Value) -> Option<Value> {
    value.as_f64().filter(|number| number.is_finite()).map(|_| value.clone())
}

/// OpenCode form fields as the Assistant's form fields. Unknown field types are dropped.
pub fn form_fields_from_opencode(fields: &Value) -> Vec<Value> {
    const KNOWN: [&str; 6] = ["string", "number", "integer", "boolean", "multiselect", "external"];
    fields
        .as_array()
        .into_iter()
        .flatten()
        .filter(|field| field["key"].is_string() && field["type"].as_str().is_some_and(|kind| KNOWN.contains(&kind)))
        .map(|field| {
            let mut out = Map::new();
            out.insert("key".into(), field["key"].clone());
            out.insert("type".into(), field["type"].clone());
            for key in ["title", "description"] {
                if field[key].is_string() {
                    out.insert(key.into(), field[key].clone());
                }
            }
            out.insert("required".into(), json!(field["required"] == true));
            out.insert("hidden".into(), json!(field["hidden"] == true));
            if let Some(when) = field["when"].as_array() {
                let conditions: Vec<Value> = when.iter().filter(|condition| condition["key"].is_string() && (condition["op"] == "eq" || condition["op"] == "neq")).cloned().collect();
                out.insert("when".into(), json!(conditions));
            }
            if let Some(options) = field["options"].as_array() {
                let mapped: Vec<Value> = options
                    .iter()
                    .map(|option| {
                        let value = option["value"].as_str().map_or_else(|| option["value"].to_string(), str::to_owned);
                        let label = option["label"].as_str().map_or_else(|| value.clone(), str::to_owned);
                        let mut entry = json!({ "value": value, "label": label });
                        if option["description"].as_str().is_some_and(|text| !text.is_empty()) {
                            entry["description"] = json!(option["description"].as_str().unwrap_or_default());
                        }
                        entry
                    })
                    .collect();
                out.insert("options".into(), json!(mapped));
            }
            if field["custom"] == true {
                out.insert("custom".into(), json!(true));
            }
            if !field["default"].is_null() && !(field["default"].is_number() && finite(&field["default"]).is_none()) {
                out.insert("default".into(), field["default"].clone());
            }
            for key in ["minimum", "maximum"] {
                if let Some(number) = finite(&field[key]) {
                    out.insert(key.into(), number);
                }
            }
            if field["url"].is_string() {
                out.insert("url".into(), field["url"].clone());
            }
            Value::Object(out)
        })
        .collect()
}

/// Shows an OpenCode form in the app and sends the designer's answer back, or cancels the form.
pub fn handle_form(server: &OpenCodeServer, target: Option<(String, Option<String>)>, form: &Value, on_request: &RequestHandler) {
    let params = json!({
        "threadId": target.as_ref().map(|(thread, _)| thread),
        "turnId": target.as_ref().and_then(|(_, turn)| turn.clone()),
        "title": form["title"].as_str().unwrap_or("OpenCode needs your input"),
        "fields": form_fields_from_opencode(&form["fields"]),
    });
    let result = on_request("form/request", &params).unwrap_or_else(|_| json!({ "cancelled": true }));
    let (session, id) = (form["sessionID"].as_str().unwrap_or_default(), form["id"].as_str().unwrap_or_default());
    if result.get("answer").is_some() {
        let accepted = server.request("POST", &format!("/api/session/{session}/form/{id}/reply"), Some(&json!({ "answer": result["answer"] }))).is_ok();
        if accepted {
            return;
        }
    }
    let _ = server.request("DELETE", &format!("/api/session/{session}/form/{id}"), None);
}

fn handle_permission(server: &OpenCodeServer, target: Option<(String, Option<String>)>, request: &Value, on_request: &RequestHandler) {
    let resources: Vec<String> = request["resources"].as_array().map(|items| items.iter().map(|item| item.as_str().map_or_else(|| item.to_string(), str::to_owned)).collect()).unwrap_or_default();
    let action = request["action"].as_str().unwrap_or_default();
    let reason = request["message"].as_str().filter(|message| !message.is_empty()).map_or_else(|| format!("OpenCode wants permission for “{action}”."), str::to_owned);
    let params = json!({
        "threadId": target.as_ref().map(|(thread, _)| thread),
        "turnId": target.as_ref().and_then(|(_, turn)| turn.clone()),
        "itemId": request["source"]["id"],
        "harnessName": "OpenCode",
        "reason": reason,
        "command": format!("{action}{}", if resources.is_empty() { String::new() } else { format!(" {}", resources.join(" ")) }),
    });
    let decision = match on_request("item/commandExecution/requestApproval", &params) {
        Ok(response) if response["decision"] == "accept" => "once",
        _ => "reject",
    };
    let (session, id) = (request["sessionID"].as_str().unwrap_or_default(), request["id"].as_str().unwrap_or_default());
    let _ = server.request("POST", &format!("/api/session/{session}/permission/{id}/reply"), Some(&json!({ "decision": decision })));
}

/* ------------------------------------------------------------------ events */

/// Translates OpenCode's events into the notifications Codex would send.
fn run_events(server: Arc<OpenCodeServer>, session: Arc<OpenCodeSession>, closed: Arc<AtomicBool>, on_notification: NotificationHandler, on_request: RequestHandler, on_end: impl FnOnce() + Send + 'static) {
    let mut tool_names: std::collections::HashMap<String, String> = Default::default();
    let mut tool_items: std::collections::HashMap<String, Value> = Default::default();
    let prefix = format!("{OPENCODE_PROJECT_SERVER}_");
    let outcome = server.clone().events(|kind, data| {
        if closed.load(Ordering::SeqCst) {
            return false;
        }
        let session_id = session.id();
        if kind == "permission.asked" {
            if data["sessionID"].as_str() == session_id.as_deref() {
                let (server, target, request, on_request) = (server.clone(), session.target(), data.clone(), on_request.clone());
                std::thread::spawn(move || handle_permission(&server, target, &request, &on_request));
            }
            return true;
        }
        if kind == "form.created" {
            if data["form"]["sessionID"].as_str() == session_id.as_deref() {
                let (server, target, form, on_request) = (server.clone(), session.target(), data["form"].clone(), on_request.clone());
                std::thread::spawn(move || handle_form(&server, target, &form, &on_request));
            }
            return true;
        }
        if data["sessionID"].as_str() != session_id.as_deref() {
            return true;
        }
        let text_id = || format!("{}:{}", data["assistantMessageID"].as_str().unwrap_or_default(), if data["ordinal"].is_null() { "0".to_owned() } else { data["ordinal"].to_string() });
        let name_of = |id: &str, names: &std::collections::HashMap<String, String>| names.get(id).cloned().unwrap_or_else(|| {
            let trimmed = id.strip_prefix("functions.").unwrap_or(id);
            match trimmed.rsplit_once(':') {
                Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) => head.to_owned(),
                _ => trimmed.to_owned(),
            }
        });
        match kind {
            "session.text.started" => on_notification("item/started", &json!({ "item": { "id": text_id(), "type": "agentMessage" } })),
            "session.text.delta" => on_notification("item/agentMessage/delta", &json!({ "delta": data["delta"] })),
            "session.text.ended" => on_notification("item/completed", &json!({ "item": { "id": text_id(), "type": "agentMessage", "text": data["text"] } })),
            "session.tool.input.started" => {
                if let (Some(id), Some(name)) = (data["id"].as_str(), data["name"].as_str()) {
                    tool_names.insert(id.to_owned(), name.to_owned());
                }
            }
            "session.tool.called" => {
                let id = data["id"].as_str().unwrap_or_default();
                let name = name_of(id, &tool_names);
                // The Project tool bridge records these itself.
                if !name.starts_with(&prefix) {
                    let input = if data["input"].is_object() { data["input"].clone() } else { json!({}) };
                    let item = if name == "shell" || name == "bash" {
                        json!({ "id": id, "type": "commandExecution", "command": input["command"].as_str().unwrap_or_default(), "cwd": input["cwd"].as_str().or_else(|| input["workdir"].as_str()).unwrap_or_default() })
                    } else {
                        json!({ "id": id, "type": "mcpToolCall", "server": "opencode", "tool": name, "arguments": input })
                    };
                    tool_items.insert(id.to_owned(), item.clone());
                    on_notification("item/started", &json!({ "item": item }));
                }
            }
            "session.tool.success" | "session.tool.failed" => {
                let id = data["id"].as_str().unwrap_or_default();
                if let Some(mut item) = tool_items.remove(id) {
                    let output = data["content"].as_array().map(|parts| parts.iter().filter(|part| part["type"] == "text").map(|part| part["text"].as_str().unwrap_or_default().to_owned()).collect::<Vec<_>>().join("\n")).unwrap_or_default();
                    let failed = kind == "session.tool.failed";
                    item["status"] = json!(if failed { "failed" } else { "completed" });
                    item["aggregatedOutput"] = json!(output);
                    if failed {
                        item["error"] = if data["error"].is_null() { json!(true) } else { data["error"].clone() };
                    }
                    on_notification("item/completed", &json!({ "item": item }));
                }
            }
            "session.execution.succeeded" => session.finish("succeeded", None),
            "session.execution.failed" => session.finish("failed", data["error"]["message"].as_str()),
            "session.execution.interrupted" => session.finish("interrupted", Some("OpenCode turn interrupted")),
            _ => {}
        }
        true
    });
    if let Err(error) = outcome {
        if !closed.load(Ordering::SeqCst) {
            session.finish("failed", Some(&error));
        }
    }
    if !closed.load(Ordering::SeqCst) {
        on_end();
    }
}

/* ------------------------------------------------------------------ the harness */

pub struct OpenCodeHarness {
    pub session: Arc<OpenCodeSession>,
    server: Arc<OpenCodeServer>,
    tools: Arc<ProjectToolServer>,
    closed: Arc<AtomicBool>,
}

impl OpenCodeHarness {
    pub fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.session.close("OpenCode session closed");
        self.server.close();
        self.tools.close();
    }
}

pub struct StartOptions {
    pub cwd: String,
    pub executable: Option<PathBuf>,
    pub instructions: String,
    pub thread_id: Option<String>,
    pub default_model: Option<String>,
    pub bridge: Arc<ToolBridge>,
    pub on_notification: NotificationHandler,
    pub on_request: RequestHandler,
    /// Called once, when OpenCode goes away or its event stream ends, with the reason.
    pub on_close: Arc<dyn Fn(&str) + Send + Sync>,
}

/// Starts an app-owned OpenCode server with the Project tools reachable only through it.
pub fn start_harness(options: StartOptions) -> Result<Arc<OpenCodeHarness>> {
    let token = uuid::Uuid::new_v4().to_string();
    let session_slot: Arc<Mutex<Option<Arc<OpenCodeSession>>>> = Arc::new(Mutex::new(None));
    let (call_slot, bridge) = (session_slot.clone(), options.bridge.clone());
    let tools = Arc::new(ProjectToolServer::start(
        &token,
        bridge.specs(),
        Arc::new(move |name, arguments| {
            let target = call_slot.lock().ok().and_then(|slot| slot.clone()).and_then(|session| session.target());
            let Some((thread, Some(turn))) = target else { return Err("Project tools are only available during a turn".into()) };
            bridge.call(&json!({ "threadId": thread, "turnId": turn, "callId": uuid::Uuid::new_v4().to_string(), "tool": name, "namespace": null, "arguments": arguments }))
        }),
    )?);
    let closed = Arc::new(AtomicBool::new(false));
    let exit_slot: Arc<Mutex<Option<Arc<OpenCodeHarness>>>> = Arc::new(Mutex::new(None));
    let (exit_close, exit_handler, exit_closed) = (exit_slot.clone(), options.on_close.clone(), closed.clone());
    let config = json!({ "mcp": { "servers": { OPENCODE_PROJECT_SERVER: { "type": "remote", "url": tools.url, "headers": { "Authorization": format!("Bearer {token}") }, "oauth": false, "codemode": false } } } });
    let server = match OpenCodeServer::start(
        &options.cwd,
        options.executable.clone(),
        Some(&config),
        Arc::new(move |message| {
            if exit_closed.load(Ordering::SeqCst) {
                return;
            }
            if let Some(harness) = exit_close.lock().ok().and_then(|slot| slot.clone()) {
                harness.close();
            }
            exit_handler(&message);
        }),
    ) {
        Ok(server) => server,
        Err(error) => {
            tools.close();
            return Err(error);
        }
    };
    let session = OpenCodeSession::new(server.clone(), &options.cwd);
    *session_slot.lock().expect("session slot") = Some(session.clone());
    let harness = Arc::new(OpenCodeHarness { session: session.clone(), server: server.clone(), tools, closed: closed.clone() });
    *exit_slot.lock().expect("exit slot") = Some(harness.clone());
    let (event_harness, event_close) = (harness.clone(), options.on_close.clone());
    {
        let (server, session, closed) = (server.clone(), session.clone(), closed.clone());
        std::thread::spawn(move || {
            run_events(server, session, closed, options.on_notification, options.on_request, move || {
                event_harness.close();
                event_close("OpenCode event stream ended");
            })
        });
    }
    let names: Vec<String> = options.bridge.specs().into_iter().map(|tool| tool.name).collect();
    if let Err(error) = session.start(&options.instructions, &names, options.thread_id.as_deref(), options.default_model.as_deref()) {
        harness.close();
        return Err(error);
    }
    Ok(harness)
}

/// One-shot discovery of what the installed OpenCode can run, using a bare private server.
pub fn discover_models(executable: Option<PathBuf>) -> Result<(Vec<ModelInfo>, Option<String>)> {
    let home = crate::platform::home_or_current();
    let server = OpenCodeServer::start(&home, executable, None, Arc::new(|_| {}))?;
    let outcome = (|| {
        let models = parse_models(&server.request("GET", "/api/model", None)?);
        Ok((models, default_model_id(&server)))
    })();
    server.close();
    outcome
}
