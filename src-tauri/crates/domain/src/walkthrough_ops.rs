//! Editing operations on Walkthroughs, ported from the pure functions in
//! `src/shared/walkthrough.ts`.
//!
//! A Walkthrough is a tree: sequences of blocks, where a block is a step, a
//! parallel block with several branches, or a repeat block with one body. The
//! tree edits below mirror the originals, including which problem is reported
//! first when several apply.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::patch::Patch;
use crate::system_design::SystemDesign;
use crate::system_ops::find_connection;
use crate::walkthrough::*;

type Result<T> = std::result::Result<T, String>;
type Blocks = Vec<WalkthroughBlock>;

pub const DEFAULT_ACTION: &str = "send";
pub const REPEAT_COUNT_DEFAULT: i64 = 2;

/* ------------------------------------------------------------------ inputs */

/// Where new content goes: the top-level sequence (`blockId` null), the body of a
/// repeat block, or one branch of a parallel block.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SequenceRef {
    pub block_id: Option<String>,
    #[serde(default)]
    pub branch: Patch<f64>,
}

impl SequenceRef {
    fn root() -> Self {
        Self { block_id: None, branch: Patch::Absent }
    }
}

/// Fields a designer may set on a step. Empty text clears an optional field; null clears the duration.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDraft {
    pub title: Option<String>,
    pub explanation: Option<String>,
    pub action: Option<String>,
    pub operation: Option<String>,
    #[serde(default)]
    pub duration_ms: Patch<f64>,
    #[serde(default)]
    pub travel_percent: Patch<f64>,
    pub example_message: Option<String>,
    pub example_payload: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInput {
    pub id: String,
    pub connection_id: String,
    pub sequence: Option<SequenceRef>,
    #[serde(flatten)]
    pub draft: StepDraft,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockInput {
    pub id: String,
    /// `parallel` or `repeat`.
    pub kind: String,
    pub sequence: Option<SequenceRef>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WalkthroughInput {
    pub id: String,
    pub name: Option<String>,
}

/* ------------------------------------------------------- derived read-outs */

/// A step, in any Walkthrough, that plays a Connection a pending removal would delete.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedStep {
    pub walkthrough_id: String,
    pub walkthrough_name: String,
    pub step_id: String,
    pub title: String,
    pub connection_id: String,
}

/// Compares a step's stored reference with the System design as it is now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum StepStatus {
    Ok,
    Dangling,
    #[serde(rename_all = "camelCase")]
    Redirected { source_id: String, target_id: String },
}

pub fn step_status(step: &WalkthroughStep, design: &SystemDesign) -> StepStatus {
    let Some(connection) = find_connection(design, &step.connection_id) else { return StepStatus::Dangling };
    if connection.source_id != step.route.source_id || connection.target_id != step.route.target_id {
        return StepStatus::Redirected { source_id: connection.source_id.clone(), target_id: connection.target_id.clone() };
    }
    StepStatus::Ok
}

/* ------------------------------------------------------------- tree helpers */

fn entry_id(block: &WalkthroughBlock) -> &str {
    match block {
        WalkthroughBlock::Step { step } => &step.id,
        WalkthroughBlock::Parallel { id, .. } | WalkthroughBlock::Repeat { id, .. } => id,
    }
}

/// The sequences a container holds: a parallel block's branches, or a repeat block's body.
fn child_sequences(block: &WalkthroughBlock) -> Vec<&[WalkthroughBlock]> {
    match block {
        WalkthroughBlock::Step { .. } => vec![],
        WalkthroughBlock::Parallel { branches, .. } => branches.iter().map(Vec::as_slice).collect(),
        WalkthroughBlock::Repeat { body, .. } => vec![body.as_slice()],
    }
}

fn with_child_sequences(block: &WalkthroughBlock, mut sequences: Vec<Blocks>) -> WalkthroughBlock {
    match block {
        WalkthroughBlock::Step { .. } => block.clone(),
        WalkthroughBlock::Parallel { id, .. } => WalkthroughBlock::Parallel { id: id.clone(), branches: sequences },
        WalkthroughBlock::Repeat { id, count, .. } => {
            WalkthroughBlock::Repeat { id: id.clone(), count: *count, body: sequences.swap_remove(0) }
        }
    }
}

