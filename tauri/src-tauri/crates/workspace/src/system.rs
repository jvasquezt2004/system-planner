//! System design and Walkthrough handlers, and the design-management calls the System
//! overview depends on (linking a Database component creates and opens designs).
//!
//! Each handler validates through the ported operations in `schema-domain`, names its
//! history action as the original does, and persists the whole document. A change that
//! leaves the content as it was is not saved and not recorded.

use schema_domain::design::Design;
use schema_domain::geometry::{CanvasPoint, CanvasViewport, DEFAULT_VIEWPORT, Size};
use schema_domain::patch::Patch;
use schema_domain::system_design::{SystemComponent, SystemDesign, SystemGroup};
use schema_domain::system_ops::*;
use schema_domain::walkthrough::Walkthrough;
use schema_domain::walkthrough_ops::{self as walkthrough_ops, BlockInput, SequenceRef, StepDraft, StepInput, WalkthroughInput};
use schema_store::{DatabaseDesignSummary, DesignSave, ScenarioSave};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::{saved, saving};
use crate::{edits, require_open_project, to_json, Inner, Result, Workspace, WorkspaceState};

const ASSISTANT_TURN_ACTION_NAME: &str = "Assistant turn";

/// How one content change is named, grouped, and attributed in the Project history.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct HistoryAction {
    pub name: String,
    /// Edits with the same key in a row merge into one history entry (typing in one field).
    pub coalesce_key: Option<String>,
    pub assistant_turn_id: Option<String>,
}

impl HistoryAction {
    fn named(name: impl Into<String>) -> Self {
        Self { name: name.into(), coalesce_key: None, assistant_turn_id: None }
    }

    fn coalescing(name: impl Into<String>, key: impl Into<String>) -> Self {
        Self { name: name.into(), coalesce_key: Some(key.into()), assistant_turn_id: None }
    }
}

/// An Assistant-attributed change joins its turn's single history action.
fn attributed(turn: &Option<String>, action: HistoryAction) -> HistoryAction {
    match turn {
        None => action,
        Some(id) => HistoryAction { name: ASSISTANT_TURN_ACTION_NAME.into(), coalesce_key: None, assistant_turn_id: Some(id.clone()) },
    }
}

/// The System design content that Undo, Revert and the Assistant change. The viewport, collapsed
/// Services and focus are navigation and presentation.
fn same_content(a: &SystemDesign, b: &SystemDesign) -> bool {
    a.services == b.services && a.groups == b.groups && a.components == b.components && a.connections == b.connections
}

fn name_group_edit(design: &SystemDesign, before: &SystemGroup, after: &SystemGroup) -> HistoryAction {
    if after.name != before.name {
        return HistoryAction::named(format!("Rename group to “{}”", after.name));
    }
    let added: Vec<&String> = after.member_ids.iter().filter(|id| !before.member_ids.contains(id)).collect();
    let removed: Vec<&String> = before.member_ids.iter().filter(|id| !after.member_ids.contains(id)).collect();
    let label = |id: &str| {
        find_component(design, id)
            .map(|item| item.name.clone())
            .or_else(|| find_service(design, id).map(|item| item.name.clone()))
            .or_else(|| find_group(design, id).map(|item| item.name.clone()))
            .unwrap_or_else(|| id.to_owned())
    };
    if added.len() == 1 && removed.is_empty() {
        return HistoryAction::named(format!("Add “{}” to “{}”", label(added[0]), after.name));
    }
    if removed.len() == 1 && added.is_empty() {
        return HistoryAction::named(format!("Remove “{}” from “{}”", label(removed[0]), after.name));
    }
    HistoryAction::named(format!("Edit members of “{}”", after.name))
}

fn require_database_component<'a>(design: &'a SystemDesign, component_id: &str) -> Result<&'a SystemComponent> {
    let component = find_component(design, component_id).ok_or("That Component could not be found.")?;
    if component.kind != "database" {
        return Err("Only a Database component can link to a database design.".into());
    }
    Ok(component)
}

/// A design with no content yet.
fn empty_design() -> Design {
    Design {
        tables: vec![],
        relationships: vec![],
        many_to_many_relationships: vec![],
        viewport: DEFAULT_VIEWPORT,
        enum_types: None,
        functions: None,
        triggers: None,
        raw_statements: None,
    }
}

/// "Design 2", "Design 3", ...: the first such name not already in use.
fn next_default_design_name(existing: &[DatabaseDesignSummary]) -> String {
    let taken: Vec<String> = existing.iter().map(|design| schema_domain::js::trim(&design.name).to_lowercase()).collect();
    (existing.len() + 1..).map(|number| format!("Design {number}")).find(|name| !taken.contains(&name.to_lowercase())).expect("unbounded")
}

