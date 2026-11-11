//! The portable Project document (`src/shared/project-portability.ts`): a versioned, editable copy
//! of one Project's System design, every database Design with its Scenarios and Edge functions,
//! and its named Walkthroughs.
//!
//! It is deliberately narrow. Provider credentials and Assistant conversation history are never
//! part of it. An import reads the fields listed here and ignores any other top-level field.
//!
//! Imports never reuse stored identities for the Project or its Designs; they get fresh ones, and
//! every Database component's link follows its Design. The other ids stay as authored because they
//! are scoped to their Project or Design.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use crate::design::{normalize_design, Design};
use crate::design_edits::{normalize_functions, normalize_triggers};
use crate::js;
use crate::system_design::{normalize_system_design, SystemDesign, SystemViewName};
use crate::walkthrough::{normalize_walkthroughs, Walkthrough};

pub const PROJECT_EXPORT_FORMAT: &str = "schema-designer.project";
pub const PROJECT_EXPORT_VERSION: i64 = 1;
pub const PROJECT_EXPORT_FILE_SUFFIX: &str = ".schema-designer.json";

type Result<T> = std::result::Result<T, String>;

const SCENARIO_NAME_LIMIT: usize = 80;

/// Scenario or Edge function source as the portable document carries it.
#[derive(Debug, Clone, PartialEq)]
pub struct ExportSource {
    pub id: String,
    pub name: String,
    pub source: String,
}

/// One database Design of a Project being exported. `design` is the stored document as it is.
#[derive(Debug, Clone)]
pub struct ExportDesign {
    pub id: String,
    pub name: String,
    pub design: Value,
    pub scenarios: Vec<ExportSource>,
    pub edge_functions: Vec<ExportSource>,
}

pub struct ExportInput<'a> {
    pub project_name: &'a str,
    pub active_design_id: &'a str,
    pub active_view: SystemViewName,
    pub system_design: &'a SystemDesign,
    pub walkthroughs: &'a [Walkthrough],
    pub designs: Vec<ExportDesign>,
}

fn sources(items: &[ExportSource]) -> Value {
    Value::Array(items.iter().map(|item| json!({ "id": item.id, "name": item.name, "source": item.source })).collect())
}

pub fn create_project_export_document(input: &ExportInput) -> Value {
    json!({
        "format": PROJECT_EXPORT_FORMAT,
        "version": PROJECT_EXPORT_VERSION,
        "project": {
            "name": input.project_name,
            "activeDesignId": input.active_design_id,
            "activeView": input.active_view,
        },
        "systemDesign": input.system_design,
        "designs": input.designs.iter().map(|design| json!({
            "id": design.id,
            "name": design.name,
            "design": design.design,
            "scenarios": sources(&design.scenarios),
            "edgeFunctions": sources(&design.edge_functions),
        })).collect::<Vec<_>>(),
        "walkthroughs": input.walkthroughs,
    })
}

/// What an import creates: every identity is new, and every reference is already remapped.
#[derive(Debug, Clone)]
pub struct PreparedImport {
    pub project_id: String,
    pub project_name: String,
    pub active_design_id: String,
    pub active_view: SystemViewName,
    pub designs: Vec<PreparedImportDesign>,
    pub system_design: SystemDesign,
    pub walkthroughs: Vec<Walkthrough>,
}

#[derive(Debug, Clone)]
pub struct PreparedImportDesign {
    pub id: String,
    pub name: String,
    pub design: Design,
    pub scenarios: Vec<ExportSource>,
    pub edge_functions: Vec<ExportSource>,
}

/// An import error names the first malformed part of the file.
fn malformed_message(path: &str, problem: &str) -> String {
    let problem = problem.strip_suffix('.').unwrap_or(problem);
    format!("The project file is malformed: {path} {problem}. Export the project again from Schema Designer.")
}

fn malformed<T>(path: &str, problem: &str) -> Result<T> {
    Err(malformed_message(path, problem))
}

