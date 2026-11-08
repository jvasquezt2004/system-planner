//! The Tauri side of the view's RPC: the workspace answers everything it has ported, and this
//! layer answers the few read-only Assistant lists with the truth, that there are none yet.

use std::sync::Arc;

use schema_workspace::{Options, Workspace};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Backend {
    workspace: Workspace,
}

type Result<T> = std::result::Result<T, String>;

impl Backend {
    /// Opens the workspace on `database_path` and starts pushing state changes through `push`.
    pub fn start(database_path: std::path::PathBuf, push: impl Fn(Value) + Send + Sync + 'static) -> Result<Self> {
        let sandbox: schema_workspace::SandboxFactory = Arc::new(|| Box::new(schema_sandbox::PgliteSandbox));
        let workspace = Workspace::open(Options::new(database_path, sandbox))?;
        workspace.subscribe(Arc::new(move |state| {
            if let Ok(payload) = serde_json::to_value(state) {
                push(json!({ "method": "workspaceState", "payload": payload }));
            }
        }));
        Ok(Self { workspace })
    }

    pub fn request(&self, method: &str, value: Value) -> Result<Value> {
        match method {
            // The Assistant is ported last, and its harnesses are the only part kept. Until then it has
            // no conversations, models or connections, which is true, so the sidebar can say so.
            "listAssistantConversations" | "listAssistantModels" | "listAssistantConnections" => Ok(json!([])),
            "getClaudeOptIn" => Ok(json!(false)),
            _ => self.workspace.request(method, value).inspect_err(|error| {
                if error.contains(schema_workspace::NOT_IMPLEMENTED) {
                    eprintln!("[rpc] not implemented yet: {method}");
                }
            }),
        }
    }

    pub fn message(&self, method: &str, _value: Value) -> Result<()> {
        eprintln!("[rpc] not implemented yet: {method}");
        Err(format!("`{method}` {}", schema_workspace::NOT_IMPLEMENTED))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::Backend;

    /// The calls below use exactly the JSON the view sends (see `src/mainview/workspace-client.ts`).
    #[test]
    fn the_views_calls_round_trip_through_the_dispatcher() {
        let directory = tempfile::tempdir().unwrap();
        let pushed = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = pushed.clone();
        let backend = Backend::start(directory.path().join("rpc.sqlite"), move |message| sink.lock().unwrap().push(message)).unwrap();

        let created = backend.request("createProject", json!({ "name": "Shop" })).unwrap();
        let design_id = created["activeDesignId"].as_str().unwrap().to_owned();
        assert_eq!(created["project"]["name"], "Shop");
        assert_eq!(created["activeView"], "system");

        assert_eq!(backend.request("setActiveView", json!({ "view": "database" })).unwrap()["activeView"], "database");

        let table = backend.request("addTable", json!({ "designId": design_id, "name": "orders", "position": { "x": 10, "y": 20 } })).unwrap();
        let table_id = table["design"]["tables"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(table["sandbox"]["status"], "applied", "{}", table["sandbox"]);

        let renamed = backend.request("renameTable", json!({ "designId": design_id, "tableId": table_id, "name": "purchases" })).unwrap();
        assert_eq!(renamed["design"]["tables"][0]["name"], "purchases");
        backend.request("moveTable", json!({ "designId": design_id, "tableId": table_id, "position": { "x": 5, "y": 6 } })).unwrap();
        let column = backend.request("addColumn", json!({ "designId": design_id, "tableId": table_id, "name": "total", "type": "numeric" })).unwrap();
        let column_id = column["design"]["tables"][0]["columns"][1]["id"].as_str().unwrap().to_owned();
        let updated = backend
            .request("updateColumn", json!({ "designId": design_id, "tableId": table_id, "columnId": column_id, "changes": { "nullable": false } }))
            .unwrap();
        assert_eq!(updated["design"]["tables"][0]["columns"][1]["nullable"], false);
        let viewport = backend.request("setViewport", json!({ "designId": design_id, "x": 1, "y": 2, "zoom": 1.5 })).unwrap();
        assert_eq!(viewport["design"]["viewport"], json!({ "x": 1, "y": 2, "zoom": 1.5 }));

        // The view reads state back, and sees what was pushed.
        assert_eq!(backend.request("getWorkspaceState", json!({})).unwrap()["revision"], viewport["revision"]);
        let methods: Vec<String> = pushed.lock().unwrap().iter().map(|m| m["method"].as_str().unwrap().to_owned()).collect();
        assert!(!methods.is_empty() && methods.iter().all(|method| method == "workspaceState"));

        // Calls that are not ported say so by name instead of inventing an answer.
        let error = backend.request("describeRemoval", json!({})).unwrap_err();
        assert!(error.contains("describeRemoval") && error.contains("not implemented"), "{error}");
        // Malformed parameters name the method and the problem.
        let error = backend.request("addTable", json!({ "name": "x" })).unwrap_err();
        assert!(error.contains("addTable") && error.contains("designId"), "{error}");
    }
}
