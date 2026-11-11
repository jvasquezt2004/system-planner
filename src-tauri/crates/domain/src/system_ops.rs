//! Editing operations on a System design: Services, Groups, Components, and
//! Connections. A port of the pure functions in `src/shared/system-design.ts`.
//!
//! Every operation takes a design and returns a new one, or the message the
//! TypeScript version throws. Checks run in the same order, because only the first
//! failure is reported. Operations that find nothing to change return the design
//! unchanged, as the originals do.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::catalog::default_name_stem;
use crate::geometry::{CanvasPoint, CanvasViewport, Size};
use crate::js;
use crate::patch::Patch;
use crate::system_design::*;

type Result<T> = std::result::Result<T, String>;

pub const DEFAULT_CONNECTION_LABEL: &str = "Interaction";

/* ------------------------------------------------------------------ inputs */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInput {
    pub id: String,
    pub name: Option<String>,
    pub position: CanvasPoint,
    pub size: Option<Size>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceChanges {
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub id: String,
    pub name: Option<String>,
    pub position: CanvasPoint,
    pub size: Option<Size>,
    pub member_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupChanges {
    pub name: Option<String>,
    pub member_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentInput {
    pub id: String,
    pub kind: Option<String>,
    pub name: Option<String>,
    pub technology: Option<String>,
    pub description: Option<String>,
    /// Checked one by one like stored properties, so odd entries get the same messages.
    pub properties: Option<Vec<Value>>,
    pub position: CanvasPoint,
    pub design_id: Option<String>,
    pub icon: Option<String>,
    /// The owning Service. Omitted or null places the Component at system scope.
    pub service_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentChanges {
    pub kind: Option<String>,
    pub name: Option<String>,
    pub properties: Option<Vec<Value>>,
    #[serde(default)]
    pub technology: Patch<String>,
    #[serde(default)]
    pub description: Patch<String>,
    #[serde(default)]
    pub design_id: Patch<String>,
    #[serde(default)]
    pub service_id: Patch<String>,
    #[serde(default)]
    pub icon: Patch<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub label: Option<String>,
    pub interaction_type: Option<String>,
    pub protocol: Option<String>,
}

/// Connection edits. A `null` or `"auto"` side restores the automatic side, an
/// empty `bendPoints` removes every bend, and a `null` label offset puts the label
/// back on the route. An omitted field is left as it is.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionChanges {
    pub source_id: Option<String>,
    pub target_id: Option<String>,
    pub label: Option<String>,
    #[serde(default)]
    pub interaction_type: Patch<String>,
    #[serde(default)]
    pub protocol: Patch<String>,
    #[serde(default)]
    pub from_side: Patch<String>,
    #[serde(default)]
    pub to_side: Patch<String>,
    pub bend_points: Option<Vec<CanvasPoint>>,
    #[serde(default)]
    pub label_offset: Patch<CanvasPoint>,
}

/* ------------------------------------------------------------------- plans */

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedConnection {
    pub id: String,
    pub label: String,
    pub source_id: String,
    pub target_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NamedId {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRemovalPlan {
    pub component_id: String,
    pub component_name: String,
    pub connections: Vec<AffectedConnection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRemovalPlan {
    pub service_id: String,
    pub service_name: String,
    /// Components the removal releases to system scope; they keep their positions and Connections.
    pub released_components: Vec<NamedId>,
    /// Connections whose actual endpoint is this Service; removing it deletes them.
    pub connections: Vec<AffectedConnection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRemovalPlan {
    pub connection_id: String,
    pub connection_label: String,
}

/// The identities a move of one Group carries, each listed once even when
/// memberships overlap or nest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMoveTargets {
    pub group_ids: Vec<String>,
    pub service_ids: Vec<String>,
    pub component_ids: Vec<String>,
}

/* ----------------------------------------------------------------- finders */

pub fn find_service<'a>(design: &'a SystemDesign, id: &str) -> Option<&'a SystemService> {
    design.services.iter().find(|service| service.id == id)
}
pub fn find_component<'a>(design: &'a SystemDesign, id: &str) -> Option<&'a SystemComponent> {
    design.components.iter().find(|component| component.id == id)
}
pub fn find_connection<'a>(design: &'a SystemDesign, id: &str) -> Option<&'a SystemConnection> {
    design.connections.iter().find(|connection| connection.id == id)
}
pub fn find_group<'a>(design: &'a SystemDesign, id: &str) -> Option<&'a SystemGroup> {
    design.groups.iter().find(|group| group.id == id)
}

