//! `run_scenarios` asks the view to run Scenarios and reports what came back, briefly.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use schema_assistant::read_tools::ToolContext;
use schema_assistant::scenario_tools::{RunScenarios, ScenarioRunner};
use schema_assistant::store::AssistantStore;
use schema_assistant::tools::ProjectTool;
use schema_sandbox::{ApplyResult, Sandbox};
use schema_workspace::{Options, Workspace};
use serde_json::{json, Value};

struct Empty;

impl Sandbox for Empty {
    fn apply(&mut self, _sql: &str) -> ApplyResult {
        ApplyResult::Applied { tables: vec![], relationships: vec![] }
    }
}

/// A view that answers each Scenario with the run it was told to give.
struct FakeView {
    runs: Mutex<Vec<Option<Value>>>,
    asked: Mutex<Vec<String>>,
}

impl ScenarioRunner for FakeView {
    fn run(&self, _project: &str, _design: &str, scenario: &Value, _aborted: &dyn Fn() -> bool, _timeout: Duration) -> Result<Option<Value>, String> {
        self.asked.lock().unwrap().push(scenario["name"].as_str().unwrap().to_owned());
        let mut runs = self.runs.lock().unwrap();
        if runs.is_empty() { Err("The view did not report the Scenario run result in time.".into()) } else { Ok(runs.remove(0)) }
    }
}

struct Fixture {
    tool: RunScenarios,
    view: Arc<FakeView>,
    scenario_ids: Vec<String>,
    _directory: tempfile::TempDir,
}

fn fixture(runs: Vec<Option<Value>>, connected: bool) -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app.sqlite");
    let workspace = Workspace::open(Options::new(&path, Arc::new(|| Box::new(Empty)))).unwrap();
    let created = workspace.request("createProject", json!({ "name": "Shop" })).unwrap();
    let project_id = created["project"]["id"].as_str().unwrap().to_owned();
    let design_id = created["activeDesignId"].as_str().unwrap().to_owned();
    let mut scenario_ids = vec![];
    for name in ["First", "Second", "Third"] {
        let state = workspace.request("createScenario", json!({ "name": name, "designId": design_id })).unwrap();
        scenario_ids.push(state["scenarios"].as_array().unwrap().iter().find(|scenario| scenario["name"] == name).unwrap()["id"].as_str().unwrap().to_owned());
    }
    let store = Arc::new(AssistantStore::open(&path, || 1).unwrap());
    let conversation = store.create_conversation(&project_id, &json!({ "role": "system", "payload": {} }), &json!({ "id": "c1" })).unwrap()["id"].as_str().unwrap().to_owned();
    let view = Arc::new(FakeView { runs: Mutex::new(runs), asked: Default::default() });
    let context = Arc::new(ToolContext {
        reads: Default::default(),
        turn_id: Box::new(|| None),
        workspace,
        store,
        files: None,
        folder: None,
        scenario_runner: if connected { Some(view.clone()) } else { None },
        abort: Default::default(),
        conversation_id: conversation,
        target: (project_id, design_id),
    });
    Fixture { tool: RunScenarios(context), view, scenario_ids, _directory: directory }
}

fn run(status: &str, console: Vec<&str>, expectations: Value) -> Value {
    json!({
        "id": "run-1", "status": status, "revision": 3, "stale": false, "console": console, "expectations": expectations,
        "requests": [{ "method": "GET", "table": "items", "status": 200 }, { "method": "GET", "table": "items", "status": 200 }, { "method": "POST", "table": "items", "status": 201 }],
        "grids": [{ "table": "items", "total": 7, "columns": ["id"], "rows": [{ "id": 1 }, { "id": 2 }, { "id": 3 }, { "id": 4 }] }],
    })
}

fn call(fixture: &Fixture, arguments: Value) -> Result<Value, String> {
    fixture.tool.execute("c", &arguments).map(|result| serde_json::from_str(&result.content[0]).unwrap())
}

#[test]
fn all_scenarios_run_in_order_and_are_summarised() {
    let failing = json!([{ "description": "has one item", "passed": false, "message": "expected 1, received [{\"id\":1}]" }, { "description": "ok", "passed": true, "message": "" }]);
    let fixture = fixture(vec![Some(run("passed", vec!["hello"], json!([]))), Some(run("failed", vec![], failing)), Some(run("passed", vec![], json!([])))], true);
    let result = call(&fixture, json!({ "mode": "all" })).unwrap();
    assert_eq!(*fixture.view.asked.lock().unwrap(), vec!["First", "Second", "Third"]);
    let runs = result["runs"].as_array().unwrap();
    assert_eq!(runs.len(), 3);
    assert_eq!(runs[0]["status"], "passed");
    assert_eq!(runs[0]["console"], json!(["hello"]));
    assert_eq!(runs[0]["requestLog"], json!([{ "request": "GET items (200)", "count": 2 }, { "request": "POST items (201)", "count": 1 }]));
    assert_eq!(runs[0]["grids"][0]["capturedRows"], 4);
    assert_eq!(runs[0]["grids"][0]["rows"].as_array().unwrap().len(), 3);
    assert_eq!(runs[1]["failedExpectationCount"], 1);
    assert_eq!(runs[1]["failedExpectations"][0]["message"], "expected 1, received row data omitted.");
}

#[test]
fn one_scenario_needs_an_id_that_exists() {
    let fixture = fixture(vec![Some(run("passed", vec![], json!([])))], true);
    assert_eq!(call(&fixture, json!({ "mode": "one" })).unwrap_err(), "A Scenario id is required to run one Scenario.");
    assert_eq!(call(&fixture, json!({ "mode": "one", "scenarioId": "nope" })).unwrap_err(), "That Scenario does not exist in the bound project.");
    let result = call(&fixture, json!({ "mode": "one", "scenarioId": fixture.scenario_ids[1] })).unwrap();
    assert_eq!(*fixture.view.asked.lock().unwrap(), vec!["Second"]);
    assert_eq!(result["runs"].as_array().unwrap().len(), 1);
}

#[test]
fn a_view_that_is_not_connected_or_never_answers_is_reported() {
    assert_eq!(call(&fixture(vec![], false), json!({ "mode": "all" })).unwrap_err(), "Scenario runs are unavailable because the view is not connected.");
    assert_eq!(call(&fixture(vec![], true), json!({ "mode": "all" })).unwrap_err(), "The view did not report the Scenario run result in time.");
}

#[test]
fn a_stopped_run_ends_the_batch() {
    let stopped = json!({ "id": "r", "status": "errored", "reason": "stopped", "revision": 1, "stale": false, "console": [], "expectations": [], "requests": [], "grids": [] });
    let fixture = fixture(vec![Some(stopped), Some(run("passed", vec![], json!([])))], true);
    let result = call(&fixture, json!({ "mode": "all" })).unwrap();
    assert_eq!(*fixture.view.asked.lock().unwrap(), vec!["First"]);
    assert_eq!(result["runs"][0]["status"], "stopped");
}
