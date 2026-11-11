//! PostgreSQL generation from a Design (`src/bun/sql.ts`).
//!
//! Validation, identifier planning and rendering follow the original's order, so
//! the same Design yields the same errors, warnings and statements in the same
//! sequence. An incomplete draft produces explicit errors instead of partial SQL;
//! a lenient render shows an invalid draft as the SQL it would be.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::column_defaults::{column_default_problem, render_default_expression};
use crate::column_types::{find_column_type, is_supported_column_type, render_column_type};
use crate::design::{
    Design, DesignColumn, DesignIndex, DesignManyToManyAssociation, DesignTable, DesignTrigger, DesignUniqueConstraint,
    DesignFunction,
};
use crate::index_methods::{find_index_method, index_operator_classes, IndexMethodDefinition};
use crate::js;
use crate::postgres_identifiers::{
    postgres_generated_object_name, truncate_postgres_identifier, unique_postgres_identifier, MAX_IDENTIFIER_BYTES,
};
use crate::relationships::{
    relationship_constraint_name, relationship_unique_constraint_name, resolve_relationship, resolve_relationships, RelationshipView,
};

/// The outcome of generating SQL: the statements and any advice, or the problems found.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlGeneration {
    /// `warnings` is advice that does not stop the SQL: PostgreSQL accepts it, but it is usually a mistake.
    Ok { sql: String, warnings: Vec<String> },
    Errors(Vec<String>),
}

impl Serialize for SqlGeneration {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Ok { sql, warnings } => serde_json::json!({ "ok": true, "sql": sql, "warnings": warnings }).serialize(serializer),
            Self::Errors(errors) => serde_json::json!({ "ok": false, "errors": errors }).serialize(serializer),
        }
    }
}

/// Rendering can fail only on a draft that validation would have rejected, where the
/// TypeScript version throws a `TypeError`. Strict generation never reaches it.
type Rendered<T> = Result<T, String>;

fn unresolved(what: &str) -> String {
    format!("Cannot render: {what} is missing from the Design.")
}

macro_rules! pattern {
    ($source:expr) => {{
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| Regex::new($source).expect("valid pattern"))
    }};
}

/// Quotes an identifier so a name can never become an unintended SQL statement.
pub fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn same_columns(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let (mut a, mut b) = (a.to_vec(), b.to_vec());
    a.sort();
    b.sort();
    a == b
}

/// Whether the table already makes exactly these columns unique, through a unique constraint or a unique index.
fn has_equivalent_unique(table: &DesignTable, column_ids: &[String]) -> bool {
    table.unique_constraints.as_deref().unwrap_or(&[]).iter().any(|constraint| same_columns(&constraint.column_ids, column_ids))
        || table
            .indexes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|index| index.unique == Some(true) && same_columns(&index.keys.iter().map(|key| key.column_id.clone()).collect::<Vec<_>>(), column_ids))
}

struct PendingPair<'a> {
    association: &'a DesignManyToManyAssociation,
    junction: &'a DesignTable,
}

/// The many-to-many links that still need a pair constraint of their own. A junction already
/// unique on its two columns does not get a second, identical constraint (and index).
fn pending_pair_associations(design: &Design) -> Vec<PendingPair<'_>> {
    design
        .many_to_many_relationships
        .iter()
        .filter_map(|association| {
            let junction = design.tables.iter().find(|table| table.id == association.junction_table_id)?;
            let ends: Vec<Option<&String>> = [&association.left_relationship_id, &association.right_relationship_id]
                .iter()
                .map(|id| design.relationships.iter().find(|relationship| &&relationship.id == id).map(|relationship| &relationship.referencing_column_id))
                .collect();
            if ends.iter().all(Option::is_some) {
                let ids: Vec<String> = ends.into_iter().flatten().cloned().collect();
                if has_equivalent_unique(junction, &ids) {
                    return None;
                }
            }
            Some(PendingPair { association, junction })
        })
        .collect()
}

/// Names of the tables, identity sequences, and indexes in PostgreSQL's schema namespace.
pub fn postgres_schema_relation_names(design: &Design) -> HashSet<String> {
    let relationships = resolve_relationships(design);
    let junctions: Vec<&DesignTable> = pending_pair_associations(design).into_iter().map(|pair| pair.junction).collect();
    plan_postgres_identifiers(design, &relationships, &junctions).relation_names
}

/// The exact constraint and index names the generated SQL uses, keyed by the design
/// object's id, so ORM schema code can name the same database objects.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaObjectNames {
    /// Foreign-key constraint name by relationship id.
    pub foreign_keys: HashMap<String, String>,
    /// One-to-one uniqueness constraint name by relationship id.
    pub relationship_uniques: HashMap<String, String>,
    /// Endpoint-pair unique constraint name by many-to-many association id.
    pub pair_constraints: HashMap<String, String>,
    /// Index name by index id.
    pub indexes: HashMap<String, String>,
    /// Composite unique constraint name by constraint id.
    pub unique_constraints: HashMap<String, String>,
}

pub fn plan_schema_object_names(design: &Design) -> SchemaObjectNames {
    let relationships = resolve_relationships(design);
    let associations = pending_pair_associations(design);
    let junctions: Vec<&DesignTable> = associations.iter().map(|pair| pair.junction).collect();
    let plan = plan_postgres_identifiers(design, &relationships, &junctions);
    let mut names = SchemaObjectNames::default();
    for entry in &plan.named_relationships {
        names.foreign_keys.insert(entry.view.relationship.id.clone(), entry.foreign_key_constraint_name.clone());
        if let Some(unique) = &entry.unique_constraint_name {
            names.relationship_uniques.insert(entry.view.relationship.id.clone(), unique.clone());
        }
    }
    for (index, pair) in associations.iter().enumerate() {
        names.pair_constraints.insert(pair.association.id.clone(), plan.pair_constraint_names.get(index).cloned().unwrap_or_default());
    }
    for entry in &plan.indexes {
        names.indexes.insert(entry.index.id.clone(), entry.name.clone());
    }
    for entry in &plan.unique_constraints {
        names.unique_constraints.insert(entry.constraint.id.clone(), entry.name.clone());
    }
    names
}

/// The text of a Design's schema.sql. An invalid draft is still written out as the SQL it would
/// be, under a comment naming its problems, so the file can be edited to fix them.
pub fn render_schema_file(design: &Design) -> Rendered<String> {
    match generate_design_sql(design, false)? {
        SqlGeneration::Ok { sql, warnings } => {
            if warnings.is_empty() {
                return Ok(sql);
            }
            let notes: Vec<String> = warnings.iter().map(|warning| format!("-- {warning}")).collect();
            Ok(format!("-- Worth a look (the SQL is valid; these are advice, not errors):\n{}\n\n{sql}", notes.join("\n")))
        }
        SqlGeneration::Errors(errors) => {
            // Some drafts cannot be rendered at all; the problems are still listed.
            let body = match generate_design_sql(design, true) {
                Ok(SqlGeneration::Ok { sql, .. }) => sql,
                _ => String::new(),
            };
            let listed: Vec<String> = errors.iter().map(|error| format!("-- {error}")).collect();
            Ok(format!("-- This Design has problems. Fix them in this file, then apply it:\n{}\n\n{body}", listed.join("\n")))
        }
    }
}

/// Insertion-ordered de-duplication, like `[...new Set(items)]`.
fn unique(items: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    items.into_iter().filter(|item| seen.insert(item.clone())).collect()
}

struct PairConstraint<'a> {
    association: &'a DesignManyToManyAssociation,
    junction: &'a DesignTable,
    left_column: &'a DesignColumn,
    right_column: &'a DesignColumn,
}

