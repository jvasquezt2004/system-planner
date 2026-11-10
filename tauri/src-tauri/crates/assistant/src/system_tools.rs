//! `read_system_design` and `edit_system_design` (`src/bun/system-design-operations.ts` and the tools
//! in the original runtime): the Assistant reads every Service, Group, Component and Connection with
//! its version, and edits them in batches that apply in full or not at all.

use std::collections::HashSet;
use std::sync::Arc;

use schema_domain::geometry::{CanvasPoint, Size};
use schema_domain::system_design::{SystemDesign, GROUP_DEFAULT_SIZE};
use schema_domain::system_layout::{apply_system_layout, compute_system_layout, frame_around_members, open_service_spot_near, open_spot_near, LayoutPlacement};
use schema_domain::system_ops::*;
use schema_domain::walkthrough_ops::steps_on_connections;
use serde_json::{json, Map, Value};

use crate::read_tools::{project_snapshot, ToolContext};
use crate::tools::{ProjectTool, ToolResult};
use crate::walkthrough_tools::{item_version, walkthrough_diagnostics};

type Result<T> = std::result::Result<T, String>;

const ENUMS: &str = include_str!("../data/tool-enums.json");

/// The System design content a read or a snapshot records.
pub fn content_of(design: &SystemDesign) -> Value {
    json!({ "services": design.services, "groups": design.groups, "components": design.components, "connections": design.connections })
}

fn groups_containing<'a>(design: &'a SystemDesign, id: &str) -> Vec<&'a schema_domain::system_design::SystemGroup> {
    design.groups.iter().filter(|group| group.member_ids.iter().any(|member| member == id)).collect()
}

/// The focused architecture context the Assistant reads: every item with its stable id, relevant
/// version, ownership, Group membership and nesting, database link, and Connection attachment, route
/// and label overrides, plus diagnostics that name what a designer would want to fix.
pub fn read_system_architecture(design: &SystemDesign, designs: &[(String, String)]) -> Value {
    let design_ids: HashSet<&str> = designs.iter().map(|(id, _)| id.as_str()).collect();
    let ids = |items: Vec<&str>| items.into_iter().map(str::to_owned).collect::<Vec<_>>();
    json!({
        "services": design.services.iter().map(|service| json!({
            "id": service.id, "name": service.name, "position": service.position, "size": service.size,
            "ownedComponentIds": ids(design.components.iter().filter(|component| component.service_id.as_deref() == Some(service.id.as_str())).map(|component| component.id.as_str()).collect()),
            "version": item_version(service),
        })).collect::<Vec<_>>(),
        "groups": design.groups.iter().map(|group| json!({
            "id": group.id, "name": group.name, "position": group.position, "size": group.size, "memberIds": group.member_ids,
            "containedInGroupIds": ids(groups_containing(design, &group.id).iter().map(|item| item.id.as_str()).collect()),
            "version": item_version(group),
        })).collect::<Vec<_>>(),
        "components": design.components.iter().map(|component| {
            let mut item = Map::new();
            item.insert("id".into(), json!(component.id));
            item.insert("kind".into(), json!(component.kind));
            item.insert("name".into(), json!(component.name));
            if let Some(technology) = &component.technology {
                item.insert("technology".into(), json!(technology));
            }
            if let Some(description) = &component.description {
                item.insert("description".into(), json!(description));
            }
            item.insert("properties".into(), json!(component.properties));
            if let Some(icon) = &component.icon {
                item.insert("icon".into(), json!(icon));
            }
            item.insert("position".into(), json!(component.position));
            item.insert("ownerServiceId".into(), json!(component.service_id));
            item.insert("linkedDesignId".into(), json!(component.design_id));
            item.insert("groupIds".into(), json!(ids(groups_containing(design, &component.id).iter().map(|group| group.id.as_str()).collect())));
            item.insert("version".into(), json!(item_version(component)));
            Value::Object(item)
        }).collect::<Vec<_>>(),
        "connections": design.connections.iter().map(|connection| {
            let mut item = Map::new();
            item.insert("id".into(), json!(connection.id));
            item.insert("sourceId".into(), json!(connection.source_id));
            item.insert("targetId".into(), json!(connection.target_id));
            item.insert("label".into(), json!(connection.label));
            if let Some(protocol) = &connection.protocol {
                item.insert("protocol".into(), json!(protocol));
            }
            if let Some(interaction) = &connection.interaction_type {
                item.insert("interactionType".into(), json!(interaction));
            }
            item.insert("attachment".into(), json!({ "fromSide": connection.from_side.as_deref().unwrap_or("auto"), "toSide": connection.to_side.as_deref().unwrap_or("auto") }));
            item.insert("bendPoints".into(), json!(connection.bend_points.clone().unwrap_or_default()));
            item.insert("labelOffset".into(), json!(connection.label_offset));
            item.insert("version".into(), json!(item_version(connection)));
            Value::Object(item)
        }).collect::<Vec<_>>(),
        "designs": designs.iter().map(|(id, name)| json!({ "id": id, "name": name })).collect::<Vec<_>>(),
        "diagnostics": system_diagnostics(design, &design_ids),
    })
}