fn require_record<'a>(value: Option<&'a Value>, path: &str) -> Result<&'a Map<String, Value>> {
    match value.and_then(Value::as_object) {
        Some(record) => Ok(record),
        None => malformed(path, "must be an object"),
    }
}

fn require_array<'a>(value: Option<&'a Value>, path: &str) -> Result<&'a Vec<Value>> {
    match value.and_then(Value::as_array) {
        Some(items) => Ok(items),
        None => malformed(path, "must be a list"),
    }
}

fn require_string(value: Option<&Value>, path: &str) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(text) => Ok(text.to_owned()),
        None => malformed(path, "must be text"),
    }
}

fn require_id(value: Option<&Value>, path: &str) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(text) if !js::trim(text).is_empty() => Ok(text.to_owned()),
        _ => malformed(path, "is required"),
    }
}

fn require_text(value: Option<&Value>, path: &str) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(text) if !js::trim(text).is_empty() => Ok(js::trim(text).to_owned()),
        _ => malformed(path, "is required"),
    }
}

fn require_bounded_name(value: Option<&Value>, path: &str, limit: usize) -> Result<String> {
    let name = require_text(value, path)?;
    if js::length(&name) > limit {
        return malformed(path, &format!("must be {limit} characters or fewer"));
    }
    Ok(name)
}

fn require_view(value: Option<&Value>, path: &str) -> Result<SystemViewName> {
    match value.and_then(Value::as_str) {
        Some("system") => Ok(SystemViewName::System),
        Some("database") => Ok(SystemViewName::Database),
        _ => malformed(path, "must be \"system\" or \"database\""),
    }
}

/// Reads a list whose items each need unique identities within it.
fn require_unique_list<T>(
    value: Option<&Value>,
    path: &str,
    read: impl Fn(&Map<String, Value>, &str) -> Result<T>,
    key_of: impl Fn(&T) -> String,
) -> Result<Vec<T>> {
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for (index, raw) in require_array(value, path)?.iter().enumerate() {
        let item_path = format!("{path}[{index}]");
        let item = read(require_record(Some(raw), &item_path)?, &item_path)?;
        let key = key_of(&item);
        if !seen.insert(key.clone()) {
            return malformed(&item_path, &format!("repeats \"{key}\""));
        }
        items.push(item);
    }
    Ok(items)
}

fn is_edge_function_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// An imported design gets the checks a designer's own edits get: the stored shape, then its
/// Functions and triggers, which must reference what they name.
///
/// The outer error is a problem the original reports too. The inner one is the typed model being
/// stricter than the original (a column without `nullable` is stored as it is there): it is held
/// back so every check the original makes still runs, and wins, first.
fn normalize_imported_design(value: &Value) -> Result<std::result::Result<Design, String>> {
    let (mut fields, mut typed_problem) = match normalize_design(value) {
        Ok(Value::Object(fields)) => (fields, None),
        // The generic refusal is the typed model meeting input the original tolerates (a column that is not an object).
        Ok(_) => return Ok(Err("The saved design is malformed.".into())),
        Err(error) if error == "The saved design is malformed." => (value.as_object().cloned().unwrap_or_default(), Some(error)),
        Err(error) => return Err(error),
    };
    let functions = fields.remove("functions");
    let triggers = fields.remove("triggers");
    // What the checks below read of the design (its tables, columns and Functions) is read leniently
    // when the whole thing cannot be typed, so they still say what the original says.
    let mut design = match typed_problem {
        Some(_) => lenient_design(&fields),
        None => match serde_json::from_value::<Design>(Value::Object(fields.clone())) {
            Ok(design) => design,
            Err(error) => {
                typed_problem = Some(format!("The saved design is malformed: {error}."));
                lenient_design(&fields)
            }
        },
    };
    if let Some(functions) = functions.filter(|value| !value.is_null()) {
        // The original reuses a Function's recorded table dependencies when nothing it depends on changed.
        design.functions = Some(functions.as_array().map(|items| items.iter().filter_map(|item| serde_json::from_value(item.clone()).ok()).collect()).unwrap_or_default());
        design.functions = Some(normalize_functions(&functions, &design)?);
    }
    if let Some(triggers) = triggers.filter(|value| !value.is_null()) {
        design.triggers = Some(normalize_triggers(&triggers, &design)?);
    }
    match typed_problem {
        Some(problem) => Ok(Err(problem)),
        None => Ok(Ok(design)),
    }
}

