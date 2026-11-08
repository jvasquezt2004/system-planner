//! Replays the sessions the real TypeScript workspace produced (see `tauri/fixtures/generate-workspace.ts`).
//!
//! Each session starts from an empty database and makes the same calls with the same clock and ids.
//! For every call the settled state, the error, and the sequence of states pushed while it ran must
//! match the original's, and so must the database at the end.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use regex::Regex;
use schema_sandbox::{AppliedColumn, AppliedTable, ApplyResult, Failure, Sandbox};
use schema_store::Store;
use schema_workspace::{Options, SandboxFactory, Workspace, WorkspaceState};
use serde_json::{json, Value};

/// Top-level fields not compared yet: they belong to Undo/Redo, which is not ported.
const NOT_YET_PORTED: &[&str] = &["undoRedo", "undoActionName", "redoActionName"];

/// The same stub the TypeScript driver uses: it reports each `CREATE TABLE` as a table with its
/// columns, and fails on SQL naming `reject_me` or `boom`.
struct Stub;

impl Sandbox for Stub {
    fn apply(&mut self, sql: &str) -> ApplyResult {
        if sql.contains("reject_me") {
            return ApplyResult::Failed { failure: Failure::SqlRejected, error: "stub: rejected".into() };
        }
        if sql.contains("boom") {
            return ApplyResult::Failed { failure: Failure::SandboxError, error: "stub: boom".into() };
        }
        let table = Regex::new(r#"CREATE TABLE "((?:[^"]|"")*)" \(\n([\s\S]*?)\n\);"#).unwrap();
        let column = Regex::new(r#"(?m)^ {2}"((?:[^"]|"")*)" (\S+)"#).unwrap();
        let tables = table
            .captures_iter(sql)
            .map(|found| AppliedTable {
                name: found[1].replace("\"\"", "\""),
                columns: column
                    .captures_iter(&found[2])
                    .map(|c| AppliedColumn {
                        name: c[1].replace("\"\"", "\""),
                        data_type: c[2].to_owned(),
                        enum_type_name: None,
                        is_identity: false,
                        default_expression: None,
                        nullable: true,
                        primary_key: false,
                        unique: false,
                    })
                    .collect(),
                indexes: None,
            })
            .collect();
        ApplyResult::Applied { tables, relationships: vec![] }
    }
}

/// FNV-1a 64-bit over UTF-8, the fingerprint the fixtures use.
fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// JSON with sorted keys and JavaScript's number formatting, the form the fingerprints are taken of.
fn canonical(value: &Value) -> String {
    match value {
        Value::Array(items) => format!("[{}]", items.iter().map(canonical).collect::<Vec<_>>().join(",")),
        Value::Object(map) => {
            let sorted: BTreeMap<&String, &Value> = map.iter().collect();
            format!("{{{}}}", sorted.iter().map(|(key, value)| format!("{}:{}", serde_json::to_string(key).unwrap(), canonical(value))).collect::<Vec<_>>().join(","))
        }
        Value::Number(number) => match number.as_f64() {
            Some(n) if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", n as i64),
            _ => number.to_string(),
        },
        other => serde_json::to_string(other).unwrap(),
    }
}

fn fingerprints(state: &Value) -> BTreeMap<String, String> {
    state.as_object().unwrap().iter().map(|(key, value)| (key.clone(), fnv(&canonical(value)))).collect()
}

fn without_unported(mut fields: BTreeMap<String, String>) -> BTreeMap<String, String> {
    for key in NOT_YET_PORTED {
        fields.remove(*key);
    }
    fields
}

fn status(value: &Value) -> &str {
    value["status"].as_str().unwrap_or("-")
}

/// The push trail entry the TypeScript driver writes for a state.
fn trail_entry(state: &WorkspaceState) -> String {
    let state = serde_json::to_value(state).unwrap();
    format!(
        "rev{} save:{} sql:{} sandbox:{} system:{} walkthrough:{} view:{} design:{}",
        state["revision"],
        status(&state["save"]),
        status(&state["sql"]),
        status(&state["sandbox"]),
        status(&state["systemSave"]),
        status(&state["walkthroughSave"]),
        state["activeView"].as_str().unwrap(),
        state["activeDesignId"].as_str().unwrap_or("-"),
    )
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/data/workspace-sessions.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("missing {} ({error}); run `bun tauri/fixtures/generate-workspace.ts`", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// The same ordered reading of the database that the fixtures fingerprint.
fn dump(path: &std::path::Path) -> Value {
    let store = Store::open(path).unwrap();
    let to_value = |value: &dyn erased::Serialize| value.to_json();
    let projects = store.list_projects().unwrap();
    Value::Array(
        projects
            .iter()
            .map(|project| {
                let designs = store.list_designs(&project.id).unwrap();
                json!({
                    "summary": to_value(project),
                    "project": to_value(&store.load_project(&project.id).unwrap()),
                    "designs": designs.iter().map(|summary| json!({
                        "summary": to_value(summary),
                        "record": to_value(&store.load_design(&summary.id).unwrap()),
                        "scenarios": to_value(&store.load_scenarios(&project.id, &summary.id).unwrap()),
                        "edgeFunctions": to_value(&store.load_edge_functions(&project.id, &summary.id).unwrap()),
                    })).collect::<Vec<_>>(),
                    "systemDesign": to_value(&store.load_system_design(&project.id).unwrap()),
                    "walkthroughs": to_value(&store.load_walkthroughs(&project.id).unwrap()),
                })
            })
            .collect(),
    )
}

mod erased {
    pub trait Serialize {
        fn to_json(&self) -> serde_json::Value;
    }
    impl<T: serde::Serialize> Serialize for T {
        fn to_json(&self) -> serde_json::Value {
            serde_json::to_value(self).unwrap()
        }
    }
}

fn replay(session: &Value) -> Result<usize, String> {
    let name = session["name"].as_str().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let step = Arc::new(AtomicUsize::new(0));
    let counter = Arc::new(AtomicUsize::new(0));

    let sandbox: SandboxFactory = Arc::new(|| Box::new(Stub));
    let mut options = Options::new(&path, sandbox);
    options.preview_delay = Duration::from_millis(3);
    options.now = { let clock = clock.clone(); Arc::new(move || clock.load(Ordering::SeqCst)) };
    options.create_id = { let (step, counter) = (step.clone(), counter.clone()); Arc::new(move || format!("id-{}-{}", step.load(Ordering::SeqCst), counter.fetch_add(1, Ordering::SeqCst) + 1)) };
    let workspace = Workspace::open(options)?;
    let trail = Arc::new(Mutex::new(Vec::<String>::new()));
    let sink = trail.clone();
    workspace.subscribe(Arc::new(move |state: &WorkspaceState| sink.lock().unwrap().push(trail_entry(state))));

    let steps = session["steps"].as_array().unwrap();
    for (index, expected) in steps.iter().enumerate() {
        let method = expected["method"].as_str().unwrap();
        clock.store(1_000_000 + index as i64 * 1000, Ordering::SeqCst);
        step.store(index, Ordering::SeqCst);
        counter.store(0, Ordering::SeqCst);
        trail.lock().unwrap().clear();

        let actual = workspace.request(method, expected["params"].clone());
        let pushed = trail.lock().unwrap().clone();
        let state_now = serde_json::to_value(workspace.state()).unwrap();
        // On a mismatch the replay leaves its own state next to the expected one for a diff.
        let context = || {
            let dump = std::env::temp_dir().join(format!("oracle-actual-{name}-{index}.json"));
            let _ = std::fs::write(&dump, serde_json::to_string_pretty(&state_now).unwrap());
            format!("{name} step {index}: {method} {}\n  actual state written to {}", expected["params"], dump.display())
        };

        let outcome = &expected["outcome"];
        if let Some(message) = outcome.get("error") {
            match &actual {
                Err(actual) if Some(actual.as_str()) == message.as_str() => {}
                other => return Err(format!("{}\n  expected error {message}\n  actual {other:?}", context())),
            }
        } else if let Some(plan) = outcome["ok"].get("value") {
            match &actual {
                Ok(actual) if actual == plan || canonical(actual) == canonical(plan) => {}
                other => return Err(format!("{}\n  expected plan {plan}\n  actual {other:?}", context())),
            }
        } else {
            let expected_fields: BTreeMap<String, String> = serde_json::from_value(outcome["ok"]["fields"].clone()).unwrap();
            match &actual {
                Ok(state) => {
                    let actual_fields = without_unported(fingerprints(state));
                    let expected_fields = without_unported(expected_fields);
                    if actual_fields != expected_fields {
                        let differing: Vec<&String> = expected_fields.keys().chain(actual_fields.keys()).filter(|key| expected_fields.get(*key) != actual_fields.get(*key)).collect();
                        return Err(format!("{}\n  the settled state differs in: {differing:?}\n  (bun tauri/fixtures/explain-workspace.ts {name} {index} prints the expected state)", context()));
                    }
                }
                Err(error) => return Err(format!("{}\n  expected the call to succeed, got {error:?}", context())),
            }
        }
        if let Some(after) = expected.get("after") {
            let expected_after: BTreeMap<String, String> = serde_json::from_value(after.clone()).unwrap();
            if without_unported(fingerprints(&state_now)) != without_unported(expected_after.clone()) {
                let actual_after = without_unported(fingerprints(&state_now));
                let differing: Vec<&String> = expected_after.keys().filter(|key| !NOT_YET_PORTED.contains(&key.as_str()) && expected_after.get(*key) != actual_after.get(*key)).collect();
                return Err(format!("{}\n  after the call the workspace holds a different state in: {differing:?}", context()));
            }
        }
        let expected_trail: Vec<String> = serde_json::from_value(expected["trail"].clone()).unwrap();
        if pushed != expected_trail {
            return Err(format!("{}\n  pushed states differ\n  expected {expected_trail:#?}\n  actual   {pushed:#?}", context()));
        }
    }

    drop(workspace);
    let fingerprint = fnv(&canonical(&dump(&path)));
    let expected = session["storeFingerprint"].as_str().unwrap();
    if fingerprint != expected {
        return Err(format!("{name}: the database ends differently (expected {expected}, got {fingerprint})"));
    }
    Ok(steps.len())
}

#[test]
fn the_workspace_matches_the_typescript_workspace() {
    let sessions = fixture();
    let mut failures = Vec::new();
    let mut calls = 0;
    for session in sessions.as_array().unwrap() {
        match replay(session) {
            Ok(count) => calls += count,
            Err(failure) => failures.push(failure),
        }
    }
    assert!(failures.is_empty(), "{} of {} sessions diverge from the TypeScript workspace:\n{}", failures.len(), sessions.as_array().unwrap().len(), failures.join("\n\n"));
    println!("{calls} calls across the sessions match the TypeScript workspace");
}
