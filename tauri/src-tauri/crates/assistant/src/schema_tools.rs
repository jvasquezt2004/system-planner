//! `apply_schema`: the harness's only way to change tables. It edits the Design's `schema.sql` in the
//! Project folder with its own file tools, then calls this to turn the edit into the Design.

use std::sync::Arc;

use schema_domain::design::Design;
use schema_domain::sql::{generate_design_sql, SqlGeneration};
use serde_json::{json, Map, Value};

use crate::read_tools::{project_snapshot, ToolContext};
use crate::schema_file::{apply_schema_file, scratch_sandbox, SchemaFileOptions, SchemaFileResult};
use crate::tools::{ProjectTool, ToolResult};

type Result<T> = std::result::Result<T, String>;

pub struct ApplySchema(pub Arc<ToolContext>);

/// `compactSqlStatus`: whether the Design's SQL is current, or why it is not.
pub fn compact_sql_status(sql: &Value) -> Value {
    if sql["status"] == "current" {
        return json!("current");
    }
    json!({ "errors": sql["errors"].as_array().cloned().unwrap_or_default() })
}

/// `compactSandboxStatus`: whether PostgreSQL accepted the Design.
pub fn compact_sandbox_status(sandbox: &Value) -> Value {
    match sandbox["status"].as_str() {
        Some("applied") => json!("accepted"),
        Some("failed") => json!({ "rejected": sandbox["error"] }),
        _ => json!("checking"),
    }
}

/// Best-practice advice for the Design's SQL; empty when it is invalid, because the errors come first.
pub fn design_warnings(design: Option<&Design>) -> Vec<String> {
    match design.map(|design| generate_design_sql(design, false)) {
        Some(Ok(SqlGeneration::Ok { warnings, .. })) => warnings,
        _ => vec![],
    }
}

impl ProjectTool for ApplySchema {
    fn name(&self) -> &str {
        "apply_schema"
    }

    fn description(&self) -> &str {
        "Apply your edits to schema.sql. Edit designs/<design>/schema.sql in your working directory with your normal file tools (it holds the Design's PostgreSQL), then call this with no arguments. Tables, columns, indexes, enum types, functions, triggers and policies become the Design and keep their identity by name; any other SQL is kept as raw SQL. PostgreSQL validates the whole file: if it rejects it, nothing changes and its error is returned. The file is rewritten from the Design afterwards."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn execute(&self, _call_id: &str, _arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        context.bound_state()?;
        let (project_id, design_id) = context.target.clone();
        let path = context.folder.as_ref().and_then(|folder| folder.schema_file(&design_id)).ok_or("schema.sql is not available for this Design. Read the project folder first.")?;
        let text = std::fs::read(&path).map(|bytes| String::from_utf8_lossy(&bytes).into_owned()).map_err(|_| "schema.sql could not be read. Do not delete or move it.")?;
        let options = SchemaFileOptions { assistant_turn_id: (context.turn_id)(), expected_project_id: Some(project_id.clone()), expected_design_id: Some(design_id.clone()) };
        let mut create_id = || uuid::Uuid::new_v4().to_string();
        let result = apply_schema_file(&context.workspace, &text, &options, &mut create_id, &mut scratch_sandbox)?;
        let (state, added, removed, changed, kept) = match result {
            SchemaFileResult::Unchanged => {
                let unchanged = json!({ "status": "unchanged", "message": "schema.sql already matches the Design; there is nothing to apply." });
                let mut details = unchanged.clone();
                details["projectId"] = json!(project_id);
                details["designId"] = json!(design_id);
                return Ok(ToolResult { content: vec![unchanged.to_string()], details, is_error: false });
            }
            SchemaFileResult::Applied { state, tables_added, tables_removed, tables_changed, kept_as_sql } => (*state, tables_added, tables_removed, tables_changed, kept_as_sql),
        };
        let open = (state.project.as_ref().map(|project| project.id.as_str()), state.active_design_id.as_deref());
        if state.design.is_none() || open != (Some(project_id.as_str()), Some(design_id.as_str())) {
            return Err("The project or Design changed before schema.sql was applied.".into());
        }
        context.store.observe_project_snapshot(&context.conversation_id, &project_snapshot(&state), state.revision)?;
        if let Some(folder) = &context.folder {
            folder.sync(true);
        }
        let warnings = design_warnings(state.design.as_ref());
        let mut summary = Map::new();
        summary.insert("status".into(), json!("applied"));
        summary.insert("tablesAdded".into(), json!(added));
        summary.insert("tablesRemoved".into(), json!(removed));
        summary.insert("tablesChanged".into(), json!(changed));
        if !kept.is_empty() {
            summary.insert("keptAsRawSql".into(), json!(kept));
            summary.insert("note".into(), json!("These statements have no table/column model, so they are kept as raw SQL and run in the sandbox as written."));
        }
        if !warnings.is_empty() {
            summary.insert("warnings".into(), json!(warnings));
        }
        summary.insert("revision".into(), json!(state.revision));
        summary.insert("sql".into(), compact_sql_status(&state.sql));
        summary.insert("sandbox".into(), compact_sandbox_status(&state.sandbox));
        summary.insert("projectId".into(), json!(project_id));
        summary.insert("designId".into(), json!(design_id));
        let details = Value::Object(summary);
        Ok(ToolResult { content: vec![details.to_string()], details, is_error: false })
    }
}