/// A design name is trimmed, non-empty, and unique within its Project, ignoring case.
fn require_design_name(value: &str, others: &[&DatabaseDesignSummary]) -> Result<String> {
    let name = schema_domain::js::trim(value);
    if name.is_empty() {
        return Err("Design name is required.".into());
    }
    if others.iter().any(|design| schema_domain::js::trim(&design.name).to_lowercase() == name.to_lowercase()) {
        return Err(format!("A design named “{name}” already exists in this project."));
    }
    Ok(name.to_owned())
}

/* ---------------------------------------------------------------- actions */

macro_rules! action {
    ($(#[$meta:meta])* $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Deserialize)]
        #[serde(rename_all = "camelCase")]
        pub(crate) struct $name { $($(#[$fmeta])* pub $field: $ty,)* #[serde(default)] pub assistant_turn_id: Option<String> }
    };
}

action!(AddSystemService { id: Option<String>, name: Option<String>, x: f64, y: f64 });
action!(UpdateSystemService { service_id: String, changes: ServiceChanges });
action!(MoveSystemService { service_id: String, x: f64, y: f64 });
action!(ResizeSystemService { service_id: String, width: f64, height: f64 });
action!(RemoveSystemService { service_id: String });
action!(AddSystemGroup { id: Option<String>, name: Option<String>, x: f64, y: f64, width: Option<f64>, height: Option<f64>, member_ids: Option<Vec<String>> });
action!(UpdateSystemGroup { group_id: String, changes: GroupChanges });
action!(MoveSystemGroup { group_id: String, x: f64, y: f64 });
action!(ResizeSystemGroup { group_id: String, width: f64, height: f64 });
action!(RemoveSystemGroup { group_id: String });
action!(AddSystemComponent {
    id: Option<String>,
    kind: Option<String>,
    name: Option<String>,
    technology: Option<String>,
    description: Option<String>,
    properties: Option<Vec<Value>>,
    design_id: Option<String>,
    icon: Option<String>,
    service_id: Option<String>,
    x: f64,
    y: f64,
});
action!(UpdateSystemComponent { component_id: String, changes: ComponentChanges });
action!(MoveSystemComponent { component_id: String, x: f64, y: f64 });
action!(RemoveSystemComponent { component_id: String });
action!(AddSystemConnection {
    id: Option<String>,
    source_id: String,
    target_id: String,
    label: Option<String>,
    interaction_type: Option<String>,
    protocol: Option<String>,
});
action!(UpdateSystemConnection { connection_id: String, changes: ConnectionChanges });
action!(RemoveSystemConnection { connection_id: String });

/// Walkthrough adds accept a client-chosen id so the view can select what it creates.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddWalkthroughStep {
    pub id: Option<String>,
    pub walkthrough_id: String,
    pub connection_id: String,
    pub sequence: Option<SequenceRef>,
    #[serde(flatten)]
    pub draft: StepDraft,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddWalkthroughBlock {
    pub id: Option<String>,
    pub walkthrough_id: String,
    pub kind: String,
    pub sequence: Option<SequenceRef>,
}

impl Workspace {
    /// Where the Project's history is recorded. Undo and Redo are not ported yet, so this only
    /// carries the action the original would have recorded; every handler already names it.
    fn record_history(&self, _inner: &mut Inner, _action: &HistoryAction) {}

    /* --------------------------------------------------------- persistence */

    /// Applies one System design change: validate it, record it as one history action, then save
    /// the whole document. A failed save keeps the draft and shows the error.
    fn apply_system_design_change(&self, mutate: impl FnOnce(&SystemDesign) -> Result<(SystemDesign, HistoryAction)>) -> Result<WorkspaceState> {
        let mut inner = self.lock();
        let (project_id, design_id) = require_open_project(&inner)?;
        let current = inner.state.system_design.clone().ok_or("Open a project before editing its System design.")?;
        let (next, action) = mutate(&current)?;
        if same_content(&next, &current) {
            return Ok(inner.state.clone());
        }
        self.record_history(&mut inner, &action);
        Ok(self.persist_system_design(&mut inner, &project_id, &design_id, next))
    }

    fn persist_system_design(&self, inner: &mut Inner, project_id: &str, design_id: &str, next: SystemDesign) -> WorkspaceState {
        inner.system_document_revision += 1;
        let revision = inner.system_document_revision;
        let saved_at = self.now();
        self.update(inner, |state| {
            state.system_design = Some(next.clone());
            state.system_save = saving(revision, design_id);
        });
        let outcome = to_json(&next).and_then(|document| {
            inner
                .store
                .save_system_design(project_id, &document, DesignSave { revision, document_revision: revision, saved_at })
                .map_err(|error| error.to_string())
        });
        let current = inner.active_project_id.as_deref() == Some(project_id) && inner.system_document_revision == revision;
        if current {
            self.update(inner, |state| {
                state.system_save = match &outcome {
                    Ok(()) => saved(revision, saved_at, design_id),
                    Err(error) => json!({ "status": "failed", "revision": revision, "error": error, "designId": design_id }),
                };
            });
        }
        inner.state.clone()
    }

    /// Applies one Walkthrough change, as above, saving the whole Walkthrough document.
    fn apply_walkthrough_change(
        &self,
        mutate: impl FnOnce(&[Walkthrough], &SystemDesign) -> Result<(Vec<Walkthrough>, HistoryAction)>,
    ) -> Result<WorkspaceState> {
        let mut inner = self.lock();
        let (project_id, design_id) = require_open_project(&inner)?;
        let current = inner.state.walkthroughs.clone();
        let system = inner.state.system_design.clone().ok_or("Open a project before editing its System design.")?;
        let (next, action) = mutate(&current, &system)?;
        if next == current {
            return Ok(inner.state.clone());
        }
        self.record_history(&mut inner, &action);
        inner.walkthrough_document_revision += 1;
        let revision = inner.walkthrough_document_revision;
        let saved_at = self.now();
        self.update(&mut inner, |state| {
            state.walkthroughs = next.clone();
            state.walkthrough_save = saving(revision, &design_id);
        });
        let outcome = to_json(&next).and_then(|document| {
            inner.store.save_walkthroughs(&project_id, &document, ScenarioSave { revision, saved_at }).map_err(|error| error.to_string())
        });
        if inner.active_project_id.as_deref() == Some(project_id.as_str()) && inner.walkthrough_document_revision == revision {
            self.update(&mut inner, |state| {
                state.walkthrough_save = match &outcome {
                    Ok(()) => saved(revision, saved_at, &design_id),
                    Err(error) => json!({ "status": "failed", "revision": revision, "error": error, "designId": design_id }),
                };
            });
        }
        Ok(inner.state.clone())
    }

    /* ------------------------------------------------------------ Services */

    pub(crate) fn add_system_service(&self, a: AddSystemService) -> Result<WorkspaceState> {
        let id = a.id.clone().unwrap_or_else(|| self.new_id());
        self.apply_system_design_change(|design| {
            let input = ServiceInput { id: id.clone(), name: a.name.clone(), position: CanvasPoint { x: a.x, y: a.y }, size: None };
            let next = add_service(design, &input)?;
            let added = find_service(&next, &id).ok_or("That Service could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Add service “{}”", added.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn update_system_service(&self, a: UpdateSystemService) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = update_service(design, &a.service_id, &a.changes)?;
            let after = find_service(&next, &a.service_id).ok_or("That Service could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Rename service to “{}”", after.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn move_system_service(&self, a: MoveSystemService) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = move_service(design, &a.service_id, CanvasPoint { x: a.x, y: a.y })?;
            let moved = find_service(&next, &a.service_id).ok_or("That Service could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Move service “{}”", moved.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn resize_system_service(&self, a: ResizeSystemService) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = resize_service(design, &a.service_id, Size { width: a.width, height: a.height })?;
            let resized = find_service(&next, &a.service_id).ok_or("That Service could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Resize service “{}”", resized.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn remove_system_service(&self, a: RemoveSystemService) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let removed = find_service(design, &a.service_id).ok_or("That Service could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Remove service “{}”", removed.name)));
            Ok((remove_service(design, &a.service_id)?, action))
        })
    }

    /// Collapsing is presentation only: saved, but outside Project history.
    pub fn set_system_service_collapsed(&self, service_id: &str, collapsed: bool) -> Result<WorkspaceState> {
        self.change_presentation(|current| set_service_collapsed(current, service_id, collapsed))
    }

    pub fn set_system_focus(&self, service_id: Option<&str>, viewport: Option<CanvasViewport>) -> Result<WorkspaceState> {
        let viewport = match viewport {
            None => None,
            Some(viewport) => Some(CanvasViewport {
                x: edits::require_number(viewport.x, "Canvas position")?,
                y: edits::require_number(viewport.y, "Canvas position")?,
                zoom: edits::require_number(viewport.zoom, "Canvas zoom")?.clamp(0.3, 2.5),
            }),
        };
        self.change_presentation(|current| set_focus(current, service_id, viewport))
    }

    pub fn set_system_viewport(&self, x: f64, y: f64, zoom: f64) -> Result<WorkspaceState> {
        let viewport = CanvasViewport {
            x: edits::require_number(x, "Canvas position")?,
            y: edits::require_number(y, "Canvas position")?,
            zoom: edits::require_number(zoom, "Canvas zoom")?.clamp(0.3, 2.5),
        };
        self.change_presentation(|current| Ok(SystemDesign { viewport, ..current.clone() }))
    }

    fn change_presentation(&self, change: impl FnOnce(&SystemDesign) -> Result<SystemDesign>) -> Result<WorkspaceState> {
        let mut inner = self.lock();
        let (project_id, design_id) = require_open_project(&inner)?;
        let current = inner.state.system_design.clone().ok_or("Open a project before editing its System design.")?;
        let next = change(&current)?;
        if next == current {
            return Ok(inner.state.clone());
        }
        Ok(self.persist_system_design(&mut inner, &project_id, &design_id, next))
    }

    /// What removing the Walkthrough steps' Connections leaves dangling, across the Project's Walkthroughs.
    fn removal_impact(&self, connection_ids: &[String]) -> Value {
        let steps = walkthrough_ops::steps_on_connections(&self.lock().state.walkthroughs, connection_ids);
        json!(steps)
    }

    fn describe_removal(&self, plan: Value, connection_ids: &[String]) -> Result<Value> {
        let mut plan = plan;
        plan["walkthroughSteps"] = self.removal_impact(connection_ids);
        Ok(plan)
    }

    fn open_system_design(&self) -> Result<SystemDesign> {
        let inner = self.lock();
        require_open_project(&inner)?;
        inner.state.system_design.clone().ok_or_else(|| "Open a project before editing its System design.".to_owned())
    }

    pub fn describe_system_service_removal(&self, service_id: &str) -> Result<Value> {
        let plan = describe_service_removal(&self.open_system_design()?, service_id)?;
        let ids: Vec<String> = plan.connections.iter().map(|connection| connection.id.clone()).collect();
        self.describe_removal(to_json(&plan)?, &ids)
    }

    pub fn describe_system_component_removal(&self, component_id: &str) -> Result<Value> {
        let plan = describe_component_removal(&self.open_system_design()?, component_id)?;
        let ids: Vec<String> = plan.connections.iter().map(|connection| connection.id.clone()).collect();
        self.describe_removal(to_json(&plan)?, &ids)
    }

    pub fn describe_system_connection_removal(&self, connection_id: &str) -> Result<Value> {
        let plan = describe_connection_removal(&self.open_system_design()?, connection_id)?;
        self.describe_removal(to_json(&plan)?, &[connection_id.to_owned()])
    }

    /* -------------------------------------------------------------- Groups */

    pub(crate) fn add_system_group(&self, a: AddSystemGroup) -> Result<WorkspaceState> {
        let id = a.id.clone().unwrap_or_else(|| self.new_id());
        self.apply_system_design_change(|design| {
            let size = match (a.width, a.height) {
                (Some(width), Some(height)) => Some(Size { width, height }),
                _ => None,
            };
            let input = GroupInput { id: id.clone(), name: a.name.clone(), position: CanvasPoint { x: a.x, y: a.y }, size, member_ids: a.member_ids.clone() };
            let next = add_group(design, &input)?;
            let added = find_group(&next, &id).ok_or("That Group could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Add group “{}”", added.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn update_system_group(&self, a: UpdateSystemGroup) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let before = find_group(design, &a.group_id);
            let next = update_group(design, &a.group_id, &a.changes)?;
            let after = find_group(&next, &a.group_id);
            let (Some(before), Some(after)) = (before, after) else { return Err("That Group could not be found.".into()) };
            let action = attributed(&a.assistant_turn_id, name_group_edit(design, before, after));
            Ok((next.clone(), action))
        })
    }

    pub(crate) fn move_system_group(&self, a: MoveSystemGroup) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = move_group(design, &a.group_id, CanvasPoint { x: a.x, y: a.y })?;
            let moved = find_group(&next, &a.group_id).ok_or("That Group could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Move group “{}”", moved.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn resize_system_group(&self, a: ResizeSystemGroup) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = resize_group(design, &a.group_id, Size { width: a.width, height: a.height })?;
            let resized = find_group(&next, &a.group_id).ok_or("That Group could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Resize group “{}”", resized.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn remove_system_group(&self, a: RemoveSystemGroup) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let removed = find_group(design, &a.group_id).ok_or("That Group could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Remove group “{}”", removed.name)));
            Ok((remove_group(design, &a.group_id)?, action))
        })
    }

    /* ---------------------------------------------------------- Components */

    pub(crate) fn add_system_component(&self, a: AddSystemComponent) -> Result<WorkspaceState> {
        let id = a.id.clone().unwrap_or_else(|| self.new_id());
        self.apply_system_design_change(|design| {
            let input = ComponentInput {
                id: id.clone(),
                kind: a.kind.clone(),
                name: a.name.clone(),
                technology: a.technology.clone(),
                description: a.description.clone(),
                properties: a.properties.clone(),
                position: CanvasPoint { x: a.x, y: a.y },
                design_id: a.design_id.clone(),
                icon: a.icon.clone(),
                service_id: a.service_id.clone(),
            };
            let next = add_component(design, &input)?;
            let added = find_component(&next, &id).ok_or("That Component could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Add component “{}”", added.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn update_system_component(&self, a: UpdateSystemComponent) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let before = find_component(design, &a.component_id);
            let next = update_component(design, &a.component_id, &a.changes)?;
            let after = find_component(&next, &a.component_id);
            let (Some(before), Some(after)) = (before, after) else { return Err("That Component could not be found.".into()) };
            let action = if after.service_id != before.service_id {
                match after.service_id.as_deref().and_then(|id| find_service(&next, id)) {
                    Some(owner) => HistoryAction::named(format!("Assign “{}” to “{}”", after.name, owner.name)),
                    None => HistoryAction::named(format!("Release “{}” to system scope", after.name)),
                }
            } else if after.name != before.name {
                HistoryAction::named(format!("Rename component to “{}”", after.name))
            } else {
                HistoryAction::coalescing(format!("Edit component “{}”", after.name), format!("system-component:{}", a.component_id))
            };
            Ok((next.clone(), attributed(&a.assistant_turn_id, action)))
        })
    }

    pub(crate) fn move_system_component(&self, a: MoveSystemComponent) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = move_component(design, &a.component_id, CanvasPoint { x: a.x, y: a.y })?;
            let moved = find_component(&next, &a.component_id).ok_or("That Component could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Move “{}”", moved.name)));
            Ok((next, action))
        })
    }

    pub(crate) fn remove_system_component(&self, a: RemoveSystemComponent) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let removed = find_component(design, &a.component_id).ok_or("That Component could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Remove component “{}”", removed.name)));
            Ok((remove_component(design, &a.component_id)?, action))
        })
    }

    /* --------------------------------------------------------- Connections */

    pub(crate) fn add_system_connection(&self, a: AddSystemConnection) -> Result<WorkspaceState> {
        let id = a.id.clone().unwrap_or_else(|| self.new_id());
        self.apply_system_design_change(|design| {
            let input = ConnectionInput {
                id: id.clone(),
                source_id: a.source_id.clone(),
                target_id: a.target_id.clone(),
                label: a.label.clone(),
                interaction_type: a.interaction_type.clone(),
                protocol: a.protocol.clone(),
            };
            let next = add_connection(design, &input)?;
            let added = find_connection(&next, &id).ok_or("That Connection could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Add connection “{}”", added.label)));
            Ok((next, action))
        })
    }

    pub(crate) fn update_system_connection(&self, a: UpdateSystemConnection) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let next = update_connection(design, &a.connection_id, &a.changes)?;
            let after = find_connection(&next, &a.connection_id).ok_or("That Connection could not be found.")?;
            // A route edit is one completed gesture, so it is never merged with a later edit to the same Connection.
            let action = if has_route_change(&a.changes) {
                HistoryAction::named(format!("Reroute connection “{}”", after.label))
            } else {
                HistoryAction::coalescing(format!("Edit connection “{}”", after.label), format!("system-connection:{}", a.connection_id))
            };
            Ok((next.clone(), attributed(&a.assistant_turn_id, action)))
        })
    }

    pub(crate) fn remove_system_connection(&self, a: RemoveSystemConnection) -> Result<WorkspaceState> {
        self.apply_system_design_change(|design| {
            let removed = find_connection(design, &a.connection_id).ok_or("That Connection could not be found.")?;
            let action = attributed(&a.assistant_turn_id, HistoryAction::named(format!("Remove connection “{}”", removed.label)));
            Ok((remove_connection(design, &a.connection_id)?, action))
        })
    }

    /* ------------------------------------------------------- Walkthroughs */

    pub fn create_walkthrough(&self, id: Option<String>, name: Option<String>) -> Result<WorkspaceState> {
        let id = id.unwrap_or_else(|| self.new_id());
        self.apply_walkthrough_change(|walkthroughs, _| {
            let next = walkthrough_ops::add_walkthrough(walkthroughs, &WalkthroughInput { id: id.clone(), name })?;
            let added = walkthrough_ops::find_walkthrough(&next, &id).ok_or("That Walkthrough could not be found.")?;
            Ok((next.clone(), HistoryAction::named(format!("Add walkthrough “{}”", added.name))))
        })
    }

    pub fn rename_walkthrough(&self, walkthrough_id: &str, name: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let next = walkthrough_ops::rename_walkthrough(walkthroughs, walkthrough_id, name)?;
            let renamed = walkthrough_ops::find_walkthrough(&next, walkthrough_id).ok_or("That Walkthrough could not be found.")?;
            Ok((next.clone(), HistoryAction::named(format!("Rename walkthrough to “{}”", renamed.name))))
        })
    }

    pub fn remove_walkthrough(&self, walkthrough_id: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let removed = walkthrough_ops::find_walkthrough(walkthroughs, walkthrough_id).ok_or("That Walkthrough could not be found.")?;
            let action = HistoryAction::named(format!("Remove walkthrough “{}”", removed.name));
            Ok((walkthrough_ops::remove_walkthrough(walkthroughs, walkthrough_id)?, action))
        })
    }

    pub fn move_walkthrough(&self, walkthrough_id: &str, to_index: f64) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let next = walkthrough_ops::move_walkthrough(walkthroughs, walkthrough_id, to_index)?;
            let moved = walkthrough_ops::find_walkthrough(&next, walkthrough_id).ok_or("That Walkthrough could not be found.")?;
            Ok((next.clone(), HistoryAction::named(format!("Move walkthrough “{}”", moved.name))))
        })
    }

    fn find_step<'a>(walkthroughs: &'a [Walkthrough], walkthrough_id: &str, step_id: &str) -> Option<&'a schema_domain::walkthrough::WalkthroughStep> {
        walkthrough_ops::find_walkthrough(walkthroughs, walkthrough_id)
            .and_then(|walkthrough| walkthrough_ops::walkthrough_steps(walkthrough).into_iter().find(|step| step.id == step_id))
    }

    pub(crate) fn add_walkthrough_step(&self, a: AddWalkthroughStep) -> Result<WorkspaceState> {
        let id = a.id.clone().unwrap_or_else(|| self.new_id());
        self.apply_walkthrough_change(|walkthroughs, system| {
            let input = StepInput { id: id.clone(), connection_id: a.connection_id.clone(), sequence: a.sequence.clone(), draft: a.draft.clone() };
            let next = walkthrough_ops::add_step(walkthroughs, &a.walkthrough_id, &input, system)?;
            let added = Self::find_step(&next, &a.walkthrough_id, &id).ok_or("That step could not be found.")?;
            let action = HistoryAction::named(format!("Add step “{}”", added.title));
            Ok((next.clone(), action))
        })
    }

    pub fn update_walkthrough_step(&self, walkthrough_id: &str, step_id: &str, changes: &StepDraft) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let before = Self::find_step(walkthroughs, walkthrough_id, step_id).map(|step| step.title.clone());
            let next = walkthrough_ops::update_step(walkthroughs, walkthrough_id, step_id, changes)?;
            let after = Self::find_step(&next, walkthrough_id, step_id).map(|step| step.title.clone());
            let (Some(before), Some(after)) = (before, after) else { return Err("That step could not be found.".into()) };
            let action = if after != before {
                HistoryAction::named(format!("Rename step to “{after}”"))
            } else {
                HistoryAction::coalescing(format!("Edit step “{after}”"), format!("walkthrough-step:{step_id}"))
            };
            Ok((next, action))
        })
    }

    pub fn move_walkthrough_step(&self, walkthrough_id: &str, step_id: &str, to_index: f64) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let next = walkthrough_ops::move_step(walkthroughs, walkthrough_id, step_id, to_index)?;
            let moved = Self::find_step(&next, walkthrough_id, step_id).ok_or("That step could not be found.")?;
            Ok((next.clone(), HistoryAction::named(format!("Move step “{}”", moved.title))))
        })
    }

    pub fn remove_walkthrough_step(&self, walkthrough_id: &str, step_id: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let removed = Self::find_step(walkthroughs, walkthrough_id, step_id).ok_or("That step could not be found.")?;
            let action = HistoryAction::named(format!("Remove step “{}”", removed.title));
            Ok((walkthrough_ops::remove_step(walkthroughs, walkthrough_id, step_id)?, action))
        })
    }

    pub(crate) fn add_walkthrough_block(&self, a: AddWalkthroughBlock) -> Result<WorkspaceState> {
        let id = a.id.clone().unwrap_or_else(|| self.new_id());
        self.apply_walkthrough_change(|walkthroughs, _| {
            let input = BlockInput { id: id.clone(), kind: a.kind.clone(), sequence: a.sequence.clone() };
            let next = walkthrough_ops::add_block(walkthroughs, &a.walkthrough_id, &input)?;
            let name = if a.kind == "parallel" { "Add parallel block" } else { "Add repeated block" };
            Ok((next, HistoryAction::named(name)))
        })
    }

    pub fn add_walkthrough_parallel_branch(&self, walkthrough_id: &str, block_id: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            Ok((walkthrough_ops::add_parallel_branch(walkthroughs, walkthrough_id, block_id)?, HistoryAction::named("Add parallel branch")))
        })
    }

    pub fn update_walkthrough_repeat(&self, walkthrough_id: &str, block_id: &str, count: f64) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let next = walkthrough_ops::update_repeat(walkthroughs, walkthrough_id, block_id, count)?;
            let times = if count == 1.0 { "time" } else { "times" };
            Ok((next, HistoryAction::named(format!("Repeat {} {times}", schema_domain::js::number_to_string(count)))))
        })
    }

    pub fn move_walkthrough_block(&self, walkthrough_id: &str, block_id: &str, to_index: f64) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            Ok((walkthrough_ops::move_block(walkthroughs, walkthrough_id, block_id, to_index)?, HistoryAction::named("Move block")))
        })
    }

    pub fn remove_walkthrough_block(&self, walkthrough_id: &str, block_id: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, _| {
            let walkthrough = walkthrough_ops::find_walkthrough(walkthroughs, walkthrough_id).ok_or("That Walkthrough could not be found.")?;
            let container = walkthrough_ops::find_container_kind(walkthrough, block_id).ok_or("That block could not be found.")?;
            let name = if container == "parallel" { "Remove parallel block" } else { "Remove repeated block" };
            Ok((walkthrough_ops::remove_block(walkthroughs, walkthrough_id, block_id)?, HistoryAction::named(name)))
        })
    }

    pub fn repair_walkthrough_step(&self, walkthrough_id: &str, step_id: &str, connection_id: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, system| {
            let before = Self::find_step(walkthroughs, walkthrough_id, step_id).map(|step| step.connection_id.clone()).ok_or("That step could not be found.")?;
            let next = walkthrough_ops::repair_step(walkthroughs, walkthrough_id, step_id, connection_id, system)?;
            let repaired = Self::find_step(&next, walkthrough_id, step_id).ok_or("That step could not be found.")?;
            let action = if repaired.connection_id != before {
                HistoryAction::named(format!("Relink step “{}”", repaired.title))
            } else {
                HistoryAction::named(format!("Accept route for step “{}”", repaired.title))
            };
            Ok((next.clone(), action))
        })
    }

    pub fn accept_walkthrough_step_redirection(&self, walkthrough_id: &str, step_id: &str) -> Result<WorkspaceState> {
        self.apply_walkthrough_change(|walkthroughs, system| {
            if Self::find_step(walkthroughs, walkthrough_id, step_id).is_none() {
                return Err("That step could not be found.".into());
            }
            let next = walkthrough_ops::accept_step_redirection(walkthroughs, walkthrough_id, step_id, system)?;
            let accepted = Self::find_step(&next, walkthrough_id, step_id).ok_or("That step could not be found.")?;
            Ok((next.clone(), HistoryAction::named(format!("Accept route for step “{}”", accepted.title))))
        })
    }

    /* -------------------------------------------------- Database designs */

    fn require_design_owner(&self, design_id: &str) -> Result<(schema_store::ProjectSummary, DatabaseDesignSummary, Vec<DatabaseDesignSummary>)> {
        let inner = self.lock();
        let Some(project) = inner.state.project.clone() else { return Err("Open a project before managing its designs.".into()) };
        let designs = inner.store.list_designs(&project.id).map_err(|error| error.to_string())?;
        let design = designs.iter().find(|candidate| candidate.id == design_id).cloned().ok_or("That design could not be found in this project.")?;
        Ok((project, design, designs))
    }

    pub fn create_design(&self, name: &str) -> Result<WorkspaceState> {
        let (project, existing) = {
            let inner = self.lock();
            let Some(project) = inner.state.project.clone() else { return Err("Open a project before adding a design.".into()) };
            let existing = inner.store.list_designs(&project.id).map_err(|error| error.to_string())?;
            (project, existing)
        };
        let name = if schema_domain::js::trim(name).is_empty() {
            next_default_design_name(&existing)
        } else {
            require_design_name(name, &existing.iter().collect::<Vec<_>>())?
        };
        let design_id = self.new_id();
        let saved_at = self.now();
        self.lock()
            .store
            .create_design(&project.id, &design_id, &name, &to_json(&empty_design())?, DesignSave { revision: 1, document_revision: 1, saved_at })
            .map_err(|error| error.to_string())?;
        self.activate(project, &design_id, false)
    }

    pub fn open_design(&self, design_id: &str) -> Result<WorkspaceState> {
        let (project, _, _) = self.require_design_owner(design_id)?;
        if self.lock().active_design_id.as_deref() == Some(design_id) {
            return Ok(self.state());
        }
        self.activate(project, design_id, false)
    }

    pub fn rename_design(&self, design_id: &str, name: &str) -> Result<WorkspaceState> {
        let (project, design, designs) = self.require_design_owner(design_id)?;
        let others: Vec<&DatabaseDesignSummary> = designs.iter().filter(|candidate| candidate.id != design.id).collect();
        let name = require_design_name(name, &others)?;
        let saved_at = self.now();
        let mut inner = self.lock();
        inner.store.rename_design(&project.id, &design.id, &name, saved_at).map_err(|error| error.to_string())?;
        let projects = inner.store.list_projects().map_err(|error| error.to_string())?;
        let designs = inner.store.list_designs(&project.id).map_err(|error| error.to_string())?;
        self.update(&mut inner, |state| {
            state.projects = projects;
            state.designs = designs;
        });
        Ok(inner.state.clone())
    }

    /// Links a Database component to a Design of this Project, or unlinks it with `None`.
    pub fn link_system_database(&self, component_id: &str, design_id: Option<&str>) -> Result<WorkspaceState> {
        let target = {
            let inner = self.lock();
            let (project_id, _) = require_open_project(&inner)?;
            let designs = inner.store.list_designs(&project_id).map_err(|error| error.to_string())?;
            match design_id {
                None => None,
                Some(id) => Some(designs.into_iter().find(|design| design.id == id).ok_or("That design could not be found in this project.")?),
            }
        };
        self.apply_system_design_change(|design| {
            let component = require_database_component(design, component_id)?;
            let changes = ComponentChanges {
                design_id: match design_id {
                    Some(id) => Patch::Value(id.to_owned()),
                    None => Patch::Null,
                },
                ..Default::default()
            };
            let next = update_component(design, &component.id, &changes)?;
            let name = match &target {
                Some(target) => format!("Link “{}” to “{}”", component.name, target.name),
                None => format!("Unlink “{}” from its design", component.name),
            };
            Ok((next, HistoryAction::named(name)))
        })
    }

    /// Creates a new empty Design for a Database component, opens it, and links the component to it.
    pub fn create_system_database_design(&self, component_id: &str, name: Option<&str>) -> Result<WorkspaceState> {
        let (project, component_name, existing) = {
            let inner = self.lock();
            let (project_id, _) = require_open_project(&inner)?;
            let project = inner.state.project.clone().ok_or("Open a project before editing its System design.")?;
            let system = inner.state.system_design.as_ref().ok_or("Open a project before editing its System design.")?;
            let component = require_database_component(system, component_id)?;
            if component.design_id.is_some() {
                return Err("This database component is already linked to a design. Unlink it first.".into());
            }
            let existing = inner.store.list_designs(&project_id).map_err(|error| error.to_string())?;
            (project, component.name.clone(), existing)
        };
        let name = match name {
            Some(name) if !schema_domain::js::trim(name).is_empty() => require_design_name(name, &existing.iter().collect::<Vec<_>>())?,
            _ => next_default_design_name(&existing),
        };
        let design_id = self.new_id();
        let saved_at = self.now();
        self.lock()
            .store
            .create_design(&project.id, &design_id, &name, &to_json(&empty_design())?, DesignSave { revision: 1, document_revision: 1, saved_at })
            .map_err(|error| error.to_string())?;
        self.activate(project, &design_id, false)?;
        self.apply_system_design_change(|design| {
            let changes = ComponentChanges { design_id: Patch::Value(design_id.clone()), ..Default::default() };
            let next = update_component(design, component_id, &changes)?;
            Ok((next, HistoryAction::named(format!("Link “{component_name}” to “{name}”"))))
        })
    }
}
