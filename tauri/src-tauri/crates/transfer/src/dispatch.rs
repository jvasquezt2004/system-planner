//! The view's requests for copies and exports. A `begin…` request only registers the work and
//! answers with a request id; the view then sends a `choose…` message, which opens the picker
//! and later pushes the outcome (`…Completed`). That way the picker never blocks a request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::Actions;

type Work = Box<dyn FnOnce(&Actions) -> Value + Send>;

struct Pending {
    work: Work,
    /// The push that reports the outcome.
    completed: &'static str,
}

/// Routes the requests and messages that involve files, pickers and the clipboard.
pub struct Transfers {
    actions: Actions,
    pending: Mutex<HashMap<String, Pending>>,
    push: Arc<dyn Fn(Value) + Send + Sync>,
}

impl Transfers {
    pub fn new(actions: Actions, push: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Self { actions, pending: Mutex::new(HashMap::new()), push: Arc::new(push) }
    }

    fn register(&self, completed: &'static str, work: impl FnOnce(&Actions) -> Value + Send + 'static) -> Value {
        let request_id = uuid::Uuid::new_v4().to_string();
        self.pending.lock().expect("pending transfers").insert(request_id.clone(), Pending { work: Box::new(work), completed });
        json!({ "requestId": request_id })
    }

    /// Answers a request this layer owns, or `None` for any other.
    pub fn request(&self, method: &str, params: &Value) -> Option<Result<Value, String>> {
        let host = self.actions.host().clone();
        let design_of = |subject: &Value| subject.get("designId").and_then(Value::as_str).map(str::to_owned);
        let subject = |key: &str| params.get(key).cloned().unwrap_or(Value::Null);
        Some(match method {
            "copySqlPreview" => {
                let preview = subject("preview");
                host.require_active_design(design_of(&preview).as_deref()).map(|()| self.actions.copy_sql(Some(&preview)))
            }
            "copySchemaCode" => {
                let snapshot = subject("snapshot");
                host.require_active_design(design_of(&snapshot).as_deref()).map(|()| self.actions.copy_code(Some(&snapshot)))
            }
            "beginSqlPreviewExport" => {
                let (preview, file_name) = (subject("preview"), subject("fileName"));
                host.require_active_design(design_of(&preview).as_deref())
                    .map(|()| self.register("sqlPreviewExportCompleted", move |actions| actions.export_sql(Some(&preview), &file_name)))
            }
            "beginSchemaCodeExport" => {
                let (snapshot, file_name) = (subject("snapshot"), subject("fileName"));
                host.require_active_design(design_of(&snapshot).as_deref())
                    .map(|()| self.register("sqlPreviewExportCompleted", move |actions| actions.export_code(Some(&snapshot), &file_name)))
            }
            "beginProjectExport" => {
                if host.has_open_project() {
                    Ok(self.register("projectTransferCompleted", |actions| actions.export_project()))
                } else {
                    Err("Open a project before exporting it.".into())
                }
            }
            "beginProjectImport" => Ok(self.register("projectTransferCompleted", |actions| actions.import_project())),
            "beginSystemDesignSvgExport" | "beginSystemDesignPngExport" => {
                if !host.has_open_project() {
                    return Some(Err("Open a project before exporting its System design.".into()));
                }
                let request = params.clone();
                if method == "beginSystemDesignSvgExport" {
                    Ok(self.register("systemDesignSvgExportCompleted", move |actions| actions.export_system_design_svg(&request)))
                } else {
                    Ok(self.register("systemDesignPngExportCompleted", move |actions| actions.export_system_design_png(&request)))
                }
            }
            _ => return None,
        })
    }

    /// Handles a message that starts a registered picker, or `None` for any other message.
    pub fn message(&self, method: &str, params: &Value) -> Option<Result<(), String>> {
        if !matches!(
            method,
            "chooseSqlPreviewExportDirectory"
                | "chooseProjectExportDirectory"
                | "chooseProjectImportFile"
                | "chooseSystemDesignSvgExportDirectory"
                | "chooseSystemDesignPngExportDirectory"
        ) {
            return None;
        }
        let request_id = params.get("requestId").and_then(Value::as_str).unwrap_or_default().to_owned();
        let Some(pending) = self.pending.lock().expect("pending transfers").remove(&request_id) else { return Some(Ok(())) };
        let (actions, push) = (self.actions.clone(), self.push.clone());
        std::thread::spawn(move || {
            let result = (pending.work)(&actions);
            push(json!({ "method": pending.completed, "payload": { "requestId": request_id, "result": result } }));
        });
        Some(Ok(()))
    }
}
