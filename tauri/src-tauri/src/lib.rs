//! Tauri backend for Schema Designer.
//!
//! The view talks to the backend through two commands that mirror the shape of
//! the Electrobun RPC it was written against (see `tauri/shims`):
//!
//! * `rpc_request(method, params)` is a request/response call, one per entry in
//!   `AppRPCSchema.bun.requests`.
//! * `rpc_message(method, params)` is a fire-and-forget message, one per entry in
//!   `AppRPCSchema.bun.messages`.
//!
//! Backend pushes reach the view as the `rpc-message` event carrying
//! `{ method, payload }`, matching `AppRPCSchema.webview.messages`.

use serde_json::Value;

mod rpc;

#[tauri::command]
fn rpc_request(method: String, params: Value) -> Result<Value, String> {
    rpc::request(&method, params)
}

#[tauri::command]
fn rpc_message(method: String, params: Value) -> Result<(), String> {
    rpc::message(&method, params)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![rpc_request, rpc_message])
        .run(tauri::generate_context!())
        .expect("error while running Schema Designer");
}