fn require_service<'a>(design: &'a SystemDesign, id: &str) -> Result<&'a SystemService> {
    find_service(design, id).ok_or_else(|| "That Service could not be found.".into())
}
fn require_group<'a>(design: &'a SystemDesign, id: &str) -> Result<&'a SystemGroup> {
    find_group(design, id).ok_or_else(|| "That Group could not be found.".into())
}
fn require_component<'a>(design: &'a SystemDesign, id: &str) -> Result<&'a SystemComponent> {
    find_component(design, id).ok_or_else(|| "That Component could not be found.".into())
}
fn require_connection<'a>(design: &'a SystemDesign, id: &str) -> Result<&'a SystemConnection> {
    find_connection(design, id).ok_or_else(|| "That Connection could not be found.".into())
}

fn is_identity(design: &SystemDesign, id: &str) -> bool {
    find_component(design, id).is_some() || find_service(design, id).is_some() || find_group(design, id).is_some()
}
fn is_endpoint(design: &SystemDesign, id: &str) -> bool {
    find_component(design, id).is_some() || find_service(design, id).is_some()
}

/* -------------------------------------------------------------- validation */

fn identity(id: &str, label: &str) -> Result<()> {
    if js::trim(id).is_empty() { Err(format!("{label} is required.")) } else { Ok(()) }
}

/// `requirePosition` for a point already typed: finite is the only way it can fail.
fn position(point: CanvasPoint, label: &str) -> Result<CanvasPoint> {
    if !point.x.is_finite() || !point.y.is_finite() {
        return Err(format!("{label} must be finite."));
    }
    Ok(CanvasPoint { x: js::round2(point.x), y: js::round2(point.y) })
}

fn frame_size(size: Size, minimum: Size) -> Result<Size> {
    if !size.width.is_finite() || !size.height.is_finite() {
        return Err("Size must be finite.".into());
    }
    Ok(Size { width: minimum.width.max(js::round(size.width)), height: minimum.height.max(js::round(size.height)) })
}

/// Component, Service, and Group ids share one namespace, so a Connection endpoint or Group member is never ambiguous.
fn require_unused_id(design: &SystemDesign, id: &str) -> Result<()> {
    if find_service(design, id).is_some() {
        return Err(format!("\"{id}\" is already used by a Service."));
    }
    if find_component(design, id).is_some() {
        return Err(format!("\"{id}\" is already used by a Component."));
    }
    if find_group(design, id).is_some() {
        return Err(format!("\"{id}\" is already used by a Group."));
    }
    Ok(())
}

/// Services own Components; a Component names at most one owning Service, or none for system scope.
fn require_owner_service(design: &SystemDesign, service_id: Option<&str>) -> Result<Option<String>> {
    match service_id {
        None => Ok(None),
        Some(id) if find_service(design, id).is_some() => Ok(Some(id.to_owned())),
        Some(_) => Err("That Service could not be found.".into()),
    }
}

fn require_distinct_endpoints(design: &SystemDesign, source_id: &str, target_id: &str) -> Result<()> {
    if !is_endpoint(design, source_id) {
        return Err("The Connection source Component could not be found.".into());
    }
    if !is_endpoint(design, target_id) {
        return Err("The Connection target Component could not be found.".into());
    }
    if source_id == target_id {
        return Err("A Connection must join two different Components.".into());
    }
    Ok(())
}

fn next_default_name(base: &str, names: &[&str]) -> String {
    if !names.contains(&base) {
        return base.to_owned();
    }
    (2..).map(|index| format!("{base} {index}")).find(|candidate| !names.contains(&candidate.as_str())).expect("unbounded")
}

/// Checks a complete member list for a Group. Members must exist, a Group cannot
/// contain itself, and no member Group may already contain this one, directly or
/// through its own Groups. Duplicates collapse to one membership.
fn require_group_members(design: &SystemDesign, group_id: &str, member_ids: &[String]) -> Result<Vec<String>> {
    let mut members: Vec<String> = Vec::new();
    for member_id in member_ids {
        identity(member_id, "Group member")?;
        if members.contains(member_id) {
            continue;
        }
        if member_id == group_id {
            return Err("A Group cannot contain itself.".into());
        }
        if !is_identity(design, member_id) {
            return Err(format!("\"{member_id}\" does not match a Component, Service, or Group."));
        }
        members.push(member_id.clone());
    }
    let target = find_group(design, group_id);
    for member_id in &members {
        if let Some(member) = find_group(design, member_id) {
            if reaches_group(&design.groups, member_id, group_id) {
                let target_name = target.map_or(group_id, |group| group.name.as_str());
                return Err(format!("Nesting \"{target_name}\" inside \"{}\" would create a cycle.", member.name));
            }
        }
    }
    Ok(members)
}

