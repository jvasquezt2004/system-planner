//! Validation of the schema objects a Design edit replaces wholesale (indexes, enum types, unique
//! constraints, policies, Functions, triggers) and the cascades of removing a table or column.
//! Ported from the helpers in `src/bun/workspace.ts`; the messages and the order the checks run in
//! are the original's, because the view shows them to the designer.
//!
//! Inputs are raw JSON values: the original validates what the view sends before trusting its shape.

use std::collections::HashSet;

use serde_json::{Map, Value};

use crate::design::{
    Design, DesignColumn, DesignEnumType, DesignFunction, DesignIndex, DesignPolicy, DesignTable, DesignTrigger, DesignUniqueConstraint,
    FunctionArgument, IndexKey, IndexOptions, TriggerEvent,
};
use crate::js::{self, SPACE_CLASS};
use crate::relationships::{removal_plan, RemovalTarget};

type Result<T> = std::result::Result<T, String>;

/* ------------------------------------------------------------- primitives */

/// `requireName`: text, trimmed, not blank.
fn require_text(value: Option<&Value>, label: &str) -> Result<String> {
    let Some(Value::String(text)) = value else { return Err(format!("{label} must be text.")) };
    let name = js::trim(text);
    if name.is_empty() { Err(format!("{label} is required.")) } else { Ok(name.to_owned()) }
}

/// A non-null object that is not an array.
fn structured(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `typeof value === "string" && value.trim()` and not seen before; the id is kept as written.
fn fresh_id(value: Option<&Value>, seen: &mut HashSet<String>) -> Option<String> {
    let Some(Value::String(id)) = value else { return None };
    if js::trim(id).is_empty() || !seen.insert(id.clone()) {
        return None;
    }
    Some(id.clone())
}

fn require_column<'a>(table: &'a DesignTable, id: &Value) -> Result<&'a DesignColumn> {
    id.as_str()
        .and_then(|id| table.columns.iter().find(|column| column.id == id))
        .ok_or_else(|| "That column could not be found.".to_owned())
}

fn optional_bool(map: &Map<String, Value>, key: &str, message: &str) -> Result<Option<bool>> {
    match map.get(key) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(message.to_owned()),
    }
}

fn string_of(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key).and_then(Value::as_str).map(str::to_owned)
}

/* ---------------------------------------------------------------- indexes */

const INDEX_METHODS: [&str; 8] = ["btree", "hash", "gin", "gist", "spgist", "brin", "hnsw", "ivfflat"];

/// Validates and copies index action data before it enters the design history.
pub fn normalize_indexes(values: &Value, table: &DesignTable) -> Result<Vec<DesignIndex>> {
    let Some(values) = values.as_array() else { return Err("Indexes must be a list.".into()) };
    let mut ids = HashSet::new();
    values
        .iter()
        .map(|value| {
            let Some(index) = structured(value) else { return Err("Each index must be a structured value.".to_owned()) };
            let Some(id) = fresh_id(index.get("id"), &mut ids) else { return Err("Index ids must be non-empty and unique.".to_owned()) };
            let method = index.get("method").and_then(Value::as_str).filter(|method| INDEX_METHODS.contains(method));
            let Some(method) = method else { return Err("That index access method is not supported.".to_owned()) };
            let Some(keys) = index.get("keys").and_then(Value::as_array) else { return Err("Index keys must be a list.".to_owned()) };
            let keys = keys.iter().map(|key| normalize_index_key(key, table)).collect::<Result<Vec<_>>>()?;
            let name = match index.get("name") {
                None => None,
                Some(name) => Some(require_text(Some(name), "Index name")?),
            };
            let unique = optional_bool(index, "unique", "Index uniqueness must be true or false.")?;
            let nulls_not_distinct = optional_bool(index, "nullsNotDistinct", "Index NULL treatment must be true or false.")?;
            let include_column_ids = match js::nullish(index.get("includeColumnIds")) {
                None => None,
                Some(Value::Array(ids)) => {
                    for id in ids {
                        require_column(table, id)?;
                    }
                    Some(ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect())
                }
                Some(_) => return Err("Index INCLUDE columns must be a list.".to_owned()),
            };
            let options = match index.get("with") {
                None => None,
                Some(options) => Some(normalize_index_options(options)?),
            };
            Ok(DesignIndex { id, name, method: method.to_owned(), keys, unique, nulls_not_distinct, include_column_ids, options })
        })
        .collect()
}