/// Generates PostgreSQL from the authoritative design. `lenient` renders an invalid draft anyway.
pub fn generate_design_sql(design: &Design, lenient: bool) -> Rendered<SqlGeneration> {
    // Errors are what PostgreSQL would reject. Warnings are best practice: never a reason to withhold SQL.
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let enum_types = design.enum_types.as_deref().unwrap_or(&[]);

    let mut table_names = HashSet::new();
    for table in &design.tables {
        validate_table(table, &mut table_names, &mut errors, enum_types, &mut warnings);
        validate_indexes(table, &mut errors);
        validate_unique_constraints(table, &mut errors);
    }
    let mut enum_names = HashSet::new();
    for enum_type in enum_types {
        let name = js::trim(&enum_type.name);
        if name.is_empty() || enum_names.contains(name) || table_names.contains(name) {
            errors.push(format!("Enum type name \"{}\" is empty or already used in the PostgreSQL schema.", enum_type.name));
        }
        enum_names.insert(name.to_owned());
        let distinct: HashSet<&String> = enum_type.labels.iter().collect();
        let invalid_labels = enum_type.name.contains('\0')
            || enum_type.labels.is_empty()
            || enum_type.labels.iter().any(|label| js::trim(label).is_empty() || label.contains('\0'))
            || distinct.len() != enum_type.labels.len();
        if invalid_labels {
            errors.push(format!("Enum type \"{}\" needs non-empty, unique labels.", enum_type.name));
        }
    }
    for function in design.functions.as_deref().unwrap_or(&[]) {
        if js::trim(&function.name).is_empty() || function.name.contains('\0') {
            errors.push(format!("Function name \"{}\" is invalid.", function.name));
        }
        for argument in &function.arguments {
            if js::trim(&argument.name).is_empty() || argument.name.contains('\0') {
                errors.push(format!("Function \"{}\" has an invalid argument name.", function.name));
            }
            if !is_function_type(&argument.argument_type) {
                errors.push(format!("Function \"{}\" has unsupported argument type \"{}\".", function.name, argument.argument_type));
            }
        }
        for dependency in function.table_dependencies.as_deref().unwrap_or(&[]) {
            if !design.tables.iter().any(|table| &table.id == dependency) {
                errors.push(format!("Function \"{}\" depends on a table that no longer exists.", function.name));
            }
        }
        if !is_function_type(&function.return_type) {
            errors.push(format!("Function \"{}\" has unsupported return type \"{}\".", function.name, function.return_type));
        }
    }
    for trigger in design.triggers.as_deref().unwrap_or(&[]) {
        let table = design.tables.iter().find(|candidate| candidate.id == trigger.table_id);
        let function = design.functions.as_deref().and_then(|functions| functions.iter().find(|candidate| candidate.id == trigger.function_id));
        if js::trim(&trigger.name).is_empty() || trigger.name.contains('\0') {
            errors.push(format!("Trigger name \"{}\" is invalid.", trigger.name));
        }
        if table.is_none() {
            errors.push(format!("Trigger \"{}\" depends on a table that no longer exists.", trigger.name));
        }
        let usable = function.is_some_and(|function| {
            js::trim(&function.return_type).to_lowercase() == "trigger" && function.language == "plpgsql" && function.arguments.is_empty()
        });
        if !usable {
            errors.push(format!("Trigger \"{}\" needs a no-argument PL/pgSQL Function returning trigger.", trigger.name));
        }
        if trigger.events.is_empty() {
            errors.push(format!("Trigger \"{}\" needs at least one event.", trigger.name));
        }
        for event in &trigger.events {
            for column_id in event.column_ids.as_deref().unwrap_or(&[]) {
                if !table.is_some_and(|table| table.columns.iter().any(|column| &column.id == column_id)) {
                    errors.push(format!("Trigger \"{}\" references a column that no longer exists.", trigger.name));
                }
            }
        }
        if trigger.when.contains('\0') {
            errors.push(format!("Trigger \"{}\" has an invalid WHEN condition.", trigger.name));
        }
    }

    let occupied_names = initial_postgres_relation_names(design);
    let mut explicit_schema_names = HashSet::new();
    for table in &design.tables {
        let names = table
            .indexes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|index| index.name.as_deref().map(js::trim))
            .chain(table.unique_constraints.as_deref().unwrap_or(&[]).iter().map(|constraint| constraint.name.as_deref().map(js::trim)));
        for name in names {
            let Some(name) = name.filter(|name| !name.is_empty()) else { continue };
            let bounded = truncate_postgres_identifier(name, MAX_IDENTIFIER_BYTES);
            if occupied_names.contains(&bounded) || explicit_schema_names.contains(&bounded) {
                errors.push(format!("Index or constraint name \"{name}\" is already used in the PostgreSQL schema."));
            }
            explicit_schema_names.insert(bounded);
        }
    }

    // A relationship that cannot be resolved stays in the saved draft and is reported here,
    // so an incompatible edit never silently drops the link.
    let mut relationships: Vec<RelationshipView> = Vec::new();
    for relationship in &design.relationships {
        if let Some(view) = validate_relationship(design, relationship, &mut errors, &mut warnings) {
            relationships.push(view);
        }
    }

    let mut pair_constraints: Vec<PairConstraint> = Vec::new();
    for association in &design.many_to_many_relationships {
        if let Some(constraint) = validate_many_to_many_association(design, association, &mut warnings) {
            pair_constraints.push(constraint);
        }
    }

    for view in &relationships {
        warn_foreign_key_index(view, &mut warnings);
    }
    let pending: HashSet<&str> = pending_pair_associations(design).iter().map(|pair| pair.association.id.as_str()).collect();
    let active_pairs: Vec<&PairConstraint> = pair_constraints.iter().filter(|pair| pending.contains(pair.association.id.as_str())).collect();

    // A lenient render shows an invalid draft as the SQL it would be, problems and all, so it can be edited.
    if !errors.is_empty() && !lenient {
        return Ok(SqlGeneration::Errors(unique(errors)));
    }

    let junctions: Vec<&DesignTable> = active_pairs.iter().map(|pair| pair.junction).collect();
    let plan = plan_postgres_identifiers(design, &relationships, &junctions);
    warn_redundant_indexes(&plan, &mut warnings);
    let mut pair_constraint_sql = Vec::new();
    for (index, pair) in active_pairs.iter().enumerate() {
        let name = plan.pair_constraint_names.get(index).ok_or("A pair constraint has no planned name.")?;
        pair_constraint_sql.push(render_pair_constraint(pair.junction, pair.left_column, pair.right_column, name));
    }
    let vector_used = design.tables.iter().any(|table| {
        table.columns.iter().any(|column| ["vector", "halfvec", "sparsevec"].contains(&column.column_type.as_str()))
            || table.indexes.as_deref().unwrap_or(&[]).iter().any(|index| index.method == "hnsw" || index.method == "ivfflat")
    });
    // A foreign key goes inside CREATE TABLE when the table it references is already created (itself
    // included); only references that are part of a cycle are added afterwards.
    let ordered_tables = dependency_order(design, &relationships);
    let table_position: HashMap<&str, usize> = ordered_tables.iter().enumerate().map(|(position, table)| (table.id.as_str(), position)).collect();
    let inline_foreign_keys: HashSet<&str> = plan
        .named_relationships
        .iter()
        .filter(|entry| {
            let referenced = table_position.get(entry.view.referenced_table.id.as_str()).map_or(f64::INFINITY, |p| *p as f64);
            let referencing = table_position.get(entry.view.referencing_table.id.as_str()).map_or(-1.0, |p| *p as f64);
            referenced <= referencing
        })
        .map(|entry| entry.view.relationship.id.as_str())
        .collect();
    let raw_sql = |phase: &str| -> Vec<String> {
        design
            .raw_statements
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .filter(|raw| raw.phase == phase)
            .map(|raw| if pattern!(&format!(r";{}*$", js::SPACE_CLASS)).is_match(&raw.sql) { js::trim(&raw.sql).to_owned() } else { format!("{};", js::trim(&raw.sql)) })
            .collect()
    };

    let mut statements: Vec<String> = Vec::new();
    if vector_used {
        statements.push("CREATE EXTENSION IF NOT EXISTS vector;".into());
    }
    statements.extend(raw_sql("before"));
    for enum_type in enum_types {
        let labels: Vec<String> = enum_type.labels.iter().map(|label| quote_string(label)).collect();
        statements.push(format!("CREATE TYPE {} AS ENUM ({});", quote_identifier(&enum_type.name), labels.join(", ")));
    }
    for table in &ordered_tables {
        let uniques: Vec<&UniqueEntry> = plan.unique_constraints.iter().filter(|entry| entry.table.id == table.id).collect();
        let inline: Vec<&NamedRelationship> = plan
            .named_relationships
            .iter()
            .filter(|entry| inline_foreign_keys.contains(entry.view.relationship.id.as_str()) && entry.view.referencing_table.id == table.id)
            .collect();
        statements.push(render_table(table, design, &uniques, &inline)?);
    }
    let mut sorted_indexes: Vec<&IndexEntry> = plan.indexes.iter().collect();
    sorted_indexes.sort_by_key(|entry| table_position.get(entry.table.id.as_str()).copied().unwrap_or(0));
    for entry in sorted_indexes {
        statements.push(render_index(entry.table, entry.index, &entry.name)?);
    }
    for entry in plan.named_relationships.iter().filter(|entry| !inline_foreign_keys.contains(entry.view.relationship.id.as_str())) {
        statements.push(render_relationship(&entry.view, &entry.foreign_key_constraint_name, entry.unique_constraint_name.as_deref())?);
    }
    statements.extend(pair_constraint_sql);
    for function in design.functions.as_deref().unwrap_or(&[]) {
        statements.push(render_function(function, design));
    }
    for trigger in design.triggers.as_deref().unwrap_or(&[]) {
        statements.push(render_trigger(trigger, design));
    }
    for table in &ordered_tables {
        statements.extend(render_policies(table));
    }
    statements.extend(raw_sql("after"));
    Ok(SqlGeneration::Ok { sql: format!("{}\n", statements.join("\n\n")), warnings: unique(warnings) })
}

