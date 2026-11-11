//! Turning the edited text of a Design's `schema.sql` back into that Design
//! (`applySchemaFile` in `src/bun/assistant-schema-file.ts`).
//!
//! Tables, columns and the rest are read by name, so everything that still exists keeps its identity,
//! position and notes. PostgreSQL has to accept the result before anything changes.

use schema_domain::design::{empty_design, Design};
use schema_domain::js;
use schema_domain::schema_identity::adopt_identities;
use schema_domain::sql::{generate_design_sql, render_schema_file, SqlGeneration};
use schema_sandbox::{ApplyResult, PgliteSandbox, Sandbox};
use schema_workspace::{Workspace, WorkspaceState};

use crate::ddl::translate_ddl_text;

type Result<T> = std::result::Result<T, String>;

pub enum SchemaFileResult {
    Unchanged,
    Applied { state: Box<WorkspaceState>, tables_added: Vec<String>, tables_removed: Vec<String>, tables_changed: Vec<String>, kept_as_sql: Vec<String> },
}

#[derive(Default)]
pub struct SchemaFileOptions {
    pub expected_project_id: Option<String>,
    pub expected_design_id: Option<String>,
    pub assistant_turn_id: Option<String>,
}

fn normalize(sql: &str) -> String {
    js::trim(&sql.replace("\r\n", "\n")).to_owned()
}

/// A scratch database accepts the schema, or says why not.
pub type Scratch<'a> = &'a mut dyn FnMut(&str) -> ApplyResult;

pub fn scratch_sandbox(sql: &str) -> ApplyResult {
    PgliteSandbox.apply(sql)
}

pub fn apply_schema_file(workspace: &Workspace, text: &str, options: &SchemaFileOptions, create_id: &mut dyn FnMut() -> String, scratch: Scratch) -> Result<SchemaFileResult> {
    let state = workspace.state();
    let (Some(project), Some(current), Some(design_id)) = (state.project.as_ref(), state.design.as_ref(), state.active_design_id.as_ref()) else {
        return Err("Open a database Design before applying its schema file.".into());
    };
    if options.expected_project_id.as_ref().is_some_and(|expected| *expected != project.id) {
        return Err("The project changed before the schema file was applied.".into());
    }
    if options.expected_design_id.as_ref().is_some_and(|expected| expected != design_id) {
        return Err("The Design changed before the schema file was applied.".into());
    }
    let generated = generate_design_sql(current, false)?;
    // A Design with problems is never "unchanged": applying its file is how it gets repaired.
    if matches!(generated, SqlGeneration::Ok { .. }) && normalize(&render_schema_file(current)?) == normalize(text) {
        return Ok(SchemaFileResult::Unchanged);
    }

    let mut empty = empty_design();
    empty.viewport = current.viewport;
    let translated = translate_ddl_text(&empty, text, create_id).map_err(|error| format!("schema.sql could not be read: {error}"))?;
    if translated.statement_count == 0 && (!current.tables.is_empty() || !current.raw_statements.as_deref().unwrap_or_default().is_empty()) {
        let advice = match &generated {
            SqlGeneration::Ok { .. } => "Edit the SQL in the file instead.".to_owned(),
            SqlGeneration::Errors(errors) => format!("The Design has problems ({}), so the file may have been shortened; read it again.", errors.iter().take(3).cloned().collect::<Vec<_>>().join(" ")),
        };
        return Err(format!("schema.sql has no SQL statements (only comments or nothing), which would delete the whole schema. Nothing was applied. {advice}"));
    }
    let next: Design = adopt_identities(current, &translated.design);
    let next_sql = match generate_design_sql(&next, false)? {
        SqlGeneration::Ok { sql, .. } => sql,
        SqlGeneration::Errors(errors) => return Err(format!("The schema in schema.sql is incomplete: {} Nothing was applied.", errors.join(" "))),
    };
    if let ApplyResult::Failed { error, .. } = scratch(&next_sql) {
        return Err(format!("PostgreSQL rejected schema.sql, so nothing was applied: {error}"));
    }

    let latest = workspace.state();
    if latest.project.as_ref().map(|latest| &latest.id) != Some(&project.id) || latest.active_design_id.as_ref() != Some(design_id) || latest.revision != state.revision {
        return Err("The Design changed while schema.sql was being applied. Read schema.sql again and repeat the edit.".into());
    }
    let applied = workspace.apply_assistant_design(next.clone(), design_id, options.assistant_turn_id.as_deref())?;
    let fingerprint = |design: &Design| -> Vec<(String, String)> {
        design
            .tables
            .iter()
            .map(|table| {
                let mut value = serde_json::to_value(table).expect("a table serializes");
                if let Some(record) = value.as_object_mut() {
                    record.remove("position");
                }
                (table.name.clone(), value.to_string())
            })
            .collect()
    };
    let before = fingerprint(current);
    let after = fingerprint(applied.design.as_ref().unwrap_or(&next));
    let lookup = |entries: &Vec<(String, String)>, name: &str| entries.iter().find(|(entry, _)| entry == name).map(|(_, value)| value.clone());
    Ok(SchemaFileResult::Applied {
        tables_added: after.iter().filter(|(name, _)| lookup(&before, name).is_none()).map(|(name, _)| name.clone()).collect(),
        tables_removed: before.iter().filter(|(name, _)| lookup(&after, name).is_none()).map(|(name, _)| name.clone()).collect(),
        tables_changed: after.iter().filter(|(name, value)| lookup(&before, name).is_some_and(|earlier| earlier != *value)).map(|(name, _)| name.clone()).collect(),
        kept_as_sql: translated.kept_as_sql,
        state: Box::new(applied),
    })
}