/// A block and, recursively, every block it contains, in authoring order.
fn all_blocks(blocks: &[WalkthroughBlock]) -> Vec<&WalkthroughBlock> {
    blocks
        .iter()
        .flat_map(|block| {
            let mut found = vec![block];
            for sequence in child_sequences(block) {
                found.extend(all_blocks(sequence));
            }
            found
        })
        .collect()
}

fn steps_in(blocks: &[WalkthroughBlock]) -> Vec<&WalkthroughStep> {
    all_blocks(blocks)
        .into_iter()
        .filter_map(|block| match block {
            WalkthroughBlock::Step { step } => Some(step),
            _ => None,
        })
        .collect()
}

/// Every authored step of a Walkthrough, in authoring order.
pub fn walkthrough_steps(walkthrough: &Walkthrough) -> Vec<&WalkthroughStep> {
    steps_in(&walkthrough.blocks)
}

fn all_entry_ids(walkthroughs: &[Walkthrough]) -> HashSet<&str> {
    walkthroughs.iter().flat_map(|walkthrough| all_blocks(&walkthrough.blocks)).map(entry_id).collect()
}

pub fn find_walkthrough<'a>(walkthroughs: &'a [Walkthrough], id: &str) -> Option<&'a Walkthrough> {
    walkthroughs.iter().find(|walkthrough| walkthrough.id == id)
}

fn find_container<'a>(walkthrough: &'a Walkthrough, block_id: &str) -> Option<&'a WalkthroughBlock> {
    all_blocks(&walkthrough.blocks).into_iter().find(|block| !matches!(block, WalkthroughBlock::Step { .. }) && entry_id(block) == block_id)
}

/// `"parallel"` or `"repeat"` for the container with this id, if the Walkthrough has one.
pub fn find_container_kind(walkthrough: &Walkthrough, block_id: &str) -> Option<&'static str> {
    find_container(walkthrough, block_id).map(|block| match block {
        WalkthroughBlock::Parallel { .. } => "parallel",
        WalkthroughBlock::Repeat { .. } => "repeat",
        WalkthroughBlock::Step { .. } => "step",
    })
}

fn replace_at<T: Clone>(items: &[T], index: usize, item: T) -> Vec<T> {
    items.iter().enumerate().map(|(at, current)| if at == index { item.clone() } else { current.clone() }).collect()
}

/// Applies `change` to the first sequence, searching the top level and then every
/// nested one, that accepts it (`Ok(Some)`). `Ok(None)` means no sequence did.
fn edit_sequence(blocks: &[WalkthroughBlock], change: &dyn Fn(&[WalkthroughBlock]) -> Result<Option<Blocks>>) -> Result<Option<Blocks>> {
    if let Some(direct) = change(blocks)? {
        return Ok(Some(direct));
    }
    for (index, block) in blocks.iter().enumerate() {
        let sequences = child_sequences(block);
        for (position, sequence) in sequences.iter().enumerate() {
            if let Some(edited) = edit_sequence(sequence, change)? {
                let next: Vec<Blocks> =
                    sequences.iter().enumerate().map(|(at, current)| if at == position { edited.clone() } else { current.to_vec() }).collect();
                return Ok(Some(replace_at(blocks, index, with_child_sequences(block, next))));
            }
        }
    }
    Ok(None)
}

fn edit_container(
    blocks: &[WalkthroughBlock],
    block_id: &str,
    change: &dyn Fn(&WalkthroughBlock) -> Result<WalkthroughBlock>,
) -> Result<Option<Blocks>> {
    edit_sequence(blocks, &|sequence| {
        let Some(index) = sequence.iter().position(|block| !matches!(block, WalkthroughBlock::Step { .. }) && entry_id(block) == block_id) else {
            return Ok(None);
        };
        Ok(Some(replace_at(sequence, index, change(&sequence[index])?)))
    })
}

fn edit_step(blocks: &[WalkthroughBlock], step_id: &str, change: &dyn Fn(&WalkthroughStep) -> Result<WalkthroughStep>) -> Result<Option<Blocks>> {
    edit_sequence(blocks, &|sequence| {
        let Some(index) = sequence.iter().position(|block| matches!(block, WalkthroughBlock::Step { step } if step.id == step_id)) else {
            return Ok(None);
        };
        let WalkthroughBlock::Step { step } = &sequence[index] else { unreachable!("matched a step") };
        Ok(Some(replace_at(sequence, index, WalkthroughBlock::Step { step: change(step)? })))
    })
}

