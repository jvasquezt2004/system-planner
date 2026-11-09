//! Replays `fixtures/data/transfer.json`: the TypeScript actions' results for copies and exports
//! against fake pickers, and the files they leave behind.

use std::path::Path;
use std::sync::{Arc, Mutex};

use schema_transfer::{Actions, Platform, ProjectHost};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/data/transfer.json");
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

/// "2026-10-26T21:00:00.000Z" as milliseconds since the epoch.
fn parse_iso(text: &str) -> i64 {
    let number = |range: std::ops::Range<usize>| text[range].parse::<i64>().unwrap();
    let (year, month, day) = (number(0..4), number(5..7), number(8..10));
    let (year_adjusted, month_adjusted) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = year_adjusted.div_euclid(400);
    let year_of_era = year_adjusted - era * 400;
    let day_of_year = (153 * month_adjusted + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    days * 86_400_000 + number(11..13) * 3_600_000 + number(14..16) * 60_000 + number(17..19) * 1000 + number(20..23)
}

struct Fake {
    root: String,
    directory: String,
    clipboard: Mutex<Option<String>>,
    clipboard_error: Option<String>,
    now: i64,
    import_file: Option<String>,
}

impl Platform for Fake {
    fn choose_directory(&self) -> Option<String> {
        match self.directory.as_str() {
            "dir" => Some(self.root.clone()),
            "cancel" => None,
            "blank" => Some("   ".into()),
            _ => Some(format!("{}/nowhere", self.root)),
        }
    }

    fn choose_file(&self) -> Option<String> {
        self.import_file.clone()
    }

    fn choose_files(&self) -> Vec<String> {
        vec![]
    }

    fn open_path(&self, _path: &str) -> bool {
        false
    }

    fn write_clipboard_text(&self, text: &str) -> Result<(), String> {
        if let Some(error) = &self.clipboard_error {
            return Err(error.clone());
        }
        *self.clipboard.lock().unwrap() = Some(text.to_owned());
        Ok(())
    }

    fn now_millis(&self) -> i64 {
        self.now
    }
}

struct Host {
    workspace: Value,
}

impl ProjectHost for Host {
    fn has_open_project(&self) -> bool {
        true
    }

    fn open_project_id(&self) -> Option<String> {
        Some("p1".into())
    }

    fn export_project(&self) -> Result<Value, String> {
        match self.workspace["exportError"].as_str() {
            Some(error) => Err(error.to_owned()),
            None => Ok(self.workspace["exportDocument"].clone()),
        }
    }

    fn import_project(&self, _document: &Value) -> Result<Option<(String, String)>, String> {
        let outcome = self.workspace.get("importProject").cloned().unwrap_or(json!({ "project": { "id": "p1", "name": "Imported" } }));
        if let Some(error) = outcome.get("error").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        Ok(outcome["project"].as_object().map(|project| (project["id"].as_str().unwrap().to_owned(), project["name"].as_str().unwrap().to_owned())))
    }

    fn require_active_design(&self, _design_id: Option<&str>) -> Result<(), String> {
        Ok(())
    }
}

fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b)),
        (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| json_equal(a, b))),
        _ => a == b,
    }
}

fn decode(base64: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let (mut bytes, mut accumulator, mut bits) = (Vec::new(), 0u32, 0u32);
    for c in base64.bytes().filter(|c| *c != b'=') {
        accumulator = accumulator << 6 | ALPHABET.iter().position(|a| *a == c).unwrap() as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((accumulator >> bits & 0xff) as u8);
        }
    }
    bytes
}

#[test]
fn the_file_actions_match_the_typescript_actions() {
    let cases = fixture();
    let mut failures = Vec::new();
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let setup = &case["setup"];
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_str().unwrap().to_owned();
        for file in setup["existing"].as_array().into_iter().flatten() {
            std::fs::write(directory.path().join(file["name"].as_str().unwrap()), file["text"].as_str().unwrap()).unwrap();
        }
        let import_file = match &setup["importFile"] {
            Value::Null => None,
            Value::String(kind) if kind == "cancel" => None,
            Value::String(kind) if kind == "missing" => Some(format!("{root}/no-such-file.json")),
            Value::String(_) => Some(root.clone()),
            file => {
                let path = directory.path().join("import.json");
                std::fs::write(&path, decode(file["base64"].as_str().unwrap())).unwrap();
                Some(path.to_str().unwrap().to_owned())
            }
        };
        let fake = Arc::new(Fake {
            root: root.clone(),
            directory: setup["directory"].as_str().unwrap_or("dir").to_owned(),
            clipboard: Mutex::new(None),
            clipboard_error: setup["clipboard"].as_str().and_then(|text| text.strip_prefix("fail:")).map(str::to_owned),
            now: parse_iso(setup["now"].as_str().unwrap_or("2026-10-26T21:00:00.000Z")),
            import_file,
        });
        let actions = Actions::new(fake.clone(), Arc::new(Host { workspace: setup["workspace"].clone() }));
        let input = &case["input"];
        let result = match case["action"].as_str().unwrap() {
            "copySql" => actions.copy_sql(input.get("preview")),
            "exportSql" => actions.export_sql(input.get("preview"), input.get("fileName").unwrap_or(&Value::Null)),
            "copyCode" => actions.copy_code(input.get("snapshot")),
            "exportCode" => actions.export_code(input.get("snapshot"), input.get("fileName").unwrap_or(&Value::Null)),
            "exportSvg" => actions.export_system_design_svg(input),
            "exportPng" => actions.export_system_design_png(input),
            "exportProject" => actions.export_project(),
            "importProject" => actions.import_project(),
            other => panic!("unknown action {other}"),
        };
        let result: Value = serde_json::from_str(&serde_json::to_string(&result).unwrap().replace(&root, "<dir>")).unwrap();
        let mut files = serde_json::Map::new();
        for entry in std::fs::read_dir(directory.path()).unwrap() {
            let entry = entry.unwrap();
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if file_name == "import.json" {
                continue;
            }
            // The original hashes the bytes as Latin-1 text.
            let text: String = std::fs::read(entry.path()).unwrap().iter().map(|byte| *byte as char).collect();
            files.insert(file_name, json!(fnv(&text)));
        }
        let clipboard = fake.clipboard.lock().unwrap().clone();
        if !json_equal(&result, &case["result"]) {
            failures.push(format!("{name}\n  expected {}\n  actual   {result}", case["result"]));
        } else if clipboard.as_deref() != case["clipboard"].as_str() {
            failures.push(format!("{name}: the clipboard holds {clipboard:?}, expected {}", case["clipboard"]));
        } else if Value::Object(files.clone()) != case["files"] {
            failures.push(format!("{name}: files differ\n  expected {}\n  actual   {}", case["files"], Value::Object(files)));
        }
    }
    assert!(failures.is_empty(), "{} of {} cases differ:\n{}", failures.len(), cases.as_array().unwrap().len(), failures.join("\n"));
}
