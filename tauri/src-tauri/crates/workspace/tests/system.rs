use std::sync::{Arc, Mutex};
use std::time::Duration;

use schema_sandbox::{ApplyResult, Sandbox};
use schema_workspace::{Options, SandboxFactory, Workspace, WorkspaceState};
use serde_json::{json, Value};

struct Accepting;
impl Sandbox for Accepting {
    fn apply(&mut self, _sql: &str) -> ApplyResult {
        ApplyResult::Applied { tables: vec![], relationships: vec![] }
    }
}

fn open(directory: &tempfile::TempDir) -> Workspace {
    let sandbox: SandboxFactory = Arc::new(|| Box::new(Accepting));
    let mut options = Options::new(directory.path().join("workspace.sqlite"), sandbox);
    options.preview_delay = Duration::from_millis(20);
    Workspace::open(options).unwrap()
}

/// A Project open on the System overview, with an API component, a database component, a Service,
/// and a Connection between the components.
struct Fixture {
    workspace: Workspace,
    api: String,
    database: String,
    service: String,
    connection: String,
}

fn fixture(directory: &tempfile::TempDir) -> Fixture {
    let workspace = open(directory);
    workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let call = |method: &str, params: Value| workspace.request(method, params).unwrap();
    let service = call("addSystemService", json!({ "id": "svc", "name": "Checkout", "x": 40, "y": 40 }));
    let service = service["systemDesign"]["services"][0]["id"].as_str().unwrap().to_owned();
    call("addSystemComponent", json!({ "id": "api", "kind": "api", "name": "Checkout API", "x": 100, "y": 100, "serviceId": service }));
    call("addSystemComponent", json!({ "id": "db", "kind": "database", "x": 400, "y": 100 }));
    call("addSystemConnection", json!({ "id": "con", "sourceId": "api", "targetId": "db", "label": "Writes order" }));
    Fixture { workspace, api: "api".into(), database: "db".into(), service, connection: "con".into() }
}

#[test]
fn the_system_overview_edits_persist_and_survive_a_restart() {
    let directory = tempfile::tempdir().unwrap();
    let f = fixture(&directory);
    let state = f.workspace.state();
    let design = state.system_design.as_ref().unwrap();
    assert_eq!((design.services.len(), design.components.len(), design.connections.len()), (1, 2, 1));
    assert_eq!(design.components[1].name, "Database", "a default name comes from the catalog");
    assert_eq!(state.system_save["status"], "saved");

    let reopened = open(&directory);
    let design = reopened.state().system_design.unwrap();
    assert_eq!(design.components[0].service_id.as_deref(), Some(f.service.as_str()));
    assert_eq!(design.connections[0].label, "Writes order");
}

#[test]
fn a_change_that_leaves_the_content_alone_is_not_saved() {
    let directory = tempfile::tempdir().unwrap();
    let f = fixture(&directory);
    let before = f.workspace.state();
    let after = f.workspace.request("moveSystemComponent", json!({ "componentId": f.api, "x": 100, "y": 100 })).unwrap();
    assert_eq!(after["systemSave"], before.system_save, "no save was made");
    let moved = f.workspace.request("moveSystemComponent", json!({ "componentId": f.api, "x": 120.456, "y": 100 })).unwrap();
    assert_ne!(moved["systemSave"], before.system_save);
    assert_eq!(moved["systemDesign"]["components"][0]["position"]["x"], 120.46, "positions are rounded to hundredths");
}

#[test]
fn presentation_is_saved_but_is_not_content() {
    let directory = tempfile::tempdir().unwrap();
    let f = fixture(&directory);
    let call = |method: &str, params: Value| f.workspace.request(method, params).unwrap();
    call("setSystemServiceCollapsed", json!({ "serviceId": f.service, "collapsed": true }));
    call("setSystemFocus", json!({ "serviceId": f.service, "viewport": { "x": 1, "y": 2, "zoom": 9 } }));
    let state = call("setSystemViewport", json!({ "x": 5, "y": 6, "zoom": 0.01 }));
    assert_eq!(state["systemDesign"]["collapsedServiceIds"], json!([f.service]));
    assert_eq!(state["systemDesign"]["focusViewport"]["zoom"], 2.5, "zoom is clamped");
    assert_eq!(state["systemDesign"]["viewport"]["zoom"], 0.3);
    let reopened = open(&directory).state().system_design.unwrap();
    assert_eq!(reopened.collapsed_service_ids, vec![f.service.clone()]);
    assert_eq!(reopened.focused_service_id.as_deref(), Some(f.service.as_str()));
}

