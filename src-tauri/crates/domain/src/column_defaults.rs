//! Structured column defaults (`src/shared/column-defaults.ts`).
//!
//! A default is never handwritten SQL: it is one of a small set of choices that
//! the type registry says the column supports, and a typed literal is validated
//! and encoded here so its content stays a value.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::column_types::find_column_type;
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

/// How a literal category is named in a message.
fn literal_label(literal_type: &str) -> &str {
    match literal_type {
        "text" => "text value",
        "integer" => "whole number",
        "numeric" => "number",
        "boolean" => "true or false",
        "date" => "date",
        "time" => "time",
        "timestamp" => "timestamp",
        "json" => "JSON value",
        other => other,
    }
}

/// Explains why a default cannot apply to a column type, or `None` when the
/// combination is valid. The message is a sentence fragment so callers can place
/// it in their own context.
pub fn column_default_problem(column_type: &str, value: &ColumnDefault) -> Option<String> {
    let Some(info) = find_column_type(column_type) else {
        return Some("the column type is not supported".into());
    };
    match value {
        ColumnDefault::None => None,
        ColumnDefault::CurrentTimestamp => {
            (!info.defaults.current_timestamp).then(|| "current timestamp only applies to timestamp columns".into())
        }
        ColumnDefault::GenerateUuid => (!info.defaults.generate_uuid).then(|| "UUID generation only applies to UUID columns".into()),
        ColumnDefault::Literal { literal_type, value } => {
            let Some(expected) = &info.defaults.literal else {
                return Some(format!("a {column_type} column does not take a literal default"));
            };
            if literal_type != expected {
                return Some(format!(
                    "the {column_type} type needs a {} default, not a {}",
                    literal_label(expected),
                    literal_label(literal_type)
                ));
            }
            literal_problem(column_type, literal_type, value)
        }
    }
}

/// A pattern compiled once. The expressions use `[0-9]`, never `\d`: JavaScript's
/// `\d` is ASCII-only, while Rust's matches every Unicode digit.
macro_rules! pattern {
    ($source:expr) => {{
        static PATTERN: OnceLock<Regex> = OnceLock::new();
        PATTERN.get_or_init(|| Regex::new($source).expect("valid pattern"))
    }};
}