/// Problems a designer would want fixed. None of them block editing.
pub fn system_diagnostics(design: &SystemDesign, design_ids: &HashSet<&str>) -> Vec<String> {
    let mut notes = Vec::new();
    for component in &design.components {
        if component.kind == "database" && component.design_id.is_none() {
            notes.push(format!("Database component \"{}\" ({}) has no linked database design.", component.name, component.id));
        }
        if let Some(linked) = &component.design_id {
            if !design_ids.contains(linked.as_str()) {
                notes.push(format!("Component \"{}\" ({}) links design \"{linked}\", which is not in this Project.", component.name, component.id));
            }
        }
    }
    for service in &design.services {
        if !design.components.iter().any(|component| component.service_id.as_deref() == Some(service.id.as_str())) {
            notes.push(format!("Service \"{}\" ({}) owns no Components.", service.name, service.id));
        }
    }
    for group in &design.groups {
        if group.member_ids.is_empty() {
            notes.push(format!("Group \"{}\" ({}) has no members.", group.name, group.id));
        }
    }
    let mut linked_by: Vec<(&str, Vec<&str>)> = Vec::new();
    for component in &design.components {
        let Some(linked) = component.design_id.as_deref() else { continue };
        match linked_by.iter_mut().find(|(id, _)| *id == linked) {
            Some((_, components)) => components.push(&component.id),
            None => linked_by.push((linked, vec![&component.id])),
        }
    }
    for (design_id, components) in linked_by {
        if components.len() > 1 {
            notes.push(format!("Design \"{design_id}\" is a shared schema linked from {}.", components.join(", ")));
        }
    }
    notes
}

/* --------------------------------------------------------------------- planning */

fn present<'a>(operation: &'a Value, key: &str) -> Option<&'a Value> {
    operation.get(key)
}

fn text_of(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

fn require_id(operation: &Value, label: &str) -> Result<String> {
    match text_of(present(operation, label)) {
        Some(text) if !schema_domain::js::trim(text).is_empty() => Ok(schema_domain::js::trim(text).to_owned()),
        _ => Err(format!("A new {label} is required.")),
    }
}

fn require_named<'a>(operation: &'a Value, key: &str, exists: impl Fn(&str) -> bool, noun: &str) -> Result<&'a str> {
    let Some(value) = text_of(present(operation, key)).filter(|value| !value.is_empty()) else { return Err(format!("{key} is required.")) };
    if !exists(value) {
        return Err(format!("{key} \"{value}\" does not match a {noun}."));
    }
    Ok(value)
}

fn require_existing<'a>(design: &SystemDesign, operation: &'a Value, key: &str) -> Result<&'a str> {
    require_named(operation, key, |id| find_component(design, id).is_some(), "Component")
}

fn require_service<'a>(design: &SystemDesign, operation: &'a Value, key: &str) -> Result<&'a str> {
    require_named(operation, key, |id| find_service(design, id).is_some(), "Service")
}

fn require_group<'a>(design: &SystemDesign, operation: &'a Value, key: &str) -> Result<&'a str> {
    require_named(operation, key, |id| find_group(design, id).is_some(), "Group")
}

/// A Connection endpoint is a Component or a Service.
fn require_endpoint<'a>(design: &SystemDesign, operation: &'a Value, key: &str) -> Result<&'a str> {
    require_named(operation, key, |id| find_component(design, id).is_some() || find_service(design, id).is_some(), "Component or Service")
}

fn require_connection<'a>(design: &SystemDesign, operation: &'a Value) -> Result<&'a str> {
    require_named(operation, "connectionId", |id| find_connection(design, id).is_some(), "Connection")
}

fn require_point(operation: &Value) -> Result<CanvasPoint> {
    match (present(operation, "x").and_then(Value::as_f64), present(operation, "y").and_then(Value::as_f64)) {
        (Some(x), Some(y)) => Ok(CanvasPoint { x, y }),
        _ => Err("x and y are required.".into()),
    }
}

/// A database Design named for a Component: `Some(Null)` unlinks, `None` means the field was not given.
fn require_linked_design(operation: &Value, design_ids: &HashSet<String>) -> Result<Option<Value>> {
    match present(operation, "linkedDesignId") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(Value::Null)),
        Some(value) => match value.as_str().filter(|id| design_ids.contains(*id)) {
            Some(id) => Ok(Some(json!(id))),
            None => Err(format!("linkedDesignId \"{}\" does not match a database design in this Project.", schema_domain::js::to_js_string(value))),
        },
    }
}

