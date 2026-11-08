//! PostgreSQL index access-method capabilities (`src/shared/index-methods.ts`).
//!
//! Used by SQL validation and the index editor. The data is generated from the
//! TypeScript source by `tauri/fixtures/export-index-methods.ts` and embedded.

use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Map;

use crate::design::DesignIndex;

/// Operator-class choices accepted for one indexed column type.
#[derive(Debug, Clone, Deserialize)]
pub struct OperatorClassOption {
    pub name: String,
    /// Whether PostgreSQL selects this class when the design omits one.
    pub default: bool,
}

/// Features and per-type operator classes exposed by an access method.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMethodDefinition {
    pub method: String,
    pub label: String,
    pub unique: bool,
    pub include: bool,
    pub ordering: bool,
    pub storage_options: Vec<String>,
    pub default_types: Vec<String>,
    pub array_default: bool,
    #[serde(default)]
    pub array_types: Option<Vec<String>>,
    pub operator_classes: Map<String, serde_json::Value>,
}

fn definitions() -> &'static [IndexMethodDefinition] {
    static DEFINITIONS: OnceLock<Vec<IndexMethodDefinition>> = OnceLock::new();
    DEFINITIONS.get_or_init(|| serde_json::from_str(include_str!("../data/index-methods.json")).expect("embedded index methods are valid"))
}

/// Finds the shared capability record for an access method.
pub fn find_index_method(method: &str) -> Option<&'static IndexMethodDefinition> {
    definitions().iter().find(|entry| entry.method == method)
}

/// Operator classes valid for the selected access method and column.
pub fn index_operator_classes(method: &str, column_type: &str, array: bool) -> Vec<OperatorClassOption> {
    let Some(definition) = find_index_method(method) else { return vec![] };
    if array {
        let usable = definition.array_default && definition.array_types.as_ref().is_some_and(|types| types.iter().any(|known| known == column_type));
        return if usable { vec![OperatorClassOption { name: "array_ops".into(), default: true }] } else { vec![] };
    }
    let choices: Vec<OperatorClassOption> = definition
        .operator_classes
        .get(column_type)
        .map(|value| serde_json::from_value(value.clone()).expect("embedded operator classes are valid"))
        .unwrap_or_default();
    if !choices.is_empty() {
        return choices;
    }
    if definition.default_types.iter().any(|known| known == column_type) {
        return vec![OperatorClassOption { name: "default".into(), default: true }];
    }
    vec![]
}

/// One indexed column's type, for [`index_method_problem`].
pub struct IndexedType<'a> {
    pub column_type: &'a str,
    pub array: bool,
    pub dimensions: Option<f64>,
}

/// Checks whether a modeled index still matches its selected column types.
pub fn index_method_problem(index: &DesignIndex, types: &[IndexedType]) -> Option<String> {
    let Some(method) = find_index_method(&index.method) else {
        return Some("This access method is not supported.".into());
    };
    if index.unique == Some(true) && !method.unique {
        return Some(format!("{} does not support unique indexes.", method.label));
    }
    if index.include_column_ids.as_ref().is_some_and(|ids| !ids.is_empty()) && !method.include {
        return Some(format!("{} does not support INCLUDE columns.", method.label));
    }
    // `key.order || key.nulls`: an empty string is falsy in JavaScript.
    if index.keys.iter().any(|key| (key.order.as_deref().is_some_and(|v| !v.is_empty()) || key.nulls.as_deref().is_some_and(|v| !v.is_empty())) && !method.ordering) {
        return Some(format!("{} does not support key ordering.", method.label));
    }
    if index.method == "hnsw" || index.method == "ivfflat" {
        if index.keys.len() != 1 {
            return Some(format!("{} needs exactly one key column.", method.label));
        }
        if let Some(column) = types.first() {
            let limit = match column.column_type {
                "vector" => Some(2000.0),
                "halfvec" => Some(4000.0),
                "bit" => Some(64000.0),
                _ => None,
            };
            if let (Some(limit), Some(dimensions)) = (limit, column.dimensions) {
                if dimensions > limit {
                    return Some(format!("{} supports at most {} dimensions for {} columns.", method.label, limit as i64, column.column_type));
                }
            }
        }
    }
    for (position, column) in types.iter().enumerate().take(index.keys.len()) {
        let classes = index_operator_classes(&index.method, column.column_type, column.array);
        let selected = index.keys[position].operator_class.as_deref().filter(|name| !name.is_empty());
        let compatible = match selected {
            Some(name) => classes.iter().any(|entry| entry.name == name),
            None => classes.iter().any(|entry| entry.default),
        };
        if !compatible {
            return Some(format!(
                "{} has no compatible operator class for key {} ({}{}).",
                method.label,
                position + 1,
                column.column_type,
                if column.array { "[]" } else { "" }
            ));
        }
    }
    None
}