fn render_function(function: &DesignFunction, design: &Design) -> String {
    let arguments: Vec<String> =
        function.arguments.iter().map(|argument| format!("{} {}", quote_identifier(&argument.name), render_function_type(&argument.argument_type, design))).collect();
    let mut delimiter = "$function$".to_owned();
    let mut suffix = 1;
    while function.body.contains(&delimiter) {
        delimiter = format!("$function_{suffix}$");
        suffix += 1;
    }
    let returns_table = pattern!(&format!(r"(?i)^TABLE{}*\(", js::SPACE_CLASS)).is_match(&function.return_type);
    [
        format!("CREATE FUNCTION {}({})", quote_identifier(&function.name), arguments.join(", ")),
        format!("RETURNS {}{}", if function.returns_set && !returns_table { "SETOF " } else { "" }, render_function_type(&function.return_type, design)),
        format!("LANGUAGE {}", function.language.to_uppercase()),
        function.volatility.to_uppercase(),
        format!("SECURITY {}", function.security.to_uppercase()),
        format!("AS {delimiter}{}{delimiter};", function.body),
    ]
    .join("\n")
}

fn render_trigger(trigger: &DesignTrigger, design: &Design) -> String {
    let table = design.tables.iter().find(|candidate| candidate.id == trigger.table_id);
    let function = design.functions.as_deref().and_then(|functions| functions.iter().find(|candidate| candidate.id == trigger.function_id));
    let (Some(table), Some(function)) = (table, function) else { return String::new() };
    let events: Vec<String> = trigger
        .events
        .iter()
        .map(|event| {
            let columns: Vec<&str> = event
                .column_ids
                .as_deref()
                .unwrap_or(&[])
                .iter()
                .filter_map(|id| table.columns.iter().find(|candidate| &candidate.id == id).map(|column| column.name.as_str()))
                .collect();
            if event.event == "UPDATE" && !columns.is_empty() {
                format!("UPDATE OF {}", columns.iter().map(|name| quote_identifier(name)).collect::<Vec<_>>().join(", "))
            } else {
                event.event.clone()
            }
        })
        .collect();
    format!(
        "CREATE TRIGGER {} {} {} ON {}{}{} EXECUTE FUNCTION {}();",
        quote_identifier(&trigger.name),
        trigger.timing,
        events.join(" OR "),
        quote_identifier(&table.name),
        if trigger.level == "ROW" { " FOR EACH ROW" } else { " FOR EACH STATEMENT" },
        if trigger.when.is_empty() { String::new() } else { format!(" WHEN ({})", trigger.when) },
        quote_identifier(&function.name)
    )
}

fn render_function_type(value: &str, design: &Design) -> String {
    let normalized = js::trim(value);
    let array_suffix = if normalized.ends_with("[]") { "[]" } else { "" };
    let base_type = if array_suffix.is_empty() { normalized } else { js::trim(&normalized[..normalized.len() - 2]) };
    let custom = design
        .tables
        .iter()
        .map(|table| table.name.as_str())
        .chain(design.enum_types.as_deref().unwrap_or(&[]).iter().map(|enum_type| enum_type.name.as_str()))
        .find(|name| *name == base_type);
    match custom {
        Some(name) => format!("{}{array_suffix}", quote_identifier(name)),
        None => normalized.to_owned(),
    }
}

fn is_function_type(value: &str) -> bool {
    let normalized = js::trim(value);
    if normalized.is_empty() || normalized.contains('\0') || normalized.contains([';', '\'', '"', '`', '$']) {
        return false;
    }
    if pattern!(&format!("^{}$", type_pattern())).is_match(normalized) {
        return true;
    }
    let Some(table) = pattern!(&format!(r"(?is)^TABLE{}*\((.*)\)$", js::SPACE_CLASS)).captures(normalized) else { return false };
    let space = js::SPACE_CLASS;
    let column_pattern = pattern!(&format!(r"^{space}*[A-Za-z_][A-Za-z0-9_]*{space}+{}{space}*$", type_pattern()));
    table[1].split(',').all(|column| column_pattern.is_match(column))
}

/// The type grammar accepted for function arguments and return values. JavaScript's `\s` is spelled
/// out, and digits are ASCII, as in the original expression.
fn type_pattern() -> String {
    let space = js::SPACE_CLASS;
    format!(r"[A-Za-z_][A-Za-z0-9_ .]*(?:\({space}*[0-9]+(?:{space}*,{space}*[0-9]+)?{space}*\))?(?:\[\])*")
}

/// PostgreSQL lets integer types reference each other, and text, varchar and char alike; other mixes it refuses.
fn reference_types_compatible(referencing: &DesignColumn, referenced: &DesignColumn) -> bool {
    if referencing.column_type == "enum" || referenced.column_type == "enum" {
        return referencing.column_type == referenced.column_type && referencing.enum_type_id == referenced.enum_type_id;
    }
    if referencing.column_type == referenced.column_type {
        return true;
    }
    let family = |column_type: &str| find_column_type(column_type).map(|info| info.family.as_str());
    let (a, b) = (family(&referencing.column_type), family(&referenced.column_type));
    a == b && (a == Some("integer") || a == Some("text"))
}

