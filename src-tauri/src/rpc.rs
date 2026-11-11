//! The Tauri side of the view's RPC: the workspace answers everything it has ported, and this
//! layer answers the few read-only Assistant lists with the truth, that there are none yet.

use std::sync::Arc;

use schema_transfer::{Actions, Platform, Transfers};
use schema_workspace::{Options, Workspace};
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Backend {
    workspace: Workspace,
    transfers: Arc<Transfers>,
    folder: Arc<crate::folder::Folder>,
    platform: Arc<dyn Platform>,
    assistant: schema_assistant::runtime::Runtime,
    scenario_runner: Arc<crate::scenario::ViewScenarioRunner>,
}

type Result<T> = std::result::Result<T, String>;

impl Backend {
    /// Opens the workspace on `database_path` and starts pushing state changes through `push`.
    pub fn start(database_path: std::path::PathBuf, projects_root: std::path::PathBuf, platform: Arc<dyn Platform>, push: impl Fn(Value) + Send + Sync + 'static) -> Result<Self> {
        let push = Arc::new(push);
        let sandbox: schema_workspace::SandboxFactory = Arc::new(|| Box::new(schema_sandbox::PgliteSandbox));
        let path = database_path.clone();
        let workspace = Workspace::open(Options::new(database_path, sandbox))?;
        let state_push = push.clone();
        workspace.subscribe(Arc::new(move |state| {
            if let Ok(payload) = serde_json::to_value(state) {
                state_push(json!({ "method": "workspaceState", "payload": payload }));
            }
        }));
        let actions = Actions::new(platform.clone(), Arc::new(workspace.clone()));
        // Attached files sit beside the Project's own data, in the same database file.
        let files = schema_files::ProjectFiles::open(&path, || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)).ok().map(Arc::new);
        let folder = crate::folder::Folder::start(projects_root, workspace.clone(), files.clone());
        let changed = folder.clone();
        workspace.subscribe(Arc::new(move |_| changed.changed()));
        let transfer_push = push.clone();
        let transfers = Arc::new(Transfers::new(actions, files.clone(), move |message| transfer_push(message)));
        // The Assistant keeps its conversations in the same database file as the Project.
        let now = || std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64);
        let store = Arc::new(schema_assistant::store::AssistantStore::open(&path, now)?);
        let assistant_push = push.clone();
        let scenario_runner = Arc::new(crate::scenario::ViewScenarioRunner::new(push.clone()));
        let assistant = schema_assistant::runtime::Runtime::new(
            schema_assistant::runtime::Options {
                workspace: workspace.clone(),
                files,
                folder: Some(folder.clone()),
                scenario_runner: Some(scenario_runner.clone()),
                push: Arc::new(move |message| assistant_push(message)),
                codex_executable: None,
                codex_args: schema_assistant::runtime::Options::standard_codex_args(),
                opencode_executable: None,
            },
            store,
        );
        Ok(Self { workspace, transfers, folder, platform, assistant, scenario_runner })
    }

    pub fn request(&self, method: &str, value: Value) -> Result<Value> {
        if let Some(answer) = self.transfers.request(method, &value) {
            return answer;
        }
        if let Some(answer) = crate::assistant::request(&self.assistant, method, &value) {
            return answer;
        }
        if method == "revealProjectFolder" {
            let path = self.folder.sync(false)?;
            let opened = path.as_ref().is_some_and(|path| self.platform.open_path(&path.to_string_lossy()));
            return Ok(json!({ "path": path.map(|path| path.to_string_lossy().into_owned()), "opened": opened }));
        }
        match method {
            // The Assistant is ported last, and its harnesses are the only part kept. Until then it has
            // no conversations, models or connections, which is true, so the sidebar can say so.
            _ => self.workspace.request(method, value).inspect_err(|error| {
                if error.contains(schema_workspace::NOT_IMPLEMENTED) {
                    eprintln!("[rpc] not implemented yet: {method}");
                }
            }),
        }
    }

    pub fn message(&self, method: &str, value: Value) -> Result<()> {
        if let Some(answer) = self.transfers.message(method, &value) {
            return answer;
        }
        if method == "assistantScenarioRunCompleted" {
            let request_id = value["requestId"].as_str().unwrap_or_default();
            self.scenario_runner.completed(request_id, value["run"].clone(), value["error"].as_str().map(str::to_owned));
            return Ok(());
        }
        eprintln!("[rpc] not implemented yet: {method}");
        Err(format!("`{method}` {}", schema_workspace::NOT_IMPLEMENTED))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::Backend;
    use schema_transfer::Platform;

    struct NoPlatform;

    impl Platform for NoPlatform {
        fn choose_directory(&self) -> Option<String> {
            None
        }
        fn choose_file(&self) -> Option<String> {
            None
        }
        fn choose_files(&self) -> Vec<String> {
            vec![]
        }
        fn open_path(&self, _path: &str) -> bool {
            false
        }
        fn write_clipboard_text(&self, _text: &str) -> Result<(), String> {
            Ok(())
        }
        fn now_millis(&self) -> i64 {
            0
        }
    }

    /// The calls below use exactly the JSON the view sends (see `src/workspace-client.ts`).
    #[test]
    fn the_views_calls_round_trip_through_the_dispatcher() {
        let directory = tempfile::tempdir().unwrap();
        let pushed = Arc::new(Mutex::new(Vec::<Value>::new()));
        let sink = pushed.clone();
        let backend = Backend::start(directory.path().join("rpc.sqlite"), directory.path().join("projects"), Arc::new(NoPlatform), move |message| sink.lock().unwrap().push(message)).unwrap();

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
        // The Assistant's conversations are kept with the Project.
        let project_id = created["project"]["id"].as_str().unwrap();
        let conversation = backend.request("createAssistantConversation", json!({ "projectId": project_id })).unwrap();
        assert_eq!(conversation["connection_id"], "codex-harness");
        let listed = backend.request("listAssistantConversations", json!({ "projectId": project_id })).unwrap();
        assert_eq!(listed[0]["id"], conversation["id"]);
        let record = backend.request("getAssistantConversation", json!({ "conversationId": conversation["id"] })).unwrap();
        assert_eq!(record["messages"][0]["kind"], "assistant-context");
        // Provider connections are not part of the app any more, so their calls are simply unknown.
        assert!(backend.request("setAssistantApiKey", json!({ "providerId": "openai", "apiKey": "x" })).unwrap_err().contains("not implemented"));
        let error = backend.request("exportAssistantThing", json!({})).unwrap_err();
        assert!(error.contains("exportAssistantThing") && error.contains("not implemented"), "{error}");
        // Database edits go through the same dispatcher: a plan, a refused removal, then the removal.
        let plan = backend.request("describeRemoval", json!({ "kind": "table", "tableId": table_id, "designId": design_id })).unwrap();
        assert_eq!(plan["target"], "purchases");
        let removed = backend.request("removeTable", json!({ "tableId": table_id, "designId": design_id })).unwrap();
        assert_eq!(removed["design"]["tables"], json!([]));
        assert_eq!(removed["undoActionName"], "Remove table “purchases”");
        // Undo brings the table back, and Redo removes it again.
        let undone = backend.request("undo", json!({ "designId": design_id })).unwrap();
        assert_eq!(undone["design"]["tables"][0]["name"], "purchases");
        assert_eq!(undone["redoActionName"], "Remove table “purchases”");
        let redone = backend.request("redo", json!({ "designId": design_id })).unwrap();
        assert_eq!(redone["design"]["tables"], json!([]));
        // Malformed parameters name the method and the problem.
        let error = backend.request("addTable", json!({ "name": "x" })).unwrap_err();
        assert!(error.contains("addTable") && error.contains("designId"), "{error}");
    }
}