/// Tables with their ids, names and column ids: all that checking Functions and triggers needs.
fn lenient_design(fields: &Map<String, Value>) -> Design {
    let text = |value: Option<&Value>| value.and_then(Value::as_str).unwrap_or_default().to_owned();
    let tables = fields
        .get("tables")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|table| crate::design::DesignTable {
            id: text(table.get("id")),
            name: text(table.get("name")),
            position: crate::geometry::CanvasPoint { x: 0.0, y: 0.0 },
            columns: table
                .get("columns")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_object)
                .map(|column| crate::design::DesignColumn {
                    id: text(column.get("id")),
                    name: text(column.get("name")),
                    column_type: text(column.get("type")),
                    type_parameters: None,
                    enum_type_id: None,
                    nullable: true,
                    primary_key: false,
                    unique: false,
                    identity: false,
                    default: crate::column_defaults::ColumnDefault::None,
                    notes: String::new(),
                    extra: Map::new(),
                })
                .collect(),
            indexes: None,
            unique_constraints: None,
            row_level_security: false,
            policies: vec![],
            extra: Map::new(),
        })
        .collect();
    Design { tables, ..crate::design::empty_design() }
}

fn normalize_design_document(value: Option<&Value>, path: &str) -> Result<std::result::Result<Design, String>> {
    let record = require_record(value, path)?;
    if !record.get("tables").is_some_and(Value::is_array) {
        return malformed(&format!("{path}.tables"), "must be a list");
    }
    match normalize_imported_design(&Value::Object(record.clone())) {
        Ok(Ok(design)) => Ok(Ok(design)),
        Ok(Err(problem)) => Ok(Err(malformed_message(path, &problem))),
        Err(error) => Err(malformed_message(path, &error)),
    }
}

