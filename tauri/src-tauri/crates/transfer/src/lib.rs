//! Everything the app does with files and the clipboard on the designer's behalf: copying and
//! exporting the SQL preview and generated ORM code, saving a System design diagram, and
//! exporting or importing a whole Project (`sql-preview.ts`, `project-transfer.ts` and the System
//! design exporters in the original).
//!
//! The pickers and the clipboard are the platform's, behind [`Platform`], so all of it runs, and is
//! tested, without a window.

use std::path::PathBuf;
use std::sync::Arc;

use schema_domain::js;
use serde_json::{json, Value};

mod dispatch;
mod files;
mod png;

pub use dispatch::Transfers;
pub use files::{export_file_name, system_design_file_name, timestamp, write_new_file};

/// What only the platform can do. Paths are the text the picker returned.
pub trait Platform: Send + Sync {
    /// The native folder picker. `None` means the designer cancelled.
    fn choose_directory(&self) -> Option<String>;
    /// The native file picker. `None` means the designer cancelled.
    fn choose_file(&self) -> Option<String>;
    /// The native multi-file picker. Empty means the designer cancelled.
    fn choose_files(&self) -> Vec<String>;
    fn write_clipboard_text(&self, text: &str) -> Result<(), String>;
    /// Opens a folder or file in the system's file manager or default app.
    fn open_path(&self, path: &str) -> bool;
    /// Milliseconds since the epoch.
    fn now_millis(&self) -> i64;
}

/// The open Project, as far as transfers need it.
pub trait ProjectHost: Send + Sync {
    fn has_open_project(&self) -> bool;
    /// The id of the open Project.
    fn open_project_id(&self) -> Option<String>;
    fn export_project(&self) -> Result<Value, String>;
    /// Imports a document and returns the id and name of the Project it opened, if one opened.
    fn import_project(&self, document: &Value) -> Result<Option<(String, String)>, String>;
    /// Fails unless `design_id` names the open Project's active Design.
    fn require_active_design(&self, design_id: Option<&str>) -> Result<(), String>;
}

impl ProjectHost for schema_workspace::Workspace {
    fn has_open_project(&self) -> bool {
        self.state().project.is_some()
    }

    fn open_project_id(&self) -> Option<String> {
        self.state().project.map(|project| project.id)
    }

    fn export_project(&self) -> Result<Value, String> {
        schema_workspace::Workspace::export_project(self)
    }

    fn import_project(&self, document: &Value) -> Result<Option<(String, String)>, String> {
        let state = schema_workspace::Workspace::import_project(self, document)?;
        Ok(state.project.map(|project| (project.id, project.name)))
    }

    fn require_active_design(&self, design_id: Option<&str>) -> Result<(), String> {
        schema_workspace::Workspace::require_active_design(self, design_id)
    }
}

/// Larger files are refused before they are read: a project export is a text document, not an asset.
pub const PROJECT_IMPORT_FILE_LIMIT_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct Actions {
    platform: Arc<dyn Platform>,
    host: Arc<dyn ProjectHost>,
}

/// `schemaCodeFormat`: the label and file extensions of each format the preview offers.
fn code_format(target: &Value) -> Result<(&'static str, &'static [&'static str]), String> {
    Ok(match target.as_str() {
        Some("sql") => ("SQL", &[".sql"]),
        Some("prisma") => ("Prisma", &[".prisma"]),
        Some("drizzle") => ("Drizzle", &[".ts"]),
        Some("sqlalchemy") => ("SQLAlchemy", &[".py"]),
        Some("django") => ("Django", &[".py"]),
        _ => return Err(format!("Unknown schema code format: {}", js::to_js_string(target))),
    })
}

fn revision_of(subject: Option<&Value>) -> Value {
    js::nullish(subject.and_then(|subject| subject.get("revision"))).cloned().unwrap_or(json!(0))
}

fn text_field<'a>(subject: Option<&'a Value>, key: &str) -> Option<&'a str> {
    subject.and_then(|subject| subject.get(key)).and_then(Value::as_str)
}

fn require_text(subject: Option<&Value>, key: &str, message: &str) -> Result<String, String> {
    match text_field(subject, key) {
        Some(text) if !js::trim(text).is_empty() => Ok(text.to_owned()),
        _ => Err(message.to_owned()),
    }
}

