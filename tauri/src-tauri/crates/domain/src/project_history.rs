//! The Project-wide content history shared by Undo, Redo, and Assistant turns
//! (`src/bun/project-history.ts`).
//!
//! Each entry stores the content before and after one named action. The workspace decides what
//! "content" means; this module only orders, groups, and replays those snapshots.
//!
//! Grouping rules:
//! - A change with a `coalesce_key` joins the newest entry when that entry has the same key, is
//!   not Assistant-owned, and was recorded no more than [`HISTORY_COALESCE_WINDOW_MS`] earlier.
//!   This groups continuous typing and rapid renames.
//! - An Assistant change joins the newest Assistant turn entry for the same turn. Manual changes
//!   made between the turn's changes are rebased so the turn is one action and the designer's
//!   work is kept.

use std::collections::HashMap;

use serde_json::{Map, Value};

pub const HISTORY_COALESCE_WINDOW_MS: i64 = 1500;

/// What a snapshot must be able to do for an Assistant turn to fold into one entry.
pub trait Snapshot: Clone {
    /// `JSON.stringify(a) === JSON.stringify(b)`.
    fn same(&self, other: &Self) -> bool;
    /// Re-applies a manual before/after delta onto content that may have changed since.
    fn rebase(manual_before: &Self, manual_after: &Self, base: &Self) -> Self;
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectHistoryChange<T> {
    /// The name Undo and Redo show, such as `Add table “Authors”`.
    pub name: String,
    pub before: T,
    pub after: T,
    /// True when the schema changed, so the SQL preview and sandbox must rebuild.
    pub structural: bool,
    /// Attributes the change to one Assistant turn. `None` for manual edits.
    pub assistant_turn_id: Option<String>,
    /// Groups consecutive changes to the same thing, such as one source editor.
    pub coalesce_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectHistoryEntry<T> {
    pub change: ProjectHistoryChange<T>,
    pub recorded_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProjectHistory<T> {
    pub entries: Vec<ProjectHistoryEntry<T>>,
    pub cursor: usize,
}

impl<T> Default for ProjectHistory<T> {
    fn default() -> Self {
        Self { entries: Vec::new(), cursor: 0 }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectHistoryDescription {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_action_name: Option<String>,
    pub redo_action_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Undo,
    Redo,
}

/// Describes the next Undo and Redo actions for display.
pub fn describe_project_history<T>(history: Option<&ProjectHistory<T>>) -> ProjectHistoryDescription {
    let Some(history) = history else { return ProjectHistoryDescription::default() };
    ProjectHistoryDescription {
        can_undo: history.cursor > 0,
        can_redo: history.cursor < history.entries.len(),
        undo_action_name: history.cursor.checked_sub(1).and_then(|index| history.entries.get(index)).map(|entry| entry.change.name.clone()),
        redo_action_name: history.entries.get(history.cursor).map(|entry| entry.change.name.clone()),
    }
}

/// Records one change at the cursor. Any redo entries are discarded first, so a new change
/// always branches from the current state.
pub fn record_project_change<T: Snapshot>(history: &mut ProjectHistory<T>, change: ProjectHistoryChange<T>, recorded_at: i64) {
    history.entries.truncate(history.cursor);
    if change.assistant_turn_id.is_some() {
        if fold_into_assistant_turn(history, &change, recorded_at) {
            return;
        }
    } else if let Some(latest) = history.cursor.checked_sub(1).and_then(|index| history.entries.get_mut(index)) {
        if change.coalesce_key.is_some()
            && latest.change.coalesce_key == change.coalesce_key
            && latest.change.assistant_turn_id.is_none()
            && recorded_at - latest.recorded_at <= HISTORY_COALESCE_WINDOW_MS
        {
            latest.change.name = change.name;
            latest.change.after = change.after;
            latest.change.structural = latest.change.structural || change.structural;
            latest.recorded_at = recorded_at;
            return;
        }
    }
    history.entries.push(ProjectHistoryEntry { change, recorded_at });
    history.cursor = history.entries.len();
}

/// Moves the cursor one step and returns the entry that was crossed: its `before` content for
/// Undo and its `after` content for Redo. `None` when there is nothing to cross. The caller
/// restores the cursor if applying fails.
pub fn step_project_history<T>(history: &mut ProjectHistory<T>, direction: Direction) -> Option<&ProjectHistoryEntry<T>> {
    match direction {
        Direction::Undo => {
            let index = history.cursor.checked_sub(1)?;
            history.cursor = index;
            history.entries.get(index)
        }
        Direction::Redo => {
            let index = history.cursor;
            let entry = history.entries.get(index)?;
            history.cursor += 1;
            Some(entry)
        }
    }
}

/// Folds an Assistant change into its turn's entry. Manual entries recorded after the turn
/// started are rebased onto the turn's starting content and placed before the combined entry,
/// so the turn remains one action.
fn fold_into_assistant_turn<T: Snapshot>(history: &mut ProjectHistory<T>, change: &ProjectHistoryChange<T>, recorded_at: i64) -> bool {
    let mut turn_index = history.cursor as isize - 1;
    while turn_index >= 0 && history.entries[turn_index as usize].change.assistant_turn_id.is_none() {
        turn_index -= 1;
    }
    let Some(turn) = usize::try_from(turn_index).ok().and_then(|index| history.entries.get(index)) else { return false };
    if turn.change.assistant_turn_id != change.assistant_turn_id {
        return false;
    }
    let turn_index = turn_index as usize;

    let mut rebased = turn.change.before.clone();
    let mut manual_entries = Vec::new();
    for entry in &history.entries[turn_index + 1..history.cursor] {
        let next = T::rebase(&entry.change.before, &entry.change.after, &rebased);
        if !rebased.same(&next) {
            let mut moved = entry.clone();
            moved.change.before = rebased.clone();
            moved.change.after = next.clone();
            manual_entries.push(moved);
            rebased = next;
        }
    }
    let mut rebased_after = change.after.clone();
    for entry in &history.entries[turn_index + 1..history.cursor] {
        rebased_after = T::rebase(&entry.change.before, &entry.change.after, &rebased_after);
    }
    let turn_entry = ProjectHistoryEntry {
        change: ProjectHistoryChange {
            name: turn.change.name.clone(),
            before: rebased,
            after: rebased_after,
            structural: turn.change.structural || change.structural,
            assistant_turn_id: turn.change.assistant_turn_id.clone(),
            coalesce_key: None,
        },
        recorded_at,
    };
    let manual_count = manual_entries.len();
    let cursor = history.cursor;
    history.entries.splice(turn_index..cursor, manual_entries.into_iter().chain(std::iter::once(turn_entry)));
    history.cursor = turn_index + manual_count + 1;
    true
}

/* -------------------------------------------------------- JSON snapshots */

fn stringify(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

impl Snapshot for Value {
    fn same(&self, other: &Self) -> bool {
        stringify(self) == stringify(other)
    }

    fn rebase(manual_before: &Self, manual_after: &Self, base: &Self) -> Self {
        apply_manual_delta(base, manual_before, manual_after)
    }
}

/// The identity an array entry is matched by: its `id`, or for a Walkthrough step block
/// (`{ kind: "step", step }`) the step's id. `None` when it has neither.
fn entry_key(item: &Value) -> Option<String> {
    let record = item.as_object()?;
    if let Some(Value::String(id)) = record.get("id") {
        return Some(id.clone());
    }
    if record.get("kind").and_then(Value::as_str) == Some("step") {
        if let Some(Value::String(id)) = record.get("step").and_then(Value::as_object).and_then(|step| step.get("id")) {
            return Some(id.clone());
        }
    }
    None
}

/// A JavaScript `Map` built from entries: a repeated key keeps its first position and takes the last value.
struct OrderedMap<'a> {
    order: Vec<Option<String>>,
    values: HashMap<Option<String>, &'a Value>,
}

impl<'a> OrderedMap<'a> {
    fn from(items: impl IntoIterator<Item = &'a Value>) -> Self {
        let mut map = Self { order: Vec::new(), values: HashMap::new() };
        for item in items {
            let key = entry_key(item);
            if map.values.insert(key.clone(), item).is_none() {
                map.order.push(key);
            }
        }
        map
    }
}

fn is_container(value: &Value) -> bool {
    value.is_object() || value.is_array()
}

/// Applies the difference between two snapshots to a target. Records with a stable `id` are
/// matched by identity so independent edits merge. Anything that cannot be matched takes the
/// manual value.
fn apply_manual_delta(target: &Value, manual_before: &Value, manual_after: &Value) -> Value {
    if stringify(manual_before) == stringify(manual_after) {
        return target.clone();
    }
    if let (Value::Array(before_items), Value::Array(after_items)) = (manual_before, manual_after) {
        let keyed = before_items.iter().chain(after_items).all(|item| entry_key(item).is_some());
        if let (true, Value::Array(target_items)) = (keyed, target) {
            let before_by_id = OrderedMap::from(before_items);
            let after_by_id = OrderedMap::from(after_items);
            let target_by_id = OrderedMap::from(target_items);
            let mut result: Vec<Value> = target_items.clone();
            let mut present: std::collections::HashSet<Option<String>> = result.iter().map(entry_key).collect();
            let mut ids = before_by_id.order.clone();
            for id in &after_by_id.order {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
            for id in ids {
                let before = before_by_id.values.get(&id);
                let after = after_by_id.values.get(&id);
                match (before, after) {
                    (None, Some(after)) => {
                        if !present.contains(&id) {
                            result.push((*after).clone());
                            present.insert(id);
                        }
                    }
                    (Some(_), None) => {
                        if let Some(index) = result.iter().position(|item| entry_key(item) == id) {
                            result.remove(index);
                        }
                        present.remove(&id);
                    }
                    (Some(before), Some(after)) if present.contains(&id) => {
                        let current = target_by_id.values.get(&id).copied().unwrap_or(&Value::Null);
                        let next = apply_manual_delta(current, before, after);
                        if let Some(index) = result.iter().position(|item| entry_key(item) == id) {
                            result[index] = next;
                        }
                    }
                    _ => {}
                }
            }
            return Value::Array(result);
        }
        if let Value::Array(target_items) = target {
            if before_items.len() == after_items.len() && target_items.len() == before_items.len() {
                return Value::Array(before_items.iter().enumerate().map(|(index, item)| apply_manual_delta(&target_items[index], item, &after_items[index])).collect());
            }
        }
        return manual_after.clone();
    }
    if let (Value::Object(before), Value::Object(after), Value::Object(target)) = (manual_before, manual_after, target) {
        let mut result: Map<String, Value> = target.clone();
        let mut keys: Vec<&String> = before.keys().collect();
        keys.extend(after.keys().filter(|key| !before.contains_key(*key)));
        for key in keys {
            match (before.get(key), after.get(key)) {
                (_, None) => {
                    result.shift_remove(key);
                }
                (None, Some(added)) => {
                    result.insert(key.clone(), added.clone());
                }
                (Some(was), Some(now)) => {
                    if stringify(was) != stringify(now) {
                        let merged = match result.get(key) {
                            Some(current) if is_container(was) && is_container(now) => apply_manual_delta(current, was, now),
                            _ => now.clone(),
                        };
                        result.insert(key.clone(), merged);
                    }
                }
            }
        }
        return Value::Object(result);
    }
    manual_after.clone()
}