fn pick(operation: &Value, keys: &[&str]) -> Map<String, Value> {
    keys.iter().filter_map(|key| present(operation, key).map(|value| ((*key).to_owned(), value.clone()))).collect()
}

fn typed<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| error.to_string())
}

/// One workspace call: the request name and its parameters.
pub type PlannedAction = (&'static str, Value);

pub struct SystemPlan {
    pub actions: Vec<PlannedAction>,
    /// The design after every operation, computed without touching the workspace.
    pub next: SystemDesign,
    /// What the batch removes or moves beyond the items it names, reported back so the Assistant can say so.
    pub impacts: Vec<String>,
}

fn plan_one(next: &SystemDesign, operation: &Value, design_ids: &HashSet<String>, attribution: &Map<String, Value>) -> Result<(SystemDesign, PlannedAction)> {
    let with_attribution = |mut action: Map<String, Value>| {
        action.extend(attribution.clone());
        Value::Object(action)
    };
    let op = text_of(present(operation, "op")).unwrap_or_default();
    Ok(match op {
        "add_component" => {
            let id = require_id(operation, "id")?;
            let position = match (present(operation, "x"), present(operation, "y")) {
                (Some(x), Some(y)) => CanvasPoint { x: x.as_f64().unwrap_or(f64::NAN), y: y.as_f64().unwrap_or(f64::NAN) },
                _ => open_spot_near(next, CanvasPoint { x: 120.0, y: 120.0 }),
            };
            let linked = require_linked_design(operation, design_ids)?;
            if let Some(owner) = text_of(present(operation, "ownerServiceId")) {
                require_service(next, &json!({ "ownerServiceId": owner }), "ownerServiceId")?;
            }
            let mut action = Map::new();
            action.insert("id".into(), json!(id));
            action.extend(pick(operation, &["kind", "name", "technology", "description", "properties", "icon"]));
            if let Some(owner) = present(operation, "ownerServiceId") {
                action.insert("serviceId".into(), owner.clone());
            }
            if let Some(Value::String(linked)) = &linked {
                action.insert("designId".into(), json!(linked));
            }
            action.insert("x".into(), json!(position.x));
            action.insert("y".into(), json!(position.y));
            let mut input = action.clone();
            input.remove("x");
            input.remove("y");
            input.insert("position".into(), json!({ "x": position.x, "y": position.y }));
            let design = add_component(next, &typed::<ComponentInput>(Value::Object(input))?)?;
            (design, ("addSystemComponent", with_attribution(action)))
        }
        "update_component" => {
            let component_id = require_existing(next, operation, "componentId")?.to_owned();
            if let Some(owner) = text_of(present(operation, "ownerServiceId")) {
                require_service(next, &json!({ "ownerServiceId": owner }), "ownerServiceId")?;
            }
            let mut changes = pick(operation, &["name", "kind", "technology", "description", "properties", "icon"]);
            if let Some(owner) = present(operation, "ownerServiceId") {
                changes.insert("serviceId".into(), owner.clone());
            }
            if let Some(linked) = require_linked_design(operation, design_ids)? {
                changes.insert("designId".into(), linked);
            }
            if changes.is_empty() {
                return Err("Give at least one field to change.".into());
            }
            let design = update_component(next, &component_id, &typed::<ComponentChanges>(Value::Object(changes.clone()))?)?;
            (design, ("updateSystemComponent", with_attribution(Map::from_iter([("componentId".to_owned(), json!(component_id)), ("changes".to_owned(), Value::Object(changes))]))))
        }
        "move_component" => {
            let component_id = require_existing(next, operation, "componentId")?.to_owned();
            let position = require_point(operation)?;
            let design = move_component(next, &component_id, position)?;
            (design, ("moveSystemComponent", with_attribution(Map::from_iter([("componentId".to_owned(), json!(component_id)), ("x".to_owned(), json!(position.x)), ("y".to_owned(), json!(position.y))]))))
        }
        "remove_component" => {
            let component_id = require_existing(next, operation, "componentId")?.to_owned();
            (remove_component(next, &component_id)?, ("removeSystemComponent", with_attribution(Map::from_iter([("componentId".to_owned(), json!(component_id))]))))
        }
        "add_service" => {
            let id = require_id(operation, "id")?;
            let position = match (present(operation, "x"), present(operation, "y")) {
                (Some(x), Some(y)) => CanvasPoint { x: x.as_f64().unwrap_or(f64::NAN), y: y.as_f64().unwrap_or(f64::NAN) },
                _ => open_service_spot_near(next, CanvasPoint { x: 120.0, y: 120.0 }),
            };
            let mut action = Map::from_iter([("id".to_owned(), json!(id))]);
            action.extend(pick(operation, &["name"]));
            action.insert("x".into(), json!(position.x));
            action.insert("y".into(), json!(position.y));
            let input = json!({ "id": id, "name": present(operation, "name"), "position": { "x": position.x, "y": position.y } });
            (add_service(next, &typed::<ServiceInput>(input)?)?, ("addSystemService", with_attribution(action)))
        }
        "update_service" => {
            let service_id = require_service(next, operation, "serviceId")?.to_owned();
            let Some(name) = present(operation, "name") else { return Err("Give a name to change.".into()) };
            let changes = json!({ "name": name });
            (update_service(next, &service_id, &typed::<ServiceChanges>(changes.clone())?)?, ("updateSystemService", with_attribution(Map::from_iter([("serviceId".to_owned(), json!(service_id)), ("changes".to_owned(), changes)]))))
        }
        "move_service" => {
            let service_id = require_service(next, operation, "serviceId")?.to_owned();
            let position = require_point(operation)?;
            (move_service(next, &service_id, position)?, ("moveSystemService", with_attribution(Map::from_iter([("serviceId".to_owned(), json!(service_id)), ("x".to_owned(), json!(position.x)), ("y".to_owned(), json!(position.y))]))))
        }
        "remove_service" => {
            let service_id = require_service(next, operation, "serviceId")?.to_owned();
            (remove_service(next, &service_id)?, ("removeSystemService", with_attribution(Map::from_iter([("serviceId".to_owned(), json!(service_id))]))))
        }
        "add_group" => {
            let id = require_id(operation, "id")?;
            let member_ids: Vec<String> = present(operation, "memberIds").and_then(Value::as_array).map(|items| items.iter().map(schema_domain::js::to_js_string).collect()).unwrap_or_default();
            let fitted = frame_around_members(next, &member_ids);
            let position = match (present(operation, "x"), present(operation, "y")) {
                (Some(x), Some(y)) => CanvasPoint { x: x.as_f64().unwrap_or(f64::NAN), y: y.as_f64().unwrap_or(f64::NAN) },
                _ => fitted.map_or_else(|| open_service_spot_near(next, CanvasPoint { x: 120.0, y: 120.0 }), |(position, _)| position),
            };
            let size = match (present(operation, "width"), present(operation, "height")) {
                (Some(width), Some(height)) => Size { width: width.as_f64().unwrap_or(f64::NAN), height: height.as_f64().unwrap_or(f64::NAN) },
                _ => fitted.map_or(GROUP_DEFAULT_SIZE, |(_, size)| size),
            };
            let mut action = Map::from_iter([("id".to_owned(), json!(id))]);
            action.extend(pick(operation, &["name"]));
            action.extend([("x".to_owned(), json!(position.x)), ("y".to_owned(), json!(position.y)), ("width".to_owned(), json!(size.width)), ("height".to_owned(), json!(size.height)), ("memberIds".to_owned(), json!(member_ids))]);
            let input = json!({ "id": id, "name": present(operation, "name"), "position": { "x": position.x, "y": position.y }, "size": { "width": size.width, "height": size.height }, "memberIds": member_ids });
            (add_group(next, &typed::<GroupInput>(input)?)?, ("addSystemGroup", with_attribution(action)))
        }
        "update_group" => {
            let group_id = require_group(next, operation, "groupId")?.to_owned();
            let changes = pick(operation, &["name", "memberIds"]);
            if changes.is_empty() {
                return Err("Give at least one field to change.".into());
            }
            (update_group(next, &group_id, &typed::<GroupChanges>(Value::Object(changes.clone()))?)?, ("updateSystemGroup", with_attribution(Map::from_iter([("groupId".to_owned(), json!(group_id)), ("changes".to_owned(), Value::Object(changes))]))))
        }
        "move_group" => {
            let group_id = require_group(next, operation, "groupId")?.to_owned();
            let position = require_point(operation)?;
            (move_group(next, &group_id, position)?, ("moveSystemGroup", with_attribution(Map::from_iter([("groupId".to_owned(), json!(group_id)), ("x".to_owned(), json!(position.x)), ("y".to_owned(), json!(position.y))]))))
        }
        "remove_group" => {
            let group_id = require_group(next, operation, "groupId")?.to_owned();
            (remove_group(next, &group_id)?, ("removeSystemGroup", with_attribution(Map::from_iter([("groupId".to_owned(), json!(group_id))]))))
        }
        "add_connection" => {
            let id = require_id(operation, "id")?;
            let source = require_endpoint(next, operation, "sourceId")?.to_owned();
            let target = require_endpoint(next, operation, "targetId")?.to_owned();
            let mut action = Map::from_iter([("id".to_owned(), json!(id)), ("sourceId".to_owned(), json!(source)), ("targetId".to_owned(), json!(target))]);
            action.extend(pick(operation, &["label", "interactionType", "protocol"]));
            (add_connection(next, &typed::<ConnectionInput>(Value::Object(action.clone()))?)?, ("addSystemConnection", with_attribution(action)))
        }
        "update_connection" => {
            let connection_id = require_connection(next, operation)?.to_owned();
            let mut changes = pick(operation, &["label", "interactionType", "protocol"]);
            if present(operation, "sourceId").is_some() {
                changes.insert("sourceId".into(), json!(require_endpoint(next, operation, "sourceId")?));
            }
            if present(operation, "targetId").is_some() {
                changes.insert("targetId".into(), json!(require_endpoint(next, operation, "targetId")?));
            }
            changes.extend(pick(operation, &["fromSide", "toSide", "bendPoints", "labelOffset"]));
            if changes.is_empty() {
                return Err("Give at least one field to change.".into());
            }
            (update_connection(next, &connection_id, &typed::<ConnectionChanges>(Value::Object(changes.clone()))?)?, ("updateSystemConnection", with_attribution(Map::from_iter([("connectionId".to_owned(), json!(connection_id)), ("changes".to_owned(), Value::Object(changes))]))))
        }
        "remove_connection" => {
            let connection_id = require_connection(next, operation)?.to_owned();
            (remove_connection(next, &connection_id)?, ("removeSystemConnection", with_attribution(Map::from_iter([("connectionId".to_owned(), json!(connection_id))]))))
        }
        "arrange_layout" => {
            let ids: Option<Vec<String>> = present(operation, "componentIds").and_then(Value::as_array).map(|items| items.iter().map(schema_domain::js::to_js_string).collect());
            let placement = compute_system_layout(next, ids.as_deref())?.to_value();
            let design = apply_system_layout(next, &typed::<LayoutPlacement>(placement.clone())?)?;
            (design, ("arrangeSystemLayout", with_attribution(Map::from_iter([("placement".to_owned(), placement)]))))
        }
        other => return Err(format!("Unsupported operation \"{other}\".")),
    })
}

fn describe_impact(before: &SystemDesign, after: &SystemDesign, operation: &Value) -> Vec<String> {
    let mut notes = Vec::new();
    let op = text_of(present(operation, "op")).unwrap_or_default();
    for connection in before.connections.iter().filter(|connection| find_connection(after, &connection.id).is_none()) {
        if text_of(present(operation, "connectionId")) == Some(connection.id.as_str()) {
            continue;
        }
        notes.push(format!("Removed Connection \"{}\" ({}) because one of its endpoints was removed.", connection.label, connection.id));
    }
    let released: Vec<&str> = after
        .components
        .iter()
        .filter(|component| find_component(before, &component.id).is_some_and(|previous| previous.service_id.is_some()) && component.service_id.is_none())
        .map(|component| component.id.as_str())
        .collect();
    if !released.is_empty() {
        notes.push(format!("Released {} Component{} to system scope: {}.", released.len(), if released.len() == 1 { "" } else { "s" }, released.join(", ")));
    }
    for group in &after.groups {
        if let Some(previous) = find_group(before, &group.id) {
            if previous.member_ids != group.member_ids && op != "update_group" {
                notes.push(format!("Group \"{}\" ({}) membership changed.", group.name, group.id));
            }
        }
    }
    if op == "arrange_layout" {
        notes.push(format!("Arranged layout for {} Components.", after.components.len()));
    }
    if op == "move_service" || op == "move_group" {
        let moved: Vec<&str> = after
            .components
            .iter()
            .filter(|component| find_component(before, &component.id).is_some_and(|previous| previous.position.x != component.position.x || previous.position.y != component.position.y))
            .map(|component| component.id.as_str())
            .collect();
        if !moved.is_empty() {
            notes.push(format!("Moved {} Component{} with the frame: {}.", moved.len(), if moved.len() == 1 { "" } else { "s" }, moved.join(", ")));
        }
    }
    notes
}

/// Validates a whole batch against the current design before anything is saved. Any invalid
/// operation fails the batch, so it applies in full or not at all. Operations that are only valid
/// after an earlier one in the batch are accepted, because each is checked against the design it
/// would see. `design_ids` are the database Designs of the Project that a Component may link.
pub fn plan_system_operations(current: &SystemDesign, operations: &[Value], assistant_turn_id: Option<&str>, design_ids: &HashSet<String>) -> Result<SystemPlan> {
    if operations.is_empty() {
        return Err("At least one System design operation is required.".into());
    }
    let attribution: Map<String, Value> = assistant_turn_id.map(|turn| Map::from_iter([("assistantTurnId".to_owned(), json!(turn))])).unwrap_or_default();
    let mut next = current.clone();
    let (mut actions, mut impacts) = (Vec::new(), Vec::new());
    for (index, operation) in operations.iter().enumerate() {
        let label = format!("Operation {} ({})", index + 1, text_of(present(operation, "op")).unwrap_or("undefined"));
        let (design, action) = plan_one(&next, operation, design_ids, &attribution).map_err(|error| format!("{label}: {error}"))?;
        impacts.extend(describe_impact(&next, &design, operation));
        next = design;
        actions.push(action);
    }
    impacts.retain(|note| !note.is_empty());
    Ok(SystemPlan { actions, next, impacts })
}

/* ------------------------------------------------------------ read preconditions */

fn referenced_items(read: &Value, current: &SystemDesign, operation: &Value) -> Vec<String> {
    let mut keys = Vec::new();
    let mut add = |kind: &str, id: Option<&str>| {
        if let Some(id) = id.filter(|id| !id.is_empty()) {
            keys.push(format!("{kind}:{id}"));
        }
    };
    let identity = |id: Option<&str>| -> Option<(&'static str, String)> {
        let id = id.filter(|id| !id.is_empty())?;
        if find_component(current, id).is_some() {
            Some(("component", id.to_owned()))
        } else if find_service(current, id).is_some() {
            Some(("service", id.to_owned()))
        } else if find_group(current, id).is_some() {
            Some(("group", id.to_owned()))
        } else {
            None
        }
    };
    let get = |key: &str| text_of(present(operation, key));
    let components_of = |service: &str| current.components.iter().filter(|component| component.service_id.as_deref() == Some(service)).map(|component| component.id.clone()).collect::<Vec<_>>();
    let connections_and_groups_of = |item: &str| -> Vec<(&'static str, String)> {
        let mut found: Vec<(&'static str, String)> = current.connections.iter().filter(|c| c.source_id == item || c.target_id == item).map(|c| ("connection", c.id.clone())).collect();
        found.extend(groups_containing(current, item).iter().map(|group| ("group", group.id.clone())));
        found
    };
    let members = |key: &str| -> Vec<String> { present(operation, key).and_then(Value::as_array).map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect()).unwrap_or_default() };
    match get("op").unwrap_or_default() {
        "add_component" => add("service", get("ownerServiceId")),
        "update_component" => {
            add("component", get("componentId"));
            add("service", get("ownerServiceId"));
        }
        "move_component" => add("component", get("componentId")),
        "remove_component" => {
            add("component", get("componentId"));
            if let Some(id) = get("componentId").filter(|id| !id.is_empty()) {
                for (kind, found) in connections_and_groups_of(id) {
                    add(kind, Some(&found));
                }
            }
        }
        "update_service" => add("service", get("serviceId")),
        "move_service" => {
            add("service", get("serviceId"));
            if let Some(id) = get("serviceId").filter(|id| !id.is_empty()) {
                for component in components_of(id) {
                    add("component", Some(&component));
                }
            }
        }
        "remove_service" => {
            add("service", get("serviceId"));
            if let Some(id) = get("serviceId").filter(|id| !id.is_empty()) {
                for component in components_of(id) {
                    add("component", Some(&component));
                }
                for (kind, found) in connections_and_groups_of(id) {
                    add(kind, Some(&found));
                }
            }
        }
        "add_group" => {
            for member in members("memberIds") {
                if let Some((kind, id)) = identity(Some(&member)) {
                    add(kind, Some(&id));
                }
            }
        }
        "update_group" => {
            add("group", get("groupId"));
            for member in members("memberIds") {
                if let Some((kind, id)) = identity(Some(&member)) {
                    add(kind, Some(&id));
                }
            }
        }
        "move_group" | "remove_group" => {
            add("group", get("groupId"));
            if let Some(group) = get("groupId").and_then(|id| find_group(current, id)) {
                for member in &group.member_ids {
                    if let Some((kind, id)) = identity(Some(member)) {
                        add(kind, Some(&id));
                    }
                }
            }
        }
        "update_connection" => {
            add("connection", get("connectionId"));
            for key in ["sourceId", "targetId"] {
                if let Some((kind, id)) = identity(get(key)) {
                    add(kind, Some(&id));
                }
            }
        }
        "remove_connection" => add("connection", get("connectionId")),
        "arrange_layout" => {
            for (key, kind) in [("components", "component"), ("services", "service"), ("groups", "group"), ("connections", "connection")] {
                for item in read[key].as_array().into_iter().flatten() {
                    add(kind, item["id"].as_str());
                }
            }
        }
        _ => {}
    }
    keys
}

fn find_current(design: &SystemDesign, kind: &str, id: &str) -> Value {
    match kind {
        "component" => find_component(design, id).map(|item| json!(item)),
        "service" => find_service(design, id).map(|item| json!(item)),
        "group" => find_group(design, id).map(|item| json!(item)),
        "connection" => find_connection(design, id).map(|item| json!(item)),
        _ => None,
    }
    .unwrap_or(Value::Null)
}

/// Refuses a batch that changes an item the Assistant read before the item changed since, including
/// the items an operation depends on: a removed Service's Components and Connections, a Group's
/// members, a moved Group's contents. An arrangement depends on everything it read. Unrelated manual
/// edits do not block the batch.
pub fn check_read_preconditions(read: Option<&Value>, current: &SystemDesign, operations: &[Value]) -> Result<()> {
    let Some(read) = read else { return Ok(()) };
    let mut referenced: Vec<String> = Vec::new();
    for operation in operations {
        for key in referenced_items(read, current, operation) {
            if !referenced.contains(&key) {
                referenced.push(key);
            }
        }
    }
    let mut changed = Vec::new();
    for key in &referenced {
        let (kind, id) = key.split_once(':').unwrap_or_default();
        let list = match kind {
            "component" => "components",
            "service" => "services",
            "group" => "groups",
            _ => "connections",
        };
        let Some(before) = read[list].as_array().and_then(|items| items.iter().find(|item| item["id"].as_str() == Some(id))) else { continue };
        if *before != find_current(current, kind, id) {
            changed.push(format!("{kind} {id}"));
        }
    }
    if changed.is_empty() {
        Ok(())
    } else {
        Err(format!("These items changed after you read the project: {}. Read the project again before editing them.", changed.join(", ")))
    }
}

/* ----------------------------------------------------------------------- tools */

pub struct ReadSystemDesign(pub Arc<ToolContext>);

impl ProjectTool for ReadSystemDesign {
    fn name(&self) -> &str {
        "read_system_design"
    }

    fn description(&self) -> &str {
        "Read the System design in focus: every Service, Group, Component, and Connection with its stable id and version, ownership (ownerServiceId), Group membership and nesting (memberIds, containedInGroupIds), database design links (linkedDesignId), Connection attachment sides, bend points, and label offsets, the database designs the Project offers for linking, and diagnostics. Read before editing; an item changed after your read is refused."
    }

    fn parameters(&self) -> Value {
        json!({ "type": "object", "properties": {} })
    }

    fn execute(&self, _call_id: &str, _arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        let state = context.bound_state()?;
        let design = state.system_design.as_ref().ok_or("The System design is not loaded for this project.")?;
        context.reads.lock().map_err(|_| "Read state is unavailable.")?.system = Some(content_of(design));
        let designs: Vec<(String, String)> = state.designs.iter().map(|summary| (summary.id.clone(), summary.name.clone())).collect();
        let mut body = Map::from_iter([("projectId".to_owned(), json!(context.target.0)), ("designId".to_owned(), json!(context.target.1)), ("revision".to_owned(), json!(state.revision))]);
        if let Value::Object(architecture) = read_system_architecture(design, &designs) {
            body.extend(architecture);
        }
        Ok(ToolResult { content: vec![Value::Object(body).to_string()], details: json!({ "projectId": context.target.0, "designId": context.target.1, "revision": state.revision }), is_error: false })
    }
}

pub struct EditSystemDesign(pub Arc<ToolContext>);

impl ProjectTool for EditSystemDesign {
    fn name(&self) -> &str {
        "edit_system_design"
    }

    fn description(&self) -> &str {
        "Edit the Project's System design in one batch: add, update, move, or remove Services, Components, Groups, and directed, labeled Connections; assign or release Component ownership; link or unlink database components to designs; set Connection attachment sides, bend points, and label offsets; or arrange the layout. Each batch applies in full or not at all. Give new items a new stable id and reuse it in later operations of the same batch. Read the System design before editing: an item changed since your read is refused until you read again. The result lists the impacts of the batch, such as Connections a removal deleted."
    }

    fn parameters(&self) -> Value {
        let enums: Value = serde_json::from_str(ENUMS).unwrap_or(Value::Null);
        let point = json!({ "type": "object", "properties": { "x": { "type": "number" }, "y": { "type": "number" } }, "required": ["x", "y"] });
        let strings_or_null = |description: &str| json!({ "anyOf": [{ "type": "string" }, { "type": "null" }], "description": description });
        json!({
            "type": "object",
            "properties": { "operations": { "type": "array", "items": { "type": "object", "properties": {
                "op": { "enum": ["add_component", "update_component", "move_component", "remove_component", "add_service", "update_service", "move_service", "remove_service", "add_group", "update_group", "move_group", "remove_group", "add_connection", "update_connection", "remove_connection", "arrange_layout"] },
                "id": { "type": "string", "description": "New stable id for an add_ operation" },
                "componentId": { "type": "string" }, "serviceId": { "type": "string" }, "groupId": { "type": "string" }, "connectionId": { "type": "string" },
                "sourceId": { "type": "string", "description": "Existing Component or Service id where a Connection starts" },
                "targetId": { "type": "string", "description": "Existing Component or Service id where a Connection arrives" },
                "componentIds": { "type": "array", "items": { "type": "string" }, "description": "arrange_layout only: the Components to arrange. Omit to arrange every Component." },
                "name": { "type": "string" },
                "kind": { "enum": enums["componentKinds"] },
                "technology": { "type": "string" }, "description": { "type": "string" },
                "properties": { "type": "array", "items": { "type": "object", "properties": { "key": { "type": "string" }, "value": { "type": "string" } }, "required": ["key", "value"] }, "description": "Descriptive properties; replaces the Component's list" },
                "icon": { "enum": enums["customIcons"], "description": "Custom components only" },
                "label": { "type": "string", "description": "Connection label describing the interaction" },
                "interactionType": { "type": "string", "description": "Connection interaction type, such as Synchronous request or Event" },
                "protocol": { "type": "string" },
                "ownerServiceId": strings_or_null("Service that owns the Component; null releases it to system scope"),
                "linkedDesignId": strings_or_null("Database component only: a design id from read_system_design; null unlinks it"),
                "memberIds": { "type": "array", "items": { "type": "string" }, "description": "Group members: Component, Service, or Group ids. Replaces the list; a Group cannot contain itself or a Group that contains it." },
                "fromSide": { "enum": enums["connectionSides"], "description": "Side the Connection leaves its source from; auto restores the default" },
                "toSide": { "enum": enums["connectionSides"], "description": "Side the Connection arrives at its target; auto restores the default" },
                "bendPoints": { "type": "array", "items": point, "description": "Waypoints from source to target; an empty list removes them" },
                "labelOffset": { "anyOf": [point, { "type": "null" }], "description": "Label offset from the route midpoint; null puts the label back on the route" },
                "x": { "type": "number" }, "y": { "type": "number" },
                "width": { "type": "number", "description": "Group width" }, "height": { "type": "number", "description": "Group height" },
            }, "required": ["op"] } } },
            "required": ["operations"],
        })
    }

    fn execute(&self, _call_id: &str, arguments: &Value) -> Result<ToolResult> {
        let context = &self.0;
        let operations = arguments["operations"].as_array().ok_or("operations must be a list.")?;
        let state = context.bound_state()?;
        let current = state.system_design.as_ref().ok_or("The System design is not loaded for this project.")?;
        let read = context.reads.lock().map_err(|_| "Read state is unavailable.")?.system.clone();
        check_read_preconditions(read.as_ref(), current, operations)?;
        let turn = (context.turn_id)();
        let design_ids: HashSet<String> = state.designs.iter().map(|summary| summary.id.clone()).collect();
        let plan = plan_system_operations(current, operations, turn.as_deref(), &design_ids)?;
        // Each planned action goes through the workspace, in order, as the designer's own edit would.
        for (method, params) in plan.actions.iter().cloned() {
            context.workspace.request(method, params)?;
        }
        let after = context.workspace.state();
        let after_design = after.system_design.as_ref().unwrap_or(current).clone();
        let (project, design_id) = (after.project.as_ref().map(|project| project.id.as_str()), after.active_design_id.as_deref());
        if project != Some(context.target.0.as_str()) || design_id != Some(context.target.1.as_str()) {
            return Err("The project changed before the System design edit completed.".into());
        }
        let after_content = content_of(&after_design);
        let removed: Vec<String> = current.connections.iter().filter(|connection| find_connection(&after_design, &connection.id).is_none()).map(|connection| connection.id.clone()).collect();
        let impacted = steps_on_connections(&after.walkthroughs, &removed);
        context.reads.lock().map_err(|_| "Read state is unavailable.")?.system = Some(after_content.clone());
        context.store.observe_project_snapshot(&context.conversation_id, &project_snapshot(&after), after.revision)?;
        let summary = json!({
            "status": "applied", "projectId": context.target.0, "designId": context.target.1, "operations": plan.actions.len(), "impacts": plan.impacts,
            "services": after_design.services.iter().map(|service| json!({ "id": service.id, "name": service.name, "x": service.position.x, "y": service.position.y })).collect::<Vec<_>>(),
            "groups": after_design.groups.iter().map(|group| json!({ "id": group.id, "name": group.name, "memberIds": group.member_ids })).collect::<Vec<_>>(),
            "components": after_design.components.iter().map(|component| json!({
                "id": component.id, "kind": component.kind, "name": component.name, "technology": component.technology, "x": component.position.x, "y": component.position.y,
                "ownerServiceId": component.service_id, "linkedDesignId": component.design_id,
            })).collect::<Vec<_>>(),
            "connections": after_design.connections.iter().map(|connection| json!({ "id": connection.id, "sourceId": connection.source_id, "targetId": connection.target_id, "label": connection.label, "protocol": connection.protocol })).collect::<Vec<_>>(),
            "walkthroughImpacts": impacted.iter().map(|step| json!({ "walkthroughName": step.walkthrough_name, "stepId": step.step_id, "title": step.title, "connectionId": step.connection_id })).collect::<Vec<_>>(),
            "walkthroughDiagnostics": walkthrough_diagnostics(&after.walkthroughs, &after_design),
        });
        Ok(ToolResult { content: vec![summary.to_string()], details: summary, is_error: false })
    }
}