/// A file name the designer chose: no surrounding space, no path characters, one of the extensions.
fn require_file_name(file_name: &Value, extensions: &[&str], message: &str) -> Result<String, String> {
    let invalid = || Err(message.to_owned());
    let Some(name) = file_name.as_str() else { return invalid() };
    let lower = name.to_lowercase();
    if name.is_empty()
        || name != js::trim(name)
        || !extensions.iter().any(|extension| lower.ends_with(extension))
        || name.chars().any(|c| c <= '\u{1f}' || "<>:\"/\\|?*".contains(c))
        || name.ends_with('.')
    {
        return invalid();
    }
    Ok(name.to_owned())
}

fn export_error_message(message: String) -> String {
    if files::is_already_exists(&message) { "A file with that name already exists. Choose a different name.".to_owned() } else { message }
}

impl Actions {
    pub fn new(platform: Arc<dyn Platform>, host: Arc<dyn ProjectHost>) -> Self {
        Self { platform, host }
    }

    pub fn host(&self) -> &Arc<dyn ProjectHost> {
        &self.host
    }

    /// Asks for a folder. `Ok(None)` is a cancelled picker.
    fn choose_directory(&self) -> Result<Option<PathBuf>, String> {
        match self.platform.choose_directory() {
            None => Ok(None),
            Some(directory) if js::trim(&directory).is_empty() => Err("No export folder was selected.".into()),
            Some(directory) => Ok(Some(PathBuf::from(directory))),
        }
    }

    fn copy_text(&self, subject: Option<&Value>, text: Result<String, String>) -> Value {
        let revision = revision_of(subject);
        match text.and_then(|text| self.platform.write_clipboard_text(&text)) {
            Ok(()) => json!({ "status": "copied", "revision": revision }),
            Err(error) => json!({ "status": "failed", "revision": revision, "error": error }),
        }
    }

    fn export_text(&self, subject: Option<&Value>, prepare: impl FnOnce() -> Result<(String, String), String>) -> Value {
        let revision = revision_of(subject);
        let outcome = prepare().and_then(|(file_name, contents)| {
            let Some(directory) = self.choose_directory()? else { return Ok(json!({ "status": "cancelled", "revision": revision })) };
            let path = directory.join(file_name);
            files::write_new_file(&path, contents.as_bytes())?;
            Ok(json!({ "status": "saved", "revision": revision, "path": path.to_string_lossy() }))
        });
        outcome.unwrap_or_else(|error| json!({ "status": "failed", "revision": revision, "error": export_error_message(error) }))
    }

    /// Copies the SQL preview as it was displayed.
    pub fn copy_sql(&self, preview: Option<&Value>) -> Value {
        self.copy_text(preview, require_text(preview, "sql", "No SQL is available to copy or export."))
    }

    pub fn export_sql(&self, preview: Option<&Value>, file_name: &Value) -> Value {
        self.export_text(preview, || {
            let sql = require_text(preview, "sql", "No SQL is available to copy or export.")?;
            let name = require_file_name(file_name, &[".sql"], "Choose a valid SQL file name ending in .sql.")?;
            Ok((name, sql))
        })
    }

    /// Copies the ORM code on screen, exactly as the view captured it.
    pub fn copy_code(&self, snapshot: Option<&Value>) -> Value {
        self.copy_text(snapshot, require_text(snapshot, "code", "No generated code is available to copy or export."))
    }

    pub fn export_code(&self, snapshot: Option<&Value>, file_name: &Value) -> Value {
        self.export_text(snapshot, || {
            let code = require_text(snapshot, "code", "No generated code is available to copy or export.")?;
            let target = js::nullish(snapshot.and_then(|snapshot| snapshot.get("target"))).cloned().unwrap_or(json!("sql"));
            let (label, extensions) = code_format(&target)?;
            let message = format!("Choose a valid {label} file name ending in {}.", extensions.join(" or "));
            Ok((require_file_name(file_name, extensions, &message)?, code))
        })
    }