#[test]
fn removing_a_connection_reports_the_walkthrough_steps_it_would_leave_dangling() {
    let directory = tempfile::tempdir().unwrap();
    let f = fixture(&directory);
    let call = |method: &str, params: Value| f.workspace.request(method, params).unwrap();
    let created = call("createWalkthrough", json!({ "id": "wt", "name": "Place an order" }));
    assert_eq!(created["walkthroughs"][0]["name"], "Place an order");
    let stepped = call("addWalkthroughStep", json!({ "walkthroughId": "wt", "connectionId": f.connection, "id": "s1", "action": "send", "durationMs": 1200 }));
    let step = &stepped["walkthroughs"][0]["blocks"][0]["step"];
    assert_eq!(step["title"], "Writes order", "the title defaults to the Connection's label");
    assert_eq!(step["route"], json!({ "sourceId": "api", "targetId": "db" }));

    let plan = call("describeSystemConnectionRemoval", json!({ "connectionId": f.connection }));
    assert_eq!(plan["connectionLabel"], "Writes order");
    assert_eq!(plan["walkthroughSteps"][0]["stepId"], "s1");
    let by_component = call("describeSystemComponentRemoval", json!({ "componentId": f.database }));
    assert_eq!(by_component["connections"][0]["id"], f.connection);
    assert_eq!(by_component["walkthroughSteps"][0]["walkthroughName"], "Place an order");
    let by_service = call("describeSystemServiceRemoval", json!({ "serviceId": f.service }));
    assert_eq!(by_service["releasedComponents"][0]["id"], f.api);
    assert_eq!(by_service["walkthroughSteps"], json!([]), "only Connections whose endpoint is the Service are deleted");

    // Removal keeps the step; it simply becomes dangling for the view to report.
    let removed = call("removeSystemConnection", json!({ "connectionId": f.connection }));
    assert_eq!(removed["walkthroughs"][0]["blocks"][0]["step"]["connectionId"], f.connection);
    assert_eq!(removed["walkthroughSave"]["status"], "saved");
}

#[test]
fn walkthrough_blocks_and_steps_follow_the_authoring_rules() {
    let directory = tempfile::tempdir().unwrap();
    let f = fixture(&directory);
    let call = |method: &str, params: Value| f.workspace.request(method, params);
    call("createWalkthrough", json!({ "id": "wt" })).unwrap();
    let block = call("addWalkthroughBlock", json!({ "walkthroughId": "wt", "id": "par", "kind": "parallel" })).unwrap();
    assert_eq!(block["walkthroughs"][0]["name"], "Walkthrough", "a default name is generated");
    assert_eq!(block["walkthroughs"][0]["blocks"][0]["branches"].as_array().unwrap().len(), 2);
    call("addWalkthroughStep", json!({ "walkthroughId": "wt", "connectionId": f.connection, "id": "a", "sequence": { "blockId": "par", "branch": 1 } })).unwrap();
    assert_eq!(
        call("addWalkthroughStep", json!({ "walkthroughId": "wt", "connectionId": f.connection, "id": "b", "sequence": { "blockId": "par" } })).unwrap_err(),
        "Choose a branch of the parallel block for this step."
    );
    assert_eq!(call("addWalkthroughParallelBranch", json!({ "walkthroughId": "wt", "blockId": "par" })).unwrap()["walkthroughs"][0]["blocks"][0]["branches"].as_array().unwrap().len(), 3);
    assert_eq!(call("updateWalkthroughRepeat", json!({ "walkthroughId": "wt", "blockId": "par", "count": 3 })).unwrap_err(), "Only a repeated block has a count.");
    assert_eq!(call("removeWalkthroughStep", json!({ "walkthroughId": "wt", "stepId": "missing" })).unwrap_err(), "That step could not be found.");
    let removed = call("removeWalkthroughBlock", json!({ "walkthroughId": "wt", "blockId": "par" })).unwrap();
    assert_eq!(removed["walkthroughs"][0]["blocks"], json!([]), "the block takes its steps with it");
}

