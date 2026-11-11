use std::path::Path;

use schema_folder::{folder_slug, render_project_folder};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/data/folder.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("missing fixture {} ({error})", path.display()))).unwrap()
}

fn fnv(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[test]
fn slugs_match() {
    for case in fixture()["slugs"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert_eq!(json!(folder_slug(name, "untitled")), case["slug"], "slug of {name:?}");
        assert_eq!(json!(folder_slug(name, "project")), case["fallback"], "slug of {name:?} with a fallback");
    }
}

#[test]
fn the_rendered_folders_match() {
    let mut failures = Vec::new();
    let data = fixture();
    for case in data["cases"].as_array().unwrap() {
        let rendered = render_project_folder(&case["document"], case["projectId"].as_str().unwrap(), case["context"].as_array().unwrap());
        let key = case["key"].as_str().unwrap();
        match rendered {
            Err(error) => failures.push(format!("{key}: {error}")),
            Ok(files) => {
                let actual: Vec<Value> = files.iter().map(|(path, content)| json!([path, fnv(content)])).collect();
                if Value::Array(actual.clone()) != case["files"] {
                    let expected = case["files"].as_array().unwrap();
                    let first = actual.iter().zip(expected).position(|(a, e)| a != e).map_or(format!("{} files vs {}", actual.len(), expected.len()), |i| format!("{} vs {}", actual[i], expected[i]));
                    failures.push(format!("{key}: {first}"));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} renderings differ:\n{}", failures.len(), data["cases"].as_array().unwrap().len(), failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
}

fn document() -> Value {
    let data = fixture();
    let with_tables = data["cases"].as_array().unwrap().iter().find(|case| !case["document"]["designs"][0]["design"]["tables"].as_array().unwrap().is_empty());
    with_tables.expect("a recorded Project with a table")["document"].clone()
}

#[test]
fn sync_writes_the_folder_and_keeps_an_edited_schema_file() {
    let root = tempfile::tempdir().unwrap();
    let mirror = schema_folder::ProjectFolderMirror::new(root.path());
    let document = document();
    let dir = mirror.sync(&document, "p1", None, false).unwrap();
    assert!(dir.join(schema_folder::PROJECT_FOLDER_MARKER).exists());
    assert!(dir.join("README.md").exists() && dir.join("system-design.md").exists() && dir.join("walkthroughs.json").exists());
    let schema = mirror.schema_file(document["designs"][0]["id"].as_str().unwrap()).unwrap();
    let original = std::fs::read_to_string(&schema).unwrap();
    // Everything but schema.sql is read-only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir.join("README.md")).unwrap().permissions().mode() & 0o777, 0o444);
        assert_eq!(std::fs::metadata(&schema).unwrap().permissions().mode() & 0o777, 0o644);
    }
    // A tool edits schema.sql; the Project then changes, and the edit is not overwritten...
    std::fs::write(&schema, "-- my edit\n").unwrap();
    let mut changed = document.clone();
    changed["designs"][0]["design"]["tables"][0]["name"] = json!("renamed_table");
    mirror.sync(&changed, "p1", None, false).unwrap();
    assert_eq!(std::fs::read_to_string(&schema).unwrap(), "-- my edit\n");
    // ...unless the sync is forced.
    mirror.sync(&changed, "p1", None, true).unwrap();
    assert!(std::fs::read_to_string(&schema).unwrap().contains("renamed_table"));
    assert_ne!(std::fs::read_to_string(&schema).unwrap(), original);
}

#[test]
fn sync_moves_the_folder_with_the_project_name_and_drops_stale_files() {
    let root = tempfile::tempdir().unwrap();
    // A folder that is not ours was there before the first sync.
    std::fs::create_dir(root.path().join("blog")).unwrap();
    let mirror = schema_folder::ProjectFolderMirror::new(root.path());
    let mut document = document();
    document["project"]["name"] = json!("Shop");
    let first = mirror.sync(&document, "p1", None, false).unwrap();
    assert_eq!(first.file_name().unwrap(), "shop");
    document["project"]["name"] = json!("Storefront");
    let second = mirror.sync(&document, "p1", None, false).unwrap();
    assert_eq!(second.file_name().unwrap(), "storefront");
    assert!(!first.exists() && second.exists());
    // The folder that is not ours keeps the name; the Project takes a suffixed one.
    document["project"]["name"] = json!("Blog");
    let third = mirror.sync(&document, "p1", None, false).unwrap();
    assert_eq!(third.file_name().unwrap(), "blog-p1");
    // Removing every Scenario removes its file and the emptied folders.
    let mut with_scenario = document.clone();
    with_scenario["designs"][0]["scenarios"] = json!([{ "id": "s1", "name": "Happy path", "source": "x" }]);
    let dir = mirror.sync(&with_scenario, "p1", None, false).unwrap();
    let scenarios = std::fs::read_dir(dir.join("designs")).unwrap().next().unwrap().unwrap().path().join("scenarios");
    assert!(scenarios.join("happy-path.ts").exists());
    mirror.sync(&document, "p1", None, false).unwrap();
    assert!(!scenarios.exists());
}
