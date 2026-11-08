//! Helpers for replaying the TypeScript-generated store fixtures.

use std::path::PathBuf;

use schema_store::Store;
use serde_json::{Map, Value, json};

/// `tauri/fixtures/<relative>`, relative to this crate.
pub fn fixture_path(relative: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures").join(relative)
}

pub fn read_json(name: &str) -> Value {
    let path = fixture_path(&format!("data/{name}"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("missing fixture {} ({error}); run `bun tauri/fixtures/generate-store.ts`", path.display())
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

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, len)| {
            group.len() == len && group.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

/// Replaces each distinct UUID with `<uuid#n>` in order of first appearance. Object keys
/// are visited in sorted order.
pub fn normalize_uuids(value: &Value) -> Value {
    fn visit(node: &Value, seen: &mut Vec<String>) -> Value {
        match node {
            Value::String(text) if is_uuid(text) => {
                let index = seen.iter().position(|known| known == text).unwrap_or_else(|| {
                    seen.push(text.clone());
                    seen.len() - 1
                });
                Value::String(format!("<uuid#{}>", index + 1))
            }
            Value::Array(items) => Value::Array(items.iter().map(|item| visit(item, seen)).collect()),
            Value::Object(map) => {
                // Visit keys in sorted order so numbering matches the TypeScript traversal.
                let mut keys: Vec<&String> = map.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for key in keys {
                    out.insert(key.clone(), visit(&map[key], seen));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
    visit(value, &mut Vec::new())
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("serializes")
}

/// The same ordered reading of a store that `dumpStore` makes in TypeScript.
pub fn dump(store: &Store) -> Value {
    let projects = store.list_projects().unwrap();
    Value::Array(
        projects
            .iter()
            .map(|project| {
                let designs = store.list_designs(&project.id).unwrap();
                json!({
                    "summary": to_value(project),
                    "project": to_value(store.load_project(&project.id).unwrap()),
                    "designs": designs.iter().map(|summary| json!({
                        "summary": to_value(summary),
                        "record": to_value(store.load_design(&summary.id).unwrap()),
                        "scenarios": to_value(store.load_scenarios(&project.id, &summary.id).unwrap()),
                        "edgeFunctions": to_value(store.load_edge_functions(&project.id, &summary.id).unwrap()),
                    })).collect::<Vec<_>>(),
                    "systemDesign": to_value(store.load_system_design(&project.id).unwrap()),
                    "walkthroughs": to_value(store.load_walkthroughs(&project.id).unwrap()),
                })
            })
            .collect(),
    )
}

/// Runs one scripted operation, returning its JSON result or the error text.
pub fn execute(store: &mut Store, op: &str, args: &Value) -> Result<Value, String> {
    use schema_store::*;
    let get = |key: &str| &args[key];
    let text = |key: &str| args[key].as_str().unwrap_or_else(|| panic!("{op}: missing {key}")).to_owned();
    let parse = |key: &str| -> serde_json::Value { args[key].clone() };
    macro_rules! typed {
        ($key:expr, $ty:ty) => {
            serde_json::from_value::<$ty>(parse($key)).unwrap_or_else(|error| panic!("{op}.{}: {error}", $key))
        };
    }
    let result: std::result::Result<Value, StoreError> = (|| match op {
        "listProjects" => Ok(to_value(store.list_projects()?)),
        "createProject" => store
            .create_project(&typed!("project", ProjectSummary), get("design"), typed!("save", DesignSave), &text("designId"))
            .map(|()| Value::Null),
        "createDesign" => store
            .create_design(&text("projectId"), &text("designId"), &text("name"), get("design"), typed!("save", DesignSave))
            .map(|()| Value::Null),
        "renameDesign" => store
            .rename_design(&text("projectId"), &text("designId"), &text("name"), args["savedAt"].as_i64().unwrap())
            .map(|()| Value::Null),
        "saveDesign" => store
            .save_design(&text("projectId"), get("design"), typed!("save", DesignSave), &text("designId"))
            .map(|()| Value::Null),
        "saveProjectArtifacts" => store
            .save_project_artifacts(&serde_json::from_value::<ProjectArtifacts>(args.clone()).expect("artifacts"))
            .map(|()| Value::Null),
        "loadProject" => Ok(to_value(store.load_project(&text("projectId"))?)),
        "listDesigns" => Ok(to_value(store.list_designs(&text("projectId"))?)),
        "loadDesign" => Ok(to_value(store.load_design(&text("designId"))?)),
        "loadSystemDesign" => Ok(to_value(store.load_system_design(&text("projectId"))?)),
        "saveSystemDesign" => store
            .save_system_design(&text("projectId"), get("document"), typed!("save", DesignSave))
            .map(|()| Value::Null),
        "saveLastView" => {
            let view = typed!("view", schema_domain::system_design::SystemViewName);
            store.save_last_view(&text("projectId"), view).map(|()| Value::Null)
        }
        "loadWalkthroughs" => Ok(to_value(store.load_walkthroughs(&text("projectId"))?)),
        "saveWalkthroughs" => store
            .save_walkthroughs(&text("projectId"), get("walkthroughs"), typed!("save", ScenarioSave))
            .map(|()| Value::Null),
        "loadScenarios" => Ok(to_value(store.load_scenarios(&text("projectId"), &text("designId"))?)),
        "saveScenarios" => store
            .save_scenarios(&text("projectId"), &typed!("scenarios", Vec<StoredScenario>), typed!("save", ScenarioSave), &text("designId"))
            .map(|()| Value::Null),
        "loadEdgeFunctions" => Ok(to_value(store.load_edge_functions(&text("projectId"), &text("designId"))?)),
        "saveEdgeFunctions" => store
            .save_edge_functions(&text("projectId"), &typed!("edgeFunctions", Vec<StoredEdgeFunction>), typed!("save", ScenarioSave), &text("designId"))
            .map(|()| Value::Null),
        "importProject" => store
            .import_project(&typed!("prepared", PreparedProjectImport), args["savedAt"].as_i64().unwrap())
            .map(|()| Value::Null),
        other => panic!("unknown op {other}"),
    })();
    result.map_err(|error| error.to_string())
}
