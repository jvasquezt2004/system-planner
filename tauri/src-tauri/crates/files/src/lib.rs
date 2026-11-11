//! Files attached to a Project (`src/bun/project-files.ts` and `src/shared/project-files.ts`).
//! They live beside the Project's own data in the same database file, so a database written by
//! the Electrobun app opens unchanged. The Design never depends on them.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection};
use schema_domain::js;
use serde_json::{json, Value};

mod extract;
pub use extract::{extract_file_text, ExtractedText};

pub const PROJECT_FILE_LIMIT_BYTES: usize = 20 * 1024 * 1024;
pub const PROJECT_FILES_PER_PROJECT: usize = 50;

const TEXT_EXTENSIONS: [&str; 24] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "sql", "log", "ts", "tsx", "js", "jsx", "py", "toml", "ini", "env", "rst", "tex",
];

pub fn file_extension(name: &str) -> String {
    match name.rfind('.') {
        Some(dot) => name[dot + 1..].to_lowercase(),
        None => String::new(),
    }
}

pub fn is_text_file_name(name: &str) -> bool {
    TEXT_EXTENSIONS.contains(&file_extension(name).as_str())
}

/// A name that is safe to use as a file in the Project folder: no path parts, no control characters.
pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['\\', '/']).next().unwrap_or_default();
    let replaced: String = base.chars().map(|c| if c <= '\u{1f}' || "<>:\"|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = js::slice(js::trim(replaced.trim_start_matches('.')), 150);
    // `trim().slice()` in the original: slice, then nothing more; an empty result is "file".
    if cleaned.is_empty() { "file".to_owned() } else { cleaned }
}

/// "spec.pdf" when free, otherwise "spec (2).pdf", "spec (3).pdf"…
pub fn unique_file_name(name: &str, taken: &[String]) -> String {
    let used: Vec<String> = taken.iter().map(|entry| entry.to_lowercase()).collect();
    if !used.contains(&name.to_lowercase()) {
        return name.to_owned();
    }
    let dot = name.rfind('.').filter(|dot| *dot > 0);
    let (stem, extension) = match dot {
        Some(dot) => (&name[..dot], &name[dot..]),
        None => (name, ""),
    };
    (2..)
        .map(|n| format!("{stem} ({n}){extension}"))
        .find(|candidate| !used.contains(&candidate.to_lowercase()))
        .expect("an unbounded search ends")
}

pub fn mime_for_file_name(name: &str) -> String {
    match file_extension(name).as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "json" => "application/json",
        "html" => "text/html",
        "xml" => "application/xml",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        _ if is_text_file_name(name) => "text/plain",
        _ => "application/octet-stream",
    }
    .to_owned()
}

/// Node's wording for the failures a designer can meet when a file cannot be read.
fn node_message(error: &std::io::Error, path: &str, call: &str) -> String {
    let (code, text) = match error.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        _ => return error.to_string(),
    };
    format!("{code}: {text}, {call} '{path}'")
}

const SCHEMA: &str = "
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS project_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        added_at INTEGER NOT NULL,
        pages INTEGER,
        note TEXT,
        text TEXT,
        content BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_files_project ON project_files(project_id, added_at);
";

type Result<T> = std::result::Result<T, String>;

pub struct ProjectFiles {
    conn: Mutex<Connection>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

const COLUMNS: &str = "id, name, mime, size, added_at, pages, note, text IS NOT NULL AS has_text";

fn summarize(row: &rusqlite::Row) -> rusqlite::Result<Value> {
    let mut summary = json!({
        "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?, "mime": row.get::<_, String>(2)?,
        "size": row.get::<_, i64>(3)?, "addedAt": row.get::<_, i64>(4)?, "hasText": row.get::<_, i64>(7)? == 1,
    });
    if let Some(pages) = row.get::<_, Option<i64>>(5)? {
        summary["pages"] = json!(pages);
    }
    if let Some(note) = row.get::<_, Option<String>>(6)?.filter(|note| !note.is_empty()) {
        summary["note"] = json!(note);
    }
    Ok(summary)
}

impl ProjectFiles {
    pub fn open(path: impl AsRef<Path>, now: impl Fn() -> i64 + Send + Sync + 'static) -> Result<Self> {
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|error| error.to_string())?;
        Ok(Self { conn: Mutex::new(conn), now: Box::new(now) })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().expect("project files")
    }