    fn image_result(&self, prepare: impl FnOnce() -> Result<(Vec<u8>, &'static str, String), String>) -> Value {
        let outcome = prepare().and_then(|(bytes, extension, project_name)| {
            let Some(directory) = self.choose_directory()? else { return Ok(json!({ "status": "cancelled" })) };
            let path = directory.join(files::system_design_file_name(&project_name, self.platform.now_millis(), extension));
            files::write_new_file(&path, &bytes)?;
            Ok(json!({ "status": "saved", "path": path.to_string_lossy() }))
        });
        outcome.unwrap_or_else(|error| json!({ "status": "failed", "error": error }))
    }

    /// Writes an SVG the view already built from its snapshot into a new file in a folder the designer picks.
    pub fn export_system_design_svg(&self, request: &Value) -> Value {
        self.image_result(|| {
            let svg = request.get("svg").and_then(Value::as_str).unwrap_or_default();
            let start = svg.trim_start_matches(|c: char| js::trim(&c.to_string()).is_empty());
            if !start.starts_with("<svg") && !start.starts_with("<?xml") {
                return Err("No System design diagram is available to export.".into());
            }
            Ok((svg.as_bytes().to_vec(), "svg", project_name_of(request)))
        })
    }

    /// Writes a PNG the view rasterized, checked to be a complete PNG before the picker opens.
    pub fn export_system_design_png(&self, request: &Value) -> Value {
        self.image_result(|| {
            let bytes = png::decode_png(request.get("png").and_then(Value::as_str).unwrap_or_default())?;
            Ok((bytes, "png", project_name_of(request)))
        })
    }

    /// Writes the open Project to a new file in a folder the designer picks.
    pub fn export_project(&self) -> Value {
        let outcome = (|| -> Result<Value, String> {
            // Build the document before the picker opens, so a failure never follows a folder choice.
            let document = self.host.export_project()?;
            let Some(directory) = self.choose_directory()? else { return Ok(json!({ "status": "cancelled" })) };
            let name = document["project"]["name"].as_str().unwrap_or_default().to_owned();
            let path = directory.join(files::export_file_name(&name, self.platform.now_millis()));
            let text = format!("{}\n", serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?);
            files::write_new_file(&path, text.as_bytes())?;
            Ok(json!({ "status": "exported", "path": path.to_string_lossy(), "name": name }))
        })();
        outcome.unwrap_or_else(|error| json!({ "status": "failed", "error": error }))
    }

    /// Attaches files the designer picks to the open Project.
    pub fn attach_files(&self, files: &schema_files::ProjectFiles) -> Value {
        let Some(project_id) = self.host.open_project_id() else { return json!({ "status": "failed", "error": "Open a project before attaching files." }) };
        let paths = self.platform.choose_files();
        if paths.is_empty() {
            return json!({ "status": "cancelled" });
        }
        let (added, skipped) = files.add_from_paths(&project_id, &paths);
        let names: Vec<Value> = added.iter().map(|file| file["name"].clone()).collect();
        json!({ "status": "attached", "added": names, "skipped": skipped })
    }

    /// Creates a new Project from a file the designer picks. The open Project is unchanged unless the import succeeds.
    pub fn import_project(&self) -> Value {
        let outcome = (|| -> Result<Value, String> {
            let Some(path) = self.platform.choose_file() else { return Ok(json!({ "status": "cancelled" })) };
            let document = read_project_file(&path)?;
            match self.host.import_project(&document)? {
                Some((project_id, name)) => Ok(json!({ "status": "imported", "projectId": project_id, "name": name })),
                None => Err("The imported project could not be opened.".into()),
            }
        })();
        outcome.unwrap_or_else(|error| json!({ "status": "failed", "error": error }))
    }
}

fn project_name_of(request: &Value) -> String {
    request.get("projectName").map(js::to_js_string).unwrap_or_else(|| "undefined".into())
}

/// Reads and parses a project file. Structure is checked by the workspace import, which writes nothing on failure.
fn read_project_file(path: &str) -> Result<Value, String> {
    let metadata = std::fs::metadata(path).map_err(|error| files::io_error_message(&error, std::path::Path::new(path)).replacen("open", "stat", 1))?;
    if !metadata.is_file() {
        return Err("Choose a project file, not a folder.".into());
    }
    if metadata.len() > PROJECT_IMPORT_FILE_LIMIT_BYTES {
        return Err("This project file is larger than 64 MB, so it is not a Schema Designer project export.".into());
    }
    let bytes = std::fs::read(path).map_err(|error| files::io_error_message(&error, std::path::Path::new(path)).replacen("open", "read", 1))?;
    serde_json::from_str(&String::from_utf8_lossy(&bytes))
        .map_err(|_| "The file is not valid JSON. Choose a Schema Designer project export (.schema-designer.json).".to_owned())
}
