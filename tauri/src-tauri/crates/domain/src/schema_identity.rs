//! Keeping identity across a file edit (`src/bun/schema-identity.ts`).
//!
//! A Design read back from SQL has fresh ids and default positions. [`adopt_identities`] gives
//! everything that still exists (by name) the id, canvas position, and notes it had before, so the
//! canvas, Walkthroughs' links, and history keep following the same tables and columns across a file
//! edit. Renaming in the file therefore reads as a removal plus an addition.

use std::collections::HashMap;

use serde_json::Value;

use crate::design::{Design, DesignFunction, DesignIndex, DesignTable};
use crate::sql::{plan_schema_object_names, SchemaObjectNames};

/// `Array.prototype.sort()` on strings: UTF-16 code unit order.
fn js_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    values
}

fn table_name(design: &Design, id: &str) -> String {
    design.tables.iter().find(|table| table.id == id).map(|table| table.name.clone()).unwrap_or_default()
}

fn column_name(table: &DesignTable, id: &str) -> String {
    table.columns.iter().find(|column| column.id == id).map(|column| column.name.clone()).unwrap_or_default()
}

fn unique_key(table: &DesignTable, ids: &[String]) -> String {
    js_sorted(ids.iter().map(|id| column_name(table, id)).collect()).join(",")
}

fn index_key(table: &DesignTable, index: &DesignIndex) -> String {
    let keys: Vec<String> = index.keys.iter().map(|key| column_name(table, &key.column_id)).collect();
    format!("{}|{}|{}", index.method, if index.unique == Some(true) { "u" } else { "" }, keys.join(","))
}

fn function_signature(function: &DesignFunction) -> String {
    let types: Vec<&str> = function.arguments.iter().map(|argument| argument.argument_type.as_str()).collect();
    format!("{}({})", function.name, types.join(","))
}

fn relationship_key(design: &Design, referencing_table: &str, referencing_column: &str, referenced_table: &str) -> String {
    let from = design.tables.iter().find(|table| table.id == referencing_table);
    format!(
        "{}.{}->{}",
        from.map_or("undefined", |table| table.name.as_str()),
        from.map(|table| column_name(table, referencing_column)).unwrap_or_default(),
        table_name(design, referenced_table)
    )
}

fn blank(name: &Option<String>) -> bool {
    name.as_deref().is_none_or(str::is_empty)
}

fn rename(value: &mut Value, ids: &HashMap<String, String>) {
    match value {
        Value::String(text) => {
            if let Some(previous) = ids.get(text.as_str()) {
                *text = previous.clone();
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| rename(item, ids)),
        Value::Object(map) => map.values_mut().for_each(|entry| rename(entry, ids)),
        _ => {}
    }
}

/// Gives `next` the identities `previous` has for everything that still exists by name.
pub fn adopt_identities(previous: &Design, next: &Design) -> Design {
    let mut result = next.clone();
    let mut ids: HashMap<String, String> = HashMap::new(); // next id -> previous id
    // A name the generated SQL gave an object is not a name the designer chose, so it is not stored.
    let planned: SchemaObjectNames = plan_schema_object_names(previous);
    let mut claim = |next_id: &str, previous_id: &str| {
        if next_id != previous_id {
            ids.insert(next_id.to_owned(), previous_id.to_owned());
        }
    };

    for table in &mut result.tables {
        let Some(old) = previous.tables.iter().find(|candidate| candidate.name == table.name) else { continue };
        claim(&table.id, &old.id);
        table.position = old.position;
        for column in &mut table.columns {
            let Some(old_column) = old.columns.iter().find(|candidate| candidate.name == column.name) else { continue };
            claim(&column.id, &old_column.id);
            // Notes live only in the Design, never in the SQL.
            if column.notes.is_empty() && !old_column.notes.is_empty() {
                column.notes = old_column.notes.clone();
            }
        }
        let old_uniques = old.unique_constraints.clone().unwrap_or_default();
        let table_snapshot = table.clone();
        for constraint in table.unique_constraints.iter_mut().flatten() {
            let wanted = unique_key(&table_snapshot, &constraint.column_ids);
            let Some(found) = old_uniques.iter().find(|candidate| unique_key(old, &candidate.column_ids) == wanted) else { continue };
            claim(&constraint.id, &found.id);
            if blank(&found.name) && constraint.name.as_ref() == planned.unique_constraints.get(&found.id) {
                constraint.name = None;
            }
        }
        let old_indexes = old.indexes.clone().unwrap_or_default();
        for index in table.indexes.iter_mut().flatten() {
            let wanted = index_key(&table_snapshot, index);
            let candidates: Vec<&DesignIndex> = old_indexes.iter().filter(|candidate| index_key(old, candidate) == wanted).collect();
            let found = candidates
                .iter()
                .find(|candidate| candidate.name == index.name || planned.indexes.get(&candidate.id) == index.name.as_ref())
                .or(candidates.first());
            let Some(found) = found else { continue };
            claim(&index.id, &found.id);
            if blank(&found.name) && index.name.as_ref() == planned.indexes.get(&found.id) {
                index.name = None;
            }
        }
        for policy in &table.policies {
            if let Some(found) = old.policies.iter().find(|candidate| candidate.name == policy.name) {
                claim(&policy.id, &found.id);
            }
        }
    }

    for enum_type in result.enum_types.iter().flatten() {
        if let Some(found) = previous.enum_types.iter().flatten().find(|candidate| candidate.name == enum_type.name) {
            claim(&enum_type.id, &found.id);
        }
    }
    for function in result.functions.iter().flatten() {
        let signature = function_signature(function);
        if let Some(found) = previous.functions.iter().flatten().find(|candidate| function_signature(candidate) == signature) {
            claim(&function.id, &found.id);
        }
    }
    for trigger in result.triggers.iter().flatten() {
        let table = table_name(&result, &trigger.table_id);
        let found = previous.triggers.iter().flatten().find(|candidate| candidate.name == trigger.name && table_name(previous, &candidate.table_id) == table);
        if let Some(found) = found {
            claim(&trigger.id, &found.id);
        }
    }

    for relationship in &result.relationships {
        let wanted = relationship_key(&result, &relationship.referencing_table_id, &relationship.referencing_column_id, &relationship.referenced_table_id);
        let found = previous
            .relationships
            .iter()
            .find(|candidate| relationship_key(previous, &candidate.referencing_table_id, &candidate.referencing_column_id, &candidate.referenced_table_id) == wanted);
        if let Some(found) = found {
            claim(&relationship.id, &found.id);
        }
    }
    for association in &result.many_to_many_relationships {
        let junction = table_name(&result, &association.junction_table_id);
        let found = previous.many_to_many_relationships.iter().find(|candidate| table_name(previous, &candidate.junction_table_id) == junction);
        if let Some(found) = found {
            claim(&association.id, &found.id);
        }
    }

    // Raw SQL has no name, so identical text keeps its id, in order.
    let mut unclaimed: Vec<&crate::design::DesignRawStatement> = previous.raw_statements.iter().flatten().collect();
    for raw in result.raw_statements.iter().flatten() {
        if let Some(position) = unclaimed.iter().position(|candidate| candidate.sql == raw.sql) {
            claim(&raw.id, &unclaimed.remove(position).id);
        }
    }

    let mut value = serde_json::to_value(&result).expect("a Design serializes");
    rename(&mut value, &ids);
    let mut adopted: Design = serde_json::from_value(value).expect("a renamed Design is still a Design");
    adopted.viewport = previous.viewport;
    adopted
}
