//! The Project history behind Undo and Redo (`recordContentChange`, `applyHistoryChange` and
//! `applyProjectContent` in `src/bun/workspace.ts`).
//!
//! One content history is kept per database design, for the session. Each entry holds the content
//! of the Project before and after one named action: the Design, Scenarios, Edge functions, the
//! System design's content and the Walkthroughs. Undo and Redo restore one side of an entry and
//! save whatever differs.

use schema_domain::design::Design;
use schema_domain::geometry::DEFAULT_VIEWPORT;
use schema_domain::project_history::{
    describe_project_history, record_project_change, step_project_history, Direction, ProjectHistoryChange, ProjectHistoryDescription, Snapshot,
};
use schema_domain::system_design::{SystemComponent, SystemConnection, SystemDesign, SystemGroup, SystemService};
use schema_domain::walkthrough::Walkthrough;
use schema_store::{DesignSave, DesignWrite, EdgeFunctionsWrite, ProjectArtifacts, ScenarioSave, ScenariosWrite, SystemDesignWrite, WalkthroughsWrite};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::state::{last_applied_sandbox, saved, saving};
use crate::system::KeyOrders;
use crate::{Inner, Result, Workspace, WorkspaceState};

pub(crate) const ASSISTANT_TURN_ACTION_NAME: &str = "Assistant turn";
pub(crate) use ASSISTANT_TURN_ACTION_NAME as ASSISTANT_TURN_ASSISTANT_NAME;

/// How one content change is named, grouped, and attributed in the Project history.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HistoryAction {
    pub name: String,
    /// Edits with the same key in a row merge into one history entry (typing in one field).
    pub coalesce_key: Option<String>,
    pub assistant_turn_id: Option<String>,
}

impl HistoryAction {
    pub(crate) fn named(name: impl Into<String>) -> Self {
        Self { name: name.into(), coalesce_key: None, assistant_turn_id: None }
    }

    pub(crate) fn coalescing(name: impl Into<String>, key: impl Into<String>) -> Self {
        Self { name: name.into(), coalesce_key: Some(key.into()), assistant_turn_id: None }
    }
}

/// The System design content that Undo, Revert and the Assistant change. The viewport, collapsed
/// Services and focus are navigation and presentation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SystemContent {
    pub services: Vec<SystemService>,
    pub groups: Vec<SystemGroup>,
    pub components: Vec<SystemComponent>,
    pub connections: Vec<SystemConnection>,
}

impl SystemContent {
    fn of(design: Option<&SystemDesign>) -> Self {
        match design {
            Some(design) => Self {
                services: design.services.clone(),
                groups: design.groups.clone(),
                components: design.components.clone(),
                connections: design.connections.clone(),
            },
            None => Self { services: vec![], groups: vec![], components: vec![], connections: vec![] },
        }
    }
}

/// `withSystemPresentation`: restored content keeps the open design's viewport; only collapsed
/// Services that still exist stay collapsed, and focus stays only while its Service exists.
fn with_system_presentation(content: SystemContent, presentation: &SystemDesign) -> SystemDesign {
    let has_service = |id: &String| content.services.iter().any(|service| &service.id == id);
    SystemDesign {
        viewport: presentation.viewport,
        collapsed_service_ids: presentation.collapsed_service_ids.iter().filter(|id| has_service(id)).cloned().collect(),
        focused_service_id: presentation.focused_service_id.clone().filter(has_service),
        focus_viewport: presentation.focus_viewport,
        services: content.services,
        groups: content.groups,
        components: content.components,
        connections: content.connections,
    }
}

/// Content that Undo, Redo, and Assistant Revert move together. Snapshots hold a placeholder
/// viewport because navigation is outside content history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectContent {
    pub design: Design,
    pub scenarios: Vec<Value>,
    pub edge_functions: Vec<Value>,
    pub system_design: SystemContent,
    pub walkthroughs: Vec<Walkthrough>,
    /// Optional-key order of the System design's objects, which the original's comparisons see.
    #[serde(skip)]
    pub key_orders: KeyOrders,
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn text<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

impl Snapshot for ProjectContent {
    fn same(&self, other: &Self) -> bool {
        text(self) == text(other)
    }

