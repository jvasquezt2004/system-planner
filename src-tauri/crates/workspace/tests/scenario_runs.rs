//! A Scenario run: begin, requests answered from the run's private database, finish.

use std::sync::Arc;
use std::time::{Duration, Instant};

use schema_sandbox::{PgliteSandbox, Sandbox};
use schema_workspace::{Options, Workspace};
use serde_json::json;

struct Pglite;
impl Sandbox for Pglite {
    fn apply(&mut self, sql: &str) -> schema_sandbox::ApplyResult {
        PgliteSandbox.apply(sql)
    }
}

fn wait_for(workspace: &Workspace, what: &str, done: impl Fn(&schema_workspace::WorkspaceState) -> bool) {
    let started = Instant::now();
    while !done(&workspace.state()) {
        assert!(started.elapsed() < Duration::from_secs(60), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_run_reads_and_writes_its_own_copy_and_records_what_happened() {
    let directory = tempfile::tempdir().unwrap();
    let mut options = Options::new(directory.path().join("workspace.sqlite"), Arc::new(|| Box::new(Pglite)));
    options.preview_delay = Duration::from_millis(20);
    let workspace = Workspace::open(options).unwrap();
    let created = workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let design_id = created["activeDesignId"].as_str().unwrap().to_owned();
    let with_table = workspace.request("addTable", json!({ "name": "items", "designId": design_id })).unwrap();
    let table = &with_table["design"]["tables"][0];
    let table_id = table["id"].as_str().unwrap().to_owned();
    workspace.request("addColumn", json!({ "tableId": table_id, "name": "label", "type": "text", "designId": design_id })).unwrap();
    let scenario = workspace.request("createScenario", json!({ "name": "Adds an item", "designId": design_id })).unwrap();
    let scenario_id = scenario["scenarios"][0]["id"].as_str().unwrap().to_owned();

    // Nothing runs before the sandbox accepted the Design.
    wait_for(&workspace, "the sandbox", |state| state.sandbox["status"] == "applied");

    let begun = workspace.request("beginScenarioRun", json!({ "scenarioId": scenario_id, "designId": design_id })).unwrap();
    let run_id = begun["runId"].as_str().unwrap().to_owned();
    assert_eq!(begun["state"]["scenarioRuns"][&scenario_id]["status"], "running");
    // Only one run at a time.
    assert_eq!(workspace.request("beginScenarioRun", json!({ "scenarioId": scenario_id, "designId": design_id })).unwrap_err(), "Another Scenario run is already active.");

    let service = format!("Bearer h.{}.s", base64_url(r#"{"role":"service_role"}"#));
    let post = json!({ "method": "POST", "path": "/rest/v1/items", "query": "", "headers": { "authorization": service, "prefer": "return=representation" }, "body": "{\"label\":\"pen\"}" });
    let response = workspace.request("handleSandboxApiRequest", json!({ "runId": run_id, "request": post })).unwrap();
    assert_eq!(response["status"], 201);
    let read = json!({ "method": "GET", "path": "/rest/v1/items", "query": "select=label", "headers": {}, "body": null });
    let response = workspace.request("handleSandboxApiRequest", json!({ "runId": run_id, "request": read })).unwrap();
    assert_eq!(response["body"], json!([{ "label": "pen" }]));
    // An unknown run is told it expired.
    let expired = workspace.request("handleSandboxApiRequest", json!({ "runId": "nope", "request": read })).unwrap();
    assert_eq!(expired["status"], 410);

    let log = &workspace.state().scenario_runs[&scenario_id];
    assert_eq!(log["requests"].as_array().unwrap().len(), 2);
    assert_eq!(log["requests"][0]["order"], 1);
    assert_eq!(log["requests"][1]["method"], "GET");

    let finished = workspace
        .request("finishScenarioRun", json!({ "runId": run_id, "status": "passed", "console": ["done"], "expectations": [{ "description": "one item", "passed": true, "message": "" }] }))
        .unwrap();
    let run = &finished["scenarioRuns"][&scenario_id];
    assert_eq!((run["status"].as_str(), run["console"][0].as_str()), (Some("passed"), Some("done")));
    assert_eq!(run["grids"][0]["table"], "items");
    assert_eq!(run["grids"][0]["total"], 1);
    assert_eq!(run["grids"][0]["rows"][0]["label"], "pen");
    assert_eq!(run["stale"], false);

    // The next run starts from the Design, not from what the last one wrote.
    let again = workspace.request("beginScenarioRun", json!({ "scenarioId": scenario_id, "designId": design_id })).unwrap();
    let second = again["runId"].as_str().unwrap().to_owned();
    let empty = workspace.request("handleSandboxApiRequest", json!({ "runId": second, "request": read })).unwrap();
    assert_eq!(empty["body"], json!([]));
    workspace.request("finishScenarioRun", json!({ "runId": second, "status": "failed", "console": [] })).unwrap();

    // Editing the Design makes the finished run stale.
    workspace.request("addColumn", json!({ "tableId": table_id, "name": "extra", "type": "text", "designId": design_id })).unwrap();
    assert_eq!(workspace.state().scenario_runs[&scenario_id]["stale"], true);
}

fn base64_url(text: &str) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let bytes = text.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}
