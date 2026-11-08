//! Dispatch for the view's RPC. A request names a method and carries the same JSON
//! params the Electrobun app received, so the view needs no changes.
//!
//! Anything not yet ported fails loudly, naming the method, rather than returning
//! invented data.

use std::sync::Arc;

use schema_domain::geometry::CanvasPoint;
use schema_domain::system_design::SystemViewName;
use schema_workspace::{Options, Workspace};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone)]
pub struct Backend {
    workspace: Workspace,
}

type Result<T> = std::result::Result<T, String>;

fn params<T: DeserializeOwned>(method: &str, value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| format!("`{method}` received invalid parameters: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NameParams {
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectParams {
    project_id: String,
}
#[derive(Deserialize)]
struct ViewParams {
    view: SystemViewName,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddTableParams {
    name: String,
    position: Option<CanvasPoint>,
    design_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameTableParams {
    table_id: String,
    name: String,
    design_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveTableParams {
    table_id: String,
    position: CanvasPoint,
    design_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddColumnParams {
    table_id: String,
    name: Option<String>,
    #[serde(rename = "type")]
    column_type: Option<String>,
    design_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateColumnParams {
    table_id: String,
    column_id: String,
    changes: Value,
    design_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewportParams {
    x: f64,
    y: f64,
    zoom: f64,
    design_id: String,
}

impl Backend {
    /// Opens the workspace on `database_path` and starts pushing state changes through `push`.
    pub fn start(database_path: std::path::PathBuf, push: impl Fn(Value) + Send + Sync + 'static) -> Result<Self> {
        let sandbox: schema_workspace::SandboxFactory = Arc::new(|| Box::new(schema_sandbox::PgliteSandbox));
        let workspace = Workspace::open(Options::new(database_path, sandbox))?;
        workspace.subscribe(Arc::new(move |state| {
            if let Ok(payload) = serde_json::to_value(state) {
                push(serde_json::json!({ "method": "workspaceState", "payload": payload }));
            }
        }));
        Ok(Self { workspace })
    }

    fn state(state: schema_workspace::WorkspaceState) -> Result<Value> {
        serde_json::to_value(state).map_err(|error| error.to_string())
    }

    pub fn request(&self, method: &str, value: Value) -> Result<Value> {
        let workspace = &self.workspace;
        match method {
            "getWorkspaceState" => Self::state(workspace.state()),
            "createProject" => Self::state(workspace.create_project(&params::<NameParams>(method, value)?.name)?),
            "openProject" => Self::state(workspace.open_project(&params::<ProjectParams>(method, value)?.project_id)?),
            "setActiveView" => Self::state(workspace.set_active_view(params::<ViewParams>(method, value)?.view)?),
            "addTable" => {
                let p: AddTableParams = params(method, value)?;
                Self::state(workspace.add_table(&p.design_id, &p.name, p.position)?)
            }
            "renameTable" => {
                let p: RenameTableParams = params(method, value)?;
                Self::state(workspace.rename_table(&p.design_id, &p.table_id, &p.name)?)
            }
            "moveTable" => {
                let p: MoveTableParams = params(method, value)?;
                Self::state(workspace.move_table(&p.design_id, &p.table_id, p.position)?)
            }
            "addColumn" => {
                let p: AddColumnParams = params(method, value)?;
                Self::state(workspace.add_column(&p.design_id, &p.table_id, p.name.as_deref(), p.column_type.as_deref())?)
            }
            "updateColumn" => {
                let p: UpdateColumnParams = params(method, value)?;
                Self::state(workspace.update_column(&p.design_id, &p.table_id, &p.column_id, &p.changes)?)
            }
            "setViewport" => {
                let p: ViewportParams = params(method, value)?;
                Self::state(workspace.set_viewport(&p.design_id, p.x, p.y, p.zoom)?)
            }
            // The Assistant is ported last, and its harnesses are the only part kept. Until then it has
            // no conversations, models or connections, which is true, so the sidebar can say so.
            "listAssistantConversations" | "listAssistantModels" | "listAssistantConnections" => Ok(serde_json::json!([])),
            "getClaudeOptIn" => Ok(serde_json::json!(false)),
            other => Err(not_ported(other)),
        }
    }

    pub fn message(&self, method: &str, _value: Value) -> Result<()> {
        Err(not_ported(method))
    }
}

fn not_ported(method: &str) -> String {
    eprintln!("[rpc] not implemented yet: {method}");
    format!("`{method}` is not implemented in the Tauri backend yet")
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
