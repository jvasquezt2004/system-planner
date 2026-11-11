//! The database design edits behind removing tables and columns, relationships, and the schema
//! objects a table or Design carries (indexes, unique constraints, enum types, Functions,
//! triggers and policies). The checks live in `schema_domain::design_edits` and `edits`; this
//! only decides when a change counts and hands it to the save and preview.

use schema_domain::design::{Design, DesignFunction, DesignTable};
use schema_domain::design_edits::{
    normalize_enum_types, normalize_functions, normalize_indexes, normalize_policies, normalize_triggers, normalize_unique_constraints,
    remove_column_and_its_relationships, remove_table_and_its_relationships, require_confirmed_removal, require_removal_target,
};
use schema_domain::geometry::CanvasPoint;
use schema_domain::relationships::{removal_plan, RemovalTarget};
use serde_json::Value;

use crate::edits::{self, RelationshipChanges};
use crate::history::HistoryAction;
use crate::{to_json, Result, Workspace, WorkspaceState};

/// `JSON.stringify(a) === JSON.stringify(b)`: the original decides that a list is unchanged by comparing text.
fn same_json<T: serde::Serialize>(a: &T, b: &T) -> bool {
    serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
}

impl Workspace {
    pub(crate) fn remove_table(&self, design_id: &str, table_id: &str, confirmed: bool) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        require_confirmed_removal(&design, &RemovalTarget::Table { table_id: table.id.clone() }, confirmed)?;
        let action = HistoryAction::named(format!("Remove table “{}”", table.name));
        let next = remove_table_and_its_relationships(&design, table);
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn remove_column(&self, design_id: &str, table_id: &str, column_id: &str, confirmed: bool) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        let column = edits::require_column(table, column_id)?;
        let target = RemovalTarget::Column { table_id: table.id.clone(), column_id: column.id.clone() };
        require_confirmed_removal(&design, &target, confirmed)?;
        let action = HistoryAction::named(format!("Remove column “{}”", column.name));
        let next = remove_column_and_its_relationships(&design, table, column);
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn add_relationship(
        &self,
        design_id: &str,
        referencing_table_id: &str,
        referenced_table_id: &str,
        cardinality: Option<&Value>,
        junction_position: Option<CanvasPoint>,
    ) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let next = edits::add_relationship(&design, referencing_table_id, referenced_table_id, cardinality, junction_position, &mut || self.new_id())?;
        let many_to_many = cardinality.and_then(Value::as_str) == Some("many-to-many");
        let action = HistoryAction::named(if many_to_many { "Add many-to-many relationship" } else { "Add relationship" });
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn update_relationship(&self, design_id: &str, relationship_id: &str, changes: &RelationshipChanges) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        match edits::update_relationship(&design, relationship_id, changes)? {
            None => Ok(self.state()),
            Some(next) => self.apply_structural_change(&project_id, next, Some(HistoryAction::named("Update relationship")), &design_id),
        }
    }

    pub(crate) fn remove_relationship(&self, design_id: &str, relationship_id: &str) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let next = edits::remove_relationship(&design, relationship_id)?;
        self.apply_structural_change(&project_id, next, Some(HistoryAction::named("Remove relationship")), &design_id)
    }

    pub(crate) fn update_indexes(&self, design_id: &str, table_id: &str, indexes: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        let indexes = normalize_indexes(indexes, table)?;
        if same_json(&indexes, &table.indexes.clone().unwrap_or_default()) {
            return Ok(self.state());
        }
        let action = HistoryAction::named(format!("Update indexes on “{}”", table.name));
        let next = edits::replace_table(&design, DesignTable { indexes: Some(indexes), ..table.clone() });
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn update_unique_constraints(&self, design_id: &str, table_id: &str, constraints: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        let constraints = normalize_unique_constraints(constraints, table)?;
        if same_json(&constraints, &table.unique_constraints.clone().unwrap_or_default()) {
            return Ok(self.state());
        }
        let action = HistoryAction::named(format!("Update unique constraints on “{}”", table.name));
        let next = edits::replace_table(&design, DesignTable { unique_constraints: Some(constraints), ..table.clone() });
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn update_policies(&self, design_id: &str, table_id: &str, row_level_security: &Value, policies: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        let row_level_security = *row_level_security == Value::Bool(true);
        let policies = normalize_policies(policies)?;
        if row_level_security == table.row_level_security && same_json(&policies, &table.policies) {
            return Ok(self.state());
        }
        let action = HistoryAction::named(format!("Update policies on “{}”", table.name));
        let next = edits::replace_table(&design, DesignTable { row_level_security, policies, ..table.clone() });
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn update_enum_types(&self, design_id: &str, enum_types: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let enum_types = normalize_enum_types(enum_types)?;
        let previous = design.enum_types.clone().unwrap_or_default();
        for removed in previous.iter().filter(|previous| !enum_types.iter().any(|candidate| candidate.id == previous.id)) {
            let columns: Vec<String> = design
                .tables
                .iter()
                .flat_map(|table| {
                    table
                        .columns
                        .iter()
                        .filter(|column| column.column_type == "enum" && column.enum_type_id.as_deref() == Some(removed.id.as_str()))
                        .map(|column| format!("{}.{}", table.name, column.name))
                })
                .collect();
            if !columns.is_empty() {
                return Err(format!("Enum type \"{}\" is used by {}.", removed.name, columns.join(", ")));
            }
        }
        if same_json(&enum_types, &previous) {
            return Ok(self.state());
        }
        self.apply_structural_change(&project_id, Design { enum_types: Some(enum_types), ..design }, Some(HistoryAction::named("Update enum types")), &design_id)
    }

    pub(crate) fn update_functions(&self, design_id: &str, functions: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let functions = normalize_functions(functions, &design)?;
        if same_json(&functions, &design.functions.clone().unwrap_or_default()) {
            return Ok(self.state());
        }
        let action = functions_history_action(design.functions.as_deref().unwrap_or_default(), &functions);
        self.apply_structural_change(&project_id, Design { functions: Some(functions), ..design }, Some(action), &design_id)
    }

    pub(crate) fn remove_function(&self, design_id: &str, function_id: &str, confirmed: bool) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let target = RemovalTarget::Function { function_id: function_id.to_owned() };
        require_removal_target(&design, &target)?;
        require_confirmed_removal(&design, &target, confirmed)?;
        let name = design.functions.iter().flatten().find(|function| function.id == function_id).map(|function| function.name.clone());
        let action = HistoryAction::named(format!("Remove function “{}”", name.unwrap_or_default()));
        let next = Design {
            functions: Some(design.functions.iter().flatten().filter(|function| function.id != function_id).cloned().collect()),
            triggers: Some(design.triggers.iter().flatten().filter(|trigger| trigger.function_id != function_id).cloned().collect()),
            ..design
        };
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub(crate) fn update_triggers(&self, design_id: &str, triggers: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let triggers = normalize_triggers(triggers, &design)?;
        if same_json(&triggers, &design.triggers.clone().unwrap_or_default()) {
            return Ok(self.state());
        }
        self.apply_structural_change(&project_id, Design { triggers: Some(triggers), ..design }, Some(HistoryAction::named("Update triggers")), &design_id)
    }

    /// What removing the target would also remove, for the designer to inspect before confirming.
    pub(crate) fn describe_database_removal(&self, design_id: &str, target: &RemovalTarget) -> Result<Value> {
        let (_, design, _) = self.require_open_design(&self.lock(), design_id)?;
        require_removal_target(&design, target)?;
        to_json(&removal_plan(&design, target))
    }
}

/// Names a Function edit for the Project history, with typing in one body grouped.
fn functions_history_action(before: &[DesignFunction], after: &[DesignFunction]) -> HistoryAction {
    if let Some(added) = after.iter().find(|function| !before.iter().any(|candidate| candidate.id == function.id)) {
        return HistoryAction::named(format!("Add function “{}”", added.name));
    }
    if let Some(removed) = before.iter().find(|function| !after.iter().any(|candidate| candidate.id == function.id)) {
        return HistoryAction::named(format!("Remove function “{}”", removed.name));
    }
    let text = |function: &DesignFunction| serde_json::to_string(function).ok();
    let edited = after.iter().find(|function| text(function) != before.iter().find(|candidate| candidate.id == function.id).and_then(text));
    match edited {
        Some(function) => HistoryAction::coalescing(format!("Edit function “{}”", function.name), format!("function:{}", function.id)),
        None => HistoryAction::named("Update functions"),
    }
}
