use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use schema_domain::js;
use schema_files::*;
use schema_store::{DesignSave, ProjectSummary, Store};
use serde_json::{json, Value};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/data/project-files.json");
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_else(|error| panic!("missing fixture {} ({error})", path.display()))).unwrap()
}

fn strip(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), if key == "id" { json!("<id>") } else { strip(value) })).collect()),
        Value::Array(items) => Value::Array(items.iter().map(strip).collect()),
        other => other.clone(),
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
fn the_naming_and_type_rules_match() {
    let data = fixture();
    for case in data["naming"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        assert_eq!(json!(safe_file_name(name)), case["safe"], "safe name of {name:?}");
        assert_eq!(json!(file_extension(name)), case["extension"], "extension of {name:?}");
        assert_eq!(json!(is_text_file_name(name)), case["text"], "text type of {name:?}");
        assert_eq!(json!(mime_for_file_name(name)), case["mime"], "mime of {name:?}");
    }
    for case in data["uniques"].as_array().unwrap() {
        let taken: Vec<String> = case["taken"].as_array().unwrap().iter().map(|name| name.as_str().unwrap().to_owned()).collect();
        assert_eq!(json!(unique_file_name(case["name"].as_str().unwrap(), &taken)), case["result"], "unique name {case}");
    }
}

#[test]
fn the_text_read_from_files_matches() {
    for case in fixture()["extraction"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let result = extract_file_text(name, &decode(case["base64"].as_str().unwrap()));
        let mut actual = json!({ "text": result.text.as_ref().map(|text| format!("{}:{}", js::length(text), js::slice(text, 40))) });
        if let Some(pages) = result.pages {
            actual["pages"] = json!(pages);
        }
        if let Some(note) = &result.note {
            actual["note"] = json!(note);
        }
        // A file that is not valid UTF-8 is compared whole.
        if name == "bad.txt" {
            actual["text"] = json!(result.text);
        }
        assert_eq!(actual, case["result"], "extraction of {name}");
    }
}

#[test]
fn the_store_matches() {
    let directory = tempfile::tempdir().unwrap();
    let database = directory.path().join("files.sqlite");
    {
        let mut store = Store::open(&database).unwrap();
        for (project, design) in [("p1", "d1"), ("p2", "d2")] {
            let document = json!({ "tables": [], "relationships": [], "manyToManyRelationships": [], "viewport": { "x": 0, "y": 0, "zoom": 1 } });
            store
                .create_project(&ProjectSummary { id: project.into(), name: project.into() }, &document, DesignSave { revision: 1, document_revision: 1, saved_at: 1 }, design)
                .unwrap();
        }
    }
    let clock = Arc::new(AtomicI64::new(1000));
    let files = ProjectFiles::open(&database, { let clock = clock.clone(); move || clock.fetch_add(10, Ordering::SeqCst) + 10 }).unwrap();
    let mut removable = String::new();
    for (index, step) in fixture()["steps"].as_array().unwrap().iter().enumerate() {
        let args = &step["args"];
        let project = args["project"].as_str().unwrap_or("p1");
        let result = match step["op"].as_str().unwrap() {
            "add" => files.add(project, args["name"].as_str().unwrap(), &decode(args["base64"].as_str().unwrap())).map(|file| strip(&file)),
            "remove" => {
                if args["index"] == json!(1) {
                    removable = files.list("p1").unwrap()[1]["id"].as_str().unwrap().to_owned();
                }
                let id = if args["index"] == json!(-1) { "missing".to_owned() } else { removable.clone() };
                files.remove(project, &id).map(|removed| json!(removed))
            }
            "text" => Ok(files.text(project, args["name"].as_str().unwrap()).map_or(Value::Null, |(file, text)| json!({ "file": strip(&file), "text": text }))),
            "addFromPaths" => {
                for _ in 0..55 {
                    if let Some(first) = files.list("p1").unwrap().first() {
                        files.remove("p1", first["id"].as_str().unwrap()).unwrap();
                    }
                }
                let root = directory.path().to_str().unwrap();
                std::fs::write(directory.path().join("from-disk.txt"), "from disk").unwrap();
                std::fs::create_dir_all(directory.path().join("a-folder")).unwrap();
                let (added, skipped) = files.add_from_paths("p1", &[format!("{root}/from-disk.txt"), format!("{root}/a-folder"), format!("{root}/gone/missing.txt")]);
                let skipped: Vec<Value> = skipped.iter().map(|entry| json!({ "name": entry["name"], "reason": entry["reason"].as_str().unwrap().replace(root, "<dir>") })).collect();
                Ok(json!({ "added": strip(&Value::Array(added)), "skipped": skipped }))
            }
            other => panic!("unknown op {other}"),
        };
        let actual = match result {
            Ok(value) => json!({ "ok": value }),
            Err(error) => json!({ "error": error }),
        };
        assert_eq!(actual, step["result"], "step {index} {} {args}", step["op"]);
        if step["op"] != "addFromPaths" {
            let mut list = strip(&Value::Array(files.list("p1").unwrap())).as_array().unwrap().clone();
            list.extend(strip(&Value::Array(files.list("p2").unwrap())).as_array().unwrap().clone());
            assert_eq!(Value::Array(list), step["list"], "list after step {index}");
        }
    }
}

/// A one-page PDF whose page shows `text`.
fn pdf(text: &str) -> Vec<u8> {
    let content = format!("BT /F1 18 Tf 20 100 Td ({text}) Tj ET");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_owned(),
        format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_owned(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend(format!("{} 0 obj\n{object}\nendobj\n", index + 1).bytes());
    }
    let xref = out.len();
    out.extend(format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).bytes());
    for offset in offsets {
        out.extend(format!("{offset:010} 00000 n \n").bytes());
    }
    out.extend(format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).bytes());
    out
}

#[test]
fn a_pdf_gives_its_text_and_page_count() {
    let result = extract_file_text("spec.pdf", &pdf("Hello from a PDF"));
    assert_eq!(result.pages, Some(1));
    assert!(result.text.as_deref().is_some_and(|text| text.contains("Hello from a PDF")), "{result:?}");
    assert_eq!(result.note, None);
}

#[test]
fn a_pdf_without_text_or_that_is_broken_says_why() {
    let blank = extract_file_text("scan.pdf", &pdf(""));
    assert_eq!(blank.text, None);
    assert_eq!(blank.note.as_deref(), Some("No text found: this PDF looks scanned or is made of images."));
    let broken = extract_file_text("bad.pdf", b"this is not a pdf");
    assert_eq!(broken.text, None);
    assert!(broken.note.as_deref().is_some_and(|note| note.starts_with("The PDF could not be read:")), "{broken:?}");
}
