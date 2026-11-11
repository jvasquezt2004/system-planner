//! The registry of supported PostgreSQL column types (`src/shared/column-types.ts`).
//!
//! The single source of truth for the type picker, validation, SQL generation, and
//! sandbox checks. The definitions are generated from the TypeScript source by
//! `src-tauri/fixtures/export-column-types.ts` and embedded here.

use std::sync::OnceLock;

use serde::Deserialize;

use crate::design::ColumnTypeParameters;
use crate::js;

#[derive(Debug, Deserialize)]
pub struct ColumnTypeFamily {
    pub id: String,
    pub label: String,
    pub glyph: String,
    pub summary: String,
}

/// Which structured defaults a column type accepts.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultSupport {
    /// Literal category for this type, or `None` when it takes no literal default.
    pub literal: Option<String>,
    pub current_timestamp: bool,
    pub generate_uuid: bool,
}

#[derive(Debug, Deserialize)]
pub struct ColumnTypeDefinition {
    /// Exact PostgreSQL type name, used verbatim in generated SQL.
    #[serde(rename = "type")]
    pub name: String,
    pub label: String,
    pub family: String,
    /// Identity generation is only meaningful for integer types.
    pub identity: bool,
    pub defaults: DefaultSupport,
    /// `length`, `numeric`, or `dimensions` when the type takes a parameter.
    #[serde(default)]
    pub parameters: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Registry {
    families: Vec<ColumnTypeFamily>,
    definitions: Vec<ColumnTypeDefinition>,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| serde_json::from_str(include_str!("../data/column-types.json")).expect("embedded column types are valid"))
}

pub fn families() -> &'static [ColumnTypeFamily] {
    &registry().families
}

pub fn definitions() -> &'static [ColumnTypeDefinition] {
    &registry().definitions
}

/// `findColumnTypeInfo`: `None` for a type that is not in the supported registry.
pub fn find_column_type(name: &str) -> Option<&'static ColumnTypeDefinition> {
    definitions().iter().find(|definition| definition.name == name)
}

pub fn is_supported_column_type(name: &str) -> bool {
    find_column_type(name).is_some()
}

/// `renderColumnType`: the type name with its structured parameters, as written in SQL.
pub fn render_column_type(name: &str, parameters: Option<&ColumnTypeParameters>) -> String {
    let mut result = name.to_owned();
    let kind = find_column_type(name).and_then(|definition| definition.parameters.as_deref());
    if let Some(parameters) = parameters {
        match kind {
            Some("length") => {
                if let Some(length) = parameters.length {
                    result += &format!("({})", js::number_to_string(length));
                }
            }
            Some("numeric") => {
                if let Some(precision) = parameters.precision {
                    let scale = parameters.scale.map(|scale| format!(",{}", js::number_to_string(scale))).unwrap_or_default();
                    result += &format!("({}{scale})", js::number_to_string(precision));
                }
            }
            Some("dimensions") => {
                if let Some(dimensions) = parameters.dimensions {
                    result += &format!("({})", js::number_to_string(dimensions));
                }
            }
            _ => {}
        }
        if parameters.array == Some(true) {
            result += "[]";
        }
    }
    result
}
