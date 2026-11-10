//! Tauri backend for Schema Designer.
//!
//! The view talks to the backend through two commands that mirror the shape of the
//! Electrobun RPC it was written against (see `tauri/shims`):
//!
//! * `rpc_request(method, params)` is a request/response call, one per entry in
//!   `AppRPCSchema.bun.requests`.
//! * `rpc_message(method, params)` is a fire-and-forget message, one per entry in
//!   `AppRPCSchema.bun.messages`.
//!
//! Backend pushes reach the view as the `rpc-message` event carrying
//! `{ method, payload }`, matching `AppRPCSchema.webview.messages`.

use std::path::PathBuf;

use serde_json::Value;
use tauri::{Emitter, Manager};

mod assistant;
mod debug_bridge;
mod folder;
mod platform;
mod rpc;
mod scenario;

use rpc::Backend;

/// Requests can block (autosave, then the SQL preview), so they run off the UI thread.
#[tauri::command]
async fn rpc_request(backend: tauri::State<'_, Backend>, method: String, params: Value) -> Result<Value, String> {
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.request(&method, params)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
async fn rpc_message(backend: tauri::State<'_, Backend>, method: String, params: Value) -> Result<(), String> {
    #[cfg(all(debug_assertions, unix))]
    if method == "__debugReport" {
        debug_bridge::report(params["id"].as_u64().unwrap_or(0), params["result"].as_str().unwrap_or("").to_owned());
        return Ok(());
    }
    let backend = backend.inner().clone();
    tauri::async_runtime::spawn_blocking(move || backend.message(&method, params)).await.map_err(|error| error.to_string())?
}

/// `DB_PLANNER_DATABASE_PATH` wins, as in the Electrobun app. Otherwise the rewrite keeps its own
/// database beside the app's data, so running it never touches the Electrobun app's projects.
/// The shared location is a decision for cutover.
fn database_path(app: &tauri::AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(path) = std::env::var_os("DB_PLANNER_DATABASE_PATH") {
        return Ok(PathBuf::from(path));
    }
    Ok(app.path().app_data_dir()?.join("tauri-dev").join("schema-designer.sqlite"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let path = database_path(app.handle())?;
            eprintln!("[workspace] database={}", path.display());
            let handle = app.handle().clone();
            let platform = std::sync::Arc::new(platform::Desktop { app: app.handle().clone() });
            let backend = Backend::start(path, folder::projects_root(), platform, move |message| {
                let _ = handle.emit("rpc-message", message);
            })?;
            app.manage(backend);
            #[cfg(all(debug_assertions, unix))]
            debug_bridge::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc_request, rpc_message])
        .run(tauri::generate_context!())
        .expect("error while running Schema Designer");
}