fn validate_relationship<'a>(
    design: &'a Design,
    relationship: &'a crate::design::DesignRelationship,
    errors: &mut Vec<String>,
    warnings: &mut Vec<String>,
) -> Option<RelationshipView<'a>> {
    let Some(view) = resolve_relationship(design, relationship) else {
        errors.push("A relationship refers to a table or column that no longer exists.".into());
        return None;
    };
    let label = format!("Relationship from \"{}\" to \"{}\"", view.referencing_table.name, view.referenced_table.name);
    let Some(referenced) = view.referenced_column else {
        errors.push(format!("{label} needs \"{}\" to have exactly one primary key column.", view.referenced_table.name));
        return None;
    };
    if !reference_types_compatible(view.referencing_column, referenced) {
        let referencing = view.referencing_column;
        errors.push(format!(
            "{label} needs matching types; \"{}\" is {} but \"{}\".\"{}\" is {}.",
            referencing.name, referencing.column_type, view.referenced_table.name, referenced.name, referenced.column_type
        ));
        return None;
    }
    let actions = [("delete", relationship.on_delete.as_deref().unwrap_or("NO ACTION")), ("update", relationship.on_update.as_deref().unwrap_or("NO ACTION"))];
    for (kind, action) in actions {
        let upper = kind.to_uppercase();
        if !["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].contains(&action) {
            errors.push(format!("{label} has an unsupported ON {upper} action."));
        }
        // PostgreSQL accepts both of these; they only fail later, when a row is actually deleted or updated.
        if action == "SET NULL" && !view.referencing_column.nullable {
            warnings.push(format!("{label} uses ON {upper} SET NULL but its foreign-key column is required."));
        }
        if action == "SET DEFAULT" && matches!(view.referencing_column.default, crate::column_defaults::ColumnDefault::None) {
            warnings.push(format!("{label} uses ON {upper} SET DEFAULT but its foreign-key column has no default."));
        }
    }
    Some(view)
}

/// The junction's foreign keys are ordinary relationships, so a malformed association only loses its pair constraint.
fn validate_many_to_many_association<'a>(
    design: &'a Design,
    association: &'a DesignManyToManyAssociation,
    warnings: &mut Vec<String>,
) -> Option<PairConstraint<'a>> {
    let junction = design.tables.iter().find(|table| table.id == association.junction_table_id);
    let left = design.relationships.iter().find(|relationship| relationship.id == association.left_relationship_id);
    let right = design.relationships.iter().find(|relationship| relationship.id == association.right_relationship_id);
    let (Some(junction), Some(left), Some(right)) = (junction, left, right) else {
        warnings.push("A many-to-many relationship refers to a missing junction or reference.".into());
        return None;
    };
    let left_column = junction.columns.iter().find(|column| column.id == left.referencing_column_id);
    let right_column = junction.columns.iter().find(|column| column.id == right.referencing_column_id);
    let distinct_ends = match (left_column, right_column) {
        (Some(l), Some(r)) => l.id != r.id,
        _ => false,
    };
    if left.id == right.id
        || left.referencing_table_id != junction.id
        || right.referencing_table_id != junction.id
        || left.referenced_table_id != association.left_table_id
        || right.referenced_table_id != association.right_table_id
        || left.cardinality != "one-to-many"
        || right.cardinality != "one-to-many"
        || !distinct_ends
    {
        warnings.push(format!(
            "Many-to-many junction \"{}\" needs two distinct references to its endpoint tables, so no pair constraint was added.",
            junction.name
        ));
        return None;
    }
    let (left_column, right_column) = (left_column?, right_column?);
    let plain = |column: &DesignColumn| {
        !column.nullable && !column.primary_key && !column.unique && !column.identity && matches!(column.default, crate::column_defaults::ColumnDefault::None)
    };
    if !plain(left_column) || !plain(right_column) {
        warnings.push(format!(
            "Many-to-many junction \"{}\" needs required references without individual defaults or uniqueness, so no pair constraint was added.",
            junction.name
        ));
        return None;
    }
    Some(PairConstraint { association, junction, left_column, right_column })
}

/* --------------------------------------------------------------- planning */

struct NamedRelationship<'a> {
    view: RelationshipView<'a>,
    foreign_key_constraint_name: String,
    unique_constraint_name: Option<String>,
}

struct IndexEntry<'a> {
    table: &'a DesignTable,
    index: &'a DesignIndex,
    name: String,
}

struct UniqueEntry<'a> {
    table: &'a DesignTable,
    constraint: &'a DesignUniqueConstraint,
    name: String,
}

struct Plan<'a> {
    named_relationships: Vec<NamedRelationship<'a>>,
    pair_constraint_names: Vec<String>,
    relation_names: HashSet<String>,
    indexes: Vec<IndexEntry<'a>>,
    unique_constraints: Vec<UniqueEntry<'a>>,
}

fn allocate_constraint_name(names: &mut HashSet<String>, preferred: &str) -> String {
    let name = unique_postgres_identifier(preferred, names);
    names.insert(name.clone());
    name
}

