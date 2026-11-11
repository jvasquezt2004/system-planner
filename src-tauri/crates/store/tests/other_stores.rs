//! Reads of tables that other stores of the original own: project files and the Assistant's settings.

use rusqlite::Connection;
use schema_store::{ProjectSummary, Store};
use serde_json::json;

fn store_with_project(directory: &tempfile::TempDir) -> (std::path::PathBuf, Store) {
    let path = directory.path().join("db.sqlite");
    let mut store = Store::open(&path).unwrap();
    store
        .create_project(&ProjectSummary { id: "p1".into(), name: "Shop".into() }, &json!({ "tables": [] }), schema_store::DesignSave { revision: 1, document_revision: 1, saved_at: 10 }, "d1")
        .unwrap();
    (path, store)
}

#[test]
fn without_the_other_stores_tables_there_is_nothing_and_the_default_applies() {
    let directory = tempfile::tempdir().unwrap();
    let (_, store) = store_with_project(&directory);
    assert!(store.list_project_files("p1").unwrap().is_empty());
    assert_eq!(store.assistant_request_cap().unwrap(), 40);
}

#[test]
fn files_are_listed_oldest_first_with_the_original_shape() {
    let directory = tempfile::tempdir().unwrap();
    let (path, store) = store_with_project(&directory);
    // The original's project files store creates this table when the first file is attached.
    let other = Connection::open(&path).unwrap();
    other
        .execute_batch(
            "CREATE TABLE project_files (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
				added_at INTEGER NOT NULL, pages INTEGER, note TEXT, text TEXT, content BLOB NOT NULL);
			INSERT INTO project_files VALUES ('f2', 'p1', 'later.png', 'image/png', 9, 300, NULL, 'An image: it has no text to read.', NULL, x'00');
			INSERT INTO project_files VALUES ('f1', 'p1', 'spec.pdf', 'application/pdf', 4096, 200, 12, '', 'text of the spec', x'01');
			INSERT INTO project_files VALUES ('f3', 'other', 'elsewhere.md', 'text/markdown', 1, 100, NULL, NULL, 'x', x'02');",
        )
        .unwrap();
    let files = serde_json::to_value(store.list_project_files("p1").unwrap()).unwrap();
    assert_eq!(
        files,
        json!([
            { "id": "f1", "name": "spec.pdf", "mime": "application/pdf", "size": 4096, "addedAt": 200, "hasText": true, "pages": 12 },
            { "id": "f2", "name": "later.png", "mime": "image/png", "size": 9, "addedAt": 300, "hasText": false, "note": "An image: it has no text to read." },
        ]),
        "an empty note and a missing page count are omitted, and other Projects' files are not shown"
    );
}

#[test]
fn the_request_cap_is_the_value_the_assistant_saved() {
    let directory = tempfile::tempdir().unwrap();
    let (path, store) = store_with_project(&directory);
    let other = Connection::open(&path).unwrap();
    other
        .execute_batch("CREATE TABLE assistant_settings (id INTEGER PRIMARY KEY, max_requests_per_turn INTEGER NOT NULL DEFAULT 40);")
        .unwrap();
    assert_eq!(store.assistant_request_cap().unwrap(), 40, "a table with no row uses the default");
    other.execute_batch("INSERT INTO assistant_settings (id, max_requests_per_turn) VALUES (1, 12);").unwrap();
    assert_eq!(store.assistant_request_cap().unwrap(), 12);
}