/// `setOptionalText`: a present patch replaces the value, and null clears it.
fn apply_text(target: &mut Option<String>, patch: &Patch<String>) {
    if !patch.is_absent() {
        *target = optional_text(patch.value().map(String::as_str));
    }
}

fn require_link_allowed(component: &SystemComponent) -> Result<()> {
    if component.design_id.is_some() && component.kind != "database" {
        return Err("Only a Database component can link to a database design.".into());
    }
    Ok(())
}

fn require_icon_allowed(component: &SystemComponent) -> Result<()> {
    if component.icon.is_some() && component.kind != "custom" {
        return Err("Only a Custom component can choose an icon or shape.".into());
    }
    Ok(())
}

fn require_kind_str(kind: &str) -> Result<String> {
    require_kind(Some(&Value::String(kind.to_owned())))
}

fn icon_from(icon: Option<&str>) -> Result<Option<String>> {
    optional_icon(icon.map(|icon| Value::String(icon.to_owned())).as_ref())
}

/* ---------------------------------------------------------------- Services */

pub fn add_service(design: &SystemDesign, input: &ServiceInput) -> Result<SystemDesign> {
    identity(&input.id, "Service id")?;
    if find_service(design, &input.id).is_some() {
        return Err(format!("Service \"{}\" already exists.", input.id));
    }
    require_unused_id(design, &input.id)?;
    let existing: Vec<&str> = design.services.iter().map(|service| service.name.as_str()).collect();
    let name = name_text(&input.name.clone().unwrap_or_else(|| next_default_name("Service", &existing)), "Service name", NAME_LIMIT)?;
    let position = position(input.position, "Service position")?;
    let size = frame_size(input.size.unwrap_or(SERVICE_DEFAULT_SIZE), SERVICE_MIN_SIZE)?;
    let mut next = design.clone();
    next.services.push(SystemService { id: input.id.clone(), name, position, size });
    Ok(next)
}