fn remove_entry(blocks: &[WalkthroughBlock], id: &str) -> Result<Option<Blocks>> {
    edit_sequence(blocks, &|sequence| {
        let next: Blocks = sequence.iter().filter(|block| entry_id(block) != id).cloned().collect();
        Ok((next.len() != sequence.len()).then_some(next))
    })
}

fn move_by_id<T: Clone>(items: &[T], id: &str, to_index: f64, label: &str, id_of: impl Fn(&T) -> &str) -> Result<Vec<T>> {
    if to_index.fract() != 0.0 || to_index < 0.0 || to_index >= items.len() as f64 {
        return Err(format!("{label} position must be between 0 and {}.", items.len() as i64 - 1));
    }
    let Some(from) = items.iter().position(|item| id_of(item) == id) else {
        return Err(format!("That {} could not be found.", label.to_lowercase()));
    };
    let moving = items[from].clone();
    let rest: Vec<T> = items.iter().filter(|item| id_of(item) != id).cloned().collect();
    let to = to_index as usize;
    Ok(rest[..to].iter().cloned().chain(std::iter::once(moving)).chain(rest[to..].iter().cloned()).collect())
}

fn move_within_sequence(blocks: &[WalkthroughBlock], id: &str, to_index: f64, label: &str) -> Result<Blocks> {
    let moved = edit_sequence(blocks, &|sequence| {
        if !sequence.iter().any(|block| entry_id(block) == id) {
            return Ok(None);
        }
        move_by_id(sequence, id, to_index, label, |block| entry_id(block)).map(Some)
    })?;
    require_edited(moved, &format!("That {} could not be found.", label.to_lowercase()))
}

fn append_to_sequence(blocks: &[WalkthroughBlock], at: &SequenceRef, block: WalkthroughBlock) -> Result<Blocks> {
    let Some(block_id) = &at.block_id else {
        return Ok(blocks.iter().cloned().chain(std::iter::once(block)).collect());
    };
    let edited = edit_container(blocks, block_id, &|container| match container {
        WalkthroughBlock::Parallel { id, branches } => {
            let branch = at.branch.value().copied().filter(|branch| branch.fract() == 0.0 && *branch >= 0.0 && *branch < branches.len() as f64);
            let Some(branch) = branch else {
                return Err("Choose a branch of the parallel block for this step.".into());
            };
            let branches = branches
                .iter()
                .enumerate()
                .map(|(position, existing)| if position == branch as usize { existing.iter().cloned().chain(std::iter::once(block.clone())).collect() } else { existing.clone() })
                .collect();
            Ok(WalkthroughBlock::Parallel { id: id.clone(), branches })
        }
        WalkthroughBlock::Repeat { id, count, body } => {
            if !at.branch.is_absent() {
                return Err("A repeated block has one body, not branches.".into());
            }
            Ok(WalkthroughBlock::Repeat { id: id.clone(), count: *count, body: body.iter().cloned().chain(std::iter::once(block.clone())).collect() })
        }
        WalkthroughBlock::Step { .. } => Ok(container.clone()),
    })?;
    require_edited(edited, "Choose a parallel or repeated block to add to.")
}

fn require_edited(blocks: Option<Blocks>, message: &str) -> Result<Blocks> {
    blocks.ok_or_else(|| message.to_owned())
}

/* ------------------------------------------------------------ requirements */

fn replace_walkthrough(walkthroughs: &[Walkthrough], next: Walkthrough) -> Vec<Walkthrough> {
    walkthroughs.iter().map(|walkthrough| if walkthrough.id == next.id { next.clone() } else { walkthrough.clone() }).collect()
}

fn require_walkthrough<'a>(walkthroughs: &'a [Walkthrough], id: &str) -> Result<&'a Walkthrough> {
    find_walkthrough(walkthroughs, id).ok_or_else(|| "That Walkthrough could not be found.".into())
}

fn require_step<'a>(walkthrough: &'a Walkthrough, step_id: &str) -> Result<&'a WalkthroughStep> {
    walkthrough_steps(walkthrough).into_iter().find(|step| step.id == step_id).ok_or_else(|| "That step could not be found.".into())
}

fn require_unique_name(walkthroughs: &[Walkthrough], name: &str, except_id: Option<&str>) -> Result<()> {
    if walkthroughs.iter().any(|walkthrough| Some(walkthrough.id.as_str()) != except_id && walkthrough.name == name) {
        return Err(format!("A Walkthrough named “{name}” already exists."));
    }
    Ok(())
}