    pub fn list(&self, project_id: &str) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut statement = conn.prepare(&format!("SELECT {COLUMNS} FROM project_files WHERE project_id = ? ORDER BY added_at, rowid")).map_err(|e| e.to_string())?;
        let rows = statement.query_map([project_id], summarize).map_err(|e| e.to_string())?;
        rows.collect::<std::result::Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn add(&self, project_id: &str, name: &str, bytes: &[u8]) -> Result<Value> {
        let existing = self.list(project_id)?;
        if existing.len() >= PROJECT_FILES_PER_PROJECT {
            return Err(format!("A Project holds at most {PROJECT_FILES_PER_PROJECT} files. Remove one first."));
        }
        if bytes.len() > PROJECT_FILE_LIMIT_BYTES {
            return Err(format!("{} is larger than {} MB.", safe_file_name(name), PROJECT_FILE_LIMIT_BYTES / 1024 / 1024));
        }
        if bytes.is_empty() {
            return Err(format!("{} is empty.", safe_file_name(name)));
        }
        let taken: Vec<String> = existing.iter().filter_map(|file| file["name"].as_str().map(str::to_owned)).collect();
        let name = unique_file_name(&safe_file_name(name), &taken);
        let extracted = extract_file_text(&name, bytes);
        let id = uuid::Uuid::new_v4().to_string();
        let added_at = (self.now)();
        let mime = mime_for_file_name(&name);
        self.conn()
            .execute(
                "INSERT INTO project_files (id, project_id, name, mime, size, added_at, pages, note, text, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![id, project_id, name, mime, bytes.len() as i64, added_at, extracted.pages, extracted.note, extracted.text, bytes],
            )
            .map_err(|error| error.to_string())?;
        let mut summary = json!({ "id": id, "name": name, "mime": mime, "size": bytes.len(), "addedAt": added_at, "hasText": extracted.text.is_some() });
        if let Some(pages) = extracted.pages {
            summary["pages"] = json!(pages);
        }
        if let Some(note) = extracted.note.filter(|note| !note.is_empty()) {
            summary["note"] = json!(note);
        }
        Ok(summary)
    }

    /// Adds files by path, refusing any that are too large, unreadable, or over the Project's limit.
    pub fn add_from_paths(&self, project_id: &str, paths: &[String]) -> (Vec<Value>, Vec<Value>) {
        let (mut added, mut skipped) = (Vec::new(), Vec::new());
        for path in paths {
            let name = Path::new(path).file_name().map_or_else(|| path.clone(), |name| name.to_string_lossy().into_owned());
            let outcome = (|| -> Result<Value> {
                let metadata = std::fs::metadata(path).map_err(|error| node_message(&error, path, "stat"))?;
                if !metadata.is_file() {
                    return Err("Choose files, not folders.".into());
                }
                if metadata.len() as usize > PROJECT_FILE_LIMIT_BYTES {
                    return Err(format!("Larger than {} MB.", PROJECT_FILE_LIMIT_BYTES / 1024 / 1024));
                }
                self.add(project_id, &name, &std::fs::read(path).map_err(|error| node_message(&error, path, "open"))?)
            })();
            match outcome {
                Ok(file) => added.push(file),
                Err(reason) => skipped.push(json!({ "name": name, "reason": reason })),
            }
        }
        (added, skipped)
    }

    pub fn remove(&self, project_id: &str, file_id: &str) -> Result<bool> {
        let changes = self.conn().execute("DELETE FROM project_files WHERE project_id = ? AND id = ?", params![project_id, file_id]).map_err(|e| e.to_string())?;
        Ok(changes > 0)
    }

    /// The original bytes, for copying into the Project folder.
    pub fn content(&self, file_id: &str) -> Option<Vec<u8>> {
        self.conn().query_row("SELECT content FROM project_files WHERE id = ?", [file_id], |row| row.get(0)).ok()
    }

    /// The extracted text of a file by name, or `None`.
    pub fn text(&self, project_id: &str, name: &str) -> Option<(Value, String)> {
        let conn = self.conn();
        let mut statement = conn.prepare(&format!("SELECT {COLUMNS}, text FROM project_files WHERE project_id = ? AND lower(name) = lower(?)")).ok()?;
        statement
            .query_row(params![project_id, name], |row| Ok((summarize(row)?, row.get::<_, Option<String>>(8)?)))
            .ok()
            .and_then(|(summary, text)| text.map(|text| (summary, text)))
    }
}
