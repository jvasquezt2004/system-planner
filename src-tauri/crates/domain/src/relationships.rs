//! Relationship vocabulary (`src/shared/relationships.ts`): resolving which columns a
//! relationship joins, naming its generated foreign-key column, and describing what
//! a destructive edit would remove. SQL generation, workspace actions, and the view
//! all read relationships through here.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::design::{Design, DesignColumn, DesignManyToManyAssociation, DesignRelationship, DesignTable};
use crate::postgres_identifiers::{truncate_postgres_identifier, unique_postgres_identifier, MAX_IDENTIFIER_BYTES};

/// A relationship resolved against the current design.
#[derive(Debug, Clone)]
pub struct RelationshipView<'a> {
    pub relationship: &'a DesignRelationship,
    pub referencing_table: &'a DesignTable,
    pub referencing_column: &'a DesignColumn,
    pub referenced_table: &'a DesignTable,
    /// The referenced table's primary key, or `None` when it has no single key.
    pub referenced_column: Option<&'a DesignColumn>,
    /// A reference is required unless its own foreign-key column accepts NULL.
    pub required: bool,
    /// At most one referencing record may name each referenced record.
    pub one_to_one: bool,
    /// True when this relationship contributes the uniqueness constraint itself,
    /// rather than relying on an independently configured key or unique column.
    pub owns_uniqueness: bool,
    pub many_to_many_association: Option<&'a DesignManyToManyAssociation>,
}

pub fn is_relationship_cardinality(value: &str) -> bool {
    value == "one-to-many" || value == "one-to-one"
}

/// The table's primary key, only when exactly one column claims it.
pub fn primary_key_column(table: &DesignTable) -> Option<&DesignColumn> {
    let mut keys = table.columns.iter().filter(|column| column.primary_key);
    let first = keys.next()?;
    keys.next().is_none().then_some(first)
}

/// Finds the many-to-many association that owns a relationship, if any.
pub fn many_to_many_association_for_relationship<'a>(design: &'a Design, relationship_id: &str) -> Option<&'a DesignManyToManyAssociation> {
    design
        .many_to_many_relationships
        .iter()
        .find(|association| association.left_relationship_id == relationship_id || association.right_relationship_id == relationship_id)
}

/// `None` when the relationship points at something the design no longer has.
pub fn resolve_relationship<'a>(design: &'a Design, relationship: &'a DesignRelationship) -> Option<RelationshipView<'a>> {
    let referencing_table = design.tables.iter().find(|table| table.id == relationship.referencing_table_id)?;
    let referencing_column = referencing_table.columns.iter().find(|column| column.id == relationship.referencing_column_id)?;
    let referenced_table = design.tables.iter().find(|table| table.id == relationship.referenced_table_id)?;
    Some(RelationshipView {
        relationship,
        referencing_table,
        referencing_column,
        referenced_table,
        referenced_column: primary_key_column(referenced_table),
        required: !referencing_column.nullable,
        one_to_one: relationship.cardinality == "one-to-one",
        owns_uniqueness: relationship.cardinality == "one-to-one" && !referencing_column.unique && !referencing_column.primary_key,
        many_to_many_association: many_to_many_association_for_relationship(design, &relationship.id),
    })
}

pub fn resolve_relationships(design: &Design) -> Vec<RelationshipView<'_>> {
    design.relationships.iter().filter_map(|relationship| resolve_relationship(design, relationship)).collect()
}

pub fn relationships_for_table<'a>(design: &'a Design, table_id: &str) -> Vec<RelationshipView<'a>> {
    resolve_relationships(design)
        .into_iter()
        .filter(|view| view.referencing_table.id == table_id || view.referenced_table.id == table_id)
        .collect()
}

