//! The database Design document (`src/shared/design.ts`).
//!
//! Loading goes through [`normalize_design`], a port of `normalizeDesign` in
//! `src/bun/workspace.ts`. It works on JSON values because the original keeps
//! whatever extra fields a table, column, or relationship carries; the typed
//! [`Design`] is then read from the normalized value.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::column_defaults::{is_column_default, no_column_default, normalize_column_default};
use crate::geometry::{CanvasPoint, CanvasViewport};
use crate::js::{self, serialize_number};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnTypeParameters {
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "number_opt")]
    pub length: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "number_opt")]
    pub precision: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "number_opt")]
    pub scale: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", serialize_with = "number_opt")]
    pub dimensions: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub array: Option<bool>,
}

fn number_opt<S: serde::Serializer>(value: &Option<f64>, serializer: S) -> Result<S::Ok, S::Error> {
    match value {
        Some(value) => serialize_number(value, serializer),
        None => serializer.serialize_none(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignColumn {
    pub id: String,
    pub name: String,
    /// A name from the supported column type registry.
    #[serde(rename = "type")]
    pub column_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub type_parameters: Option<ColumnTypeParameters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_type_id: Option<String>,
    pub nullable: bool,
    pub primary_key: bool,
    pub unique: bool,
    pub identity: bool,
    pub default: crate::column_defaults::ColumnDefault,
    pub notes: String,
    /// Fields this version does not model, preserved so saving never loses them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexKey {
    pub column_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nulls: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator_class: Option<String>,
}

/// Storage options (`fillfactor`, `fastupdate`, `pagesPerRange`, `lists`, `m`, `efConstruction`) in
/// the order they were written: validation messages and the rendered `WITH (...)` clause follow it.
pub type IndexOptions = Map<String, Value>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignIndex {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub method: String,
    pub keys: Vec<IndexKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nulls_not_distinct: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_column_ids: Option<Vec<String>>,
    #[serde(default, rename = "with", skip_serializing_if = "Option::is_none")]
    pub options: Option<IndexOptions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignUniqueConstraint {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub column_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nulls_not_distinct: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignPolicy {
    pub id: String,
    pub name: String,
    pub command: String,
    pub roles: Vec<String>,
    pub mode: String,
    pub using: String,
    pub with_check: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignTable {
    pub id: String,
    pub name: String,
    pub position: CanvasPoint,
    pub columns: Vec<DesignColumn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<DesignIndex>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unique_constraints: Option<Vec<DesignUniqueConstraint>>,
    #[serde(default)]
    pub row_level_security: bool,
    #[serde(default)]
    pub policies: Vec<DesignPolicy>,
    /// Fields this version does not model, preserved so saving never loses them.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRelationship {
    pub id: String,
    /// `one-to-many` or `one-to-one`.
    pub cardinality: String,
    pub referencing_table_id: String,
    pub referencing_column_id: String,
    pub referenced_table_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignManyToManyAssociation {
    pub id: String,
    pub left_table_id: String,
    pub right_table_id: String,
    pub junction_table_id: String,
    pub left_relationship_id: String,
    pub right_relationship_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesignEnumType {
    pub id: String,
    pub name: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionArgument {
    pub name: String,
    #[serde(rename = "type")]
    pub argument_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignFunction {
    pub id: String,
    pub name: String,
    pub arguments: Vec<FunctionArgument>,
    pub return_type: String,
    pub returns_set: bool,
    pub language: String,
    pub volatility: String,
    pub security: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_dependencies: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerEvent {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignTrigger {
    pub id: String,
    pub name: String,
    pub table_id: String,
    pub timing: String,
    pub events: Vec<TriggerEvent>,
    pub level: String,
    pub function_id: String,
    pub when: String,
}

/// A PostgreSQL statement the structured Design cannot represent, kept verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRawStatement {
    pub id: String,
    pub sql: String,
    /// `before` or `after`.
    pub phase: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creates: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_to: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Design {
    pub tables: Vec<DesignTable>,
    pub relationships: Vec<DesignRelationship>,
    pub many_to_many_relationships: Vec<DesignManyToManyAssociation>,
    pub viewport: CanvasViewport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enum_types: Option<Vec<DesignEnumType>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub functions: Option<Vec<DesignFunction>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggers: Option<Vec<DesignTrigger>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_statements: Option<Vec<DesignRawStatement>>,
}

impl Design {
    /// Reads a stored Design: normalizes the document, then types it.
    pub fn load(stored: &Value) -> Result<Self, String> {
        let normalized = normalize_design(stored)?;
        serde_json::from_value(normalized).map_err(|error| format!("The saved design is malformed: {error}."))
    }
}

type Parsed<T> = std::result::Result<T, String>;

fn malformed() -> String {
    "The saved design is malformed.".into()
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value.field ?? fallback`: missing and `null` both take the fallback.
fn or_default(record: &mut Map<String, Value>, key: &str, fallback: Value) {
    if record.get(key).is_none_or(Value::is_null) {
        record.insert(key.into(), fallback);
    }
}

/// Port of `normalizeDesign`: fills in what older documents lack and cleans the shape.
///
/// Like the original it keeps any extra fields on tables, columns, relationships,
/// and enum types, drops unknown top-level fields, and does not validate field
/// types. Input that is not even the right container (for example `tables` that
/// is not a list) is reported with a message of our own; JavaScript would throw an
/// engine-specific `TypeError` there.
pub fn normalize_design(design: &Value) -> Parsed<Value> {
    let record = design.as_object().ok_or_else(malformed)?;
    let Some(Value::Array(tables)) = record.get("tables") else { return Err(malformed()) };

    let tables = tables.iter().map(normalize_table).collect::<Parsed<Vec<_>>>()?;

    let relationships = match record.get("relationships") {
        None | Some(Value::Null) => vec![],
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                let mut relationship = item.as_object().cloned().ok_or_else(malformed)?;
                let valid = matches!(relationship.get("cardinality").and_then(Value::as_str), Some("one-to-many" | "one-to-one"));
                if !valid {
                    relationship.insert("cardinality".into(), Value::String("one-to-many".into()));
                }
                Ok(Value::Object(relationship))
            })
            .collect::<Parsed<Vec<_>>>()?,
        Some(_) => return Err(malformed()),
    };

    let mut out = Map::new();
    out.insert("tables".into(), Value::Array(tables));
    out.insert("relationships".into(), Value::Array(relationships));
    // Documents saved before many-to-many existed have none.
    out.insert(
        "manyToManyRelationships".into(),
        js::nullish(record.get("manyToManyRelationships")).cloned().unwrap_or_else(|| Value::Array(vec![])),
    );
    out.insert(
        "viewport".into(),
        js::nullish(record.get("viewport")).cloned().unwrap_or_else(|| serde_json::json!({ "x": 0, "y": 0, "zoom": 1 })),
    );
    if let Some(enum_types) = record.get("enumTypes").filter(|value| truthy(value)) {
        let Value::Array(items) = enum_types else { return Err(malformed()) };
        let copied = items
            .iter()
            .map(|item| {
                let enum_type = item.as_object().ok_or_else(malformed)?;
                match enum_type.get("labels") {
                    Some(Value::Array(_)) => Ok(Value::Object(enum_type.clone())),
                    _ => Err(malformed()),
                }
            })
            .collect::<Parsed<Vec<_>>>()?;
        out.insert("enumTypes".into(), Value::Array(copied));
    }
    for key in ["functions", "triggers"] {
        if let Some(value) = record.get(key).filter(|value| truthy(value)) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(raw) = record.get("rawStatements").filter(|value| truthy(value)) {
        out.insert("rawStatements".into(), normalize_raw_statements(raw)?);
    }
    Ok(Value::Object(out))
}

fn normalize_table(table: &Value) -> Parsed<Value> {
    let mut table = table.as_object().cloned().ok_or_else(malformed)?;
    let Some(Value::Array(columns)) = table.get("columns") else { return Err(malformed()) };
    let columns = columns
        .iter()
        .map(|column| {
            let mut column = column.as_object().cloned().ok_or_else(malformed)?;
            or_default(&mut column, "unique", Value::Bool(false));
            let default = match column.get("default") {
                Some(value) if is_column_default(value) => normalize_column_default(value.as_object().expect("checked")),
                _ => no_column_default(),
            };
            column.insert("default".into(), default);
            or_default(&mut column, "notes", Value::String(String::new()));
            Ok(Value::Object(column))
        })
        .collect::<Parsed<Vec<_>>>()?;
    table.insert("columns".into(), Value::Array(columns));
    or_default(&mut table, "rowLevelSecurity", Value::Bool(false));
    or_default(&mut table, "policies", Value::Array(vec![]));
    Ok(Value::Object(table))
}

/// Raw SQL is opaque to the Design, so only its envelope is checked.
fn normalize_raw_statements(value: &Value) -> Parsed<Value> {
    let Value::Array(entries) = value else {
        return Err("Raw SQL statements must be a list.".into());
    };
    let invalid = || "A raw SQL statement needs an id, SQL text, and a before or after phase.".to_string();
    entries
        .iter()
        .map(|entry| {
            let raw = entry.as_object().ok_or_else(invalid)?;
            let id = raw.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).ok_or_else(invalid)?;
            let sql = raw.get("sql").and_then(Value::as_str).filter(|sql| !js::trim(sql).is_empty()).ok_or_else(invalid)?;
            let phase = match raw.get("phase").and_then(Value::as_str) {
                Some(phase @ ("before" | "after")) => phase,
                _ => return Err(invalid()),
            };
            let mut out = Map::new();
            out.insert("id".into(), id.into());
            out.insert("sql".into(), sql.into());
            out.insert("phase".into(), phase.into());
            for key in ["creates", "attachedTo"] {
                if let Some(text) = raw.get(key).and_then(Value::as_str) {
                    out.insert(key.into(), text.into());
                }
            }
            Ok(Value::Object(out))
        })
        .collect::<Parsed<Vec<_>>>()
        .map(Value::Array)
}