#[test]
fn a_database_component_links_to_a_new_design_that_the_project_opens() {
    let directory = tempfile::tempdir().unwrap();
    let f = fixture(&directory);
    let call = |method: &str, params: Value| f.workspace.request(method, params);
    let first_design = f.workspace.state().active_design_id.unwrap();

    assert_eq!(call("createSystemDatabaseDesign", json!({ "componentId": f.api })).unwrap_err(), "Only a Database component can link to a database design.");
    let created = call("createSystemDatabaseDesign", json!({ "componentId": f.database, "name": "  Orders DB " })).unwrap();
    let new_design = created["activeDesignId"].as_str().unwrap().to_owned();
    assert_ne!(new_design, first_design, "the new design is opened");
    assert_eq!(created["designs"].as_array().unwrap().len(), 2);
    assert_eq!(created["designs"][1]["name"], "Orders DB");
    assert_eq!(created["systemDesign"]["components"][1]["designId"], new_design, "and the component links to it");
    assert_eq!(created["systemDesign"]["components"].as_array().unwrap().len(), 2, "switching designs keeps the System design");
    assert_eq!(created["activeView"], "system");

    assert_eq!(
        call("createSystemDatabaseDesign", json!({ "componentId": f.database })).unwrap_err(),
        "This database component is already linked to a design. Unlink it first."
    );
    let unlinked = call("linkSystemDatabase", json!({ "componentId": f.database, "designId": null })).unwrap();
    assert!(unlinked["systemDesign"]["components"][1].get("designId").is_none());
    let relinked = call("linkSystemDatabase", json!({ "componentId": f.database, "designId": first_design })).unwrap();
    assert_eq!(relinked["systemDesign"]["components"][1]["designId"], first_design);
    assert_eq!(call("linkSystemDatabase", json!({ "componentId": f.database, "designId": "nope" })).unwrap_err(), "That design could not be found in this project.");

    assert_eq!(
        call("updateSystemComponent", json!({ "componentId": f.database, "changes": { "kind": "api" } })).unwrap_err(),
        "Unlink this Component from its database design before changing its kind."
    );
    let back = call("openDesign", json!({ "designId": first_design })).unwrap();
    assert_eq!(back["activeDesignId"], first_design);
    // Design names are unique ignoring case: the first design cannot take the second one's name.
    let renamed = call("renameDesign", json!({ "designId": first_design, "name": "orders db" }));
    assert!(renamed.unwrap_err().contains("already exists"));
    assert_eq!(call("renameDesign", json!({ "designId": new_design, "name": "orders db" })).unwrap()["designs"][1]["name"], "orders db", "a design may change its own name's case");
    assert_eq!(call("createDesign", json!({ "name": "" })).unwrap()["designs"][2]["name"], "Design 3");
}

#[test]
fn opening_a_project_with_tables_checks_its_schema_straight_away() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = open(&directory);
    let design_id = workspace.request("createProject", json!({ "name": "Shop" })).unwrap()["activeDesignId"].as_str().unwrap().to_owned();
    workspace.request("addTable", json!({ "designId": design_id, "name": "orders" })).unwrap();

    // The original builds the preview as part of opening, with no debounce, so the view never shows
    // "Not run" for a design that has tables.
    let pushes = Arc::new(Mutex::new(Vec::<Value>::new()));
    let reopened = open(&directory);
    let sink = pushes.clone();
    reopened.subscribe(Arc::new(move |state: &WorkspaceState| sink.lock().unwrap().push(serde_json::to_value(state).unwrap())));
    let state = reopened.state();
    assert_eq!(state.sql["status"], "current", "{}", state.sql);
    assert_eq!(state.sandbox["status"], "applied");

    // An empty design has nothing to check.
    let empty = workspace.request("createProject", json!({ "name": "Blank" })).unwrap();
    assert_eq!(empty["sql"]["status"], "empty");
    assert_eq!(empty["sandbox"]["status"], "idle");
}

#[test]
fn bad_system_requests_are_refused_with_the_original_messages() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = open(&directory);
    assert_eq!(
        workspace.request("addSystemService", json!({ "x": 0, "y": 0 })).unwrap_err(),
        "Open a project before editing its System design."
    );
    let f = fixture(&tempfile::tempdir().unwrap());
    let call = |method: &str, params: Value| f.workspace.request(method, params).unwrap_err();
    assert_eq!(call("addSystemComponent", json!({ "id": "api", "x": 0, "y": 0 })), "Component \"api\" already exists.");
    assert_eq!(call("addSystemComponent", json!({ "id": "x", "kind": "nonsense", "x": 0, "y": 0 })), "Unsupported Component kind \"nonsense\".");
    assert_eq!(call("addSystemConnection", json!({ "sourceId": "api", "targetId": "api" })), "A Connection must join two different Components.");
    assert_eq!(call("moveSystemComponent", json!({ "componentId": "ghost", "x": 1, "y": 1 })), "That Component could not be found.");
    assert_eq!(call("updateSystemComponent", json!({ "componentId": "db", "changes": { "kind": "mystery" } })), "Unsupported Component kind \"mystery\".");
    assert!(call("addSystemGroup", json!({ "x": 0, "y": 0, "memberIds": ["nowhere"] })).contains("does not match a Component, Service, or Group"));
    assert!(call("addSystemService", json!({ "x": "left", "y": 0 })).contains("invalid parameters"), "a malformed request names the method");
}