/// Validates an untrusted document and returns what an import should create. It names the first
/// malformed part, and it never returns a partial result, so a caller can write everything or nothing.
///
/// Structural problems are malformed: a missing or duplicated identity, a link to a Design the
/// file does not contain, or a System design that cannot be loaded. Walkthrough references are
/// not checked here: a step whose Connection is gone is an unfinished explanation, so it is kept.
pub fn prepare_project_import(value: &Value, create_id: &mut dyn FnMut() -> String) -> Result<PreparedImport> {
    let root = require_record(Some(value), "file")?;
    if root.get("format").and_then(Value::as_str) != Some(PROJECT_EXPORT_FORMAT) {
        return Err("This file is not a Schema Designer project export.".into());
    }
    if root.get("version").and_then(Value::as_f64) != Some(PROJECT_EXPORT_VERSION as f64) {
        let version = match root.get("version") {
            Some(Value::Number(number)) => js::number_to_string(number.as_f64().unwrap_or(f64::NAN)),
            _ => "unknown".to_owned(),
        };
        return Err(format!(
            "This project export uses format version {version}, which this version of Schema Designer cannot read. It reads version {PROJECT_EXPORT_VERSION}."
        ));
    }

    let project = require_record(root.get("project"), "project")?;
    let project_name = require_text(project.get("name"), "project.name")?;
    let active_view = require_view(project.get("activeView"), "project.activeView")?;

    let raw_designs = require_array(root.get("designs"), "designs")?;
    if raw_designs.is_empty() {
        return malformed("designs", "must list at least one design");
    }
    let mut design_ids = HashSet::new();
    let mut designs = Vec::new();
    let mut deferred: Option<String> = None;
    for (index, raw) in raw_designs.iter().enumerate() {
        let path = format!("designs[{index}]");
        let record = require_record(Some(raw), &path)?;
        let id = require_id(record.get("id"), &format!("{path}.id"))?;
        if !design_ids.insert(id.clone()) {
            return malformed(&format!("{path}.id"), &format!("repeats design \"{id}\""));
        }
        let name = require_string(record.get("name"), &format!("{path}.name"))?;
        let design = match normalize_design_document(record.get("design"), &format!("{path}.design"))? {
            Ok(design) => design,
            Err(problem) => {
                deferred.get_or_insert(problem);
                crate::design::empty_design()
            }
        };
        let scenarios = require_unique_list(
            record.get("scenarios"),
            &format!("{path}.scenarios"),
            |item, item_path| {
                Ok(ExportSource {
                    id: require_id(item.get("id"), &format!("{item_path}.id"))?,
                    name: require_bounded_name(item.get("name"), &format!("{item_path}.name"), SCENARIO_NAME_LIMIT)?,
                    source: require_string(item.get("source"), &format!("{item_path}.source"))?,
                })
            },
            |scenario| scenario.id.clone(),
        )?;
        let edge_functions = require_unique_list(
            record.get("edgeFunctions"),
            &format!("{path}.edgeFunctions"),
            |item, item_path| {
                let name = require_id(item.get("name"), &format!("{item_path}.name"))?;
                if !is_edge_function_name(&name) {
                    return malformed(&format!("{item_path}.name"), &format!("\"{name}\" must use lowercase letters, digits, hyphens, or underscores"));
                }
                Ok(ExportSource {
                    id: require_id(item.get("id"), &format!("{item_path}.id"))?,
                    name,
                    source: require_string(item.get("source"), &format!("{item_path}.source"))?,
                })
            },
            |edge_function| edge_function.name.clone(),
        )?;
        designs.push(PreparedImportDesign { id, name, design, scenarios, edge_functions });
    }

    let active_design_id = require_id(project.get("activeDesignId"), "project.activeDesignId")?;
    if !design_ids.contains(&active_design_id) {
        return malformed("project.activeDesignId", &format!("names design \"{active_design_id}\", which the file does not contain"));
    }

    let mut system_design = normalize_system_design(root.get("systemDesign").unwrap_or(&Value::Null)).map_err(|error| malformed_message("systemDesign", &error))?;
    for (index, component) in system_design.components.iter().enumerate() {
        if let Some(linked) = &component.design_id {
            if !design_ids.contains(linked) {
                return malformed(&format!("systemDesign.components[{index}].designId"), &format!("links design \"{linked}\", which the file does not contain"));
            }
        }
    }

    let walkthroughs = normalize_walkthroughs(root.get("walkthroughs").unwrap_or(&Value::Null)).map_err(|error| malformed_message("walkthroughs", &error))?;

    if let Some(problem) = deferred {
        return Err(problem);
    }

    // Fresh identities: the Project and each Design are new, so nothing an import creates can
    // overwrite what already exists.
    let new_design_ids: HashMap<String, String> = designs.iter().map(|design| (design.id.clone(), create_id())).collect();
    let project_id = create_id();
    for component in &mut system_design.components {
        if let Some(linked) = &component.design_id {
            component.design_id = Some(new_design_ids[linked].clone());
        }
    }
    let designs = designs
        .into_iter()
        .map(|design| PreparedImportDesign { id: new_design_ids[&design.id].clone(), ..design })
        .collect();
    Ok(PreparedImport {
        project_id,
        project_name,
        active_design_id: new_design_ids[&active_design_id].clone(),
        active_view,
        designs,
        system_design,
        walkthroughs,
    })
}