fn normalize_index_key(key: &Value, table: &DesignTable) -> Result<IndexKey> {
    let column_id = key.as_object().and_then(|key| key.get("columnId")).filter(|id| id.is_string());
    let (Some(key), Some(column_id)) = (key.as_object(), column_id) else { return Err("Each index key needs a column id.".into()) };
    require_column(table, column_id)?;
    let choice = |name: &str, allowed: [&str; 2], message: &str| match key.get(name) {
        None => Ok(None),
        Some(Value::String(value)) if allowed.contains(&value.as_str()) => Ok(Some(value.clone())),
        Some(_) => Err(message.to_owned()),
    };
    let order = choice("order", ["asc", "desc"], "That index key ordering is not supported.")?;
    let nulls = choice("nulls", ["first", "last"], "That index NULL ordering is not supported.")?;
    let operator_class = match key.get("operatorClass") {
        None => None,
        Some(Value::String(class)) => Some(class.clone()),
        Some(_) => return Err("Index operator classes must be text.".into()),
    };
    Ok(IndexKey { column_id: column_id.as_str().unwrap_or_default().to_owned(), order, nulls, operator_class })
}

/// Validates the supported types of structured index storage options.
fn normalize_index_options(value: &Value) -> Result<IndexOptions> {
    let Some(options) = structured(value) else { return Err("Index storage options must be structured values.".into()) };
    let mut normalized = IndexOptions::new();
    for (key, option) in options {
        if !["fillfactor", "fastupdate", "pagesPerRange", "lists", "m", "efConstruction"].contains(&key.as_str()) {
            return Err(format!("Index storage option {key} is not supported."));
        }
        if key == "fastupdate" {
            if !option.is_boolean() {
                return Err("Index fastupdate must be true or false.".into());
            }
        } else if js::integer(option).is_none() {
            return Err(format!("Index storage option {key} must be an integer."));
        }
        normalized.insert(key.clone(), option.clone());
    }
    Ok(normalized)
}

/* ------------------------------------------------------------- enum types */

/// Validates and copies enum definitions and their ordered labels.
pub fn normalize_enum_types(values: &Value) -> Result<Vec<DesignEnumType>> {
    let Some(values) = values.as_array() else { return Err("Enum types must be a list.".into()) };
    let mut ids = HashSet::new();
    values
        .iter()
        .map(|value| {
            let Some(enum_type) = structured(value) else { return Err("Each enum type must be a structured value.".to_owned()) };
            let Some(id) = fresh_id(enum_type.get("id"), &mut ids) else { return Err("Enum type ids must be non-empty and unique.".to_owned()) };
            let name = require_text(enum_type.get("name"), "Enum type name")?;
            let labels = enum_type
                .get("labels")
                .and_then(Value::as_array)
                .filter(|labels| !labels.is_empty())
                .and_then(|labels| labels.iter().map(|label| label.as_str().filter(|text| !js::trim(text).is_empty()).map(str::to_owned)).collect::<Option<Vec<_>>>());
            let Some(labels) = labels else { return Err("Enum labels must be a non-empty list of text values.".to_owned()) };
            Ok(DesignEnumType { id, name, labels })
        })
        .collect()
}

/* ------------------------------------------------------ unique constraints */

