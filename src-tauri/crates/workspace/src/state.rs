//! The observable state the view renders. Field names and shapes match the
//! TypeScript `WorkspaceState`, so the view needs no changes.

use schema_domain::design::Design;
use schema_domain::system_design::{SystemDesign, SystemViewName};
use schema_domain::walkthrough::Walkthrough;
use schema_sandbox::{ApplyResult, Failure};
use schema_store::{DatabaseDesignSummary, ProjectSummary};
use serde::Serialize;
use serde_json::{json, Map, Value};

/// Status unions (`save`, `sql`, `sandbox`, ...) stay JSON: they are tagged variants the
/// workspace builds and the view reads, and nothing else inspects them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub projects: Vec<ProjectSummary>,
    pub project: Option<ProjectSummary>,
    pub design: Option<Design>,
    pub active_design_id: Option<String>,
    pub designs: Vec<DatabaseDesignSummary>,
    pub revision: i64,
    pub save: Value,
    pub sql: Value,
    pub sandbox: Value,
    pub scenarios: Vec<Value>,
    pub scenario_save: Value,
    pub edge_functions: Vec<Value>,
    pub edge_function_save: Value,
    pub scenario_runs: Map<String, Value>,
    pub undo_redo: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undo_action_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redo_action_name: Option<String>,
    pub system_design: Option<SystemDesign>,
    pub system_save: Value,
    pub active_view: SystemViewName,
    pub walkthroughs: Vec<Walkthrough>,
    pub walkthrough_save: Value,
}

impl WorkspaceState {
    /// The state before any Project is open.
    pub fn initial(projects: Vec<ProjectSummary>) -> Self {
        Self {
            projects,
            project: None,
            design: None,
            active_design_id: None,
            designs: vec![],
            revision: 0,
            save: json!({ "status": "idle" }),
            sql: json!({ "status": "empty", "draftRevision": 0, "errors": [] }),
            sandbox: json!({ "status": "idle" }),
            scenarios: vec![],
            scenario_save: json!({ "status": "idle" }),
            edge_functions: vec![],
            edge_function_save: json!({ "status": "idle" }),
            scenario_runs: Map::new(),
            undo_redo: json!({ "canUndo": false, "canRedo": false }),
            undo_action_name: None,
            redo_action_name: None,
            system_design: None,
            system_save: json!({ "status": "idle" }),
            active_view: SystemViewName::System,
            walkthroughs: vec![],
            walkthrough_save: json!({ "status": "idle" }),
        }
    }
}

pub fn saved(revision: i64, saved_at: i64, design_id: &str) -> Value {
    json!({ "status": "saved", "revision": revision, "savedAt": saved_at, "designId": design_id })
}

pub fn saving(revision: i64, design_id: &str) -> Value {
    json!({ "status": "saving", "revision": revision, "designId": design_id })
}

/// `getLastAppliedSandbox`: the most recent successful build, even while a newer one runs or has failed.
pub fn last_applied_sandbox(sandbox: &Value) -> Option<Value> {
    match sandbox["status"].as_str() {
        Some("applied") => Some(sandbox.clone()),
        Some("idle") | None => None,
        _ => sandbox.get("lastApplied").filter(|applied| !applied.is_null()).cloned(),
    }
}

/// The sandbox state after a build: applied with PostgreSQL's own view of the schema, or failed.
pub fn sandbox_state(result: ApplyResult, design: &Design, revision: i64, sql: &str, design_id: &str, last_applied: Option<Value>) -> Value {
    match result {
        ApplyResult::Applied { mut tables, relationships } => {
            for table in &mut tables {
                let design_table = design.tables.iter().find(|candidate| candidate.name == table.name);
                for column in &mut table.columns {
                    let design_column = design_table.and_then(|table| table.columns.iter().find(|candidate| candidate.name == column.name));
                    let enum_type = design_column
                        .and_then(|column| column.enum_type_id.as_ref())
                        .and_then(|id| design.enum_types.as_deref().and_then(|types| types.iter().find(|candidate| &candidate.id == id)));
                    if let Some(enum_type) = enum_type {
                        column.enum_type_name = Some(enum_type.name.clone());
                    }
                }
            }
            let mut applied = json!({
                "status": "applied",
                "designId": design_id,
                "revision": revision,
                "tables": tables,
                "relationships": relationships,
                "sql": sql,
            });
            if let Some(enum_types) = &design.enum_types {
                applied["enumTypes"] = json!(enum_types);
            }
            if let Some(functions) = &design.functions {
                applied["functions"] = json!(functions);
            }
            applied
        }
        ApplyResult::Failed { failure: Failure::SqlRejected, error } => json!({
            "status": "failed", "failure": "sql-rejected", "revision": revision,
            "attemptedSql": sql, "error": error, "lastApplied": last_applied, "designId": design_id,
        }),
        ApplyResult::Failed { failure: Failure::SandboxError, error } => json!({
            "status": "failed", "failure": "sandbox-error", "revision": revision,
            "error": error, "lastApplied": last_applied, "designId": design_id,
        }),
    }
}
