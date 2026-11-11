//! What the Assistant may do to the database Design beyond the designer's own edits
//! (`applyAssistantDesign` in `src/bun/workspace.ts`): replace the Design with a validated one.

use schema_domain::design::{Design, DesignTable};
use schema_domain::design_edits::{normalize_enum_types, normalize_functions, normalize_indexes, normalize_policies, normalize_triggers, normalize_unique_constraints};
use serde_json::json;

use crate::edits;
use crate::history::{HistoryAction, ASSISTANT_TURN_ASSISTANT_NAME};
use crate::{Result, Workspace, WorkspaceState};

impl Workspace {
    /// Applies a Design the Assistant produced. Everything the designer's own edits check is checked
    /// again, existing tables and the canvas viewport must stay where they are, and the change joins
    /// the Assistant turn's single history action.
    pub fn apply_assistant_design(&self, design: Design, target_design_id: &str, assistant_turn_id: Option<&str>) -> Result<WorkspaceState> {
        let (project_id, current, design_id) = self.require_open_design(&self.lock(), target_design_id)?;
        for table in &design.tables {
            let position = edits::require_point(table.position, "Table position")?;
            if current.tables.iter().find(|candidate| candidate.id == table.id).is_some_and(|existing| existing.position != position) {
                return Err("Assistant design changes cannot move existing tables.".into());
            }
        }
        if design.viewport != current.viewport {
            return Err("Assistant design changes cannot change the canvas viewport.".into());
        }
        let mut validated = Design { tables: Vec::new(), ..design.clone() };
        for table in &design.tables {
            let position = edits::require_point(table.position, "Table position")?;
            let mut next = DesignTable { position, policies: normalize_policies(&json!(table.policies))?, ..table.clone() };
            if let Some(indexes) = &table.indexes {
                next.indexes = Some(normalize_indexes(&json!(indexes), &next)?);
            }
            if let Some(constraints) = &table.unique_constraints {
                next.unique_constraints = Some(normalize_unique_constraints(&json!(constraints), &next)?);
            }
            validated.tables.push(next);
        }
        if let Some(enum_types) = &design.enum_types {
            validated.enum_types = Some(normalize_enum_types(&json!(enum_types))?);
        }
        if let Some(functions) = &design.functions {
            validated.functions = Some(normalize_functions(&json!(functions), &design)?);
        }
        if let Some(triggers) = &design.triggers {
            validated.triggers = Some(normalize_triggers(&json!(triggers), &design)?);
        }
        if serde_json::to_string(&validated).ok() == serde_json::to_string(&current).ok() {
            return Ok(self.state());
        }
        let action = match assistant_turn_id {
            Some(turn) => HistoryAction { name: ASSISTANT_TURN_ASSISTANT_NAME.into(), coalesce_key: None, assistant_turn_id: Some(turn.to_owned()) },
            None => HistoryAction::named("Assistant design change"),
        };
        self.apply_structural_change(&project_id, validated, Some(action), &design_id)
    }
}
