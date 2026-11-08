//! Structured column defaults (`src/shared/column-defaults.ts`).
//!
//! Only what loading a stored Design needs lives here: the shape check and the
//! normalization. Validation against a column type and SQL rendering arrive with
//! the SQL generation port.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::js;

pub const LITERAL_TYPES: &[&str] = &["text", "integer", "numeric", "boolean", "date", "time", "timestamp", "json"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ColumnDefault {
    #[serde(rename = "none")]
    None,
    /// A value written as the column's literal category, never as an expression.
    #[serde(rename = "literal", rename_all = "camelCase")]
    Literal { literal_type: String, value: String },
    #[serde(rename = "currentTimestamp")]
    CurrentTimestamp,
    #[serde(rename = "generateUuid")]
    GenerateUuid,
}

pub fn no_column_default() -> Value {
    serde_json::json!({ "kind": "none" })
}

/// `isColumnDefault`: shape check for persisted documents.
pub fn is_column_default(value: &Value) -> bool {
    let Some(record) = value.as_object() else { return false };
    match record.get("kind").and_then(Value::as_str) {
        Some("none" | "currentTimestamp" | "generateUuid") => true,
        Some("literal") => {
            record.get("literalType").and_then(Value::as_str).is_some_and(|t| LITERAL_TYPES.contains(&t))
                && record.get("value").is_some_and(Value::is_string)
        }
        _ => false,
    }
}

/// `normalizeColumnDefault`: trims values whose surrounding whitespace is noise, keeps text as written.
/// The input must satisfy [`is_column_default`].
pub fn normalize_column_default(value: &Map<String, Value>) -> Value {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("none");
    if kind != "literal" {
        return serde_json::json!({ "kind": kind });
    }
    let literal_type = value.get("literalType").and_then(Value::as_str).unwrap_or("text");
    let text = value.get("value").and_then(Value::as_str).unwrap_or("");
    let text = if literal_type == "text" { text } else { js::trim(text) };
    serde_json::json!({ "kind": "literal", "literalType": literal_type, "value": text })
}