/// Validates composite unique constraint references and copies their ids.
pub fn normalize_unique_constraints(values: &Value, table: &DesignTable) -> Result<Vec<DesignUniqueConstraint>> {
    let Some(values) = values.as_array() else { return Err("Unique constraints must be a list.".into()) };
    let mut ids = HashSet::new();
    values
        .iter()
        .map(|value| {
            let Some(constraint) = structured(value) else { return Err("Each unique constraint must be a structured value.".to_owned()) };
            let Some(id) = fresh_id(constraint.get("id"), &mut ids) else { return Err("Unique constraint ids must be non-empty and unique.".to_owned()) };
            let Some(column_ids) = constraint.get("columnIds").and_then(Value::as_array) else {
                return Err("Unique constraint column ids must be a list.".to_owned());
            };
            for column_id in column_ids {
                require_column(table, column_id)?;
            }
            let name = match constraint.get("name") {
                None => None,
                Some(name) => Some(require_text(Some(name), "Unique constraint name")?),
            };
            let nulls_not_distinct = optional_bool(constraint, "nullsNotDistinct", "Unique constraint NULL treatment must be true or false.")?;
            Ok(DesignUniqueConstraint { id, name, column_ids: column_ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect(), nulls_not_distinct })
        })
        .collect()
}

/* ---------------------------------------------------------------- policies */

/// Validates policy names and roles before preserving handwritten conditions.
pub fn normalize_policies(values: &Value) -> Result<Vec<DesignPolicy>> {
    let Some(values) = values.as_array() else { return Err("Policies must be a list.".into()) };
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    values
        .iter()
        .map(|value| {
            let Some(policy) = structured(value) else { return Err("Policy definition is invalid.".to_owned()) };
            let id = require_text(policy.get("id"), "Policy id")?;
            let name = require_text(policy.get("name"), "Policy name")?;
            if ids.contains(&id) {
                return Err(format!("Policy id \"{id}\" is duplicated."));
            }
            if names.contains(&name) {
                return Err(format!("Policy name \"{name}\" is duplicated."));
            }
            ids.insert(id.clone());
            names.insert(name.clone());
            let command = string_of(policy, "command").filter(|command| ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].contains(&command.as_str()));
            let Some(command) = command else { return Err(format!("Policy \"{name}\" has an unsupported command.")) };
            let mode = string_of(policy, "mode").filter(|mode| ["permissive", "restrictive"].contains(&mode.as_str()));
            let Some(mode) = mode else { return Err(format!("Policy \"{name}\" has an unsupported mode.")) };
            let Some(roles) = policy.get("roles").and_then(Value::as_array) else { return Err("Policy roles must be a list.".to_owned()) };
            let mut unique_roles: Vec<String> = Vec::new();
            for role in roles {
                let role = require_text(Some(role), "Policy role")?;
                if !unique_roles.contains(&role) {
                    unique_roles.push(role);
                }
            }
            // The original keeps the conditions as written; a missing one is an empty condition here.
            Ok(DesignPolicy {
                id,
                name,
                command,
                roles: unique_roles,
                mode,
                using: string_of(policy, "using").unwrap_or_default(),
                with_check: string_of(policy, "withCheck").unwrap_or_default(),
            })
        })
        .collect()
}

/* --------------------------------------------------------------- Functions */