/// The generated foreign-key column is named after the referenced table and key
/// (for example `author_id`) and never reuses an existing PostgreSQL column name.
pub fn foreign_key_column_name(referencing_table: &DesignTable, referenced_table: &DesignTable, referenced_column: &DesignColumn) -> String {
    let owner = singularize(&to_snake_case(&referenced_table.name));
    let owner = if owner.is_empty() { "referenced".to_owned() } else { owner };
    let key = to_snake_case(&referenced_column.name);
    let key = if key.is_empty() { "id".to_owned() } else { key };
    let base = if key == "id" { format!("{owner}_id") } else { format!("{owner}_{key}") };
    let taken: HashSet<String> = referencing_table.columns.iter().map(|column| truncate_postgres_identifier(&column.name, MAX_IDENTIFIER_BYTES)).collect();
    unique_postgres_identifier(&base, &taken)
}

/// Preferred foreign-key name; SQL generation bounds and deconflicts it.
pub fn relationship_constraint_name(view: &RelationshipView) -> String {
    format!("{}_{}_fkey", view.referencing_table.name, view.referencing_column.name)
}

/// The relationship-owned uniqueness constraint, removed with the relationship.
pub fn relationship_unique_constraint_name(view: &RelationshipView) -> String {
    format!("{}_{}_key", view.referencing_table.name, view.referencing_column.name)
}

/// The constraints a removal of this relationship would drop.
pub fn relationship_constraints(view: &RelationshipView) -> Vec<&'static str> {
    if view.owns_uniqueness { vec!["foreign-key", "unique"] } else { vec!["foreign-key"] }
}

/* ------------------------------------------------------------ removal plan */