fn default_walkthrough_name(walkthroughs: &[Walkthrough]) -> String {
    let names: HashSet<&str> = walkthroughs.iter().map(|walkthrough| walkthrough.name.as_str()).collect();
    if !names.contains("Walkthrough") {
        return "Walkthrough".into();
    }
    (2..).map(|index| format!("Walkthrough {index}")).find(|candidate| !names.contains(candidate.as_str())).expect("unbounded")
}

fn identity(id: &str, label: &str) -> Result<()> {
    require_identity(Some(&Value::String(id.to_owned())), label).map(|_| ())
}

fn number_value(number: f64) -> Value {
    serde_json::Number::from_f64(number).map_or(Value::Null, Value::Number)
}

/// `applyStepChanges`: each present field is validated and replaces the current one.
fn apply_step_changes(step: &WalkthroughStep, changes: &StepDraft) -> Result<WalkthroughStep> {
    let mut next = step.clone();
    if let Some(title) = &changes.title {
        next.title = text_within(title, "Step title", TITLE_LIMIT)?;
    }
    if let Some(explanation) = &changes.explanation {
        next.explanation = text_within(explanation, "Step explanation", EXPLANATION_LIMIT)?;
    }
    if let Some(action) = &changes.action {
        next.action = action_text(action)?;
    }
    let optional = |text: &Option<String>, label: &str, limit: usize| -> Result<Option<Option<String>>> {
        text.as_ref().map(|text| text_within(text, label, limit).map(|text| (!text.is_empty()).then_some(text))).transpose()
    };
    if let Some(operation) = optional(&changes.operation, "Step operation", OPERATION_LIMIT)? {
        next.operation = operation;
    }
    match &changes.duration_ms {
        Patch::Absent => {}
        Patch::Null => next.duration_ms = None,
        Patch::Value(duration) => next.duration_ms = Some(require_duration(&number_value(*duration))?),
    }
    match &changes.travel_percent {
        Patch::Absent => {}
        Patch::Null => next.travel_percent = None,
        Patch::Value(percent) => next.travel_percent = Some(require_travel_percent(&number_value(*percent))?),
    }
    if let Some(message) = optional(&changes.example_message, "Example message", EXAMPLE_MESSAGE_LIMIT)? {
        next.example_message = message;
    }
    if let Some(payload) = optional(&changes.example_payload, "Example payload", EXAMPLE_PAYLOAD_LIMIT)? {
        next.example_payload = payload;
    }
    Ok(next)
}

/* -------------------------------------------------------------- Walkthroughs */

pub fn add_walkthrough(walkthroughs: &[Walkthrough], input: &WalkthroughInput) -> Result<Vec<Walkthrough>> {
    identity(&input.id, "Walkthrough id")?;
    if find_walkthrough(walkthroughs, &input.id).is_some() {
        return Err(format!("Walkthrough \"{}\" already exists.", input.id));
    }
    if walkthroughs.len() >= LIMIT {
        return Err(format!("A Project can have at most {LIMIT} Walkthroughs."));
    }
    let name = name_text(&input.name.clone().unwrap_or_else(|| default_walkthrough_name(walkthroughs)), "Walkthrough name")?;
    require_unique_name(walkthroughs, &name, None)?;
    let mut next = walkthroughs.to_vec();
    next.push(Walkthrough { id: input.id.clone(), name, blocks: vec![] });
    Ok(next)
}

pub fn rename_walkthrough(walkthroughs: &[Walkthrough], walkthrough_id: &str, name: &str) -> Result<Vec<Walkthrough>> {
    let current = require_walkthrough(walkthroughs, walkthrough_id)?;
    let name = name_text(name, "Walkthrough name")?;
    if name == current.name {
        return Ok(walkthroughs.to_vec());
    }
    require_unique_name(walkthroughs, &name, Some(walkthrough_id))?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { name, ..current.clone() }))
}

pub fn remove_walkthrough(walkthroughs: &[Walkthrough], walkthrough_id: &str) -> Result<Vec<Walkthrough>> {
    require_walkthrough(walkthroughs, walkthrough_id)?;
    Ok(walkthroughs.iter().filter(|walkthrough| walkthrough.id != walkthrough_id).cloned().collect())
}

pub fn move_walkthrough(walkthroughs: &[Walkthrough], walkthrough_id: &str, to_index: f64) -> Result<Vec<Walkthrough>> {
    require_walkthrough(walkthroughs, walkthrough_id)?;
    move_by_id(walkthroughs, walkthrough_id, to_index, "Walkthrough", |walkthrough| &walkthrough.id)
}

