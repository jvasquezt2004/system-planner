//! Shared helpers for replaying the TypeScript-generated fixtures.

use std::path::PathBuf;

use serde_json::Value;

/// `tauri/fixtures/data/<name>`, relative to this crate.
pub fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/data").join(name)
}

pub fn read_json(name: &str) -> Value {
    let path = fixture_path(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("missing fixture {} ({error}); run the generators in tauri/fixtures with bun", path.display())
    });
    serde_json::from_str(&text).expect("fixture is valid JSON")
}

/// JSON equality where numbers compare by value, so `1` equals `1.0` as it does in JavaScript.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b)),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b)))
        }
        _ => a == b,
    }
}

/// Replays `{ name, input, result: { ok } | { error } }` cases and fails with a readable summary.
pub fn replay(cases: &Value, run: impl Fn(&Value) -> Result<Value, String>) {
    let cases = cases.as_array().expect("fixture is an array of cases");
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let actual = run(&case["input"]);
        let result = &case["result"];
        let mismatch = match (&actual, result.get("ok"), result.get("error")) {
            (Ok(actual), Some(expected), _) if json_equal(actual, expected) => None,
            (Ok(actual), Some(expected), _) => Some(format!("output differs\n  expected {expected}\n  actual   {actual}")),
            (Err(actual), _, Some(expected)) if Some(actual.as_str()) == expected.as_str() => None,
            (Err(actual), _, Some(expected)) => Some(format!("error differs\n  expected {expected}\n  actual   {actual:?}")),
            (Ok(actual), _, Some(expected)) => Some(format!("expected error {expected}, got output {actual}")),
            (Err(actual), Some(expected), _) => Some(format!("expected output {expected}, got error {actual:?}")),
            _ => Some("malformed fixture case".into()),
        };
        if let Some(mismatch) = mismatch {
            failures.push(format!("- {name}\n  {mismatch}"));
        }
    }
    if !failures.is_empty() {
        let shown: Vec<_> = failures.iter().take(8).cloned().collect();
        panic!("{} of {} cases differ from the TypeScript oracle:\n{}", failures.len(), cases.len(), shown.join("\n"));
    }
    println!("{} cases match the TypeScript oracle", cases.len());
}

/// FNV-1a 64-bit over UTF-8, the fingerprint the fixtures use for long generated text.
pub fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// `{ hash, length }` where length is JavaScript's `.length` (UTF-16 code units).
pub fn fingerprint(text: &str) -> Value {
    serde_json::json!({ "hash": fnv(text), "length": text.encode_utf16().count() })
}

/// Applies one recorded edit (`set`, `delete`, `insert`, `remove`) at a path of keys and indexes.
pub fn apply_edit(doc: &mut Value, edit: &Value) {
    let path = edit["path"].as_array().expect("edit path");
    let (last, parents) = path.split_last().expect("non-empty path");
    let mut node = doc;
    for step in parents {
        node = match step {
            Value::String(key) => node.get_mut(key.as_str()).expect("path key"),
            Value::Number(index) => node.get_mut(index.as_u64().expect("index") as usize).expect("path index"),
            other => panic!("bad path step {other}"),
        };
    }
    match edit["op"].as_str().expect("op") {
        "set" => match last {
            Value::String(key) => {
                node.as_object_mut().expect("object").insert(key.clone(), edit["value"].clone());
            }
            Value::Number(index) => node[index.as_u64().unwrap() as usize] = edit["value"].clone(),
            other => panic!("bad step {other}"),
        },
        "delete" => {
            node.as_object_mut().expect("object").shift_remove(last.as_str().expect("key"));
        }
        "insert" => node.as_array_mut().expect("array").insert(last.as_u64().unwrap() as usize, edit["value"].clone()),
        "remove" => {
            node.as_array_mut().expect("array").remove(last.as_u64().unwrap() as usize);
        }
        other => panic!("unknown edit {other}"),
    }
}