pub fn update_service(design: &SystemDesign, service_id: &str, changes: &ServiceChanges) -> Result<SystemDesign> {
    let current = require_service(design, service_id)?;
    let Some(name) = &changes.name else { return Ok(design.clone()) };
    let name = name_text(name, "Service name", NAME_LIMIT)?;
    if name == current.name {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    if let Some(service) = next.services.iter_mut().find(|service| service.id == service_id) {
        service.name = name;
    }
    Ok(next)
}

/// Moves a Service boundary together with the Components it owns, keeping their
/// offsets. Ownership is unchanged. Each member moves once.
pub fn move_service(design: &SystemDesign, service_id: &str, new_position: CanvasPoint) -> Result<SystemDesign> {
    let current = require_service(design, service_id)?;
    let next_position = position(new_position, "Service position")?;
    let (dx, dy) = (next_position.x - current.position.x, next_position.y - current.position.y);
    if dx == 0.0 && dy == 0.0 {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    for service in next.services.iter_mut().filter(|service| service.id == service_id) {
        service.position = next_position;
    }
    for component in next.components.iter_mut().filter(|component| component.service_id.as_deref() == Some(service_id)) {
        component.position = position(CanvasPoint { x: component.position.x + dx, y: component.position.y + dy }, "Component position")?;
    }
    Ok(next)
}

pub fn resize_service(design: &SystemDesign, service_id: &str, size: Size) -> Result<SystemDesign> {
    let current = require_service(design, service_id)?;
    let size = frame_size(size, SERVICE_MIN_SIZE)?;
    if current.size == size {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.services.iter_mut().filter(|service| service.id == service_id).for_each(|service| service.size = size);
    Ok(next)
}

/// Shows the Service collapsed or expanded. Presentation only.
pub fn set_service_collapsed(design: &SystemDesign, service_id: &str, collapsed: bool) -> Result<SystemDesign> {
    require_service(design, service_id)?;
    if design.collapsed_service_ids.iter().any(|id| id == service_id) == collapsed {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    if collapsed {
        next.collapsed_service_ids.push(service_id.to_owned());
    } else {
        next.collapsed_service_ids.retain(|id| id != service_id);
    }
    Ok(next)
}

/// Opens the focused view of one Service, or returns to the overview for `None`. Presentation only.
pub fn set_focus(design: &SystemDesign, service_id: Option<&str>, viewport: Option<CanvasViewport>) -> Result<SystemDesign> {
    if let Some(service_id) = service_id {
        require_service(design, service_id)?;
    }
    let focus_viewport = viewport.unwrap_or(design.focus_viewport);
    if design.focused_service_id.as_deref() == service_id && focus_viewport == design.focus_viewport {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.focused_service_id = service_id.map(str::to_owned);
    next.focus_viewport = focus_viewport;
    Ok(next)
}

/// Lists what removing the Service releases and which Connections it deletes, before anything changes.
pub fn describe_service_removal(design: &SystemDesign, service_id: &str) -> Result<ServiceRemovalPlan> {
    let service = require_service(design, service_id)?;
    Ok(ServiceRemovalPlan {
        service_id: service_id.to_owned(),
        service_name: service.name.clone(),
        released_components: design
            .components
            .iter()
            .filter(|component| component.service_id.as_deref() == Some(service_id))
            .map(|component| NamedId { id: component.id.clone(), name: component.name.clone() })
            .collect(),
        connections: affected_connections(design, service_id),
    })
}

fn affected_connections(design: &SystemDesign, endpoint_id: &str) -> Vec<AffectedConnection> {
    design
        .connections
        .iter()
        .filter(|connection| connection.source_id == endpoint_id || connection.target_id == endpoint_id)
        .map(|connection| AffectedConnection {
            id: connection.id.clone(),
            label: connection.label.clone(),
            source_id: connection.source_id.clone(),
            target_id: connection.target_id.clone(),
        })
        .collect()
}

/// Removes the Service boundary. Its owned Components become system-scope
/// resources, keeping their positions and Connections. Connections whose actual
/// endpoint is the Service are deleted.
pub fn remove_service(design: &SystemDesign, service_id: &str) -> Result<SystemDesign> {
    require_service(design, service_id)?;
    let mut next = design.clone();
    next.services.retain(|service| service.id != service_id);
    next.groups = prune_group_memberships(&design.groups, service_id);
    next.collapsed_service_ids.retain(|id| id != service_id);
    if next.focused_service_id.as_deref() == Some(service_id) {
        next.focused_service_id = None;
    }
    for component in next.components.iter_mut().filter(|component| component.service_id.as_deref() == Some(service_id)) {
        component.service_id = None;
    }
    next.connections.retain(|connection| connection.source_id != service_id && connection.target_id != service_id);
    Ok(next)
}

/* ------------------------------------------------------------------ Groups */

pub fn add_group(design: &SystemDesign, input: &GroupInput) -> Result<SystemDesign> {
    identity(&input.id, "Group id")?;
    if find_group(design, &input.id).is_some() {
        return Err(format!("Group \"{}\" already exists.", input.id));
    }
    require_unused_id(design, &input.id)?;
    let existing: Vec<&str> = design.groups.iter().map(|group| group.name.as_str()).collect();
    let name = name_text(&input.name.clone().unwrap_or_else(|| next_default_name("Group", &existing)), "Group name", NAME_LIMIT)?;
    let position = position(input.position, "Group position")?;
    let size = frame_size(input.size.unwrap_or(GROUP_DEFAULT_SIZE), GROUP_MIN_SIZE)?;
    let member_ids = require_group_members(design, &input.id, input.member_ids.as_deref().unwrap_or(&[]))?;
    let mut next = design.clone();
    next.groups.push(SystemGroup { id: input.id.clone(), name, position, size, member_ids });
    Ok(next)
}

/// Renames a Group or replaces its members. Membership is validated as a whole: an
/// unknown member, a Group containing itself, or a nesting cycle refuses the change.
pub fn update_group(design: &SystemDesign, group_id: &str, changes: &GroupChanges) -> Result<SystemDesign> {
    let current = require_group(design, group_id)?;
    let mut updated = current.clone();
    if let Some(name) = &changes.name {
        updated.name = name_text(name, "Group name", NAME_LIMIT)?;
    }
    if let Some(members) = &changes.member_ids {
        updated.member_ids = require_group_members(design, group_id, members)?;
    }
    if &updated == current {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.groups.iter_mut().filter(|group| group.id == group_id).for_each(|group| *group = updated.clone());
    Ok(next)
}

/// Lists every identity a move of the Group carries. A nested Group contributes its
/// own members transitively; each is listed once however many memberships reach it.
pub fn describe_group_move(design: &SystemDesign, group_id: &str) -> Result<GroupMoveTargets> {
    require_group(design, group_id)?;
    let mut group_ids: Vec<String> = Vec::new();
    let mut service_ids: Vec<String> = Vec::new();
    let mut component_ids: Vec<String> = Vec::new();
    fn visit(design: &SystemDesign, id: &str, groups: &mut Vec<String>, services: &mut Vec<String>, components: &mut Vec<String>) -> Result<()> {
        if groups.iter().any(|known| known == id) {
            return Ok(());
        }
        groups.push(id.to_owned());
        for member_id in &require_group(design, id)?.member_ids {
            if find_group(design, member_id).is_some() {
                visit(design, member_id, groups, services, components)?;
            } else if find_service(design, member_id).is_some() {
                if !services.contains(member_id) {
                    services.push(member_id.clone());
                }
            } else if find_component(design, member_id).is_some() && !components.contains(member_id) {
                components.push(member_id.clone());
            }
        }
        Ok(())
    }
    visit(design, group_id, &mut group_ids, &mut service_ids, &mut component_ids)?;
    for component in &design.components {
        if component.service_id.as_ref().is_some_and(|owner| service_ids.contains(owner)) && !component_ids.contains(&component.id) {
            component_ids.push(component.id.clone());
        }
    }
    Ok(GroupMoveTargets { group_ids, service_ids, component_ids })
}

/// Moves a Group frame and carries every identity it resolves to by the same
/// offset, each exactly once. Ownership and membership are unchanged.
pub fn move_group(design: &SystemDesign, group_id: &str, new_position: CanvasPoint) -> Result<SystemDesign> {
    let current = require_group(design, group_id)?;
    let next_position = position(new_position, "Group position")?;
    let (dx, dy) = (next_position.x - current.position.x, next_position.y - current.position.y);
    if dx == 0.0 && dy == 0.0 {
        return Ok(design.clone());
    }
    let targets = describe_group_move(design, group_id)?;
    let shifted = |point: CanvasPoint| position(CanvasPoint { x: point.x + dx, y: point.y + dy }, "Position");
    let mut next = design.clone();
    for group in &mut next.groups {
        if group.id == group_id {
            group.position = next_position;
        } else if targets.group_ids.contains(&group.id) {
            group.position = shifted(group.position)?;
        }
    }
    for service in next.services.iter_mut().filter(|service| targets.service_ids.contains(&service.id)) {
        service.position = shifted(service.position)?;
    }
    for component in next.components.iter_mut().filter(|component| targets.component_ids.contains(&component.id)) {
        component.position = shifted(component.position)?;
    }
    Ok(next)
}

/// Changes the frame's size only. Drawing or resizing a Group never changes its membership.
pub fn resize_group(design: &SystemDesign, group_id: &str, size: Size) -> Result<SystemDesign> {
    let current = require_group(design, group_id)?;
    let size = frame_size(size, GROUP_MIN_SIZE)?;
    if current.size == size {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.groups.iter_mut().filter(|group| group.id == group_id).for_each(|group| group.size = size);
    Ok(next)
}

/// Removes the Group frame. Its members stay where they are with their ownership
/// and Connections; the Group is only removed from any Group that contained it.
pub fn remove_group(design: &SystemDesign, group_id: &str) -> Result<SystemDesign> {
    require_group(design, group_id)?;
    let mut next = design.clone();
    let remaining: Vec<SystemGroup> = design.groups.iter().filter(|group| group.id != group_id).cloned().collect();
    next.groups = prune_group_memberships(&remaining, group_id);
    Ok(next)
}

/// Drops one identity from every Group's members, so no Group names an item that no longer exists.
pub fn prune_group_memberships(groups: &[SystemGroup], removed_id: &str) -> Vec<SystemGroup> {
    groups
        .iter()
        .map(|group| {
            if group.member_ids.iter().any(|id| id == removed_id) {
                SystemGroup { member_ids: group.member_ids.iter().filter(|id| *id != removed_id).cloned().collect(), ..group.clone() }
            } else {
                group.clone()
            }
        })
        .collect()
}

/* -------------------------------------------------------------- Components */

pub fn add_component(design: &SystemDesign, input: &ComponentInput) -> Result<SystemDesign> {
    identity(&input.id, "Component id")?;
    if find_component(design, &input.id).is_some() {
        return Err(format!("Component \"{}\" already exists.", input.id));
    }
    require_unused_id(design, &input.id)?;
    let kind_text = input.kind.as_deref().unwrap_or("generic");
    let kind = require_kind_str(kind_text)?;
    let name = match &input.name {
        Some(name) => name.clone(),
        None => {
            let existing: Vec<&str> = design.components.iter().map(|component| component.name.as_str()).collect();
            next_default_name(default_name_stem(kind_text), &existing)
        }
    };
    let name = name_text(&name, "Component name", NAME_LIMIT)?;
    let properties = normalize_properties(input.properties.as_deref().unwrap_or(&[]))?;
    let position = position(input.position, "Component position")?;
    let service_id = require_owner_service(design, input.service_id.as_deref())?;
    let component = SystemComponent {
        id: input.id.clone(),
        kind,
        name,
        technology: optional_text(input.technology.as_deref()),
        description: optional_text(input.description.as_deref()),
        properties,
        position,
        service_id,
        design_id: input.design_id.clone().filter(|id| !id.is_empty()),
        icon: icon_from(input.icon.as_deref())?,
    };
    require_link_allowed(&component)?;
    require_icon_allowed(&component)?;
    let mut next = design.clone();
    next.components.push(component);
    Ok(next)
}

pub fn update_component(design: &SystemDesign, component_id: &str, changes: &ComponentChanges) -> Result<SystemDesign> {
    let current = require_component(design, component_id)?;
    let mut updated = current.clone();
    if let Some(kind) = &changes.kind {
        updated.kind = require_kind_str(kind)?;
    }
    if let Some(name) = &changes.name {
        updated.name = name_text(name, "Component name", NAME_LIMIT)?;
    }
    if let Some(properties) = &changes.properties {
        updated.properties = normalize_properties(properties)?;
    }
    apply_text(&mut updated.technology, &changes.technology);
    apply_text(&mut updated.description, &changes.description);
    if !changes.design_id.is_absent() {
        updated.design_id = changes.design_id.value().filter(|id| !id.is_empty()).cloned();
    }
    if !changes.service_id.is_absent() {
        updated.service_id = require_owner_service(design, changes.service_id.value().map(String::as_str))?;
    }
    if !changes.icon.is_absent() {
        updated.icon = icon_from(changes.icon.value().map(String::as_str))?;
    }
    if let Some(kind) = &changes.kind {
        if kind != "database" && current.design_id.is_some() {
            return Err("Unlink this Component from its database design before changing its kind.".into());
        }
        // A chosen icon belongs to a Custom Component, so leaving that kind drops it.
        if kind != "custom" {
            updated.icon = None;
        }
    }
    require_link_allowed(&updated)?;
    require_icon_allowed(&updated)?;
    if &updated == current {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.components.iter_mut().filter(|component| component.id == component_id).for_each(|component| *component = updated.clone());
    Ok(next)
}

pub fn move_component(design: &SystemDesign, component_id: &str, new_position: CanvasPoint) -> Result<SystemDesign> {
    let current = require_component(design, component_id)?;
    let new_position = position(new_position, "Component position")?;
    if current.position == new_position {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.components.iter_mut().filter(|component| component.id == component_id).for_each(|component| component.position = new_position);
    Ok(next)
}

/// Lists the Connections that removing the Component would delete.
pub fn describe_component_removal(design: &SystemDesign, component_id: &str) -> Result<ComponentRemovalPlan> {
    let component = require_component(design, component_id)?;
    Ok(ComponentRemovalPlan {
        component_id: component_id.to_owned(),
        component_name: component.name.clone(),
        connections: affected_connections(design, component_id),
    })
}

/// Removes the Component, its Connections, and its Group memberships.
pub fn remove_component(design: &SystemDesign, component_id: &str) -> Result<SystemDesign> {
    require_component(design, component_id)?;
    let mut next = design.clone();
    next.groups = prune_group_memberships(&design.groups, component_id);
    next.components.retain(|component| component.id != component_id);
    next.connections.retain(|connection| connection.source_id != component_id && connection.target_id != component_id);
    Ok(next)
}

/* ------------------------------------------------------------- Connections */

pub fn add_connection(design: &SystemDesign, input: &ConnectionInput) -> Result<SystemDesign> {
    identity(&input.id, "Connection id")?;
    if find_connection(design, &input.id).is_some() {
        return Err(format!("Connection \"{}\" already exists.", input.id));
    }
    require_distinct_endpoints(design, &input.source_id, &input.target_id)?;
    let label = name_text(input.label.as_deref().unwrap_or(DEFAULT_CONNECTION_LABEL), "Connection label", CONNECTION_LABEL_LIMIT)?;
    let mut next = design.clone();
    next.connections.push(SystemConnection {
        id: input.id.clone(),
        source_id: input.source_id.clone(),
        target_id: input.target_id.clone(),
        label,
        interaction_type: optional_text(input.interaction_type.as_deref()),
        protocol: optional_text(input.protocol.as_deref()),
        from_side: None,
        to_side: None,
        bend_points: None,
        label_offset: None,
    });
    Ok(next)
}

/// True when the changes adjust how the Connection is drawn rather than what it means.
pub fn has_route_change(changes: &ConnectionChanges) -> bool {
    !changes.from_side.is_absent() || !changes.to_side.is_absent() || changes.bend_points.is_some() || !changes.label_offset.is_absent()
}

/// A side is stored only when it is not automatic, so an unchanged route leaves no field behind.
fn apply_side(target: &mut Option<String>, patch: &Patch<String>) -> Result<()> {
    match patch {
        Patch::Absent => {}
        Patch::Null => *target = None,
        Patch::Value(side) => {
            let side = require_side(&Value::String(side.clone()))?;
            *target = (side != "auto").then_some(side);
        }
    }
    Ok(())
}

pub fn update_connection(design: &SystemDesign, connection_id: &str, changes: &ConnectionChanges) -> Result<SystemDesign> {
    let current = require_connection(design, connection_id)?;
    let mut updated = current.clone();
    if let Some(source_id) = &changes.source_id {
        updated.source_id = source_id.clone();
    }
    if let Some(target_id) = &changes.target_id {
        updated.target_id = target_id.clone();
    }
    require_distinct_endpoints(design, &updated.source_id, &updated.target_id)?;
    if let Some(label) = &changes.label {
        updated.label = name_text(label, "Connection label", CONNECTION_LABEL_LIMIT)?;
    }
    apply_text(&mut updated.interaction_type, &changes.interaction_type);
    apply_text(&mut updated.protocol, &changes.protocol);
    apply_side(&mut updated.from_side, &changes.from_side)?;
    apply_side(&mut updated.to_side, &changes.to_side)?;
    if let Some(bends) = &changes.bend_points {
        if bends.is_empty() {
            updated.bend_points = None;
        } else {
            if bends.len() > CONNECTION_BEND_LIMIT {
                return Err(format!("A Connection can have at most {CONNECTION_BEND_LIMIT} bend points."));
            }
            updated.bend_points = Some(bends.iter().map(|bend| position(*bend, "Bend point")).collect::<Result<Vec<_>>>()?);
        }
    }
    match &changes.label_offset {
        Patch::Absent => {}
        Patch::Null => updated.label_offset = None,
        Patch::Value(offset) => updated.label_offset = Some(position(*offset, "Label offset")?),
    }
    if &updated == current {
        return Ok(design.clone());
    }
    let mut next = design.clone();
    next.connections.iter_mut().filter(|connection| connection.id == connection_id).for_each(|connection| *connection = updated.clone());
    Ok(next)
}

pub fn describe_connection_removal(design: &SystemDesign, connection_id: &str) -> Result<ConnectionRemovalPlan> {
    let connection = require_connection(design, connection_id)?;
    Ok(ConnectionRemovalPlan { connection_id: connection_id.to_owned(), connection_label: connection.label.clone() })
}

pub fn remove_connection(design: &SystemDesign, connection_id: &str) -> Result<SystemDesign> {
    require_connection(design, connection_id)?;
    let mut next = design.clone();
    next.connections.retain(|connection| connection.id != connection_id);
    Ok(next)
}