/* ------------------------------------------------------------ steps & blocks */

/// Appends a step that plays an existing Connection to the sequence named by
/// `sequence` (the top level by default). The step records that Connection's
/// endpoints now, and its title defaults to the Connection's label.
pub fn add_step(walkthroughs: &[Walkthrough], walkthrough_id: &str, input: &StepInput, design: &SystemDesign) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    identity(&input.id, "Step id")?;
    if all_entry_ids(walkthroughs).contains(input.id.as_str()) {
        return Err(format!("Step \"{}\" already exists.", input.id));
    }
    let Some(connection) = find_connection(design, &input.connection_id) else {
        return Err("Choose a Connection from the System design for this step.".into());
    };
    let base = WalkthroughStep {
        id: input.id.clone(),
        connection_id: connection.id.clone(),
        route: StepRoute { source_id: connection.source_id.clone(), target_id: connection.target_id.clone() },
        title: connection.label.clone(),
        explanation: String::new(),
        action: DEFAULT_ACTION.into(),
        operation: None,
        duration_ms: None,
        travel_percent: None,
        example_message: None,
        example_payload: None,
    };
    let step = apply_step_changes(&base, &input.draft)?;
    let root = SequenceRef::root();
    let blocks = append_to_sequence(&walkthrough.blocks, input.sequence.as_ref().unwrap_or(&root), WalkthroughBlock::Step { step })?;
    Ok(replace_walkthrough(walkthroughs, checked(Walkthrough { blocks, ..walkthrough.clone() })?))
}

/// Appends an empty parallel block (two branches) or repeat block (default count).
pub fn add_block(walkthroughs: &[Walkthrough], walkthrough_id: &str, input: &BlockInput) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    identity(&input.id, "Block id")?;
    if all_entry_ids(walkthroughs).contains(input.id.as_str()) {
        return Err(format!("Block \"{}\" already exists.", input.id));
    }
    let block = if input.kind == "parallel" {
        WalkthroughBlock::Parallel { id: input.id.clone(), branches: vec![vec![]; PARALLEL_BRANCH_MIN] }
    } else {
        WalkthroughBlock::Repeat { id: input.id.clone(), count: REPEAT_COUNT_DEFAULT, body: vec![] }
    };
    let root = SequenceRef::root();
    let blocks = append_to_sequence(&walkthrough.blocks, input.sequence.as_ref().unwrap_or(&root), block)?;
    Ok(replace_walkthrough(walkthroughs, checked(Walkthrough { blocks, ..walkthrough.clone() })?))
}

/// Adds an empty branch to a parallel block, up to the branch limit.
pub fn add_parallel_branch(walkthroughs: &[Walkthrough], walkthrough_id: &str, block_id: &str) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    let blocks = edit_container(&walkthrough.blocks, block_id, &|container| match container {
        WalkthroughBlock::Parallel { id, branches } => {
            if branches.len() >= PARALLEL_BRANCH_LIMIT {
                return Err(format!("A parallel block can have at most {PARALLEL_BRANCH_LIMIT} branches."));
            }
            Ok(WalkthroughBlock::Parallel { id: id.clone(), branches: branches.iter().cloned().chain(std::iter::once(vec![])).collect() })
        }
        _ => Err("Only a parallel block has branches.".into()),
    })?;
    let blocks = require_edited(blocks, "That block could not be found.")?;
    Ok(replace_walkthrough(walkthroughs, checked(Walkthrough { blocks, ..walkthrough.clone() })?))
}

/// Sets how many times a repeat block runs. The count is a fixed, finite number.
pub fn update_repeat(walkthroughs: &[Walkthrough], walkthrough_id: &str, block_id: &str, count: f64) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    let checked_count = require_repeat_count(Some(&number_value(count)))?;
    let blocks = edit_container(&walkthrough.blocks, block_id, &|container| match container {
        WalkthroughBlock::Repeat { id, body, .. } => Ok(WalkthroughBlock::Repeat { id: id.clone(), count: checked_count, body: body.clone() }),
        _ => Err("Only a repeated block has a count.".into()),
    })?;
    let blocks = require_edited(blocks, "That block could not be found.")?;
    Ok(replace_walkthrough(walkthroughs, checked(Walkthrough { blocks, ..walkthrough.clone() })?))
}

