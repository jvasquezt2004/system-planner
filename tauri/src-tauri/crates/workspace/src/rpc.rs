//! The view's RPC surface: a method name and the JSON params the Electrobun app received,
//! routed to the workspace. Anything not yet ported fails loudly, naming the method,
//! rather than returning invented data.

use schema_domain::geometry::{CanvasPoint, CanvasViewport};
use schema_domain::system_design::SystemViewName;
use schema_domain::walkthrough_ops::StepDraft;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;

use crate::system::*;
use crate::{Result, Workspace, WorkspaceState};

/// The message for a method this backend does not implement yet. The app matches on it to log.
pub const NOT_IMPLEMENTED: &str = "is not implemented in the Tauri backend yet";

fn parse<T: DeserializeOwned>(method: &str, value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| format!("`{method}` received invalid parameters: {error}"))
}

fn state(state: WorkspaceState) -> Result<Value> {
    serde_json::to_value(state).map_err(|error| error.to_string())
}

macro_rules! params {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct $name { $($field: $ty,)* }
    };
}

params!(Name { name: String });
params!(ProjectId { project_id: String });
// `listProjectFiles` takes the same shape, `{ projectId }`.
params!(View { view: SystemViewName });
params!(DesignId { design_id: String });
params!(RenameDesign { design_id: String, name: String });
params!(AddTable { name: String, position: Option<CanvasPoint>, design_id: String });
params!(RenameTable { table_id: String, name: String, design_id: String });
params!(MoveTable { table_id: String, position: CanvasPoint, design_id: String });
params!(AddColumn { table_id: String, name: Option<String>, r#type: Option<String>, design_id: String });
params!(UpdateColumn { table_id: String, column_id: String, changes: Value, design_id: String });
params!(Viewport { x: f64, y: f64, zoom: f64, design_id: String });
params!(SystemViewport { x: f64, y: f64, zoom: f64 });
params!(ServiceId { service_id: String });
params!(ComponentId { component_id: String });
params!(ConnectionId { connection_id: String });
params!(Collapsed { service_id: String, collapsed: bool });
params!(Focus { service_id: Option<String>, viewport: Option<CanvasViewport> });
params!(LinkDatabase { component_id: String, design_id: Option<String> });
params!(CreateDatabaseDesign { component_id: String, name: Option<String> });
params!(CreateWalkthrough { id: Option<String>, name: Option<String> });
params!(RenameWalkthrough { walkthrough_id: String, name: String });
params!(WalkthroughId { walkthrough_id: String });
params!(MoveWalkthrough { walkthrough_id: String, to_index: f64 });
params!(UpdateStep { walkthrough_id: String, step_id: String, changes: StepDraft });
params!(StepIndex { walkthrough_id: String, step_id: String, to_index: f64 });
params!(StepRef { walkthrough_id: String, step_id: String });
params!(BlockRef { walkthrough_id: String, block_id: String });
params!(BlockIndex { walkthrough_id: String, block_id: String, to_index: f64 });
params!(RepeatCount { walkthrough_id: String, block_id: String, count: f64 });
params!(RepairStep { walkthrough_id: String, step_id: String, connection_id: String });

impl Workspace {
    /// Runs one request from the view. Blocking: a schema edit returns once its preview has settled.
    pub fn request(&self, method: &str, value: Value) -> Result<Value> {
        macro_rules! call {
            ($ty:ty, |$p:ident| $body:expr) => {{
                let $p: $ty = parse(method, value)?;
                state($body?)
            }};
        }
        match method {
            "getWorkspaceState" => state(self.state()),
            "createProject" => call!(Name, |p| self.create_project(&p.name)),
            "openProject" => call!(ProjectId, |p| self.open_project(&p.project_id)),
            "setActiveView" => call!(View, |p| self.set_active_view(p.view)),
            "createDesign" => call!(Name, |p| self.create_design(&p.name)),
            "openDesign" => call!(DesignId, |p| self.open_design(&p.design_id)),
            "renameDesign" => call!(RenameDesign, |p| self.rename_design(&p.design_id, &p.name)),

            "addTable" => call!(AddTable, |p| self.add_table(&p.design_id, &p.name, p.position)),
            "renameTable" => call!(RenameTable, |p| self.rename_table(&p.design_id, &p.table_id, &p.name)),
            "moveTable" => call!(MoveTable, |p| self.move_table(&p.design_id, &p.table_id, p.position)),
            "addColumn" => call!(AddColumn, |p| self.add_column(&p.design_id, &p.table_id, p.name.as_deref(), p.r#type.as_deref())),
            "updateColumn" => call!(UpdateColumn, |p| self.update_column(&p.design_id, &p.table_id, &p.column_id, &p.changes)),
            "setViewport" => call!(Viewport, |p| self.set_viewport(&p.design_id, p.x, p.y, p.zoom)),

            "addSystemService" => call!(AddSystemService, |p| self.add_system_service(p)),
            "updateSystemService" => call!(UpdateSystemService, |p| self.update_system_service(p)),
            "moveSystemService" => call!(MoveSystemService, |p| self.move_system_service(p)),
            "resizeSystemService" => call!(ResizeSystemService, |p| self.resize_system_service(p)),
            "removeSystemService" => call!(RemoveSystemService, |p| self.remove_system_service(p)),
            "setSystemServiceCollapsed" => call!(Collapsed, |p| self.set_system_service_collapsed(&p.service_id, p.collapsed)),
            "setSystemFocus" => call!(Focus, |p| self.set_system_focus(p.service_id.as_deref(), p.viewport)),
            "describeSystemServiceRemoval" => {
                let p: ServiceId = parse(method, value)?;
                self.describe_system_service_removal(&p.service_id)
            }
            "addSystemGroup" => call!(AddSystemGroup, |p| self.add_system_group(p)),
            "updateSystemGroup" => call!(UpdateSystemGroup, |p| self.update_system_group(p)),
            "moveSystemGroup" => call!(MoveSystemGroup, |p| self.move_system_group(p)),
            "resizeSystemGroup" => call!(ResizeSystemGroup, |p| self.resize_system_group(p)),
            "removeSystemGroup" => call!(RemoveSystemGroup, |p| self.remove_system_group(p)),
            "arrangeSystemLayout" => call!(ArrangeSystemLayout, |p| self.arrange_system_layout(p)),
            "addSystemComponent" => call!(AddSystemComponent, |p| self.add_system_component(p)),
            "updateSystemComponent" => call!(UpdateSystemComponent, |p| self.update_system_component(p)),
            "moveSystemComponent" => call!(MoveSystemComponent, |p| self.move_system_component(p)),
            "removeSystemComponent" => call!(RemoveSystemComponent, |p| self.remove_system_component(p)),
            "describeSystemComponentRemoval" => {
                let p: ComponentId = parse(method, value)?;
                self.describe_system_component_removal(&p.component_id)
            }
            "describeSystemConnectionRemoval" => {
                let p: ConnectionId = parse(method, value)?;
                self.describe_system_connection_removal(&p.connection_id)
            }
            "addSystemConnection" => call!(AddSystemConnection, |p| self.add_system_connection(p)),
            "updateSystemConnection" => call!(UpdateSystemConnection, |p| self.update_system_connection(p)),
            "removeSystemConnection" => call!(RemoveSystemConnection, |p| self.remove_system_connection(p)),
            "setSystemViewport" => call!(SystemViewport, |p| self.set_system_viewport(p.x, p.y, p.zoom)),
            "linkSystemDatabase" => call!(LinkDatabase, |p| self.link_system_database(&p.component_id, p.design_id.as_deref())),
            "createSystemDatabaseDesign" => call!(CreateDatabaseDesign, |p| self.create_system_database_design(&p.component_id, p.name.as_deref())),

            "createWalkthrough" => call!(CreateWalkthrough, |p| self.create_walkthrough(p.id, p.name)),
            "renameWalkthrough" => call!(RenameWalkthrough, |p| self.rename_walkthrough(&p.walkthrough_id, &p.name)),
            "removeWalkthrough" => call!(WalkthroughId, |p| self.remove_walkthrough(&p.walkthrough_id)),
            "moveWalkthrough" => call!(MoveWalkthrough, |p| self.move_walkthrough(&p.walkthrough_id, p.to_index)),
            "addWalkthroughStep" => call!(AddWalkthroughStep, |p| self.add_walkthrough_step(p)),
            "updateWalkthroughStep" => call!(UpdateStep, |p| self.update_walkthrough_step(&p.walkthrough_id, &p.step_id, &p.changes)),
            "moveWalkthroughStep" => call!(StepIndex, |p| self.move_walkthrough_step(&p.walkthrough_id, &p.step_id, p.to_index)),
            "removeWalkthroughStep" => call!(StepRef, |p| self.remove_walkthrough_step(&p.walkthrough_id, &p.step_id)),
            "addWalkthroughBlock" => call!(AddWalkthroughBlock, |p| self.add_walkthrough_block(p)),
            "addWalkthroughParallelBranch" => call!(BlockRef, |p| self.add_walkthrough_parallel_branch(&p.walkthrough_id, &p.block_id)),
            "updateWalkthroughRepeat" => call!(RepeatCount, |p| self.update_walkthrough_repeat(&p.walkthrough_id, &p.block_id, p.count)),
            "moveWalkthroughBlock" => call!(BlockIndex, |p| self.move_walkthrough_block(&p.walkthrough_id, &p.block_id, p.to_index)),
            "removeWalkthroughBlock" => call!(BlockRef, |p| self.remove_walkthrough_block(&p.walkthrough_id, &p.block_id)),
            "repairWalkthroughStep" => call!(RepairStep, |p| self.repair_walkthrough_step(&p.walkthrough_id, &p.step_id, &p.connection_id)),
            "acceptWalkthroughStepRedirection" => call!(StepRef, |p| self.accept_walkthrough_step_redirection(&p.walkthrough_id, &p.step_id)),

            // Read-only views of tables that other stores of the original own.
            "listProjectFiles" => {
                let p: ProjectId = parse(method, value)?;
                let files = self.lock().store.list_project_files(&p.project_id).map_err(|error| error.to_string())?;
                serde_json::to_value(files).map_err(|error| error.to_string())
            }
            "getAssistantRequestCap" => Ok(serde_json::json!(self.lock().store.assistant_request_cap().map_err(|error| error.to_string())?)),

            other => Err(format!("`{other}` {NOT_IMPLEMENTED}")),
        }
    }
}
