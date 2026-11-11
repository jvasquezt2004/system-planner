//! `read_walkthroughs` and `edit_walkthroughs` (`src/bun/walkthrough-operations.ts` and the tools in
//! the original runtime): the Assistant reads the Walkthroughs with each step's status against the
//! System design, and edits them in batches that apply in full or not at all.

use std::sync::Arc;

use schema_domain::system_design::SystemDesign;
use schema_domain::system_ops::find_connection;
use schema_domain::walkthrough::{Walkthrough, WalkthroughBlock};
use schema_domain::walkthrough_ops::{self as ops, BlockInput, SequenceRef, StepDraft, StepInput, StepStatus, WalkthroughInput};
use serde_json::{json, Map, Value};

use crate::read_tools::{project_snapshot, ToolContext};
use crate::tools::{ProjectTool, ToolResult};

type Result<T> = std::result::Result<T, String>;

const WALKTHROUGH_ACTIONS: [&str; 5] = ["send", "receive", "process", "succeed", "fail"];
const OPERATIONS: [&str; 15] = [
    "create_walkthrough", "rename_walkthrough", "remove_walkthrough", "move_walkthrough", "add_step", "update_step", "move_step", "remove_step",
    "repair_step", "accept_redirection", "add_block", "add_parallel_branch", "update_repeat", "move_block", "remove_block",
];

/// A short, stable version of one item's content, so a reader can tell whether it changed.
pub fn item_version(item: &impl serde::Serialize) -> String {
    let text = serde_json::to_string(item).unwrap_or_default();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")[..12].to_owned()
}

fn describe_block(block: &WalkthroughBlock, design: &SystemDesign) -> Value {
    match block {
        WalkthroughBlock::Step { step } => {
            let mut described = Map::new();
            described.insert("kind".into(), json!("step"));
            if let Value::Object(fields) = json!(step) {
                described.extend(fields);
            }
            match ops::step_status(step, design) {
                StepStatus::Ok => described.insert("status".into(), json!("ok")),
                StepStatus::Dangling => described.insert("status".into(), json!("dangling")),
                StepStatus::Redirected { source_id, target_id } => {
                    described.insert("status".into(), json!("redirected"));
                    described.insert("currentRoute".into(), json!({ "sourceId": source_id, "targetId": target_id }))
                }
            };
            Value::Object(described)
        }
        WalkthroughBlock::Parallel { id, branches } => json!({ "kind": "parallel", "id": id, "branches": branches.iter().map(|branch| branch.iter().map(|item| describe_block(item, design)).collect::<Vec<_>>()).collect::<Vec<_>>() }),
        WalkthroughBlock::Repeat { id, count, body } => json!({ "kind": "repeat", "id": id, "count": count, "body": body.iter().map(|item| describe_block(item, design)).collect::<Vec<_>>() }),
    }
}

/// Every Walkthrough with its stable id and version, its blocks in order, and each step's status.
pub fn read_walkthroughs(walkthroughs: &[Walkthrough], design: &SystemDesign) -> Value {
    Value::Array(
        walkthroughs
            .iter()
            .map(|walkthrough| json!({ "id": walkthrough.id, "name": walkthrough.name, "version": item_version(walkthrough), "blocks": walkthrough.blocks.iter().map(|block| describe_block(block, design)).collect::<Vec<_>>() }))
            .collect(),
    )
}

/// Problems a designer would want fixed in the Walkthroughs. A step with a problem keeps its explanation.
pub fn walkthrough_diagnostics(walkthroughs: &[Walkthrough], design: &SystemDesign) -> Vec<String> {
    let mut notes = Vec::new();
    for walkthrough in walkthroughs {
        for step in ops::walkthrough_steps(walkthrough) {
            let place = format!("Walkthrough \"{}\" step \"{}\" ({})", walkthrough.name, step.title, step.id);
            match ops::step_status(step, design) {
                StepStatus::Dangling => notes.push(format!("{place} plays Connection {}, which no longer exists. Repair it with repair_step, or remove the step. Its explanation is kept.", step.connection_id)),
                StepStatus::Redirected { source_id, target_id } => notes.push(format!(
                    "{place} plays Connection {}, which now runs from {source_id} to {target_id} instead of {} to {}. Accept the route with accept_redirection, or repair the step. Playback waits for this review.",
                    step.connection_id, step.route.source_id, step.route.target_id
                )),
                StepStatus::Ok => {}
            }
        }
    }
    notes
}