fn plan_postgres_identifiers<'a>(design: &'a Design, relationships: &[RelationshipView<'a>], junctions: &[&DesignTable]) -> Plan<'a> {
    let mut relation_names = initial_postgres_relation_names(design);
    let mut constraint_names = relation_names.clone();
    for table in &design.tables {
        let explicit = table
            .indexes
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .map(|index| index.name.as_deref())
            .chain(table.unique_constraints.as_deref().unwrap_or(&[]).iter().map(|constraint| constraint.name.as_deref()));
        for name in explicit.flatten().map(js::trim).filter(|name| !name.is_empty()) {
            let bounded = truncate_postgres_identifier(name, MAX_IDENTIFIER_BYTES);
            constraint_names.insert(bounded.clone());
            relation_names.insert(bounded);
        }
    }
    let mut named_relationships = Vec::new();
    for view in relationships {
        let foreign_key_constraint_name = allocate_constraint_name(&mut constraint_names, &relationship_constraint_name(view));
        let unique_constraint_name = view.owns_uniqueness.then(|| allocate_constraint_name(&mut constraint_names, &relationship_unique_constraint_name(view)));
        if let Some(name) = &unique_constraint_name {
            relation_names.insert(name.clone());
        }
        named_relationships.push(NamedRelationship { view: view.clone(), foreign_key_constraint_name, unique_constraint_name });
    }
    let mut pair_constraint_names = Vec::new();
    for junction in junctions {
        let name = allocate_constraint_name(&mut constraint_names, &format!("{}_pair_key", junction.name));
        relation_names.insert(name.clone());
        pair_constraint_names.push(name);
    }
    let mut indexes = Vec::new();
    for table in &design.tables {
        for index in table.indexes.as_deref().unwrap_or(&[]) {
            let key_names: Vec<&str> = index
                .keys
                .iter()
                .map(|key| table.columns.iter().find(|column| column.id == key.column_id).map_or("column", |column| column.name.as_str()))
                .collect();
            let explicit = index.name.as_deref().map(js::trim).filter(|name| !name.is_empty());
            let name = match explicit {
                Some(name) => {
                    constraint_names.insert(truncate_postgres_identifier(name, MAX_IDENTIFIER_BYTES));
                    name.to_owned()
                }
                None => allocate_constraint_name(&mut constraint_names, &format!("{}_{}_idx", table.name, key_names.join("_"))),
            };
            relation_names.insert(name.clone());
            indexes.push(IndexEntry { table, index, name });
        }
    }
    let mut unique_constraints = Vec::new();
    for table in &design.tables {
        for constraint in table.unique_constraints.as_deref().unwrap_or(&[]) {
            let names: Vec<&str> = constraint
                .column_ids
                .iter()
                .map(|id| table.columns.iter().find(|column| &column.id == id).map_or("column", |column| column.name.as_str()))
                .collect();
            let explicit = constraint.name.as_deref().map(js::trim).filter(|name| !name.is_empty());
            let name = match explicit {
                Some(name) => {
                    constraint_names.insert(truncate_postgres_identifier(name, MAX_IDENTIFIER_BYTES));
                    name.to_owned()
                }
                None => allocate_constraint_name(&mut constraint_names, &format!("{}_{}_key", table.name, names.join("_"))),
            };
            relation_names.insert(name.clone());
            unique_constraints.push(UniqueEntry { table, constraint, name });
        }
    }
    Plan { named_relationships, pair_constraint_names, relation_names, indexes, unique_constraints }
}

/// Tables, PostgreSQL-generated identity sequences, and indexes.
fn initial_postgres_relation_names(design: &Design) -> HashSet<String> {
    let mut names: HashSet<String> = design.tables.iter().map(|table| truncate_postgres_identifier(&table.name, MAX_IDENTIFIER_BYTES)).collect();
    for enum_type in design.enum_types.as_deref().unwrap_or(&[]) {
        names.insert(truncate_postgres_identifier(&enum_type.name, MAX_IDENTIFIER_BYTES));
    }
    for table in &design.tables {
        let table_name = truncate_postgres_identifier(&table.name, MAX_IDENTIFIER_BYTES);
        for column in table.columns.iter().filter(|column| column.identity) {
            add_postgres_generated_relation_name(&mut names, &table_name, Some(&truncate_postgres_identifier(&column.name, MAX_IDENTIFIER_BYTES)), "seq");
        }
        for column in table.columns.iter().filter(|column| column.unique && !column.primary_key) {
            add_postgres_generated_relation_name(&mut names, &table_name, Some(&truncate_postgres_identifier(&column.name, MAX_IDENTIFIER_BYTES)), "key");
        }
        if table.columns.iter().any(|column| column.primary_key) {
            add_postgres_generated_relation_name(&mut names, &table_name, None, "pkey");
        }
    }
    names
}

fn add_postgres_generated_relation_name(names: &mut HashSet<String>, table_name: &str, column_name: Option<&str>, label: &str) {
    for index in 0usize.. {
        let generated_label = if index == 0 { label.to_owned() } else { format!("{label}{index}") };
        let Ok(name) = postgres_generated_object_name(table_name, column_name, &generated_label) else { return };
        if names.contains(&name) {
            continue;
        }
        names.insert(name);
        return;
    }
}

/* ------------------------------------------------------------- validation */

fn validate_unique_constraints(table: &DesignTable, errors: &mut Vec<String>) {
    let mut names = HashSet::new();
    for constraint in table.unique_constraints.as_deref().unwrap_or(&[]) {
        if constraint.column_ids.is_empty() {
            errors.push(format!("Unique constraint on \"{}\" needs at least one column.", table.name));
        }
        let distinct: HashSet<&String> = constraint.column_ids.iter().collect();
        let missing_or_duplicate =
            distinct.len() != constraint.column_ids.len() || constraint.column_ids.iter().any(|id| !table.columns.iter().any(|column| &column.id == id));
        if missing_or_duplicate {
            errors.push(format!("Composite unique constraint on \"{}\" refers to missing or duplicate columns.", table.name));
        }
        // `constraint.name &&`: an empty name is falsy.
        if let Some(name) = constraint.name.as_deref().filter(|name| !name.is_empty()) {
            if names.contains(name) {
                errors.push(format!("Composite unique constraint name \"{name}\" is repeated on \"{}\".", table.name));
            }
            names.insert(name.to_owned());
        }
    }
}

fn validate_indexes(table: &DesignTable, errors: &mut Vec<String>) {
    let mut names = HashSet::new();
    for index in table.indexes.as_deref().unwrap_or(&[]) {
        let label = format!("Index on table \"{}\"", table.name);
        let Some(method) = find_index_method(&index.method) else {
            errors.push(format!("{label} uses an unsupported access method."));
            continue;
        };
        if let Some(explicit) = index.name.as_deref().map(js::trim).filter(|name| !name.is_empty()) {
            if names.contains(explicit) {
                errors.push(format!("{label} name \"{explicit}\" is used more than once."));
            }
            names.insert(explicit.to_owned());
        }
        validate_index_keys(table, index, method, &label, errors);
        validate_index_options(index, &method.storage_options, &label, errors);
        if index.nulls_not_distinct == Some(true) && index.unique != Some(true) {
            errors.push(format!("{label} can use NULLS NOT DISTINCT only when it is unique."));
        }
    }
}

fn validate_index_keys(table: &DesignTable, index: &DesignIndex, method: &IndexMethodDefinition, label: &str, errors: &mut Vec<String>) {
    let columns: Vec<Option<&DesignColumn>> = index.keys.iter().map(|key| table.columns.iter().find(|column| column.id == key.column_id)).collect();
    if index.keys.is_empty() {
        errors.push(format!("{label} needs at least one key column."));
    }
    let distinct: HashSet<&String> = index.keys.iter().map(|key| &key.column_id).collect();
    if distinct.len() != index.keys.len() {
        errors.push(format!("{label} cannot use the same column more than once."));
    }
    if columns.iter().any(Option::is_none) {
        errors.push(format!("{label} refers to a missing key column."));
    }
    let bad_ordering = index.keys.iter().any(|key| {
        key.order.as_deref().is_some_and(|order| order != "asc" && order != "desc") || key.nulls.as_deref().is_some_and(|nulls| nulls != "first" && nulls != "last")
    });
    if bad_ordering {
        errors.push(format!("{label} has an unsupported key ordering option."));
    }
    if index.method == "hash" && (index.keys.len() != 1 || index.unique == Some(true)) {
        errors.push(format!("{label} using hash must have one key and cannot be unique."));
    }
    if index.unique == Some(true) && !method.unique {
        errors.push(format!("{label} can be unique only with btree."));
    }
    let truthy = |value: &Option<String>| value.as_deref().is_some_and(|text| !text.is_empty());
    if index.keys.iter().any(|key| (truthy(&key.order) || truthy(&key.nulls)) && !method.ordering) {
        errors.push(format!("{label} using {} does not support key sort ordering.", index.method));
    }
    for (position, column) in columns.iter().enumerate() {
        let Some(column) = column else { continue };
        let key = &index.keys[position];
        let array = column.type_parameters.as_ref().and_then(|parameters| parameters.array) == Some(true);
        let classes = index_operator_classes(&index.method, &column.column_type, array);
        let vector_index = index.method == "hnsw" || index.method == "ivfflat";
        let selected = key.operator_class.as_deref().filter(|name| !name.is_empty());
        match selected {
            Some(name) if !classes.iter().any(|option| option.name == name) => {
                errors.push(if vector_index {
                    format!("{label} needs a compatible pgvector column and operator class.")
                } else {
                    format!("{label} has an operator class incompatible with {} on {}.", index.method, column.column_type)
                });
            }
            None if !classes.iter().any(|option| option.default) => {
                errors.push(format!("{label} using {} needs an explicit compatible operator class for {}.", index.method, column.column_type));
            }
            _ => {}
        }
        if let Some(name) = selected {
            if !pattern!(r"^[a-z_][a-z0-9_]*$").is_match(name) {
                errors.push(format!("{label} has an invalid operator class identifier."));
            }
        }
        validate_vector_index_key(index, &column.column_type, column.type_parameters.as_ref().and_then(|parameters| parameters.dimensions), label, errors);
    }
    let includes = index.include_column_ids.as_deref().unwrap_or(&[]);
    if !includes.is_empty() && !method.include {
        errors.push(format!("{label} using {} cannot have INCLUDE columns.", index.method));
    }
    if includes.iter().any(|id| index.keys.iter().any(|key| &key.column_id == id)) {
        errors.push(format!("{label} cannot INCLUDE a key column."));
    }
    let distinct_includes: HashSet<&String> = includes.iter().collect();
    if distinct_includes.len() != includes.len() {
        errors.push(format!("{label} repeats an INCLUDE column."));
    }
    for id in includes {
        if !table.columns.iter().any(|column| &column.id == id) {
            errors.push(format!("{label} refers to a missing INCLUDE column."));
        }
    }
    if (index.method == "hnsw" || index.method == "ivfflat") && index.keys.len() != 1 {
        errors.push(format!("{label} using {} must have exactly one key.", index.method));
    }
}

fn validate_vector_index_key(index: &DesignIndex, column_type: &str, dimensions: Option<f64>, label: &str, errors: &mut Vec<String>) {
    if index.method != "hnsw" && index.method != "ivfflat" {
        return;
    }
    let limit = match column_type {
        "vector" => Some(2000.0),
        "halfvec" => Some(4000.0),
        "bit" => Some(64000.0),
        _ => None,
    };
    if let (Some(limit), Some(dimensions)) = (limit, dimensions) {
        if dimensions != 0.0 && dimensions > limit {
            errors.push(format!("{label} exceeds the {column_type} {} dimension limit of {}.", index.method, limit as i64));
        }
    }
}

fn is_integer(value: &Value) -> bool {
    js::integer(value).is_some()
}

fn validate_index_options(index: &DesignIndex, allowed: &[String], label: &str, errors: &mut Vec<String>) {
    let Some(options) = &index.options else { return };
    for (key, value) in options {
        if !allowed.iter().any(|name| name == key) {
            errors.push(format!("{label} does not support the {key} storage option."));
        }
        if key == "fastupdate" && !value.is_boolean() {
            errors.push(format!("{label} fastupdate must be true or false."));
        }
        let number = js::to_number(value);
        if key != "fastupdate" && (!is_integer(value) || number < 1.0) {
            errors.push(format!("{label} storage options must be positive integers."));
        }
        if key == "fillfactor" && (number < 10.0 || number > 100.0) {
            errors.push(format!("{label} fillfactor must be between 10 and 100."));
        }
        if key == "m" && number > 100.0 {
            errors.push(format!("{label} HNSW m must be at most 100."));
        }
        if key == "efConstruction" && number < 4.0 {
            errors.push(format!("{label} HNSW efConstruction must be at least 4."));
        }
    }
}

fn validate_table(table: &DesignTable, table_names: &mut HashSet<String>, errors: &mut Vec<String>, enum_types: &[crate::design::DesignEnumType], warnings: &mut Vec<String>) {
    let name = js::trim(&table.name);
    let label = if name.is_empty() { "(unnamed table)".to_owned() } else { format!("\"{name}\"") };

    if name.is_empty() {
        errors.push("Every table needs a name.".into());
    } else if table_names.contains(name) {
        errors.push(format!("Table name {label} is used more than once."));
    }
    table_names.insert(name.to_owned());
    if !name.is_empty() && name != name.to_lowercase() {
        warnings.push(format!("Table {label} is mixed case, so every query must quote it. Lowercase snake_case works everywhere."));
    }

    // PostgreSQL allows a table with no columns; it is almost never intended.
    if table.columns.is_empty() {
        warnings.push(format!("Table {label} has no columns."));
    } else if !table.columns.iter().any(|column| column.primary_key) {
        warnings.push(format!("Table {label} has no primary key. Give every table one, so rows can be addressed and referenced."));
    }

    let mut column_names = HashSet::new();
    for column in &table.columns {
        validate_column(table, column, &mut column_names, errors, enum_types, warnings);
        if column.name != column.name.to_lowercase() {
            warnings.push(format!("Column \"{}\" of {label} is mixed case, so every query must quote it.", column.name));
        }
        if column.column_type == "timestamp" {
            warnings.push(format!("Column \"{}\" of {label} is timestamp without time zone; timestamptz avoids time zone surprises.", column.name));
        }
    }
}

/// Postgres does not index foreign keys itself; without one, joins and cascading deletes scan the whole table.
fn warn_foreign_key_index(view: &RelationshipView, warnings: &mut Vec<String>) {
    let table = view.referencing_table;
    let column = view.referencing_column;
    let first_key = |column_ids: &[String]| column_ids.first() == Some(&column.id);
    let primary_keys: Vec<&DesignColumn> = table.columns.iter().filter(|candidate| candidate.primary_key).collect();
    let covered = column.primary_key
        || column.unique
        || view.relationship.cardinality == "one-to-one"
        || table.unique_constraints.as_deref().unwrap_or(&[]).iter().any(|constraint| first_key(&constraint.column_ids))
        || table.indexes.as_deref().unwrap_or(&[]).iter().any(|index| index.keys.first().is_some_and(|key| key.column_id == column.id))
        || (primary_keys.len() > 1 && primary_keys.first().is_some_and(|first| first.id == column.id));
    if !covered {
        warnings.push(format!("Foreign key \"{0}\".\"{1}\" has no index, so joins and cascading deletes scan \"{0}\". Add one.", table.name, column.name));
    }
}

fn validate_column(
    table: &DesignTable,
    column: &DesignColumn,
    column_names: &mut HashSet<String>,
    errors: &mut Vec<String>,
    enum_types: &[crate::design::DesignEnumType],
    warnings: &mut Vec<String>,
) {
    let trimmed_table = js::trim(&table.name);
    let table_label = if trimmed_table.is_empty() { "(unnamed table)".to_owned() } else { format!("\"{trimmed_table}\"") };
    let name = js::trim(&column.name);
    let label = if name.is_empty() { "(unnamed column)".to_owned() } else { format!("\"{name}\"") };

    if name.is_empty() {
        errors.push(format!("Table {table_label} has a column that needs a name."));
    } else if column_names.contains(name) {
        errors.push(format!("Column name {label} is used more than once in table {table_label}."));
    }
    column_names.insert(name.to_owned());

    if !is_supported_column_type(&column.column_type) {
        errors.push(format!("Column {label} in table {table_label} uses an unsupported type."));
    } else if column.identity && !find_column_type(&column.column_type).is_some_and(|info| info.identity) {
        errors.push(format!("Column {label} in table {table_label} can only use identity on integer types."));
    } else if let Some(problem) = column_default_problem(&column.column_type, &column.default) {
        errors.push(format!("Column {label} in table {table_label} has an invalid default: {problem}."));
    }
    if column.column_type == "enum" && !enum_types.iter().any(|enum_type| Some(&enum_type.id) == column.enum_type_id.as_ref()) {
        errors.push(format!("Column {label} in table {table_label} needs a valid enum type."));
    }
    let parameters = column.type_parameters.clone().unwrap_or(crate::design::ColumnTypeParameters { length: None, precision: None, scale: None, dimensions: None, array: None });
    let whole = |value: f64| value.fract() == 0.0;
    let invalid_length = parameters.length.is_some_and(|length| !whole(length) || length < 1.0 || length > 10_485_760.0);
    if ["varchar", "char", "bit"].contains(&column.column_type.as_str()) && invalid_length {
        errors.push(format!("Column {label} in table {table_label} needs a valid positive length."));
    }
    let invalid_precision = parameters.precision.is_some_and(|precision| !whole(precision) || precision < 1.0 || precision > 1000.0);
    let invalid_scale = parameters.scale.is_some_and(|scale| parameters.precision.is_none() || !whole(scale) || scale < -1000.0 || scale > 1000.0);
    if column.column_type == "numeric" && (invalid_precision || invalid_scale) {
        errors.push(format!("Column {label} in table {table_label} has invalid numeric precision or scale."));
    }
    let invalid_dimensions = match parameters.dimensions {
        None => true,
        Some(dimensions) => !whole(dimensions) || dimensions < 1.0 || dimensions > 1_000_000_000.0,
    };
    if ["vector", "halfvec", "sparsevec"].contains(&column.column_type.as_str()) && invalid_dimensions {
        errors.push(format!("Column {label} in table {table_label} needs a valid positive vector dimension."));
    }

    // Identity generation and a default both supply a value, so PostgreSQL cannot accept them together.
    if column.identity && !matches!(column.default, crate::column_defaults::ColumnDefault::None) {
        errors.push(format!("Column {label} in table {table_label} cannot use identity generation and a default; choose one."));
    }

    // PostgreSQL makes primary key and identity columns required whatever the flag says, so a
    // contradictory flag is advice rather than an error.
    if column.primary_key && column.nullable {
        warnings.push(format!("Primary key column {label} in table {table_label} is marked Nullable, but PostgreSQL requires it; turn off Nullable."));
    }
    if column.identity && column.nullable {
        warnings.push(format!("Identity column {label} in table {table_label} is marked Nullable, but PostgreSQL requires it; turn off Nullable."));
    }
}

/// An index whose columns are the start of another index, a unique constraint, or the primary key is
/// served by it already, and only slows writes and takes space.
fn warn_redundant_indexes(plan: &Plan, warnings: &mut Vec<String>) {
    struct Cover {
        name: String,
        keys: Vec<String>,
        unique: bool,
    }
    for entry in &plan.indexes {
        let (table, index) = (entry.table, entry.index);
        let keys: Vec<String> = index.keys.iter().map(|key| key.column_id.clone()).collect();
        let has_includes = index.include_column_ids.as_ref().is_some_and(|ids| !ids.is_empty());
        if index.method == "btree" && index.unique == Some(true) && !has_includes {
            // A unique index next to a unique constraint on the same columns builds the same index twice.
            let twin = plan.unique_constraints.iter().find(|other| other.table.id == table.id && same_columns(&other.constraint.column_ids, &keys));
            if let Some(twin) = twin {
                warnings.push(format!(
                    "Unique index \"{}\" on \"{}\" repeats constraint \"{}\" on the same columns, so the same index is built twice. Keep one.",
                    entry.name, table.name, twin.name
                ));
            }
            continue;
        }
        if index.method != "btree" || index.unique == Some(true) || has_includes {
            continue;
        }
        let mut covers: Vec<Cover> = Vec::new();
        for other in plan.indexes.iter().filter(|other| other.table.id == table.id && other.index.id != index.id && other.index.method == "btree") {
            covers.push(Cover {
                name: format!("index \"{}\"", other.name),
                keys: other.index.keys.iter().map(|key| key.column_id.clone()).collect(),
                unique: other.index.unique == Some(true),
            });
        }
        for other in plan.unique_constraints.iter().filter(|other| other.table.id == table.id) {
            covers.push(Cover { name: format!("constraint \"{}\"", other.name), keys: other.constraint.column_ids.clone(), unique: true });
        }
        for column in table.columns.iter().filter(|column| column.unique && !column.primary_key) {
            covers.push(Cover { name: format!("unique column \"{}\"", column.name), keys: vec![column.id.clone()], unique: true });
        }
        if table.columns.iter().any(|column| column.primary_key) {
            covers.push(Cover {
                name: "the primary key".into(),
                keys: table.columns.iter().filter(|column| column.primary_key).map(|column| column.id.clone()).collect(),
                unique: true,
            });
        }
        let own_position = plan.indexes.iter().position(|other| other.index.id == index.id);
        let covering = covers.iter().find(|cover| {
            cover.keys.len() >= keys.len()
                && keys.iter().enumerate().all(|(position, id)| cover.keys.get(position) == Some(id))
                // Two identical plain indexes are redundant with each other; only the later one is reported.
                && (cover.keys.len() > keys.len()
                    || cover.unique
                    || own_position.map_or(-1, |p| p as i64)
                        > plan.indexes.iter().position(|other| format!("index \"{}\"", other.name) == cover.name).map_or(-1, |p| p as i64))
        });
        if let Some(covering) = covering {
            warnings.push(format!(
                "Index \"{}\" on \"{}\" is already covered by {}, which starts with the same columns. It only costs writes and space.",
                entry.name, table.name, covering.name
            ));
        }
    }
}

/* --------------------------------------------------------------- rendering */

/// Tables in an order where each comes after the tables it references, keeping the designed order otherwise.
fn dependency_order<'a>(design: &'a Design, relationships: &[RelationshipView<'a>]) -> Vec<&'a DesignTable> {
    let mut references: HashMap<&str, Vec<&str>> = HashMap::new();
    for view in relationships {
        if view.referencing_table.id == view.referenced_table.id {
            continue;
        }
        references.entry(view.referencing_table.id.as_str()).or_default().push(view.referenced_table.id.as_str());
    }
    let by_id: HashMap<&str, &DesignTable> = design.tables.iter().map(|table| (table.id.as_str(), table)).collect();
    let mut visited: HashSet<&str> = HashSet::new();
    let mut ordered: Vec<&DesignTable> = Vec::new();
    fn visit<'a>(
        table: &'a DesignTable,
        references: &HashMap<&'a str, Vec<&'a str>>,
        by_id: &HashMap<&'a str, &'a DesignTable>,
        visited: &mut HashSet<&'a str>,
        ordered: &mut Vec<&'a DesignTable>,
    ) {
        // Done, or part of a cycle: that reference is added after the tables.
        if !visited.insert(table.id.as_str()) {
            return;
        }
        for id in references.get(table.id.as_str()).into_iter().flatten() {
            if let Some(target) = by_id.get(id) {
                visit(target, references, by_id, visited, ordered);
            }
        }
        ordered.push(table);
    }
    for table in &design.tables {
        visit(table, &references, &by_id, &mut visited, &mut ordered);
    }
    ordered
}

fn render_table(table: &DesignTable, design: &Design, uniques: &[&UniqueEntry], foreign_keys: &[&NamedRelationship]) -> Rendered<String> {
    let primary_keys: Vec<&DesignColumn> = table.columns.iter().filter(|column| column.primary_key).collect();
    let mut lines: Vec<String> = table.columns.iter().map(|column| render_column(column, design)).collect();
    if !primary_keys.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", primary_keys.iter().map(|key| quote_identifier(&key.name)).collect::<Vec<_>>().join(", ")));
    }
    for entry in uniques {
        let mut columns = Vec::new();
        for id in &entry.constraint.column_ids {
            let column = table.columns.iter().find(|column| &column.id == id).ok_or_else(|| unresolved("a unique constraint column"))?;
            columns.push(quote_identifier(&column.name));
        }
        let nulls_not_distinct = if entry.constraint.nulls_not_distinct == Some(true) { " NULLS NOT DISTINCT" } else { "" };
        lines.push(format!("  CONSTRAINT {} UNIQUE{nulls_not_distinct} ({})", quote_identifier(&entry.name), columns.join(", ")));
    }
    for entry in foreign_keys {
        let referenced = entry.view.referenced_column.ok_or_else(|| unresolved("a referenced primary key"))?;
        lines.push(format!(
            "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}",
            quote_identifier(&entry.foreign_key_constraint_name),
            quote_identifier(&entry.view.referencing_column.name),
            quote_identifier(&entry.view.referenced_table.name),
            quote_identifier(&referenced.name),
            entry.view.relationship.on_update.as_deref().unwrap_or("NO ACTION"),
            entry.view.relationship.on_delete.as_deref().unwrap_or("NO ACTION")
        ));
        if entry.view.owns_uniqueness {
            if let Some(unique_name) = &entry.unique_constraint_name {
                lines.push(format!("  CONSTRAINT {} UNIQUE ({})", quote_identifier(unique_name), quote_identifier(&entry.view.referencing_column.name)));
            }
        }
    }
    Ok(format!("CREATE TABLE {} (\n{}\n);", quote_identifier(&table.name), lines.join(",\n")))
}

