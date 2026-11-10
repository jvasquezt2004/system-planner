//! Running a Scenario against the Design's sandbox (`beginScenarioRun`, `handleSandboxApiRequest`
//! and `finishScenarioRun` in `src/bun/workspace.ts`).
//!
//! The Scenario's code runs in the view. It asks the workspace to begin a run, which builds a private
//! copy of the last applied sandbox database; every request the code makes is answered from that
//! copy; finishing the run captures the tables' rows as result grids and drops the copy.

use std::sync::Arc;

use schema_scenario::{RunDatabase, RunSchema};
use serde_json::{json, Value};

use crate::state::last_applied_sandbox;
use crate::{Result, Workspace, WorkspaceState};

pub struct ActiveRun {
    id: String,
    scenario_id: String,
    project_id: String,
    design_id: String,
    revision: i64,
    scenario_revision: i64,
    edge_function_revision: i64,
    database: Option<Arc<RunDatabase>>,
}

fn expired_run() -> Value {
    json!({
        "status": 410,
        "headers": { "content-type": "application/json" },
        "body": { "code": "PGRST_SANDBOX_UNSUPPORTED", "message": "not supported by the sandbox: expired Scenario run", "details": null, "hint": null },
    })
}

impl Workspace {
    /// A run's `stale` flag follows the revisions on every state change, as the original's `setState` does.
    pub(crate) fn refresh_stale_runs(inner: &mut crate::Inner) {
        let (revision, scenario_revision, edge_revision) = (inner.state.revision, inner.scenario_revision, inner.edge_function_revision);
        for run in inner.state.scenario_runs.values_mut() {
            if let Some(record) = run.as_object_mut() {
                let stale = record["revision"].as_i64().unwrap_or(0) < revision
                    || record["scenarioRevision"].as_i64().unwrap_or(0) < scenario_revision
                    || record["edgeFunctionRevision"].as_i64().unwrap_or(0) < edge_revision;
                record.insert("stale".into(), json!(stale));
            }
        }
    }

    /// Starts a run of one Scenario. Returns the run's id and the state it shows.
    pub fn begin_scenario_run(&self, scenario_id: &str, design_id: &str) -> Result<(String, WorkspaceState)> {
        let (run_id, sql, schema) = {
            let mut inner = self.lock();
            let (project_id, _, design_id) = self.require_open_design(&inner, design_id)?;
            if inner.active_scenario_run.is_some() {
                return Err("Another Scenario run is already active.".into());
            }
            let scenario = inner
                .state
                .scenarios
                .iter()
                .find(|candidate| candidate["id"] == scenario_id)
                .filter(|scenario| scenario["designId"].is_null() || scenario["designId"] == design_id.as_str())
                .ok_or("That Scenario could not be found in the target database Design.")?
                .clone();
            let snapshot = last_applied_sandbox(&inner.state.sandbox).filter(|snapshot| snapshot["designId"] == design_id.as_str()).ok_or("Apply a valid design revision before running a Scenario.")?;
            let run = ActiveRun {
                id: self.new_id(),
                scenario_id: scenario["id"].as_str().unwrap_or_default().to_owned(),
                project_id,
                design_id: design_id.clone(),
                revision: snapshot["revision"].as_i64().unwrap_or(0),
                scenario_revision: inner.scenario_revision,
                edge_function_revision: inner.edge_function_revision,
                database: None,
            };
            let schema = RunSchema {
                tables: serde_json::from_value(snapshot["tables"].clone()).map_err(|error| error.to_string())?,
                relationships: serde_json::from_value(snapshot["relationships"].clone()).map_err(|error| error.to_string())?,
                functions: serde_json::from_value(snapshot.get("functions").cloned().unwrap_or_else(|| json!([]))).map_err(|error| error.to_string())?,
            };
            let record = json!({
                "id": run.id, "designId": design_id, "scenarioId": run.scenario_id, "status": "running", "revision": run.revision,
                "scenarioRevision": run.scenario_revision, "edgeFunctionRevision": run.edge_function_revision, "stale": false,
                "requests": [], "console": [], "grids": [], "expectations": [],
            });
            let (run_id, scenario_id) = (run.id.clone(), run.scenario_id.clone());
            inner.active_scenario_run = Some(run);
            self.update(&mut inner, |state| {
                state.scenario_runs.insert(scenario_id, record);
            });
            (run_id, snapshot["sql"].as_str().unwrap_or_default().to_owned(), schema)
        };
        // Building the copy takes a moment; the workspace stays usable meanwhile.
        let built = RunDatabase::open(&sql, schema);
        let mut inner = self.lock();
        let still_active = inner.active_scenario_run.as_ref().is_some_and(|run| run.id == run_id)
            && inner.active_project_id.as_deref() == inner.active_scenario_run.as_ref().map(|run| run.project_id.as_str())
            && inner.active_design_id.as_deref() == inner.active_scenario_run.as_ref().map(|run| run.design_id.as_str());
        match built {
            Ok(database) if still_active => {
                if let Some(run) = inner.active_scenario_run.as_mut() {
                    run.database = Some(Arc::new(database));
                }
                Ok((run_id, inner.state.clone()))
            }
            Ok(_) => Err("The Scenario run was superseded.".into()),
            Err(error) => {
                let message = error.clone();
                if inner.active_scenario_run.as_ref().is_some_and(|run| run.id == run_id) {
                    let scenario_id = inner.active_scenario_run.take().map(|run| run.scenario_id).unwrap_or_default();
                    self.update(&mut inner, |state| {
                        if let Some(record) = state.scenario_runs.get_mut(&scenario_id).and_then(Value::as_object_mut).filter(|record| record["id"] == run_id.as_str()) {
                            record.insert("status".into(), json!("errored"));
                            record.insert("reason".into(), json!("exception"));
                            record.insert("console".into(), json!([message]));
                        }
                    });
                }
                Err(error)
            }
        }
    }