fn require_string(value: &Value, label: &str) -> Result<String> {
    match value.as_str() {
        Some(text) if !schema_domain::js::trim(text).is_empty() => Ok(schema_domain::js::trim(text).to_owned()),
        _ => Err(format!("{label} is required.")),
    }
}

fn require_index(value: &Value) -> Result<f64> {
    match value.as_f64() {
        Some(number) if number.fract() == 0.0 && number >= 0.0 => Ok(number),
        _ => Err("toIndex must be a whole number, 0 or more.".into()),
    }
}

fn require_connection(design: &SystemDesign, value: &Value) -> Result<String> {
    let id = require_string(value, "connectionId")?;
    if find_connection(design, &id).is_none() {
        return Err(format!("connectionId \"{id}\" does not match a Connection in the System design. Read the System design and use one of its Connection ids, or add the Connection first."));
    }
    Ok(id)
}

fn draft_of(operation: &Value) -> Result<StepDraft> {
    let mut draft = Map::new();
    for key in ["title", "explanation", "action", "operation", "durationMs", "travelPercent", "exampleMessage", "examplePayload"] {
        if let Some(value) = operation.get(key) {
            draft.insert(key.into(), value.clone());
        }
    }
    serde_json::from_value(Value::Object(draft)).map_err(|error| error.to_string())
}

fn sequence_of(operation: &Value) -> Result<Option<SequenceRef>> {
    match operation.get("sequence").filter(|sequence| !sequence.is_null()) {
        None => Ok(None),
        Some(sequence) => serde_json::from_value(sequence.clone()).map(Some).map_err(|error| error.to_string()),
    }
}

fn apply_operation(walkthroughs: &[Walkthrough], operation: &Value, design: &SystemDesign) -> Result<Vec<Walkthrough>> {
    let id = |key: &str| require_string(&operation[key], key);
    match operation["op"].as_str().unwrap_or_default() {
        "create_walkthrough" => ops::add_walkthrough(walkthroughs, &WalkthroughInput { id: id("id")?, name: operation["name"].as_str().map(str::to_owned) }),
        "rename_walkthrough" => ops::rename_walkthrough(walkthroughs, &id("walkthroughId")?, &id("name")?),
        "remove_walkthrough" => ops::remove_walkthrough(walkthroughs, &id("walkthroughId")?),
        "move_walkthrough" => ops::move_walkthrough(walkthroughs, &id("walkthroughId")?, require_index(&operation["toIndex"])?),
        "add_step" => {
            let connection_id = require_connection(design, &operation["connectionId"])?;
            let input = StepInput { id: id("id")?, connection_id, sequence: sequence_of(operation)?, draft: draft_of(operation)? };
            ops::add_step(walkthroughs, &id("walkthroughId")?, &input, design)
        }
        "update_step" => {
            let changes = draft_of(operation)?;
            if ["title", "explanation", "action", "operation", "durationMs", "travelPercent", "exampleMessage", "examplePayload"].iter().all(|key| operation.get(*key).is_none()) {
                return Err("Give at least one step field to change.".into());
            }
            ops::update_step(walkthroughs, &id("walkthroughId")?, &id("stepId")?, &changes)
        }
        "move_step" => ops::move_step(walkthroughs, &id("walkthroughId")?, &id("stepId")?, require_index(&operation["toIndex"])?),
        "remove_step" => ops::remove_step(walkthroughs, &id("walkthroughId")?, &id("stepId")?),
        "repair_step" => ops::repair_step(walkthroughs, &id("walkthroughId")?, &id("stepId")?, &require_connection(design, &operation["connectionId"])?, design),
        "accept_redirection" => ops::accept_step_redirection(walkthroughs, &id("walkthroughId")?, &id("stepId")?, design),
        "add_block" => {
            let kind = operation["kind"].as_str().filter(|kind| *kind == "parallel" || *kind == "repeat").ok_or("kind must be \"parallel\" or \"repeat\".")?;
            ops::add_block(walkthroughs, &id("walkthroughId")?, &BlockInput { id: id("id")?, kind: kind.to_owned(), sequence: sequence_of(operation)? })
        }
        "add_parallel_branch" => ops::add_parallel_branch(walkthroughs, &id("walkthroughId")?, &id("blockId")?),
        "update_repeat" => ops::update_repeat(walkthroughs, &id("walkthroughId")?, &id("blockId")?, operation["count"].as_f64().unwrap_or(f64::NAN)),
        "move_block" => ops::move_block(walkthroughs, &id("walkthroughId")?, &id("blockId")?, require_index(&operation["toIndex"])?),
        "remove_block" => ops::remove_block(walkthroughs, &id("walkthroughId")?, &id("blockId")?),
        other => Err(format!("Unsupported operation \"{other}\".")),
    }
}