fn render_index(table: &DesignTable, index: &DesignIndex, name: &str) -> Rendered<String> {
    let mut keys = Vec::new();
    for key in &index.keys {
        let column = table.columns.iter().find(|candidate| candidate.id == key.column_id).ok_or_else(|| unresolved("an index key column"))?;
        let ordering = [
            key.order.as_deref().filter(|order| !order.is_empty()).map(str::to_uppercase),
            key.nulls.as_deref().filter(|nulls| !nulls.is_empty()).map(|nulls| format!("NULLS {}", nulls.to_uppercase())),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
        let operator_class = key.operator_class.as_deref().filter(|name| !name.is_empty()).map(|name| format!(" {name}")).unwrap_or_default();
        let key_ordering = if ordering.is_empty() { String::new() } else { format!(" {ordering}") };
        keys.push(format!("{}{operator_class}{key_ordering}", quote_identifier(&column.name)));
    }
    let mut include = Vec::new();
    for id in index.include_column_ids.as_deref().unwrap_or(&[]) {
        let column = table.columns.iter().find(|column| &column.id == id).ok_or_else(|| unresolved("an INCLUDE column"))?;
        include.push(quote_identifier(&column.name));
    }
    let mut options: Vec<String> = Vec::new();
    for (key, value) in index.options.iter().flatten() {
        let option_name = match key.as_str() {
            "efConstruction" => "ef_construction",
            "pagesPerRange" => "pages_per_range",
            other => other,
        };
        let option_value = match value {
            Value::String(text) => quote_string(text),
            other => js::to_js_string(other),
        };
        options.push(format!("{option_name} = {option_value}"));
    }
    let mut clauses = vec![format!(
        "CREATE {}INDEX {} ON {} USING {} ({})",
        if index.unique == Some(true) { "UNIQUE " } else { "" },
        quote_identifier(name),
        quote_identifier(&table.name),
        index.method,
        keys.join(", ")
    )];
    if !include.is_empty() {
        clauses.push(format!("INCLUDE ({})", include.join(", ")));
    }
    if index.unique == Some(true) && index.nulls_not_distinct == Some(true) {
        clauses.push("NULLS NOT DISTINCT".into());
    }
    if !options.is_empty() {
        clauses.push(format!("WITH ({})", options.join(", ")));
    }
    Ok(format!("{};", clauses.join(" ")))
}

fn render_policies(table: &DesignTable) -> Vec<String> {
    let mut statements = Vec::new();
    if table.row_level_security {
        statements.push(format!("ALTER TABLE {} ENABLE ROW LEVEL SECURITY;", quote_identifier(&table.name)));
    }
    for policy in &table.policies {
        let roles = if policy.roles.is_empty() { "PUBLIC".to_owned() } else { policy.roles.iter().map(|role| quote_identifier(role)).collect::<Vec<_>>().join(", ") };
        let using = js::trim(&policy.using);
        let with_check = js::trim(&policy.with_check);
        let clauses: Vec<String> = [(!using.is_empty()).then(|| format!("USING ({using})")), (!with_check.is_empty()).then(|| format!("WITH CHECK ({with_check})"))]
            .into_iter()
            .flatten()
            .collect();
        statements.push(format!(
            "CREATE POLICY {} ON {} AS {} FOR {} TO {roles}{};",
            quote_identifier(&policy.name),
            quote_identifier(&table.name),
            policy.mode.to_uppercase(),
            policy.command,
            if clauses.is_empty() { String::new() } else { format!(" {}", clauses.join(" ")) }
        ));
    }
    statements
}

fn render_column(column: &DesignColumn, design: &Design) -> String {
    let enum_name = (column.column_type == "enum")
        .then(|| design.enum_types.as_deref().and_then(|types| types.iter().find(|value| Some(&value.id) == column.enum_type_id.as_ref())).map(|value| value.name.as_str()))
        .flatten();
    let array = column.type_parameters.as_ref().and_then(|parameters| parameters.array) == Some(true);
    let sql_type = match enum_name {
        // `enumName ? ... : ...`: an empty enum name is falsy.
        Some(name) if !name.is_empty() => format!("{}{}", quote_identifier(name), if array { "[]" } else { "" }),
        _ => render_column_type(&column.column_type, column.type_parameters.as_ref()),
    };
    let mut parts = vec![format!("  {} {sql_type}", quote_identifier(&column.name))];
    if column.identity {
        parts.push("GENERATED ALWAYS AS IDENTITY".into());
    }
    if let Some(expression) = render_default_expression(&column.default, Some(&column.column_type)) {
        parts.push(format!("DEFAULT {expression}"));
    }
    if column.primary_key || column.identity || !column.nullable {
        parts.push("NOT NULL".into());
    }
    // A primary key is already unique, so it does not repeat the constraint.
    if column.unique && !column.primary_key {
        parts.push("UNIQUE".into());
    }
    parts.join(" ")
}

fn render_pair_constraint(junction: &DesignTable, left: &DesignColumn, right: &DesignColumn, constraint_name: &str) -> String {
    format!(
        "ALTER TABLE {}\n  ADD CONSTRAINT {} UNIQUE ({}, {});",
        quote_identifier(&junction.name),
        quote_identifier(constraint_name),
        quote_identifier(&left.name),
        quote_identifier(&right.name)
    )
}

/// Foreign keys are added after every table exists, so the order of table cards never has to
/// satisfy a dependency. NO ACTION keeps relationships from changing or deleting referencing
/// rows without the designer's intent.
fn render_relationship(view: &RelationshipView, foreign_key_constraint_name: &str, unique_constraint_name: Option<&str>) -> Rendered<String> {
    let referenced = view.referenced_column.ok_or("A rendered relationship needs a referenced primary key.")?;
    let mut statements = vec![format!(
        "ALTER TABLE {}\n  ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {};",
        quote_identifier(&view.referencing_table.name),
        quote_identifier(foreign_key_constraint_name),
        quote_identifier(&view.referencing_column.name),
        quote_identifier(&view.referenced_table.name),
        quote_identifier(&referenced.name),
        view.relationship.on_update.as_deref().unwrap_or("NO ACTION"),
        view.relationship.on_delete.as_deref().unwrap_or("NO ACTION")
    )];
    // A one-to-one association owns uniqueness on its referencing column. An independent key or
    // unique setting already supplies uniqueness, so the relationship does not repeat it.
    if view.owns_uniqueness {
        let name = unique_constraint_name.ok_or("A one-to-one relationship needs a unique constraint name.")?;
        statements.push(format!(
            "ALTER TABLE {}\n  ADD CONSTRAINT {} UNIQUE ({});",
            quote_identifier(&view.referencing_table.name),
            quote_identifier(name),
            quote_identifier(&view.referencing_column.name)
        ));
    }
    Ok(statements.join("\n"))
}
