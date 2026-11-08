//! Dispatch for the view's RPC. Each phase in `tauri/PLAN.md` replaces entries
//! here with real handlers; anything not yet ported fails loudly rather than
//! returning invented data.

use serde_json::Value;

pub fn request(method: &str, _params: Value) -> Result<Value, String> {
    Err(not_ported(method))
}

pub fn message(method: &str, _params: Value) -> Result<(), String> {
    Err(not_ported(method))
}

fn not_ported(method: &str) -> String {
    format!("`{method}` is not implemented in the Tauri backend yet")
}
