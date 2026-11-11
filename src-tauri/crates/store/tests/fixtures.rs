mod support;

use schema_store::Store;
use support::{dump, execute, fixture_path, json_equal, normalize_uuids, read_json};

/// Builds a legacy database the way the old app's driver saw it: foreign keys off, which is
/// how a row whose Project is gone could be written in the first place.
fn load_legacy_sql(connection: &rusqlite::Connection, sql: &str) {
    connection.execute_batch("PRAGMA foreign_keys = OFF").unwrap();
    connection.execute_batch(sql).unwrap();
}

/// Replays the scripted TypeScript session: every call must return the same result
/// or the same error, and the database must end up reading back identically.
#[test]
fn operation_script_matches_typescript() {
    let script = read_json("store-ops.json");
    let directory = tempfile::tempdir().unwrap();
    // OPS_DB_OUT keeps the database the replay builds, so the TypeScript store can be pointed at it.
    let path = std::env::var("OPS_DB_OUT").map(std::path::PathBuf::from).unwrap_or_else(|_| directory.path().join("ops.sqlite"));
    let mut store = Store::open(&path).unwrap();

    let mut failures = Vec::new();
    for (index, step) in script["steps"].as_array().unwrap().iter().enumerate() {
        let op = step["op"].as_str().unwrap();
        let note = step["note"].as_str().map(|n| format!(" ({n})")).unwrap_or_default();
        let actual = execute(&mut store, op, &step["args"]);
        let result = &step["result"];
        let mismatch = match (&actual, result.get("ok"), result.get("error")) {
            (Ok(actual), Some(expected), _) if json_equal(actual, expected) => None,
            (Ok(actual), Some(expected), _) => Some(format!("expected {expected}\n    actual   {actual}")),
            (Err(actual), _, Some(expected)) if Some(actual.as_str()) == expected.as_str() => None,
            (Err(actual), _, Some(expected)) => Some(format!("expected error {expected}\n    actual error {actual:?}")),
            (Ok(actual), _, Some(expected)) => Some(format!("expected error {expected}, got {actual}")),
            (Err(actual), Some(expected), _) => Some(format!("expected {expected}, got error {actual:?}")),
            _ => Some("malformed fixture step".into()),
        };
        if let Some(mismatch) = mismatch {
            failures.push(format!("step {index}: {op}{note}\n    {mismatch}"));
        }
    }
    let final_dump = dump(&store);
    if !json_equal(&final_dump, &script["dump"]) {
        failures.push(format!("final dump differs\n  expected {}\n  actual   {}", script["dump"], final_dump));
    }
    assert!(failures.is_empty(), "{} mismatches against the TypeScript store:\n{}", failures.len(), failures.join("\n"));
    println!("{} steps and the final dump match the TypeScript store", script["steps"].as_array().unwrap().len());
}

/// A database written by any earlier version of the app must migrate to the same
/// shape the TypeScript store leaves it in.
#[test]
fn legacy_databases_migrate_like_typescript() {
    let expected = read_json("store-legacy.json");
    let mut failures = Vec::new();
    for entry in expected.as_array().unwrap() {
        let file = entry["file"].as_str().unwrap();
        let sql = std::fs::read_to_string(fixture_path(&format!("legacy/{file}"))).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("legacy.sqlite");
        let raw = rusqlite::Connection::open(&path).unwrap();
        load_legacy_sql(&raw, &sql);
        raw.close().unwrap();

        let store = Store::open(&path).unwrap();
        let actual = normalize_uuids(&dump(&store));
        if !json_equal(&actual, &entry["dump"]) {
            failures.push(format!("{file}\n  expected {}\n  actual   {actual}", entry["dump"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Opening twice must change nothing: migrations are one-way and idempotent.
#[test]
fn reopening_a_migrated_database_changes_nothing() {
    let sql = std::fs::read_to_string(fixture_path("legacy/v0-no-design-ids.sql")).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("legacy.sqlite");
    let raw = rusqlite::Connection::open(&path).unwrap();
    load_legacy_sql(&raw, &sql);
    raw.close().unwrap();

    let first = dump(&Store::open(&path).unwrap());
    let second = dump(&Store::open(&path).unwrap());
    assert!(json_equal(&first, &second), "a second open altered the database");
}

/// Opt-in check against a real database written by the Electrobun app. Point it at a COPY:
/// opening migrates in place, and the copy keeps the original untouched.
///
///   REAL_DB_COPY=/path/copy.sqlite REAL_DB_EXPECTED=/path/ts-dump.json \
///     cargo test -p schema-store --test fixtures real_database -- --ignored --nocapture
///
/// The expected dump comes from the TypeScript store reading its own copy (see fixtures/README.md).
#[test]
#[ignore = "needs REAL_DB_COPY and REAL_DB_EXPECTED"]
fn real_database_matches_typescript() {
    let path = std::env::var("REAL_DB_COPY").expect("REAL_DB_COPY");
    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(std::env::var("REAL_DB_EXPECTED").expect("REAL_DB_EXPECTED")).unwrap()).unwrap();
    let store = Store::open(&path).unwrap();
    let actual = normalize_uuids(&dump(&store));
    let projects = actual.as_array().unwrap().len();
    let designs: usize = actual.as_array().unwrap().iter().map(|p| p["designs"].as_array().unwrap().len()).sum();
    println!("Rust read {projects} projects, {designs} designs");
    assert!(json_equal(&actual, &expected), "the real database reads differently from the TypeScript store");
}