/// Validates a whole batch against the Walkthroughs and System design as they stand. Any invalid
/// operation fails the batch, and later operations see the effects of earlier ones.
pub fn plan_walkthrough_operations(current: &[Walkthrough], operations: &[Value], design: &SystemDesign) -> Result<Vec<Walkthrough>> {
    if operations.is_empty() {
        return Err("At least one Walkthrough operation is required.".into());
    }
    let mut next = current.to_vec();
    for (index, operation) in operations.iter().enumerate() {
        next = apply_operation(&next, operation, design).map_err(|error| format!("Operation {} ({}): {error}", index + 1, operation["op"].as_str().map_or_else(|| "undefined".to_owned(), str::to_owned)))?;
    }
    Ok(next)
}

/// Refuses a batch that edits a Walkthrough the Assistant read before that Walkthrough changed.
/// Unrelated manual edits to other Walkthroughs do not block it.
pub fn check_read_preconditions(read: Option<&[Walkthrough]>, current: &[Walkthrough], operations: &[Value]) -> Result<()> {
    let Some(read) = read else { return Ok(()) };
    let mut named: Vec<&str> = Vec::new();
    for id in operations.iter().filter_map(|operation| operation["walkthroughId"].as_str()) {
        if !named.contains(&id) {
            named.push(id);
        }
    }
    let changed: Vec<String> = named
        .iter()
        .filter_map(|id| {
            let before = read.iter().find(|walkthrough| walkthrough.id == *id)?;
            let now = current.iter().find(|walkthrough| walkthrough.id == *id);
            (serde_json::to_string(before).ok() != now.and_then(|now| serde_json::to_string(now).ok())).then(|| format!("Walkthrough \"{}\"", before.name))
        })
        .collect();
    if changed.is_empty() {
        Ok(())
    } else {
        Err(format!("These changed after you read the Walkthroughs: {}. Read the Walkthroughs again before editing them.", changed.join(", ")))
    }
}

pub struct ReadWalkthroughs(pub Arc<ToolContext>);

impl ProjectTool for ReadWalkthroughs {
    fn name(&self) -> &str {
        "read_walkthroughs"
    }