    fn rebase(manual_before: &Self, manual_after: &Self, base: &Self) -> Self {
        let as_value = |content: &Self| serde_json::to_value(content).unwrap_or(Value::Null);
        let merged = Value::rebase(&as_value(manual_before), &as_value(manual_after), &as_value(base));
        let mut content: Self = serde_json::from_value(merged).unwrap_or_else(|_| base.clone());
        content.key_orders = base.key_orders.clone();
        content
    }
}

impl Workspace {
    /// `projectContent`: the open Project's content, with `system` and `walkthroughs` replaced when given.
    pub(crate) fn project_content(
        &self,
        inner: &Inner,
        design: &Design,
        system: Option<&SystemDesign>,
        walkthroughs: Option<&[Walkthrough]>,
        key_orders: &KeyOrders,
    ) -> ProjectContent {
        ProjectContent {
            design: Design { viewport: DEFAULT_VIEWPORT, ..design.clone() },
            scenarios: inner.state.scenarios.clone(),
            edge_functions: inner.state.edge_functions.clone(),
            system_design: SystemContent::of(system.or(inner.state.system_design.as_ref())),
            walkthroughs: walkthroughs.map_or_else(|| inner.state.walkthroughs.clone(), <[Walkthrough]>::to_vec),
            key_orders: key_orders.clone(),
        }
    }

    /// The single entry point for recording content changes into the open design's history.
    pub(crate) fn record_content_change(&self, inner: &mut Inner, action: &HistoryAction, before: ProjectContent, after: ProjectContent, structural: bool) {
        let Some(design_id) = inner.active_design_id.clone() else { return };
        let recorded_at = self.now();
        let history = inner.histories.entry(design_id).or_default();
        record_project_change(
            history,
            ProjectHistoryChange {
                name: action.name.clone(),
                before,
                after,
                structural,
                assistant_turn_id: action.assistant_turn_id.clone(),
                coalesce_key: action.coalesce_key.clone(),
            },
            recorded_at,
        );
    }

    /// What Undo and Redo would do next, for the state the view reads.
    pub(crate) fn describe_history(inner: &Inner) -> ProjectHistoryDescription {
        let history = match (&inner.state.project, &inner.active_design_id) {
            (Some(_), Some(design_id)) => inner.histories.get(design_id),
            _ => None,
        };
        describe_project_history(history)
    }

    /// Whether the open design's history holds an entry for this Assistant turn.
    pub fn has_assistant_turn(&self, turn_id: &str) -> bool {
        let inner = self.lock();
        inner.active_design_id.as_ref().and_then(|id| inner.histories.get(id)).is_some_and(|history| history.entries.iter().any(|entry| entry.change.assistant_turn_id.as_deref() == Some(turn_id)))
    }

    /// Takes back what an Assistant turn changed: the inverse of the turn's history entry is applied
    /// onto the Project as it is now, merged by identity, so the designer's own later edits stay.
    pub fn revert_assistant_turn(&self, target_design_id: &str, turn_id: &str) -> Result<WorkspaceState> {
        let (project_id, design_id, target, structural) = {
            let mut inner = self.lock();
            let (project_id, design, design_id) = self.require_open_design(&inner, target_design_id)?;
            let entry = inner
                .histories
                .get(&design_id)
                .and_then(|history| history.entries.iter().find(|entry| entry.change.assistant_turn_id.as_deref() == Some(turn_id)))
                .cloned()
                .ok_or("This Assistant turn is no longer available to revert.")?;
            let current = self.project_content(&inner, &design, None, None, &inner.key_orders);
            let target = <ProjectContent as Snapshot>::rebase(&entry.change.after, &entry.change.before, &current);
            if target.same(&current) {
                return Err("This Assistant turn has no changes to revert.".into());
            }
            self.record_content_change(&mut inner, &HistoryAction::named("Revert Assistant turn"), current, target.clone(), entry.change.structural);
            (project_id, design_id, target, entry.change.structural)
        };
        self.apply_project_content(&project_id, &design_id, target, structural)
    }

    pub fn undo(&self, design_id: &str) -> Result<WorkspaceState> {
        self.apply_history_change(Direction::Undo, design_id)
    }

    pub fn redo(&self, design_id: &str) -> Result<WorkspaceState> {
        self.apply_history_change(Direction::Redo, design_id)
    }