/// What a destructive edit targets.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RemovalTarget {
    #[serde(rename_all = "camelCase")]
    Table { table_id: String },
    #[serde(rename_all = "camelCase")]
    Column { table_id: String, column_id: String },
    #[serde(rename_all = "camelCase")]
    Function { function_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedRelationship {
    pub relationship_id: String,
    pub cardinality: String,
    pub referencing_table: String,
    pub referencing_column: String,
    pub referenced_table: String,
    pub referenced_column: Option<String>,
    /// Present for a many-to-many association.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub junction_table: Option<String>,
    pub constraints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedIndex {
    pub table: String,
    pub index_id: String,
    pub name: String,
    pub removed_keys: usize,
    pub removed_includes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedUniqueConstraint {
    pub table: String,
    pub constraint_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedTrigger {
    pub trigger_id: String,
    pub name: String,
    pub table: String,
}

/// What a destructive edit would remove, so the designer can inspect it before confirming.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovalPlan {
    pub target: String,
    pub relationships: Vec<AffectedRelationship>,
    pub indexes: Vec<AffectedIndex>,
    pub unique_constraints: Vec<AffectedUniqueConstraint>,
    pub triggers: Vec<AffectedTrigger>,
}

/// `value?.trim() || fallback`: a missing or blank name uses the fallback.
fn name_or(name: Option<&str>, fallback: impl FnOnce() -> String) -> String {
    match name.map(crate::js::trim) {
        Some(trimmed) if !trimmed.is_empty() => trimmed.to_owned(),
        _ => fallback(),
    }
}

const MISSING_TABLE: &str = "(missing table)";

fn trigger_entry(design: &Design, trigger: &crate::design::DesignTrigger) -> AffectedTrigger {
    let table = design.tables.iter().find(|candidate| candidate.id == trigger.table_id);
    AffectedTrigger { trigger_id: trigger.id.clone(), name: trigger.name.clone(), table: table.map_or(MISSING_TABLE, |table| table.name.as_str()).to_owned() }
}

/// Lists the relationships, indexes, constraints and triggers a removal would delete alongside its target.
pub fn removal_plan(design: &Design, target: &RemovalTarget) -> RemovalPlan {
    let label = removal_target_label(design, target);
    let triggers_list = design.triggers.as_deref().unwrap_or(&[]);
    if let RemovalTarget::Function { function_id } = target {
        let triggers = triggers_list.iter().filter(|trigger| &trigger.function_id == function_id).map(|trigger| trigger_entry(design, trigger)).collect();
        return RemovalPlan { target: label, relationships: vec![], indexes: vec![], unique_constraints: vec![], triggers };
    }
    let (target_table, target_column) = match target {
        RemovalTarget::Table { table_id } => (table_id.as_str(), None),
        RemovalTarget::Column { table_id, column_id } => (table_id.as_str(), Some(column_id.as_str())),
        RemovalTarget::Function { .. } => unreachable!("handled above"),
    };
    let mut indexes = Vec::new();
    for table in &design.tables {
        for index in table.indexes.as_deref().unwrap_or(&[]) {
            let in_target = table.id == target_table;
            let hits = |id: &str| in_target && target_column.is_none_or(|column| column == id);
            let removed_keys = index.keys.iter().filter(|key| hits(&key.column_id)).count();
            let removed_includes = index.include_column_ids.as_deref().unwrap_or(&[]).iter().filter(|id| hits(id)).count();
            if removed_keys + removed_includes > 0 {
                indexes.push(AffectedIndex {
                    table: table.name.clone(),
                    index_id: index.id.clone(),
                    name: name_or(index.name.as_deref(), || format!("{} index", table.name)),
                    removed_keys,
                    removed_includes,
                });
            }
        }
    }
    let mut unique_constraints = Vec::new();
    for table in &design.tables {
        for constraint in table.unique_constraints.as_deref().unwrap_or(&[]) {
            let affected = table.id == target_table && target_column.is_none_or(|column| constraint.column_ids.iter().any(|id| id == column));
            if affected {
                unique_constraints.push(AffectedUniqueConstraint {
                    table: table.name.clone(),
                    constraint_id: constraint.id.clone(),
                    name: name_or(constraint.name.as_deref(), || format!("{} unique constraint", table.name)),
                });
            }
        }
    }
    let triggers = triggers_list
        .iter()
        .filter(|trigger| {
            trigger.table_id == target_table
                || target_column.is_some_and(|column| trigger.events.iter().any(|event| event.column_ids.as_deref().is_some_and(|ids| ids.iter().any(|id| id == column))))
        })
        .map(|trigger| trigger_entry(design, trigger))
        .collect();
    RemovalPlan { target: label, relationships: affected_relationships(design, target), indexes, unique_constraints, triggers }
}

fn affected_relationships(design: &Design, target: &RemovalTarget) -> Vec<AffectedRelationship> {
    if matches!(target, RemovalTarget::Function { .. }) {
        return vec![];
    }
    let mut affected = Vec::new();
    let association_relationship_ids: HashSet<&str> = design
        .many_to_many_relationships
        .iter()
        .flat_map(|association| [association.left_relationship_id.as_str(), association.right_relationship_id.as_str()])
        .collect();
    let find_relationship = |id: &str| design.relationships.iter().find(|relationship| relationship.id == id);
    let table_name = |id: &str| design.tables.iter().find(|table| table.id == id).map_or(MISSING_TABLE.to_owned(), |table| table.name.clone());

    for association in &design.many_to_many_relationships {
        let left = find_relationship(&association.left_relationship_id);
        let right = find_relationship(&association.right_relationship_id);
        if ![left, right].into_iter().flatten().any(|relationship| relationship_touches_target(design, relationship, target)) {
            continue;
        }
        let left_view = left.and_then(|relationship| resolve_relationship(design, relationship));
        let right_view = right.and_then(|relationship| resolve_relationship(design, relationship));
        affected.push(AffectedRelationship {
            relationship_id: association.id.clone(),
            cardinality: "many-to-many".into(),
            referencing_table: table_name(&association.left_table_id),
            referencing_column: left_view.as_ref().and_then(|view| view.referenced_column).map_or("(no primary key)".to_owned(), |column| column.name.clone()),
            referenced_table: table_name(&association.right_table_id),
            referenced_column: right_view.as_ref().and_then(|view| view.referenced_column).map(|column| column.name.clone()),
            junction_table: Some(table_name(&association.junction_table_id)),
            constraints: vec!["foreign-key".into(), "foreign-key".into(), "pair-unique".into()],
        });
    }
    for relationship in &design.relationships {
        if association_relationship_ids.contains(relationship.id.as_str()) || !relationship_touches_target(design, relationship, target) {
            continue;
        }
        let view = resolve_relationship(design, relationship);
        affected.push(AffectedRelationship {
            relationship_id: relationship.id.clone(),
            cardinality: relationship.cardinality.clone(),
            referencing_table: view.as_ref().map_or(MISSING_TABLE.to_owned(), |view| view.referencing_table.name.clone()),
            referencing_column: view.as_ref().map_or("(missing column)".to_owned(), |view| view.referencing_column.name.clone()),
            referenced_table: view.as_ref().map_or(MISSING_TABLE.to_owned(), |view| view.referenced_table.name.clone()),
            referenced_column: view.as_ref().and_then(|view| view.referenced_column).map(|column| column.name.clone()),
            junction_table: None,
            constraints: view.as_ref().map_or(vec!["foreign-key".to_owned()], |view| relationship_constraints(view).into_iter().map(str::to_owned).collect()),
        });
    }
    affected
}

fn relationship_touches_target(design: &Design, relationship: &DesignRelationship, target: &RemovalTarget) -> bool {
    match target {
        RemovalTarget::Function { .. } => false,
        RemovalTarget::Table { table_id } => &relationship.referencing_table_id == table_id || &relationship.referenced_table_id == table_id,
        RemovalTarget::Column { table_id, column_id } => {
            let view = resolve_relationship(design, relationship);
            (&relationship.referencing_table_id == table_id && &relationship.referencing_column_id == column_id)
                || (&relationship.referenced_table_id == table_id && view.and_then(|view| view.referenced_column).is_some_and(|column| &column.id == column_id))
        }
    }
}

fn removal_target_label(design: &Design, target: &RemovalTarget) -> String {
    match target {
        RemovalTarget::Function { function_id } => design
            .functions
            .as_deref()
            .and_then(|functions| functions.iter().find(|function| &function.id == function_id))
            .map_or("(missing function)".to_owned(), |function| function.name.clone()),
        RemovalTarget::Table { table_id } | RemovalTarget::Column { table_id, .. } => {
            let table = design.tables.iter().find(|candidate| &candidate.id == table_id);
            let table_name = table.map_or(MISSING_TABLE, |table| table.name.as_str());
            if let RemovalTarget::Column { column_id, .. } = target {
                if let Some(column) = table.and_then(|table| table.columns.iter().find(|candidate| &candidate.id == column_id)) {
                    return format!("{table_name}.{}", column.name);
                }
            }
            table_name.to_owned()
        }
    }
}

/* ----------------------------------------------------------------- naming */

macro_rules! pattern {
    ($source:expr) => {{
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| Regex::new($source).expect("valid pattern"))
    }};
}

fn to_snake_case(value: &str) -> String {
    let spaced = pattern!(r"([a-z0-9])([A-Z])").replace_all(value, "${1}_${2}");
    let underscored = pattern!(r"[^A-Za-z0-9]+").replace_all(&spaced, "_");
    underscored.trim_matches('_').to_lowercase()
}

/// Just enough English plural handling for table names such as Authors. Words that
/// already end in -us or -is (Campus, Status, Analysis) are left whole.
fn singularize(word: &str) -> String {
    if let Some(stem) = word.strip_suffix("ies") {
        return format!("{stem}y");
    }
    if ["ss", "us", "is", "x", "ch", "sh"].iter().any(|suffix| word.ends_with(suffix)) {
        return word.to_owned();
    }
    if let Some(stem) = word.strip_suffix('s') {
        return stem.to_owned();
    }
    word.to_owned()
}
