//! JavaScript semantics the TypeScript documents depend on.
//!
//! The stored documents were produced and validated by JavaScript, so a few of
//! its behaviours are part of the data contract: how `trim` and `length` treat
//! Unicode, how `Math.round` breaks ties, and how a value prints through
//! `String(value)` inside an error message.

use serde::Serializer;
use serde_json::{Map, Value};

/// The characters `String.prototype.trim` removes: ECMAScript WhiteSpace and LineTerminator.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `value.trim()`. Rust's own `trim` differs (it removes U+0085 and keeps U+FEFF).
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_js_space)
}

/// `value.length`: UTF-16 code units, not characters.
pub fn length(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, max)`. A cut through a surrogate pair drops the whole character
/// because a Rust `String` cannot hold half of one.
pub fn slice(value: &str, max: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in value.chars() {
        units += c.len_utf16();
        if units > max {
            break;
        }
        out.push(c);
    }
    out
}

/// `Math.round`: nearest integer, ties toward positive infinity.
pub fn round(x: f64) -> f64 {
    if (x - x.trunc()).abs() == 0.5 { x.ceil() } else { x.round() }
}

/// `Math.round(x * 100) / 100`.
pub fn round2(x: f64) -> f64 {
    round(x * 100.0) / 100.0
}

/// Serializes a number the way `JSON.stringify` does: `3`, not `3.0`.
pub fn serialize_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9.0e15 {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

/// `isRecord`: a non-null, non-array object.
pub fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// A JSON number as `f64`, or `None` for anything else. JSON has no non-finite numbers.
pub fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

/// `Number.isInteger` for a JSON value.
pub fn integer(value: &Value) -> Option<f64> {
    finite(value).filter(|n| n.fract() == 0.0)
}

/// `value ?? fallback` for an optional field: missing and `null` both fall back.
pub fn nullish<'a>(value: Option<&'a Value>) -> Option<&'a Value> {
    value.filter(|v| !v.is_null())
}

/// `String(value)` as it appears inside an error message.
pub fn to_js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { to_js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `String(n)` / template-literal formatting of a number.
pub fn number_to_string(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1.0e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}

/// The characters JavaScript's `\s` matches, as the body of a regex character class.
/// Rust's `\s` differs: it includes U+0085 and leaves out U+FEFF.
pub const SPACE_CLASS: &str = r"[\t\n\x0B\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";

/// `Number(value)` for a JSON value. Strings follow the common cases of the JavaScript
/// conversion (blank is 0, otherwise a decimal number or NaN).
pub fn to_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let trimmed = trim(text);
            if trimmed.is_empty() { 0.0 } else { trimmed.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}