    /// Moves the Project history one step and restores that side's content. The cursor only
    /// stays moved when the restored content is saved, so a failed Undo or Redo leaves both the
    /// Project and the history unchanged.
    fn apply_history_change(&self, direction: Direction, target_design_id: &str) -> Result<WorkspaceState> {
        let (project_id, design_id, target, structural, previous_cursor) = {
            let mut inner = self.lock();
            let (project_id, _, design_id) = self.require_open_design(&inner, target_design_id)?;
            let state = inner.state.clone();
            let Some(history) = inner.histories.get_mut(&design_id) else { return Ok(state) };
            let previous_cursor = history.cursor;
            let Some(entry) = step_project_history(history, direction) else { return Ok(state) };
            let target = if direction == Direction::Undo { entry.change.before.clone() } else { entry.change.after.clone() };
            (project_id, design_id, target, entry.change.structural, previous_cursor)
        };
        match self.apply_project_content(&project_id, &design_id, target, structural) {
            Ok(state) => Ok(state),
            Err(error) => {
                let mut inner = self.lock();
                if let Some(history) = inner.histories.get_mut(&design_id) {
                    history.cursor = previous_cursor;
                }
                let state = inner.state.clone();
                self.set_state(&mut inner, state);
                Err(error)
            }
        }
    }