/// Validates function metadata and tracks referenced project tables.
pub fn normalize_functions(values: &Value, design: &Design) -> Result<Vec<DesignFunction>> {
    let Some(values) = values.as_array() else { return Err("Functions must be a list.".into()) };
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let empty = Map::new();
    values
        .iter()
        .map(|value| {
            let function = match value {
                Value::Object(map) => map,
                Value::Array(_) => &empty,
                _ => return Err("Function definition is invalid.".to_owned()),
            };
            let id = require_text(function.get("id"), "Function id")?;
            let name = require_text(function.get("name"), "Function name")?;
            if ids.contains(&id) {
                return Err(format!("Function id \"{id}\" is duplicated."));
            }
            if names.contains(&name) {
                return Err(format!("Function name \"{name}\" is duplicated."));
            }
            ids.insert(id.clone());
            names.insert(name.clone());
            let Some(raw_arguments) = function.get("arguments").and_then(Value::as_array) else {
                return Err(format!("Function \"{name}\" arguments must be a list."));
            };
            let mut argument_names = HashSet::new();
            let mut arguments = Vec::new();
            for argument in raw_arguments {
                let argument = structured(argument);
                let argument_name = require_text(argument.and_then(|argument| argument.get("name")), "Function argument name")?;
                if !argument_names.insert(argument_name.clone()) {
                    return Err(format!("Function \"{name}\" has duplicate argument \"{argument_name}\"."));
                }
                arguments.push(FunctionArgument {
                    name: argument_name,
                    argument_type: require_text(argument.and_then(|argument| argument.get("type")), "Function argument type")?,
                });
            }
            let language = string_of(function, "language").filter(|language| ["sql", "plpgsql"].contains(&language.as_str()));
            let Some(language) = language else { return Err(format!("Function \"{name}\" has an unsupported language.")) };
            let volatility = string_of(function, "volatility").filter(|value| ["volatile", "stable", "immutable"].contains(&value.as_str()));
            let Some(volatility) = volatility else { return Err(format!("Function \"{name}\" has unsupported volatility.")) };
            let security = string_of(function, "security").filter(|value| ["invoker", "definer"].contains(&value.as_str()));
            let Some(security) = security else { return Err(format!("Function \"{name}\" has unsupported security mode.")) };
            let (Some(returns_set), Some(body)) = (function.get("returnsSet").and_then(Value::as_bool), string_of(function, "body")) else {
                return Err(format!("Function \"{name}\" definition is incomplete."));
            };
            let return_type = require_text(function.get("returnType"), "Function return type")?;
            let returns_trigger = return_type.to_lowercase() == "trigger";
            if returns_trigger && language != "plpgsql" {
                return Err(format!("Function \"{name}\" returning trigger must use PL/pgSQL."));
            }
            let previous = design.functions.as_deref().and_then(|functions| functions.iter().find(|candidate| candidate.id == id));
            let unchanged_references = previous.is_some_and(|previous| {
                previous.body == body && previous.return_type == return_type && serde_json::to_string(&previous.arguments).ok() == serde_json::to_string(&arguments).ok()
            });
            let table_dependencies = match previous.and_then(|previous| previous.table_dependencies.clone()).filter(|_| unchanged_references) {
                Some(dependencies) => dependencies,
                None => {
                    let types: Vec<String> = std::iter::once(return_type.clone()).chain(arguments.iter().map(|argument| argument.argument_type.clone())).collect();
                    function_table_dependencies(&body, &design.tables, &types)
                }
            };
            Ok(DesignFunction {
                id,
                name,
                arguments,
                returns_set: if returns_trigger { false } else { returns_set || returns_table(&return_type) },
                return_type,
                language,
                volatility,
                security,
                body,
                table_dependencies: Some(table_dependencies),
            })
        })
        .collect()
}

/// `/^TABLE\s*\(/i`
fn returns_table(return_type: &str) -> bool {
    let pattern = format!(r"(?i)^TABLE{SPACE_CLASS}*\(");
    regex::Regex::new(&pattern).is_ok_and(|pattern| pattern.is_match(return_type))
}

/// The project tables a Function body or signature mentions.
pub fn function_table_dependencies(body: &str, tables: &[DesignTable], types: &[String]) -> Vec<String> {
    tables
        .iter()
        .filter(|table| {
            if types.iter().any(|candidate| {
                let candidate = js::trim(candidate);
                candidate.strip_suffix("[]").unwrap_or(candidate) == table.name
            }) {
                return true;
            }
            let escaped: String = table.name.chars().flat_map(|c| if ".*+?^${}()|[]\\".contains(c) { vec!['\\', c] } else { vec![c] }).collect();
            let relation = format!("(?:\"{escaped}\"|{escaped})");
            // `\b` before the keyword and `(?![\w$])` after the name, as consuming groups: the
            // pattern is only ever asked whether it matches somewhere.
            let space = SPACE_CLASS;
            let pattern = format!(
                r"(?i)(?:^|[^A-Za-z0-9_])(?:FROM|JOIN|UPDATE|INTO|REFERENCES){space}+(?:public{space}*\.{space}*)?{relation}(?:[^A-Za-z0-9_$]|\z)"
            );
            regex::Regex::new(&pattern).is_ok_and(|pattern| pattern.is_match(body))
        })
        .map(|table| table.id.clone())
        .collect()
}

