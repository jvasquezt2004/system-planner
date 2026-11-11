//! The Project tools a harness calls (`CodexProjectTools` in the original): each call is checked
//! to belong to the running turn, its arguments are validated against the tool's schema, and calls
//! run one at a time so workspace operations and their revision checks never race each other.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::codex::DynamicTool;

type Result<T> = std::result::Result<T, String>;

/// What a tool returns: text for the harness and details for the transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub content: Vec<String>,
    pub details: Value,
    pub is_error: bool,
}

impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self { content: vec![text.into()], details: Value::Null, is_error: false }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self { content: vec![text.into()], details: Value::Null, is_error: true }
    }
}

pub trait ProjectTool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema of the arguments.
    fn parameters(&self) -> Value;
    fn execute(&self, call_id: &str, arguments: &Value) -> Result<ToolResult>;
}

/// One tool call as the harness sends it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub tool: String,
    pub arguments: Value,
}

pub struct ToolBridge {
    tools: HashMap<String, Arc<dyn ProjectTool>>,
    order: Vec<String>,
    queue: Mutex<()>,
    /// The thread and turn that may call tools right now.
    target: Box<dyn Fn() -> Option<(String, Option<String>)> + Send + Sync>,
    aborted: Box<dyn Fn() -> bool + Send + Sync>,
    on_start: Box<dyn Fn(&ToolCall) + Send + Sync>,
    on_end: Box<dyn Fn(&ToolCall, ToolResult) -> ToolResult + Send + Sync>,
}

impl ToolBridge {
    pub fn new(
        tools: Vec<Arc<dyn ProjectTool>>,
        target: impl Fn() -> Option<(String, Option<String>)> + Send + Sync + 'static,
        aborted: impl Fn() -> bool + Send + Sync + 'static,
        on_start: impl Fn(&ToolCall) + Send + Sync + 'static,
        on_end: impl Fn(&ToolCall, ToolResult) -> ToolResult + Send + Sync + 'static,
    ) -> Self {
        let order = tools.iter().map(|tool| tool.name().to_owned()).collect();
        Self {
            tools: tools.into_iter().map(|tool| (tool.name().to_owned(), tool)).collect(),
            order,
            queue: Mutex::new(()),
            target: Box::new(target),
            aborted: Box::new(aborted),
            on_start: Box::new(on_start),
            on_end: Box::new(on_end),
        }
    }

    pub fn specs(&self) -> Vec<DynamicTool> {
        self.order
            .iter()
            .map(|name| {
                let tool = &self.tools[name];
                DynamicTool { name: name.clone(), description: tool.description().to_owned(), input_schema: tool.parameters() }
            })
            .collect()
    }

    fn parse(params: &Value) -> Result<ToolCall> {
        let malformed = || "Malformed Codex tool request".to_owned();
        let object = params.as_object().ok_or_else(malformed)?;
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned).ok_or_else(malformed);
        // A namespace means a tool that is not ours.
        if object.get("namespace").is_some_and(|namespace| !namespace.is_null()) {
            return Err(malformed());
        }
        Ok(ToolCall { thread_id: text("threadId")?, turn_id: text("turnId")?, call_id: text("callId")?, tool: text("tool")?, arguments: object.get("arguments").cloned().unwrap_or(Value::Null) })
    }

    /// Runs a tool call from the harness and answers in the shape the harness expects.
    pub fn call(&self, params: &Value) -> Result<Value> {
        let call = Self::parse(params)?;
        // Workspace operations and their revision checks must not race each other.
        let _turn = self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if (self.aborted)() {
            return Err("Codex turn was stopped".into());
        }
        match (self.target)() {
            Some((thread, turn)) if thread == call.thread_id && turn.as_deref().is_none_or(|turn| turn == call.turn_id) => {}
            _ => return Err("Tool call belongs to another Codex turn".into()),
        }
        let Some(tool) = self.tools.get(&call.tool) else { return Err(format!("Unknown project tool: {}", call.tool)) };
        let valid = jsonschema::validator_for(&tool.parameters()).is_ok_and(|validator| validator.is_valid(&call.arguments));
        if !valid {
            return Err(format!("Invalid arguments for {}", call.tool));
        }
        (self.on_start)(&call);
        let result = tool.execute(&call.call_id, &call.arguments).unwrap_or_else(ToolResult::error);
        let result = (self.on_end)(&call, result);
        Ok(json!({
            "success": !result.is_error,
            "contentItems": result.content.iter().map(|text| json!({ "type": "inputText", "text": text })).collect::<Vec<_>>(),
        }))
    }
}