    fn description(&self) -> &str {
        "Read every named Walkthrough in the Project: its stable id and version, its blocks in order (sequences, parallel blocks with branches, repeat blocks with a count), and each step's Connection, explanation, action, timing, and status against the System design (ok, dangling, or redirected). Returns diagnostics for steps that need repair or review. Read before editing; a Walkthrough changed after your read is refused."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn execute(&self, _call_id: &str, _arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        let state = context.bound_state()?;
        let design = state.system_design.as_ref().ok_or("The System design is not loaded for this project.")?;
        context.reads.lock().map_err(|_| "Read state is unavailable.")?.walkthroughs = Some(state.walkthroughs.clone());
        let body = json!({
            "projectId": context.target.0, "designId": context.target.1, "revision": state.revision,
            "walkthroughs": read_walkthroughs(&state.walkthroughs, design), "diagnostics": walkthrough_diagnostics(&state.walkthroughs, design),
        });
        Ok(ToolResult { content: vec![body.to_string()], details: json!({ "projectId": context.target.0, "designId": context.target.1, "revision": state.revision }), is_error: false })
    }
}

pub struct EditWalkthroughs(pub Arc<ToolContext>);

fn string_property(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

impl ProjectTool for EditWalkthroughs {
    fn name(&self) -> &str {
        "edit_walkthroughs"
    }

    fn description(&self) -> &str {
        "Edit the Project's Walkthroughs in one batch: create, rename, move, or remove named Walkthroughs; add, update, move, remove, repair, or accept a redirected step that plays a System design Connection by connectionId; add parallel or repeat blocks, add branches, set repeat counts, move or remove blocks. A step's sequence can name a block id and branch. Give new Walkthroughs, steps, and blocks a new stable id and reuse it in later operations of the same batch. Each batch applies in full or not at all. Read the Walkthroughs before editing. Use sequential steps for ordered work, parallel blocks for work that runs together, and repeat blocks for a fixed number of attempts; a failed attempt and its retry are ordinary steps."
    }

    fn parameters(&self) -> Value {
        let nullable_number = |description: &str| json!({ "anyOf": [{ "type": "number" }, { "type": "null" }], "description": description });
        json!({
            "type": "object",
            "properties": { "operations": { "type": "array", "items": { "type": "object", "properties": {
                "op": { "enum": OPERATIONS },
                "id": string_property("New stable id for a create or add operation"),
                "walkthroughId": { "type": "string" }, "stepId": { "type": "string" }, "blockId": { "type": "string" }, "name": { "type": "string" },
                "toIndex": { "type": "number", "description": "Position within the same list, from 0" },
                "connectionId": string_property("A Connection id from read_system_design"),
                "kind": { "enum": ["parallel", "repeat"] },
                "count": { "type": "number", "description": "repeat blocks only: a whole number from 1 to 10" },
                "sequence": { "type": "object", "properties": {
                    "blockId": { "anyOf": [{ "type": "string" }, { "type": "null" }], "description": "Null for the top-level sequence; otherwise a repeat or parallel block id" },
                    "branch": { "type": "number", "description": "For a parallel block: the branch index, from 0" },
                }, "required": ["blockId"], "description": "Where add_step or add_block places new content" },
                "title": { "type": "string" }, "explanation": { "type": "string" },
                "action": { "enum": WALKTHROUGH_ACTIONS, "description": "send, receive, process, succeed, or fail" },
                "operation": string_property("Visual preset such as Cache hit; empty text clears it"),
                "durationMs": nullable_number("Illustrative duration in milliseconds, 100 to 10000; null clears it"),
                "travelPercent": nullable_number("Whole percent of the step spent travelling, 10 to 90; null clears it"),
                "exampleMessage": { "type": "string" }, "examplePayload": { "type": "string" },
            }, "required": ["op"] } } },
            "required": ["operations"],
        })
    }

    fn execute(&self, _call_id: &str, arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        let operations = arguments["operations"].as_array().ok_or("operations must be a list.")?;
        let state = context.bound_state()?;
        let design = state.system_design.as_ref().ok_or("The System design is not loaded for this project.")?;
        let read = context.reads.lock().map_err(|_| "Read state is unavailable.")?.walkthroughs.clone();
        check_read_preconditions(read.as_deref(), &state.walkthroughs, operations)?;
        let next = plan_walkthrough_operations(&state.walkthroughs, operations, design)?;
        let turn = (context.turn_id)();
        let after = context.workspace.replace_walkthroughs(&json!(next), turn.as_deref())?;
        let (project, design_id) = (after.project.as_ref().map(|project| project.id.as_str()), after.active_design_id.as_deref());
        if project != Some(context.target.0.as_str()) || design_id != Some(context.target.1.as_str()) {
            return Err("The project changed before the Walkthrough edit completed.".into());
        }
        let after_system = after.system_design.as_ref().unwrap_or(design);
        context.reads.lock().map_err(|_| "Read state is unavailable.")?.walkthroughs = Some(after.walkthroughs.clone());
        context.store.observe_project_snapshot(&context.conversation_id, &project_snapshot(&after), after.revision)?;
        let summary = json!({
            "status": "applied", "projectId": context.target.0, "designId": context.target.1, "operations": operations.len(),
            "walkthroughs": read_walkthroughs(&after.walkthroughs, after_system), "diagnostics": walkthrough_diagnostics(&after.walkthroughs, after_system),
        });
        Ok(ToolResult { content: vec![summary.to_string()], details: summary, is_error: false })
    }
}