    /// Replaces the design, Scenarios, Edge functions, System design and Walkthroughs with a
    /// history snapshot in one atomic save. Only the parts that differ are written and revised.
    fn apply_project_content(&self, project_id: &str, design_id: &str, target: ProjectContent, structural: bool) -> Result<WorkspaceState> {
        let waiting = {
            let mut inner = self.lock();
            let current = inner.state.clone();
            let Some(current_design) = current.design.clone() else { return Err("Open a project before editing its design.".into()) };
            let design = Design { viewport: current_design.viewport, ..target.design.clone() };
            let content_of = |design: &Design| text(&Design { viewport: DEFAULT_VIEWPORT, ..design.clone() });
            let design_changed = content_of(&current_design) != content_of(&design);
            let scenarios_changed = text(&current.scenarios) != text(&target.scenarios);
            let edge_functions_changed = text(&current.edge_functions) != text(&target.edge_functions);
            let system_changed = current.system_design.is_some()
                && (text(&SystemContent::of(current.system_design.as_ref())) != text(&target.system_design) || inner.key_orders != target.key_orders);
            let walkthroughs_changed = text(&current.walkthroughs) != text(&target.walkthroughs);
            if !design_changed && !scenarios_changed && !edge_functions_changed && !system_changed && !walkthroughs_changed {
                return Ok(current);
            }
            let next_system_design = match (&current.system_design, system_changed) {
                (Some(system), true) => Some(with_system_presentation(target.system_design.clone(), system)),
                _ => current.system_design.clone(),
            };

            let schema_changed = design_changed && structural;
            let previous = (inner.document_revision, inner.scenario_revision, inner.edge_function_revision, inner.system_document_revision, inner.walkthrough_document_revision);
            if system_changed {
                inner.system_document_revision += 1;
            }
            if walkthroughs_changed {
                inner.walkthrough_document_revision += 1;
            }
            let (system_revision, walkthrough_revision) = (inner.system_document_revision, inner.walkthrough_document_revision);
            let saved_at = self.now();
            let next_revision = if schema_changed { current.revision + 1 } else { current.revision };
            if design_changed {
                inner.document_revision += 1;
            }
            if scenarios_changed {
                inner.scenario_revision += 1;
            }
            if edge_functions_changed {
                inner.edge_function_revision += 1;
            }
            let (document_revision, scenario_revision, edge_function_revision) = (inner.document_revision, inner.scenario_revision, inner.edge_function_revision);
            let last_applied = last_applied_sandbox(&current.sandbox);

            let mut next = current.clone();
            if design_changed {
                next.design = Some(design.clone());
            }
            next.revision = next_revision;
            if scenarios_changed {
                next.scenarios = target.scenarios.clone();
            }
            if edge_functions_changed {
                next.edge_functions = target.edge_functions.clone();
            }
            next.system_design = next_system_design.clone();
            if system_changed && next_system_design.is_some() {
                next.system_save = saving(system_revision, design_id);
            }
            if walkthroughs_changed {
                next.walkthroughs = target.walkthroughs.clone();
                next.walkthrough_save = saving(walkthrough_revision, design_id);
            }
            if design_changed {
                next.save = saving(next_revision, design_id);
            }
            if scenarios_changed {
                next.scenario_save = saving(scenario_revision, design_id);
            }
            if edge_functions_changed {
                next.edge_function_save = saving(edge_function_revision, design_id);
            }
            if schema_changed {
                let available = inner.last_generatable_sql.clone();
                next.sql = json!({
                    "status": "checking",
                    "draftRevision": next_revision,
                    "availableRevision": available.as_ref().map(|(revision, _)| *revision),
                    "sql": available.as_ref().map(|(_, sql)| sql),
                    "designId": design_id,
                });
                next.sandbox = match last_applied {
                    None => json!({ "status": "idle" }),
                    Some(applied) => crate::with_status_applied(applied, design_id),
                };
            }
            self.set_state(&mut inner, next);

            let outcome = (|| -> Result<()> {
                let artifacts = ProjectArtifacts {
                    project_id: project_id.to_owned(),
                    design_id: design_id.to_owned(),
                    design: design_changed
                        .then(|| -> Result<DesignWrite> {
                            Ok(DesignWrite { design: to_value(&design), save: DesignSave { revision: next_revision, document_revision, saved_at } })
                        })
                        .transpose()?,
                    scenarios: scenarios_changed
                        .then(|| -> Result<ScenariosWrite> {
                            let scenarios = serde_json::from_value(Value::Array(target.scenarios.clone())).map_err(|error| error.to_string())?;
                            Ok(ScenariosWrite { scenarios, save: ScenarioSave { revision: scenario_revision, saved_at } })
                        })
                        .transpose()?,
                    edge_functions: edge_functions_changed
                        .then(|| -> Result<EdgeFunctionsWrite> {
                            let edge_functions = serde_json::from_value(Value::Array(target.edge_functions.clone())).map_err(|error| error.to_string())?;
                            Ok(EdgeFunctionsWrite { edge_functions, save: ScenarioSave { revision: edge_function_revision, saved_at } })
                        })
                        .transpose()?,
                    system_design: match (&next_system_design, system_changed) {
                        (Some(system), true) => Some(SystemDesignWrite {
                            system_design: to_value(system),
                            save: DesignSave { revision: system_revision, document_revision: system_revision, saved_at },
                        }),
                        _ => None,
                    },
                    walkthroughs: walkthroughs_changed.then(|| WalkthroughsWrite {
                        walkthroughs: to_value(&target.walkthroughs),
                        save: ScenarioSave { revision: walkthrough_revision, saved_at },
                    }),
                };
                inner.store.save_project_artifacts(&artifacts).map_err(|error| error.to_string())
            })();
            if let Err(error) = outcome {
                inner.document_revision = previous.0;
                inner.scenario_revision = previous.1;
                inner.edge_function_revision = previous.2;
                inner.system_document_revision = previous.3;
                inner.walkthrough_document_revision = previous.4;
                if inner.active_design_id.as_deref() == Some(design_id) {
                    self.set_state(&mut inner, current);
                }
                return Err(error);
            }
            if system_changed {
                inner.key_orders = target.key_orders.clone();
            }
            let latest = inner.document_revision == document_revision
                && inner.scenario_revision == scenario_revision
                && inner.edge_function_revision == edge_function_revision
                && inner.system_document_revision == system_revision
                && inner.walkthrough_document_revision == walkthrough_revision;
            if latest && inner.state.project.as_ref().map(|project| project.id.as_str()) == Some(project_id) && inner.active_design_id.as_deref() == Some(design_id) {
                let projects = inner.store.list_projects().unwrap_or_default();
                self.update(&mut inner, |state| {
                    state.projects = projects;
                    if design_changed {
                        state.save = saved(next_revision, saved_at, design_id);
                    }
                    if scenarios_changed {
                        state.scenario_save = saved(scenario_revision, saved_at, design_id);
                    }
                    if edge_functions_changed {
                        state.edge_function_save = saved(edge_function_revision, saved_at, design_id);
                    }
                    if system_changed {
                        state.system_save = saved(system_revision, saved_at, design_id);
                    }
                    if walkthroughs_changed {
                        state.walkthrough_save = saved(walkthrough_revision, saved_at, design_id);
                    }
                });
            }
            let waiting = schema_changed.then(|| self.schedule_preview(&mut inner, project_id, next_revision, design.clone(), design_id));
            waiting
        };
        if let Some(waiting) = waiting {
            let _ = waiting.recv();
        }
        Ok(self.state())
    }
}
