//! `run_scenarios`: the harness asks the view to run saved Scenarios (their code runs in the view)
//! and gets back what happened, briefly (`run_scenarios` in `src/bun/assistant-runtime.ts`).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::read_tools::ToolContext;
use crate::tools::{ProjectTool, ToolResult};

type Result<T> = std::result::Result<T, String>;

/// How long the view has to report a run: its own limit plus a grace period.
pub const SCENARIO_RUN_TIMEOUT: Duration = Duration::from_millis(30_000 + 15_000);

/// Whatever runs a Scenario's code. In the app that is the view, which reports back when it is done.
pub trait ScenarioRunner: Send + Sync {
    /// `Ok(None)` when the run was stopped before it reported; an error when the view never answered.
    fn run(&self, project_id: &str, design_id: &str, scenario: &Value, aborted: &dyn Fn() -> bool, timeout: Duration) -> Result<Option<Value>>;
}

pub struct RunScenarios(pub Arc<ToolContext>);

fn compact_expectation_message(message: &str) -> String {
    let lower = message.to_lowercase();
    let mut received_at = None;
    for (index, _) in lower.match_indices(',') {
        let rest = lower[index + 1..].trim_start();
        if rest.starts_with("received") && !rest["received".len()..].starts_with(|c: char| c.is_alphanumeric() || c == '_') {
            received_at = Some(index);
            break;
        }
    }
    let summary = match received_at {
        Some(at) => format!("{}, received row data omitted.", &message[..at]),
        None => message.to_owned(),
    };
    summary.chars().take(500).collect()
}