/* ---------------------------------------------------------------- triggers */

fn is_trigger_function(function: &DesignFunction) -> bool {
    js::trim(&function.return_type).to_lowercase() == "trigger" && function.language == "plpgsql" && function.arguments.is_empty()
}

/// Validates triggers against the tables and Functions of the design they belong to.
pub fn normalize_triggers(values: &Value, design: &Design) -> Result<Vec<DesignTrigger>> {
    let Some(values) = values.as_array() else { return Err("Triggers must be a list.".into()) };
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    values
        .iter()
        .map(|value| {
            let Some(trigger) = structured(value) else { return Err("Trigger definition is invalid.".to_owned()) };
            let id = require_text(trigger.get("id"), "Trigger id")?;
            let name = require_text(trigger.get("name"), "Trigger name")?;
            let table_id = trigger.get("tableId");
            let scoped_name = format!("{}:{name}", table_id.map_or("undefined".to_owned(), js::to_js_string));
            if ids.contains(&id) || names.contains(&scoped_name) {
                return Err(format!("Trigger \"{name}\" is duplicated on this table."));
            }
            ids.insert(id.clone());
            names.insert(scoped_name);
            let table = table_id.and_then(Value::as_str).and_then(|table_id| design.tables.iter().find(|table| table.id == table_id));
            let Some(table) = table else { return Err(format!("Trigger \"{name}\" needs an existing table.")) };
            let function_id = trigger.get("functionId").and_then(Value::as_str);
            let function_ok = design
                .functions
                .as_deref()
                .is_some_and(|functions| functions.iter().any(|function| Some(function.id.as_str()) == function_id && is_trigger_function(function)));
            if !function_ok {
                return Err(format!("Trigger \"{name}\" needs a no-argument PL/pgSQL Function returning trigger."));
            }
            let timing = string_of(trigger, "timing").filter(|timing| ["BEFORE", "AFTER", "INSTEAD OF"].contains(&timing.as_str()));
            let Some(timing) = timing else { return Err(format!("Trigger \"{name}\" has invalid timing.")) };
            let level = string_of(trigger, "level").filter(|level| ["ROW", "STATEMENT"].contains(&level.as_str()));
            let Some(level) = level else { return Err(format!("Trigger \"{name}\" has invalid level.")) };
            let raw_events = trigger.get("events").and_then(Value::as_array).filter(|events| !events.is_empty());
            let Some(raw_events) = raw_events else { return Err(format!("Trigger \"{name}\" needs at least one event.")) };
            let mut events = Vec::new();
            for event in raw_events {
                let event = structured(event);
                let kind = event.and_then(|event| event.get("event")).and_then(Value::as_str).filter(|kind| ["INSERT", "UPDATE", "DELETE", "TRUNCATE"].contains(kind));
                let Some(kind) = kind else { return Err(format!("Trigger \"{name}\" has an invalid event.")) };
                let mut column_ids: Vec<&Value> = Vec::new();
                for column_id in event.and_then(|event| js::nullish(event.get("columnIds"))).and_then(Value::as_array).into_iter().flatten() {
                    if !column_ids.contains(&column_id) {
                        column_ids.push(column_id);
                    }
                }
                if kind != "UPDATE" && !column_ids.is_empty() {
                    return Err("Only UPDATE events can select columns.".into());
                }
                if column_ids.iter().any(|id| id.as_str().is_none_or(|id| !table.columns.iter().any(|column| column.id == id))) {
                    return Err(format!("Trigger \"{name}\" references a missing column."));
                }
                if !column_ids.is_empty() && level != "ROW" {
                    return Err("UPDATE OF columns requires a row-level trigger.".into());
                }
                events.push(TriggerEvent {
                    event: kind.to_owned(),
                    column_ids: (!column_ids.is_empty()).then(|| column_ids.iter().filter_map(|id| id.as_str().map(str::to_owned)).collect()),
                });
            }
            let distinct: HashSet<&str> = events.iter().map(|event| event.event.as_str()).collect();
            if distinct.len() != events.len() {
                return Err(format!("Trigger \"{name}\" has duplicate events."));
            }
            let when = trigger.get("when").and_then(Value::as_str).map_or(String::new(), |when| js::trim(when).to_owned());
            Ok(DesignTrigger {
                id,
                name,
                table_id: table.id.clone(),
                timing,
                events,
                level,
                function_id: function_id.unwrap_or_default().to_owned(),
                when,
            })
        })
        .collect()
}

