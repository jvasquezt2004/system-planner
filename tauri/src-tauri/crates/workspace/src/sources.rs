//! Scenarios and Edge functions: saved TypeScript source scoped to one database design. Each edit
//! is one Project-history action and saves the design's whole list (`updateScenarios`,
//! `updateEdgeFunctions` and their handlers in `src/bun/workspace.ts`).

use schema_domain::js;
use schema_store::{ScenarioSave, StoredSource};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::history::HistoryAction;
use crate::state::{saved, saving};
use crate::{Result, Workspace, WorkspaceState};

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Scenario,
    EdgeFunction,
}

const DEFAULT_EDGE_FUNCTION_SOURCE: &str = "Deno.serve(async (_request) => new Response(\"OK\"));";

/// Edge function names become URL paths.
fn require_edge_function_name(value: &str) -> Result<String> {
    let name = js::trim(value);
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-') {
        return Err("Edge function names must use lowercase letters, digits, hyphens, or underscores.".into());
    }
    Ok(name.to_owned())
}

fn field<'a>(item: &'a Value, key: &str) -> &'a str {
    item.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn with_field(items: &[Value], id: &str, key: &str, value: &str) -> Vec<Value> {
    items
        .iter()
        .map(|item| {
            let mut item = item.clone();
            if field(&item, "id") == id {
                item[key] = json!(value);
            }
            item
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceAction {
    pub design_id: String,
    pub name: Option<String>,
    pub scenario_id: Option<String>,
    pub edge_function_id: Option<String>,
    pub source: Option<String>,
    pub assistant_turn_id: Option<String>,
}

impl SourceAction {
    fn id(&self, kind: Kind) -> &str {
        match kind {
            Kind::Scenario => self.scenario_id.as_deref(),
            Kind::EdgeFunction => self.edge_function_id.as_deref(),
        }
        .unwrap_or_default()
    }
}

impl Workspace {
    /// Applies one edit to a design's Scenarios or Edge functions: record it, then save the list.
    fn update_sources(&self, kind: Kind, design_id: &str, mut action: HistoryAction, assistant_turn_id: &Option<String>, update: impl FnOnce(&[Value]) -> Vec<Value>) -> Result<WorkspaceState> {
        let mut inner = self.lock();
        let (project_id, design, design_id) = self.require_open_design(&inner, design_id)?;
        let current = if kind == Kind::Scenario { inner.state.scenarios.clone() } else { inner.state.edge_functions.clone() };
        let next = update(&current);
        action.assistant_turn_id = assistant_turn_id.clone();
        let mut before = self.project_content(&inner, &design, None, None, &inner.key_orders);
        let mut after = before.clone();
        if kind == Kind::Scenario {
            after.scenarios = next.clone();
        } else {
            after.edge_functions = next.clone();
        }
        before.key_orders = inner.key_orders.clone();
        self.record_content_change(&mut inner, &action, before, after, false);

        let revision = if kind == Kind::Scenario {
            inner.scenario_revision += 1;
            inner.scenario_revision
        } else {
            inner.edge_function_revision += 1;
            inner.edge_function_revision
        };
        self.update(&mut inner, |state| {
            if kind == Kind::Scenario {
                state.scenarios = next.clone();
                state.scenario_save = saving(revision, &design_id);
            } else {
                state.edge_functions = next.clone();
                state.edge_function_save = saving(revision, &design_id);
            }
        });
        let saved_at = self.now();
        let outcome = serde_json::from_value::<Vec<StoredSource>>(Value::Array(next.clone()))
            .map_err(|error| error.to_string())
            .and_then(|items| {
                let save = ScenarioSave { revision, saved_at };
                match kind {
                    Kind::Scenario => inner.store.save_scenarios(&project_id, &items, save, &design_id),
                    Kind::EdgeFunction => inner.store.save_edge_functions(&project_id, &items, save, &design_id),
                }
                .map_err(|error| error.to_string())
            });
        let latest = if kind == Kind::Scenario { inner.scenario_revision } else { inner.edge_function_revision } == revision;
        if inner.active_project_id.as_deref() == Some(project_id.as_str()) && inner.active_design_id.as_deref() == Some(design_id.as_str()) && latest {
            let projects = inner.store.list_projects().unwrap_or_default();
            self.update(&mut inner, |state| {
                let status = match &outcome {
                    Ok(()) => saved(revision, saved_at, &design_id),
                    Err(error) => json!({ "status": "failed", "revision": revision, "error": error, "designId": design_id }),
                };
                if outcome.is_ok() {
                    state.projects = projects;
                }
                if kind == Kind::Scenario {
                    state.scenario_save = status;
                } else {
                    state.edge_function_save = status;
                }
            });
        }
        Ok(inner.state.clone())
    }

    pub(crate) fn create_scenario(&self, a: SourceAction) -> Result<WorkspaceState> {
        self.require_open_design(&self.lock(), &a.design_id)?;
        let name = js::trim(a.name.as_deref().unwrap_or_default()).to_owned();
        if name.is_empty() {
            return Err("Scenario name is required.".into());
        }
        let scenario = json!({ "id": self.new_id(), "name": name, "source": "", "designId": a.design_id });
        self.update_sources(Kind::Scenario, &a.design_id, HistoryAction::named(format!("Add scenario “{name}”")), &a.assistant_turn_id, |items| {
            items.iter().cloned().chain([scenario]).collect()
        })
    }

    pub(crate) fn rename_scenario(&self, a: SourceAction) -> Result<WorkspaceState> {
        let current = self.lock().state.scenarios.clone();
        self.require_open_design(&self.lock(), &a.design_id)?;
        let name = js::trim(a.name.as_deref().unwrap_or_default()).to_owned();
        if name.is_empty() {
            return Err("Scenario name is required.".into());
        }
        let Some(scenario) = current.iter().find(|item| field(item, "id") == a.id(Kind::Scenario)) else { return Err("That scenario could not be found.".into()) };
        if field(scenario, "name") == name {
            return Ok(self.state());
        }
        let action = HistoryAction::coalescing(format!("Rename scenario to “{name}”"), format!("scenario-name:{}", field(scenario, "id")));
        let id = a.id(Kind::Scenario).to_owned();
        self.update_sources(Kind::Scenario, &a.design_id, action, &a.assistant_turn_id, |items| with_field(items, &id, "name", &name))
    }

    pub(crate) fn remove_scenario(&self, a: SourceAction) -> Result<WorkspaceState> {
        let current = self.lock().state.scenarios.clone();
        self.require_open_design(&self.lock(), &a.design_id)?;
        let Some(removed) = current.iter().find(|item| field(item, "id") == a.id(Kind::Scenario)) else { return Err("That scenario could not be found.".into()) };
        let action = HistoryAction::named(format!("Remove scenario “{}”", field(removed, "name")));
        let id = a.id(Kind::Scenario).to_owned();
        self.update_sources(Kind::Scenario, &a.design_id, action, &a.assistant_turn_id, |items| items.iter().filter(|item| field(item, "id") != id).cloned().collect())
    }

    pub(crate) fn update_scenario_source(&self, a: SourceAction) -> Result<WorkspaceState> {
        let current = self.lock().state.scenarios.clone();
        self.require_open_design(&self.lock(), &a.design_id)?;
        let Some(scenario) = current.iter().find(|item| field(item, "id") == a.id(Kind::Scenario)) else { return Err("That scenario could not be found.".into()) };
        let source = a.source.clone().unwrap_or_default();
        if field(scenario, "source") == source {
            return Ok(self.state());
        }
        let action = HistoryAction::coalescing(format!("Edit “{}” source", field(scenario, "name")), format!("scenario-source:{}", field(scenario, "id")));
        let id = a.id(Kind::Scenario).to_owned();
        self.update_sources(Kind::Scenario, &a.design_id, action, &a.assistant_turn_id, |items| with_field(items, &id, "source", &source))
    }

    pub(crate) fn create_edge_function(&self, a: SourceAction) -> Result<WorkspaceState> {
        self.require_open_design(&self.lock(), &a.design_id)?;
        let name = require_edge_function_name(a.name.as_deref().unwrap_or_default())?;
        if self.lock().state.edge_functions.iter().any(|item| field(item, "name") == name) {
            return Err(format!("Edge function “{name}” already exists in this project."));
        }
        let edge_function = json!({ "id": self.new_id(), "name": name, "source": DEFAULT_EDGE_FUNCTION_SOURCE, "designId": a.design_id });
        self.update_sources(Kind::EdgeFunction, &a.design_id, HistoryAction::named(format!("Add Edge function “{name}”")), &a.assistant_turn_id, |items| {
            items.iter().cloned().chain([edge_function]).collect()
        })
    }

    pub(crate) fn rename_edge_function(&self, a: SourceAction) -> Result<WorkspaceState> {
        self.require_open_design(&self.lock(), &a.design_id)?;
        let name = require_edge_function_name(a.name.as_deref().unwrap_or_default())?;
        let current = self.lock().state.edge_functions.clone();
        let Some(existing) = current.iter().find(|item| field(item, "id") == a.id(Kind::EdgeFunction)) else { return Err("That Edge function could not be found.".into()) };
        if current.iter().any(|item| field(item, "id") != field(existing, "id") && field(item, "name") == name) {
            return Err(format!("Edge function “{name}” already exists in this project."));
        }
        if field(existing, "name") == name {
            return Ok(self.state());
        }
        let id = a.id(Kind::EdgeFunction).to_owned();
        self.update_sources(Kind::EdgeFunction, &a.design_id, HistoryAction::named(format!("Rename Edge function to “{name}”")), &a.assistant_turn_id, |items| with_field(items, &id, "name", &name))
    }

    pub(crate) fn remove_edge_function(&self, a: SourceAction) -> Result<WorkspaceState> {
        self.require_open_design(&self.lock(), &a.design_id)?;
        let current = self.lock().state.edge_functions.clone();
        let Some(removed) = current.iter().find(|item| field(item, "id") == a.id(Kind::EdgeFunction)) else { return Err("That Edge function could not be found.".into()) };
        let action = HistoryAction::named(format!("Remove Edge function “{}”", field(removed, "name")));
        let id = a.id(Kind::EdgeFunction).to_owned();
        self.update_sources(Kind::EdgeFunction, &a.design_id, action, &a.assistant_turn_id, |items| items.iter().filter(|item| field(item, "id") != id).cloned().collect())
    }

    pub(crate) fn update_edge_function_source(&self, a: SourceAction) -> Result<WorkspaceState> {
        self.require_open_design(&self.lock(), &a.design_id)?;
        let current = self.lock().state.edge_functions.clone();
        let Some(edge_function) = current.iter().find(|item| field(item, "id") == a.id(Kind::EdgeFunction)) else { return Err("That Edge function could not be found.".into()) };
        let source = a.source.clone().unwrap_or_default();
        if field(edge_function, "source") == source {
            return Ok(self.state());
        }
        let action = HistoryAction::coalescing(format!("Edit “{}” handler", field(edge_function, "name")), format!("edge-function-source:{}", field(edge_function, "id")));
        let id = a.id(Kind::EdgeFunction).to_owned();
        self.update_sources(Kind::EdgeFunction, &a.design_id, action, &a.assistant_turn_id, |items| with_field(items, &id, "source", &source))
    }
}