fn truncated(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// A run, as the harness is told of it.
pub fn compact_scenario_run(scenario_id: &str, name: &str, run: &Value) -> Value {
    let stopped = run["reason"] == "stopped";
    let requests = run["requests"].as_array().cloned().unwrap_or_default();
    let mut counts: Vec<(String, u64)> = Vec::new();
    for request in &requests {
        let key = format!("{} {} ({})", request["method"].as_str().unwrap_or(""), request["table"].as_str().unwrap_or(""), request["status"]);
        match counts.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, count)) => *count += 1,
            None => counts.push((key, 1)),
        }
    }
    let failed: Vec<&Value> = run["expectations"].as_array().map(|items| items.iter().filter(|item| item["passed"] != true).collect()).unwrap_or_default();
    let console: Vec<Value> = run["console"].as_array().map(|lines| lines.iter().rev().take(20).rev().map(|line| json!(truncated(line.as_str().unwrap_or(""), 500))).collect()).unwrap_or_default();
    let grids: Vec<Value> = run["grids"]
        .as_array()
        .map(|grids| {
            grids
                .iter()
                .take(10)
                .map(|grid| {
                    let rows = grid["rows"].as_array().cloned().unwrap_or_default();
                    json!({
                        "table": grid["table"],
                        "rowCount": grid["total"],
                        "capturedRows": rows.len(),
                        "rows": rows.iter().take(3).map(|row| {
                            let text = row.to_string();
                            if text.chars().count() > 2_000 { json!(format!("{}…", truncated(&text, 2_000))) } else { row.clone() }
                        }).collect::<Vec<_>>(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let mut compact = Map::new();
    compact.insert("scenario".into(), json!(name));
    compact.insert("scenarioId".into(), json!(scenario_id));
    compact.insert("runId".into(), run["id"].clone());
    compact.insert("status".into(), if stopped { json!("stopped") } else { run["status"].clone() });
    compact.insert("revision".into(), run["revision"].clone());
    compact.insert("stale".into(), run["stale"].clone());
    if !run["reason"].is_null() {
        compact.insert("reason".into(), run["reason"].clone());
    }
    compact.insert("failedExpectationCount".into(), json!(failed.len()));
    compact.insert(
        "failedExpectations".into(),
        json!(failed.iter().take(20).map(|item| json!({ "description": truncated(item["description"].as_str().unwrap_or(""), 300), "message": compact_expectation_message(item["message"].as_str().unwrap_or("")) })).collect::<Vec<_>>()),
    );
    compact.insert("console".into(), json!(console));
    compact.insert("requestCount".into(), json!(requests.len()));
    compact.insert("requestLog".into(), json!(counts.iter().take(50).map(|(request, count)| json!({ "request": request, "count": count })).collect::<Vec<_>>()));
    compact.insert("omittedRequestKinds".into(), json!(counts.len().saturating_sub(50)));
    compact.insert("grids".into(), json!(grids));
    Value::Object(compact)
}

impl RunScenarios {
    fn on_target(&self) -> bool {
        let state = self.0.workspace.state();
        state.project.as_ref().map(|project| project.id.as_str()) == Some(self.0.target.0.as_str()) && state.active_design_id.as_deref() == Some(self.0.target.1.as_str())
    }

    fn require_target(&self, message: &str) -> Result<()> {
        if self.on_target() { Ok(()) } else { Err(message.to_owned()) }
    }
}

impl ProjectTool for RunScenarios {
    fn name(&self) -> &str {
        "run_scenarios"
    }

    fn description(&self) -> &str {
        "Run one saved Scenario or all saved Scenarios in the bound project. Returns concise expectations, console, request summary, and result-grid samples."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": { "mode": { "enum": ["one", "all"] }, "scenarioId": { "type": "string" } }, "required": ["mode"] })
    }

    fn execute(&self, _call_id: &str, arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        let state = context.bound_state()?;
        let Some(runner) = &context.scenario_runner else { return Err("Scenario runs are unavailable because the view is not connected.".into()) };
        let mode = arguments["mode"].as_str().unwrap_or("all");
        let scenario_id = arguments["scenarioId"].as_str().filter(|id| !id.is_empty());
        if mode == "one" && scenario_id.is_none() {
            return Err("A Scenario id is required to run one Scenario.".into());
        }
        let scenarios: Vec<Value> = if mode == "one" { state.scenarios.iter().filter(|scenario| Some(scenario["id"].as_str().unwrap_or("")) == scenario_id).cloned().collect() } else { state.scenarios.clone() };
        if mode == "one" && scenarios.is_empty() {
            return Err("That Scenario does not exist in the bound project.".into());
        }
        let (project_id, design_id) = context.target.clone();
        let details = |runs: Vec<Value>| json!({ "projectId": project_id, "designId": design_id, "mode": mode, "runs": runs });
        if mode == "all" && scenarios.is_empty() {
            let result = details(vec![]);
            return Ok(ToolResult { content: vec![result.to_string()], details: result, is_error: false });
        }
        let abort: Arc<AtomicBool> = context.abort.clone();
        let aborted = || abort.load(Ordering::SeqCst);
        let mut stopped: Vec<Value> = Vec::new();
        let mut results: Vec<(Value, Value)> = Vec::new();
        for scenario in &scenarios {
            if !self.on_target() {
                break;
            }
            self.require_target("The project or Design changed before the Scenario run started.")?;
            let outcome = runner.run(&project_id, &design_id, scenario, &aborted, SCENARIO_RUN_TIMEOUT);
            let run = match outcome {
                Ok(run) => {
                    self.require_target("The project or Design changed while the Scenario run was in progress.")?;
                    if run.is_none() && aborted() {
                        stopped.push(scenario.clone());
                    }
                    run
                }
                Err(error) => {
                    if !aborted() {
                        return Err(error);
                    }
                    stopped.push(scenario.clone());
                    None
                }
            };
            if !self.on_target() {
                break;
            }
            let Some(run) = run else { break };
            let ends = run["status"] == "running" || (run["status"] == "errored" && run["reason"] == "stopped");
            results.push((scenario.clone(), run));
            if ends {
                break;
            }
        }
        self.require_target("The project or Design changed while the Scenario run was in progress.")?;
        let mut runs: Vec<Value> = results.iter().map(|(scenario, run)| compact_scenario_run(scenario["id"].as_str().unwrap_or(""), scenario["name"].as_str().unwrap_or(""), run)).collect();
        if let Some(scenario) = stopped.first() {
            runs.push(json!({ "scenario": scenario["name"], "scenarioId": scenario["id"], "status": "stopped", "reason": "stopped" }));
        }
        let result = details(runs);
        Ok(ToolResult { content: vec![result.to_string()], details: result, is_error: false })
    }
}