/* ---------------------------------------------------------------- removals */

/// A destructive edit that affects other schema items needs explicit confirmation.
pub fn require_confirmed_removal(design: &Design, target: &RemovalTarget, confirmed: bool) -> Result<()> {
    if confirmed {
        return Ok(());
    }
    let plan = removal_plan(design, target);
    if plan.relationships.is_empty() && plan.indexes.is_empty() && plan.unique_constraints.is_empty() && plan.triggers.is_empty() {
        return Ok(());
    }
    let label = match target {
        RemovalTarget::Table { .. } => format!("table \"{}\"", plan.target),
        RemovalTarget::Function { .. } => format!("Function \"{}\"", plan.target),
        RemovalTarget::Column { .. } => format!("column \"{}\"", plan.target),
    };
    let count = plan.relationships.len() + plan.indexes.len() + plan.unique_constraints.len() + plan.triggers.len();
    let summary: Vec<String> = plan
        .relationships
        .iter()
        .map(|affected| {
            if affected.cardinality == "many-to-many" {
                format!(
                    "many-to-many {} ↔ {} via {}",
                    affected.referencing_table,
                    affected.referenced_table,
                    affected.junction_table.as_deref().unwrap_or("(missing junction)")
                )
            } else {
                format!("{}.{} → {}.{}", affected.referencing_table, affected.referencing_column, affected.referenced_table, affected.referenced_column.as_deref().unwrap_or("(no primary key)"))
            }
        })
        .chain(plan.indexes.iter().map(|index| format!("index {}", index.name)))
        .chain(plan.unique_constraints.iter().map(|constraint| format!("unique constraint {}", constraint.name)))
        .chain(plan.triggers.iter().map(|trigger| format!("trigger {} on {}", trigger.name, trigger.table)))
        .collect();
    Err(format!("Removing {label} also affects {count} schema item(s) ({}). Confirm the removal to continue.", summary.join(", ")))
}

/// The cascade set is exactly what the confirmation listed, never a second rule.
fn affected_relationship_ids(design: &Design, target: &RemovalTarget) -> (HashSet<String>, HashSet<String>) {
    let mut relationship_ids = HashSet::new();
    let mut association_ids = HashSet::new();
    for affected in removal_plan(design, target).relationships {
        if affected.cardinality != "many-to-many" {
            relationship_ids.insert(affected.relationship_id);
            continue;
        }
        if let Some(association) = design.many_to_many_relationships.iter().find(|candidate| candidate.id == affected.relationship_id) {
            relationship_ids.insert(association.left_relationship_id.clone());
            relationship_ids.insert(association.right_relationship_id.clone());
        }
        association_ids.insert(affected.relationship_id);
    }
    (relationship_ids, association_ids)
}