fn literal_problem(column_type: &str, literal_type: &str, value: &str) -> Option<String> {
    if value.contains('\0') {
        return Some("a default value cannot contain the null character".into());
    }
    match literal_type {
        "text" => None,
        "integer" => integer_problem(column_type, value),
        "numeric" => (!pattern!(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$").is_match(value))
            .then(|| format!("“{value}” is not a number")),
        "boolean" => (value != "true" && value != "false").then(|| "choose true or false".into()),
        "date" => (!is_calendar_date(value)).then(|| format!("“{value}” is not a valid date; use an ISO date such as 2024-02-29")),
        "time" => (!is_time(value)).then(|| format!("“{value}” is not a valid time; use HH:MM:SS, optionally followed by an offset")),
        "timestamp" => {
            (!is_timestamp(value)).then(|| format!("“{value}” is not a valid timestamp; include a zone, such as 2024-02-29T12:00:00Z"))
        }
        // Syntax only: JavaScript's JSON.parse accepts numbers beyond f64 (`1e999`), which a parsed
        // `Value` would refuse. Ignoring the content checks the syntax without converting numbers.
        "json" => serde_json::from_str::<serde::de::IgnoredAny>(value).err().map(|_| format!("“{value}” is not valid JSON")),
        _ => None,
    }
}

fn integer_range(column_type: &str) -> Option<(i128, i128)> {
    match column_type {
        "smallint" => Some((-32768, 32767)),
        "integer" => Some((-2147483648, 2147483647)),
        "bigint" => Some((-9223372036854775808, 9223372036854775807)),
        _ => None,
    }
}

fn integer_problem(column_type: &str, value: &str) -> Option<String> {
    if !pattern!(r"^[+-]?[0-9]+$").is_match(value) {
        return Some(format!("“{value}” is not a whole number"));
    }
    let range = integer_range(column_type)?;
    // Beyond i128 the number is outside every supported range.
    let in_range = value.parse::<i128>().is_ok_and(|number| number >= range.0 && number <= range.1);
    (!in_range).then(|| format!("“{value}” is outside the {column_type} range"))
}

fn days_in_month(year: i64, month: i64) -> i64 {
    if month == 2 {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        return if leap { 29 } else { 28 };
    }
    if [4, 6, 9, 11].contains(&month) { 30 } else { 31 }
}

fn number(text: &str) -> i64 {
    text.parse().unwrap_or(0)
}

fn is_calendar_date(value: &str) -> bool {
    let Some(captures) = pattern!(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})$").captures(value) else { return false };
    let (year, month, day) = (number(&captures[1]), number(&captures[2]), number(&captures[3]));
    if year < 1 || !(1..=12).contains(&month) || day < 1 {
        return false;
    }
    day <= days_in_month(year, month)
}

fn is_timestamp(value: &str) -> bool {
    let Some(captures) =
        pattern!(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?(Z|[+-][0-9]{2}:[0-9]{2})$").captures(value)
    else {
        return false;
    };
    if !is_calendar_date(&format!("{}-{}-{}", &captures[1], &captures[2], &captures[3])) {
        return false;
    }
    if number(&captures[4]) > 23 || number(&captures[5]) > 59 {
        return false;
    }
    if captures.get(6).is_some_and(|seconds| number(seconds.as_str()) > 59) {
        return false;
    }
    let zone = &captures[8];
    if zone == "Z" {
        return true;
    }
    let (offset_hours, offset_minutes) = (number(&zone[1..3]), number(&zone[4..6]));
    if offset_hours > 14 || offset_minutes > 59 {
        return false;
    }
    offset_hours < 14 || offset_minutes == 0
}

fn is_time(value: &str) -> bool {
    let Some(captures) = pattern!(r"^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,6}))?)?(Z|[+-][0-9]{2}:[0-9]{2})?$").captures(value) else {
        return false;
    };
    let seconds = captures.get(3).map_or(0, |seconds| number(seconds.as_str()));
    if number(&captures[1]) > 23 || number(&captures[2]) > 59 || seconds > 59 {
        return false;
    }
    let Some(zone) = captures.get(5).map(|zone| zone.as_str()) else { return true };
    if zone == "Z" {
        return true;
    }
    let (hours, minutes) = (number(&zone[1..3]), number(&zone[4..6]));
    if hours < 14 { minutes <= 59 } else { hours == 14 && minutes == 0 }
}

fn quote_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Renders the SQL value expression without the `DEFAULT` keyword. Literal content
/// is quoted and its quotes doubled, so it can never become a statement.
pub fn render_default_expression(value: &ColumnDefault, column_type: Option<&str>) -> Option<String> {
    match value {
        ColumnDefault::None => None,
        ColumnDefault::CurrentTimestamp => Some("CURRENT_TIMESTAMP".into()),
        ColumnDefault::GenerateUuid => Some("gen_random_uuid()".into()),
        ColumnDefault::Literal { literal_type, value } => Some(match literal_type.as_str() {
            "text" => quote_string_literal(value),
            "integer" | "numeric" | "boolean" => value.clone(),
            "date" => format!("DATE {}", quote_string_literal(value)),
            "time" if column_type == Some("timetz") => format!("TIME WITH TIME ZONE {}", quote_string_literal(value)),
            "time" => format!("TIME {}", quote_string_literal(value)),
            "timestamp" => format!("TIMESTAMP WITH TIME ZONE {}", quote_string_literal(value)),
            "json" => format!("JSONB {}", quote_string_literal(value)),
            _ => value.clone(),
        }),
    }
}
