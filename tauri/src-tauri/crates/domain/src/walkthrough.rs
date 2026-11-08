//! Saved Walkthroughs of a Project's System design.
//!
//! `normalize_walkthroughs` ports `normalizeWalkthroughs` in
//! `src/shared/walkthrough.ts`, preserving the order in which problems are found.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js;

pub const ACTIONS: &[&str] = &["send", "receive", "process", "succeed", "fail"];
pub const NAME_LIMIT: usize = 80;
pub const TITLE_LIMIT: usize = 120;
pub const EXPLANATION_LIMIT: usize = 2000;
pub const OPERATION_LIMIT: usize = 40;
pub const EXAMPLE_MESSAGE_LIMIT: usize = 500;
pub const EXAMPLE_PAYLOAD_LIMIT: usize = 4000;
pub const DURATION_MIN_MS: f64 = 100.0;
pub const DURATION_MAX_MS: f64 = 10_000.0;
pub const TRAVEL_PERCENT_MIN: f64 = 10.0;
pub const TRAVEL_PERCENT_MAX: f64 = 90.0;
pub const LIMIT: usize = 50;
pub const STEP_LIMIT: usize = 200;
pub const BLOCK_LIMIT: usize = 50;
pub const NESTING_LIMIT: usize = 4;
pub const PARALLEL_BRANCH_MIN: usize = 2;
pub const PARALLEL_BRANCH_LIMIT: usize = 6;
pub const REPEAT_COUNT_MIN: f64 = 1.0;
pub const REPEAT_COUNT_MAX: f64 = 10.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepRoute {
    pub source_id: String,
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkthroughStep {
    pub id: String,
    pub connection_id: String,
    pub route: StepRoute,
    pub title: String,
    pub explanation: String,
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub travel_percent: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub example_payload: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WalkthroughBlock {
    Step { step: WalkthroughStep },
    Parallel { id: String, branches: Vec<Vec<WalkthroughBlock>> },
    Repeat { id: String, count: i64, body: Vec<WalkthroughBlock> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Walkthrough {
    pub id: String,
    pub name: String,
    pub blocks: Vec<WalkthroughBlock>,
}

type Result<T> = std::result::Result<T, String>;

pub fn normalize_walkthroughs(value: &Value) -> Result<Vec<Walkthrough>> {
    let Value::Array(items) = value else {
        return Err("The saved Walkthroughs are malformed.".into());
    };
    if items.len() > LIMIT {
        return Err(format!("A Project can have at most {LIMIT} Walkthroughs."));
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut entry_ids = HashSet::new();
    items
        .iter()
        .map(|item| {
            let item = js::record(item).ok_or("A saved Walkthrough is malformed.")?;
            let id = require_identity(item.get("id"), "Walkthrough id")?;
            if !ids.insert(id.clone()) {
                return Err(format!("Walkthrough \"{id}\" is duplicated."));
            }
            let name = require_name(item.get("name"), "Walkthrough name")?;
            if !names.insert(name.clone()) {
                return Err(format!("Walkthrough name \"{name}\" is duplicated."));
            }
            let blocks = match (item.get("blocks"), item.get("steps")) {
                (Some(Value::Array(blocks)), _) => normalize_blocks(blocks, &mut entry_ids)?,
                // A flat `steps` list from earlier saves becomes a sequence of step blocks.
                (_, Some(Value::Array(steps))) => steps
                    .iter()
                    .map(|step| Ok(WalkthroughBlock::Step { step: normalize_step(step, &mut entry_ids)? }))
                    .collect::<Result<Vec<_>>>()?,
                _ => return Err("A saved Walkthrough's steps are malformed.".into()),
            };
            checked(Walkthrough { id, name, blocks })
        })
        .collect()
}

fn normalize_blocks(items: &[Value], entry_ids: &mut HashSet<String>) -> Result<Vec<WalkthroughBlock>> {
    items
        .iter()
        .map(|item| {
            let item = js::record(item).ok_or("A saved Walkthrough block is malformed.")?;
            match item.get("kind").and_then(Value::as_str) {
                Some("step") => {
                    let Some(step) = item.get("step").filter(|step| step.is_object()) else {
                        return Err("A saved Walkthrough step is malformed.".into());
                    };
                    Ok(WalkthroughBlock::Step { step: normalize_step(step, entry_ids)? })
                }
                Some("parallel") => {
                    let id = require_new_entry_id(item.get("id"), "Block", entry_ids)?;
                    let branches = match item.get("branches") {
                        Some(Value::Array(branches)) if branches.iter().all(Value::is_array) => branches,
                        _ => return Err(format!("Block \"{id}\" has malformed branches.")),
                    };
                    if branches.len() < PARALLEL_BRANCH_MIN || branches.len() > PARALLEL_BRANCH_LIMIT {
                        return Err(format!(
                            "A parallel block must have from {PARALLEL_BRANCH_MIN} to {PARALLEL_BRANCH_LIMIT} branches."
                        ));
                    }
                    let branches = branches
                        .iter()
                        .map(|branch| normalize_blocks(branch.as_array().expect("checked above"), entry_ids))
                        .collect::<Result<Vec<_>>>()?;
                    Ok(WalkthroughBlock::Parallel { id, branches })
                }
                Some("repeat") => {
                    let id = require_new_entry_id(item.get("id"), "Block", entry_ids)?;
                    let Some(Value::Array(body)) = item.get("body") else {
                        return Err(format!("Block \"{id}\" has a malformed body."));
                    };
                    let count = require_repeat_count(item.get("count"))?;
                    Ok(WalkthroughBlock::Repeat { id, count, body: normalize_blocks(body, entry_ids)? })
                }
                _ => Err("A saved Walkthrough block is malformed.".into()),
            }
        })
        .collect()
}

fn normalize_step(step: &Value, entry_ids: &mut HashSet<String>) -> Result<WalkthroughStep> {
    let step = js::record(step).ok_or("A saved Walkthrough step is malformed.")?;
    let id = require_new_entry_id(step.get("id"), "Step", entry_ids)?;
    let Some(route) = step.get("route").and_then(js::record) else {
        return Err(format!("Step \"{id}\" has a malformed route."));
    };
    let route = StepRoute {
        source_id: require_identity(route.get("sourceId"), "Step route source")?,
        target_id: require_identity(route.get("targetId"), "Step route target")?,
    };
    let connection_id = require_identity(step.get("connectionId"), "Step connection")?;
    let title = require_text(step.get("title"), "Step title", TITLE_LIMIT)?;
    let explanation = require_text(step.get("explanation"), "Step explanation", EXPLANATION_LIMIT)?;
    let action = require_action(step.get("action"))?;
    let operation = optional_stored_text(step, "operation", OPERATION_LIMIT, "Step operation")?;
    let duration_ms = optional_stored_number(step.get("durationMs"), require_duration)?;
    let travel_percent = optional_stored_number(step.get("travelPercent"), require_travel_percent)?;
    let example_message = optional_stored_text(step, "exampleMessage", EXAMPLE_MESSAGE_LIMIT, "Example message")?;
    let example_payload = optional_stored_text(step, "examplePayload", EXAMPLE_PAYLOAD_LIMIT, "Example payload")?;
    Ok(WalkthroughStep {
        id,
        connection_id,
        route,
        title,
        explanation,
        action,
        operation,
        duration_ms,
        travel_percent,
        example_message,
        example_payload,
    })
}

fn require_new_entry_id(value: Option<&Value>, label: &str, entry_ids: &mut HashSet<String>) -> Result<String> {
    let id = require_identity(value, &format!("{label} id"))?;
    if !entry_ids.insert(id.clone()) {
        return Err(format!("{label} \"{id}\" is duplicated."));
    }
    Ok(id)
}

/// Checks the structural limits: step count, container count, and nesting depth.
fn checked(walkthrough: Walkthrough) -> Result<Walkthrough> {
    fn count(blocks: &[WalkthroughBlock], steps: &mut usize, containers: &mut usize) {
        for block in blocks {
            match block {
                WalkthroughBlock::Step { .. } => *steps += 1,
                WalkthroughBlock::Parallel { branches, .. } => {
                    *containers += 1;
                    branches.iter().for_each(|branch| count(branch, steps, containers));
                }
                WalkthroughBlock::Repeat { body, .. } => {
                    *containers += 1;
                    count(body, steps, containers);
                }
            }
        }
    }
    /// How many containers enclose the deepest step, counting the outermost as one.
    fn depth(blocks: &[WalkthroughBlock]) -> usize {
        blocks
            .iter()
            .map(|block| match block {
                WalkthroughBlock::Step { .. } => 0,
                WalkthroughBlock::Parallel { branches, .. } => 1 + branches.iter().map(|b| depth(b)).max().unwrap_or(0),
                WalkthroughBlock::Repeat { body, .. } => 1 + depth(body),
            })
            .max()
            .unwrap_or(0)
    }
    let (mut steps, mut containers) = (0, 0);
    count(&walkthrough.blocks, &mut steps, &mut containers);
    if steps > STEP_LIMIT {
        return Err(format!("A Walkthrough can have at most {STEP_LIMIT} steps."));
    }
    if containers > BLOCK_LIMIT {
        return Err(format!("A Walkthrough can have at most {BLOCK_LIMIT} parallel or repeated blocks."));
    }
    if depth(&walkthrough.blocks) > NESTING_LIMIT {
        return Err(format!("Parallel and repeated blocks can nest at most {NESTING_LIMIT} levels deep."));
    }
    Ok(walkthrough)
}

fn require_identity(value: Option<&Value>, label: &str) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(id) if !js::trim(id).is_empty() => Ok(id.to_owned()),
        _ => Err(format!("{label} is required.")),
    }
}

fn require_name(value: Option<&Value>, label: &str) -> Result<String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!("{label} is required."));
    };
    let trimmed = js::trim(text);
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }
    if js::length(trimmed) > NAME_LIMIT {
        return Err(format!("{label} must be {NAME_LIMIT} characters or fewer."));
    }
    Ok(trimmed.to_owned())
}