/// Removes the table together with the relationships that participate in it.
pub fn remove_table_and_its_relationships(design: &Design, table: &DesignTable) -> Design {
    let (relationship_ids, association_ids) = affected_relationship_ids(design, &RemovalTarget::Table { table_id: table.id.clone() });
    Design {
        tables: design.tables.iter().filter(|candidate| candidate.id != table.id).cloned().collect(),
        relationships: design.relationships.iter().filter(|relationship| !relationship_ids.contains(&relationship.id)).cloned().collect(),
        many_to_many_relationships: design.many_to_many_relationships.iter().filter(|association| !association_ids.contains(&association.id)).cloned().collect(),
        triggers: Some(design.triggers.iter().flatten().filter(|trigger| trigger.table_id != table.id).cloned().collect()),
        ..design.clone()
    }
}

/// Removes the column together with the relationships, index entries and constraints that use it.
pub fn remove_column_and_its_relationships(design: &Design, table: &DesignTable, column: &DesignColumn) -> Design {
    let (relationship_ids, association_ids) =
        affected_relationship_ids(design, &RemovalTarget::Column { table_id: table.id.clone(), column_id: column.id.clone() });
    let tables = design
        .tables
        .iter()
        .map(|candidate| {
            if candidate.id != table.id {
                return candidate.clone();
            }
            let indexes = candidate
                .indexes
                .iter()
                .flatten()
                .filter_map(|index| {
                    let keys: Vec<IndexKey> = index.keys.iter().filter(|key| key.column_id != column.id).cloned().collect();
                    if keys.is_empty() {
                        return None;
                    }
                    let include = index.include_column_ids.iter().flatten().filter(|id| **id != column.id).cloned().collect();
                    Some(DesignIndex { keys, include_column_ids: Some(include), ..index.clone() })
                })
                .collect();
            DesignTable {
                columns: candidate.columns.iter().filter(|other| other.id != column.id).cloned().collect(),
                indexes: Some(indexes),
                unique_constraints: Some(candidate.unique_constraints.iter().flatten().filter(|constraint| !constraint.column_ids.contains(&column.id)).cloned().collect()),
                ..candidate.clone()
            }
        })
        .collect();
    // Removing the last UPDATE OF column removes the filter, so the trigger fires on any UPDATE.
    let triggers = design
        .triggers
        .iter()
        .flatten()
        .map(|trigger| DesignTrigger {
            events: trigger
                .events
                .iter()
                .map(|event| {
                    let uses_column = event.event == "UPDATE" && event.column_ids.as_ref().is_some_and(|ids| ids.contains(&column.id));
                    if !uses_column {
                        return event.clone();
                    }
                    let remaining: Vec<String> = event.column_ids.iter().flatten().filter(|id| **id != column.id).cloned().collect();
                    TriggerEvent { event: event.event.clone(), column_ids: (!remaining.is_empty()).then_some(remaining) }
                })
                .collect(),
            ..trigger.clone()
        })
        .collect();
    Design {
        tables,
        relationships: design.relationships.iter().filter(|relationship| !relationship_ids.contains(&relationship.id)).cloned().collect(),
        many_to_many_relationships: design.many_to_many_relationships.iter().filter(|association| !association_ids.contains(&association.id)).cloned().collect(),
        triggers: Some(triggers),
        ..design.clone()
    }
}

/// `requireRemovalTarget`: the target must exist.
pub fn require_removal_target(design: &Design, target: &RemovalTarget) -> Result<()> {
    match target {
        RemovalTarget::Function { function_id } => {
            if design.functions.iter().flatten().any(|function| &function.id == function_id) {
                Ok(())
            } else {
                Err("Function does not exist.".into())
            }
        }
        RemovalTarget::Table { table_id } => {
            design.tables.iter().find(|table| &table.id == table_id).map(|_| ()).ok_or_else(|| "That table could not be found.".to_owned())
        }
        RemovalTarget::Column { table_id, column_id } => {
            let table = design.tables.iter().find(|table| &table.id == table_id).ok_or_else(|| "That table could not be found.".to_owned())?;
            table.columns.iter().find(|column| &column.id == column_id).map(|_| ()).ok_or_else(|| "That column could not be found.".to_owned())
        }
    }
}