pub fn update_step(walkthroughs: &[Walkthrough], walkthrough_id: &str, step_id: &str, changes: &StepDraft) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    require_step(walkthrough, step_id)?;
    let blocks = edit_step(&walkthrough.blocks, step_id, &|current| apply_step_changes(current, changes))?;
    let blocks = require_edited(blocks, "That step could not be found.")?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { blocks, ..walkthrough.clone() }))
}

/// Moves a step within the sequence it sits in.
pub fn move_step(walkthroughs: &[Walkthrough], walkthrough_id: &str, step_id: &str, to_index: f64) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    require_step(walkthrough, step_id)?;
    let blocks = move_within_sequence(&walkthrough.blocks, step_id, to_index, "Step")?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { blocks, ..walkthrough.clone() }))
}

/// Moves a parallel or repeat block within the sequence it sits in. Its contents move with it.
pub fn move_block(walkthroughs: &[Walkthrough], walkthrough_id: &str, block_id: &str, to_index: f64) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    if find_container(walkthrough, block_id).is_none() {
        return Err("That block could not be found.".into());
    }
    let blocks = move_within_sequence(&walkthrough.blocks, block_id, to_index, "Block")?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { blocks, ..walkthrough.clone() }))
}

/// Removes one step. Other steps and their Connection references are unchanged.
pub fn remove_step(walkthroughs: &[Walkthrough], walkthrough_id: &str, step_id: &str) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    require_step(walkthrough, step_id)?;
    let blocks = require_edited(remove_entry(&walkthrough.blocks, step_id)?, "That step could not be found.")?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { blocks, ..walkthrough.clone() }))
}

/// Removes a parallel or repeat block together with every step it contains.
pub fn remove_block(walkthroughs: &[Walkthrough], walkthrough_id: &str, block_id: &str) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    if find_container(walkthrough, block_id).is_none() {
        return Err("That block could not be found.".into());
    }
    let blocks = require_edited(remove_entry(&walkthrough.blocks, block_id)?, "That block could not be found.")?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { blocks, ..walkthrough.clone() }))
}

/// Points a step at an existing Connection and records that Connection's current
/// endpoints. This repairs a dangling step and accepts a redirected route.
pub fn repair_step(walkthroughs: &[Walkthrough], walkthrough_id: &str, step_id: &str, connection_id: &str, design: &SystemDesign) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    require_step(walkthrough, step_id)?;
    let Some(connection) = find_connection(design, connection_id) else {
        return Err("Choose a Connection from the System design to repair this step.".into());
    };
    let blocks = edit_step(&walkthrough.blocks, step_id, &|step| {
        Ok(WalkthroughStep {
            connection_id: connection.id.clone(),
            route: StepRoute { source_id: connection.source_id.clone(), target_id: connection.target_id.clone() },
            ..step.clone()
        })
    })?;
    let blocks = require_edited(blocks, "That step could not be found.")?;
    Ok(replace_walkthrough(walkthroughs, Walkthrough { blocks, ..walkthrough.clone() }))
}

/// Accepts the route a redirected step's Connection now runs. Only a step whose
/// endpoints changed can be accepted.
pub fn accept_step_redirection(walkthroughs: &[Walkthrough], walkthrough_id: &str, step_id: &str, design: &SystemDesign) -> Result<Vec<Walkthrough>> {
    let walkthrough = require_walkthrough(walkthroughs, walkthrough_id)?;
    let current = require_step(walkthrough, step_id)?;
    if !matches!(step_status(current, design), StepStatus::Redirected { .. }) {
        return Err("This step does not run a changed route to accept.".into());
    }
    repair_step(walkthroughs, walkthrough_id, step_id, &current.connection_id.clone(), design)
}

/// The steps, across every Walkthrough, that play one of the given Connections.
/// Nothing is deleted by listing them.
pub fn steps_on_connections(walkthroughs: &[Walkthrough], connection_ids: &[String]) -> Vec<AffectedStep> {
    walkthroughs
        .iter()
        .flat_map(|walkthrough| {
            walkthrough_steps(walkthrough)
                .into_iter()
                .filter(|step| connection_ids.contains(&step.connection_id))
                .map(|step| AffectedStep {
                    walkthrough_id: walkthrough.id.clone(),
                    walkthrough_name: walkthrough.name.clone(),
                    step_id: step.id.clone(),
                    title: step.title.clone(),
                    connection_id: step.connection_id.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}