/// Authored text may be empty while a draft is incomplete, but never over its limit.
fn require_text(value: Option<&Value>, label: &str, limit: usize) -> Result<String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!("{label} must be text."));
    };
    let trimmed = js::trim(text);
    if js::length(trimmed) > limit {
        return Err(format!("{label} must be {limit} characters or fewer."));
    }
    Ok(trimmed.to_owned())
}

/// `optionalStoredText`: a missing field is absent, `null` is an error, empty text becomes absent.
fn optional_stored_text(step: &Map<String, Value>, key: &str, limit: usize, label: &str) -> Result<Option<String>> {
    let Some(value) = step.get(key) else { return Ok(None) };
    let text = require_text(Some(value), label, limit)?;
    Ok((!text.is_empty()).then_some(text))
}

fn require_action(value: Option<&Value>) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(action) if ACTIONS.contains(&action) => Ok(action.to_owned()),
        _ => Err(format!("Unsupported step action \"{}\".", value.map_or("undefined".into(), js::to_js_string))),
    }
}

fn optional_stored_number(value: Option<&Value>, require: fn(&Value) -> Result<i64>) -> Result<Option<i64>> {
    match value {
        None => Ok(None),
        Some(value) => require(value).map(Some),
    }
}

fn whole_number_in(value: &Value, min: f64, max: f64) -> Option<i64> {
    js::integer(value).filter(|n| *n >= min && *n <= max).map(|n| n as i64)
}

fn require_duration(value: &Value) -> Result<i64> {
    whole_number_in(value, DURATION_MIN_MS, DURATION_MAX_MS).ok_or_else(|| {
        format!("Step duration must be a whole number of milliseconds from {DURATION_MIN_MS} to {DURATION_MAX_MS}.")
    })
}

fn require_travel_percent(value: &Value) -> Result<i64> {
    whole_number_in(value, TRAVEL_PERCENT_MIN, TRAVEL_PERCENT_MAX).ok_or_else(|| {
        format!("Step travel share must be a whole percent from {TRAVEL_PERCENT_MIN} to {TRAVEL_PERCENT_MAX}.")
    })
}

fn require_repeat_count(value: Option<&Value>) -> Result<i64> {
    value
        .and_then(|value| whole_number_in(value, REPEAT_COUNT_MIN, REPEAT_COUNT_MAX))
        .ok_or_else(|| format!("A repeated block runs from {REPEAT_COUNT_MIN} to {REPEAT_COUNT_MAX} times."))
}