    /// Answers one request the Scenario's code made, from the run's private database.
    pub fn handle_sandbox_api_request(&self, run_id: &str, request: &Value) -> Value {
        let database = {
            let inner = self.lock();
            let Some(run) = inner.active_scenario_run.as_ref().filter(|run| run.id == run_id) else { return expired_run() };
            if inner.active_project_id.as_deref() != Some(run.project_id.as_str()) || inner.active_design_id.as_deref() != Some(run.design_id.as_str()) {
                return expired_run();
            }
            let Some(database) = run.database.clone() else { return expired_run() };
            database
        };
        let Some((response, entry)) = database.handle(request.clone()) else { return expired_run() };
        let mut inner = self.lock();
        let Some(run) = inner.active_scenario_run.as_ref().filter(|run| run.id == run_id) else { return response };
        let scenario_id = run.scenario_id.clone();
        self.update(&mut inner, |state| {
            if let Some(record) = state.scenario_runs.get_mut(&scenario_id).and_then(Value::as_object_mut).filter(|record| record["id"] == run_id) {
                if let Some(requests) = record.get_mut("requests").and_then(Value::as_array_mut) {
                    let mut entry = entry;
                    if let Some(fields) = entry.as_object_mut() {
                        let mut ordered = serde_json::Map::new();
                        ordered.insert("order".into(), json!(requests.len() + 1));
                        ordered.extend(std::mem::take(fields));
                        *fields = ordered;
                    }
                    requests.push(entry);
                }
            }
        });
        response
    }

    /// Ends the run: captures the result grids, drops the private database and records the outcome.
    pub fn finish_scenario_run(&self, run_id: &str, status: &str, console: Vec<String>, expectations: Option<Value>, reason: Option<String>) -> WorkspaceState {
        let (run, previous_grids) = {
            let mut inner = self.lock();
            let matches = inner.active_scenario_run.as_ref().is_some_and(|run| {
                run.id == run_id && inner.active_project_id.as_deref() == Some(run.project_id.as_str()) && inner.active_design_id.as_deref() == Some(run.design_id.as_str())
            });
            if !matches {
                return inner.state.clone();
            }
            let run = inner.active_scenario_run.take().expect("checked above");
            let grids = inner.state.scenario_runs.get(&run.scenario_id).filter(|record| record["id"] == run_id).map(|record| record["grids"].clone());
            (run, grids)
        };
        let (mut status, mut reason, mut output) = (status.to_owned(), reason, console);
        let mut grids = previous_grids.clone().unwrap_or_else(|| json!([]));
        if let Some(database) = &run.database {
            match database.grids() {
                Ok(captured) => grids = json!(captured),
                Err(error) => {
                    status = "errored".into();
                    reason = Some("exception".into());
                    output.push(error);
                }
            }
        }
        let mut inner = self.lock();
        if previous_grids.is_some() {
            let scenario_id = run.scenario_id.clone();
            self.update(&mut inner, |state| {
                if let Some(record) = state.scenario_runs.get_mut(&scenario_id).and_then(Value::as_object_mut) {
                    record.insert("id".into(), json!(run.id));
                    record.insert("designId".into(), json!(run.design_id));
                    record.insert("scenarioId".into(), json!(run.scenario_id));
                    record.insert("status".into(), json!(status));
                    record.insert("console".into(), json!(output));
                    record.insert("grids".into(), grids);
                    record.insert("expectations".into(), expectations.unwrap_or_else(|| json!([])));
                    record.insert("scenarioRevision".into(), json!(run.scenario_revision));
                    if let Some(reason) = reason {
                        record.insert("reason".into(), json!(reason));
                    }
                }
            });
        }
        inner.state.clone()
    }
}
