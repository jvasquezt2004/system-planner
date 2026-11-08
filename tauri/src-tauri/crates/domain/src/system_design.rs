//! The System design document: Services, Groups, Components, and Connections.
//!
//! `normalize_system_design` is a line-for-line port of `normalizeSystemDesign`
//! in `src/shared/system-design.ts`, including the order in which problems are
//! detected, because only the first one is reported. Differential fixtures in
//! `tauri/fixtures` hold the two implementations to identical behaviour.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::catalog::{is_custom_icon, is_system_component_kind};
use crate::geometry::{CanvasPoint, CanvasViewport, DEFAULT_VIEWPORT, Size};
use crate::js;

pub const NAME_LIMIT: usize = 80;
pub const CONNECTION_LABEL_LIMIT: usize = 80;
pub const PROPERTY_LIMIT: usize = 40;
pub const CONNECTION_BEND_LIMIT: usize = 8;
pub const SERVICE_DEFAULT_SIZE: Size = Size { width: 420.0, height: 280.0 };
pub const SERVICE_MIN_SIZE: Size = Size { width: 240.0, height: 160.0 };
pub const GROUP_DEFAULT_SIZE: Size = Size { width: 360.0, height: 240.0 };
pub const GROUP_MIN_SIZE: Size = Size { width: 160.0, height: 120.0 };

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComponentProperty {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemComponent {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub technology: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub properties: Vec<ComponentProperty>,
    pub position: CanvasPoint,
    /// The owning Service, or `null` at system scope.
    pub service_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemService {
    pub id: String,
    pub name: String,
    pub position: CanvasPoint,
    pub size: Size,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemGroup {
    pub id: String,
    pub name: String,
    pub position: CanvasPoint,
    pub size: Size,
    pub member_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemConnection {
    pub id: String,
    pub source_id: String,
    pub target_id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interaction_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// Stored only when not automatic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_side: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_side: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bend_points: Option<Vec<CanvasPoint>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_offset: Option<CanvasPoint>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDesign {
    pub services: Vec<SystemService>,
    pub groups: Vec<SystemGroup>,
    pub components: Vec<SystemComponent>,
    pub connections: Vec<SystemConnection>,
    pub viewport: CanvasViewport,
    pub collapsed_service_ids: Vec<String>,
    pub focused_service_id: Option<String>,
    pub focus_viewport: CanvasViewport,
}

/// Which overview a Project reopens to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemViewName {
    System,
    Database,
}

impl SystemViewName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Database => "database",
        }
    }

    /// Any stored value other than `database` means the system overview.
    pub fn from_stored(value: &str) -> Self {
        if value == "database" { Self::Database } else { Self::System }
    }
}

pub fn create_empty_system_design() -> SystemDesign {
    SystemDesign {
        services: vec![],
        groups: vec![],
        components: vec![],
        connections: vec![],
        viewport: DEFAULT_VIEWPORT,
        collapsed_service_ids: vec![],
        focused_service_id: None,
        focus_viewport: DEFAULT_VIEWPORT,
    }
}

/// The overview of a Project migrated from the single-database model.
pub fn create_migrated_system_design(database_design_id: &str, component_id: &str, name: &str) -> SystemDesign {
    SystemDesign {
        components: vec![SystemComponent {
            id: component_id.into(),
            kind: "database".into(),
            name: name.into(),
            technology: None,
            description: None,
            properties: vec![],
            position: CanvasPoint { x: 120.0, y: 120.0 },
            service_id: None,
            design_id: Some(database_design_id.into()),
            icon: None,
        }],
        ..create_empty_system_design()
    }
}

type Result<T> = std::result::Result<T, String>;

fn malformed() -> String {
    "The saved System design is malformed.".into()
}

pub fn normalize_system_design(value: &Value) -> Result<SystemDesign> {
    let root = js::record(value).ok_or_else(malformed)?;
    let (Some(Value::Array(raw_components)), Some(Value::Array(raw_connections))) =
        (root.get("components"), root.get("connections"))
    else {
        return Err(malformed());
    };
    let empty = Value::Array(vec![]);
    let raw_services = js::nullish(root.get("services")).unwrap_or(&empty);
    let raw_groups = js::nullish(root.get("groups")).unwrap_or(&empty);
    let (Value::Array(raw_services), Value::Array(raw_groups)) = (raw_services, raw_groups) else {
        return Err(malformed());
    };

    let mut services = Vec::new();
    let mut service_ids = HashSet::new();
    for item in raw_services {
        let item = js::record(item).ok_or("A saved Service is malformed.")?;
        let id = require_identity(item.get("id"), "Service id")?;
        if !service_ids.insert(id.clone()) {
            return Err(format!("Service \"{id}\" is duplicated."));
        }
        let name = require_name(item.get("name"), "Service name", NAME_LIMIT)?;
        let position = require_position(item.get("position"), "Service position")?;
        let size = normalize_frame_size(item.get("size"), SERVICE_DEFAULT_SIZE, SERVICE_MIN_SIZE)?;
        services.push(SystemService { id, name, position, size });
    }

    let mut groups = Vec::new();
    let mut group_ids = HashSet::new();
    for item in raw_groups {
        let item = js::record(item).ok_or("A saved Group is malformed.")?;
        let id = require_identity(item.get("id"), "Group id")?;
        if group_ids.contains(&id) {
            return Err(format!("Group \"{id}\" is duplicated."));
        }
        if service_ids.contains(&id) {
            return Err(format!("Group \"{id}\" uses the id of a Service."));
        }
        group_ids.insert(id.clone());
        let members = js::nullish(item.get("memberIds")).unwrap_or(&empty);
        let Value::Array(members) = members else {
            return Err(format!("Group \"{id}\" has malformed members."));
        };
        let name = require_name(item.get("name"), "Group name", NAME_LIMIT)?;
        let position = require_position(item.get("position"), "Group position")?;
        let size = normalize_frame_size(item.get("size"), GROUP_DEFAULT_SIZE, GROUP_MIN_SIZE)?;
        let member_ids = members
            .iter()
            .map(|member| require_identity(Some(member), &format!("Group \"{id}\" member")))
            .collect::<Result<Vec<_>>>()?;
        groups.push(SystemGroup { id, name, position, size, member_ids });
    }

    let mut components = Vec::new();
    let mut component_ids = HashSet::new();
    for item in raw_components {
        let item = js::record(item).ok_or("A saved Component is malformed.")?;
        let id = require_identity(item.get("id"), "Component id")?;
        if component_ids.contains(&id) {
            return Err(format!("Component \"{id}\" is duplicated."));
        }
        if service_ids.contains(&id) {
            return Err(format!("Component \"{id}\" uses the id of a Service."));
        }
        if group_ids.contains(&id) {
            return Err(format!("Component \"{id}\" uses the id of a Group."));
        }
        component_ids.insert(id.clone());
        let service_id = item.get("serviceId").and_then(Value::as_str).map(str::to_owned);
        if let Some(service_id) = &service_id {
            if !service_ids.contains(service_id) {
                return Err(format!("Component \"{id}\" belongs to a Service that does not exist."));
            }
        }
        let kind = require_kind(item.get("kind"))?;
        let name = require_name(item.get("name"), "Component name", NAME_LIMIT)?;
        let properties = normalize_properties(match item.get("properties") {
            Some(Value::Array(values)) => values,
            _ => &[],
        })?;
        let position = require_position(item.get("position"), "Component position")?;
        let technology = optional_text(item.get("technology").and_then(Value::as_str));
        let description = optional_text(item.get("description").and_then(Value::as_str));
        let design_id = item.get("designId").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned);
        let icon = optional_icon(item.get("icon"))?;
        if design_id.is_some() && kind != "database" {
            return Err("Only a Database component can link to a database design.".into());
        }
        if icon.is_some() && kind != "custom" {
            return Err("Only a Custom component can choose an icon or shape.".into());
        }
        components.push(SystemComponent {
            id,
            kind,
            name,
            technology,
            description,
            properties,
            position,
            service_id,
            design_id,
            icon,
        });
    }

    let endpoint_ids: HashSet<&String> = component_ids.iter().chain(service_ids.iter()).collect();
    let identity_ids: HashSet<&String> = endpoint_ids.iter().copied().chain(group_ids.iter()).collect();
    for group in &groups {
        if group.member_ids.iter().collect::<HashSet<_>>().len() != group.member_ids.len() {
            return Err(format!("Group \"{}\" lists a member twice.", group.id));
        }
        for member_id in &group.member_ids {
            if member_id == &group.id {
                return Err(format!("Group \"{}\" cannot contain itself.", group.id));
            }
            if !identity_ids.contains(member_id) {
                return Err(format!("Group \"{}\" contains \"{member_id}\", which does not exist.", group.id));
            }
        }
        if reaches_group(&groups, &group.id, &group.id) {
            return Err(format!("Group \"{}\" is part of a nesting cycle.", group.id));
        }
    }

    let mut connections = Vec::new();
    let mut connection_ids = HashSet::new();
    for item in raw_connections {
        let item = js::record(item).ok_or("A saved Connection is malformed.")?;
        let id = require_identity(item.get("id"), "Connection id")?;
        if !connection_ids.insert(id.clone()) {
            return Err(format!("Connection \"{id}\" is duplicated."));
        }
        let source_id = require_identity(item.get("sourceId"), "Connection source")?;
        let target_id = require_identity(item.get("targetId"), "Connection target")?;
        if !endpoint_ids.contains(&source_id) || !endpoint_ids.contains(&target_id) {
            return Err(format!("Connection \"{id}\" refers to a Component that does not exist."));
        }
        if source_id == target_id {
            return Err(format!("Connection \"{id}\" must join two different Components."));
        }
        let label = require_name(item.get("label"), "Connection label", CONNECTION_LABEL_LIMIT)?;
        let interaction_type = optional_text(item.get("interactionType").and_then(Value::as_str));
        let protocol = optional_text(item.get("protocol").and_then(Value::as_str));
        let route = normalize_route_fields(item)?;
        connections.push(SystemConnection {
            id,
            source_id,
            target_id,
            label,
            interaction_type,
            protocol,
            from_side: route.from_side,
            to_side: route.to_side,
            bend_points: route.bend_points,
            label_offset: route.label_offset,
        });
    }

    let viewport_record = js::record(root.get("viewport").unwrap_or(&Value::Null));
    let viewport = viewport_record.map(CanvasViewport::from_record_or_default).unwrap_or(DEFAULT_VIEWPORT);
    // Documents saved before collapsing existed have none. A stale id is dropped, not an error.
    let collapsed_service_ids = match root.get("collapsedServiceIds") {
        Some(Value::Array(ids)) => {
            let mut seen = HashSet::new();
            ids.iter()
                .filter_map(Value::as_str)
                .filter(|id| service_ids.contains(*id))
                .filter(|id| seen.insert(*id))
                .map(str::to_owned)
                .collect()
        }
        _ => vec![],
    };
    let focused_service_id = root
        .get("focusedServiceId")
        .and_then(Value::as_str)
        .filter(|id| service_ids.contains(*id))
        .map(str::to_owned);
    let focus_viewport = match js::record(root.get("focusViewport").unwrap_or(&Value::Null)) {
        Some(record) => CanvasViewport::from_record_or_default(record),
        None => viewport,
    };

    Ok(SystemDesign {
        services,
        groups,
        components,
        connections,
        viewport,
        collapsed_service_ids,
        focused_service_id,
        focus_viewport,
    })
}

/// True when `target` is reachable from `from` through member Groups.
fn reaches_group(groups: &[SystemGroup], from: &str, target: &str) -> bool {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut stack = vec![from];
    while let Some(current) = stack.pop() {
        let Some(group) = groups.iter().find(|group| group.id == current) else { continue };
        for member in &group.member_ids {
            if member == target {
                return true;
            }
            if seen.insert(member) {
                stack.push(member);
            }
        }
    }
    false
}

struct Route {
    from_side: Option<String>,
    to_side: Option<String>,
    bend_points: Option<Vec<CanvasPoint>>,
    label_offset: Option<CanvasPoint>,
}

fn normalize_route_fields(item: &Map<String, Value>) -> Result<Route> {
    let side = |key: &str| -> Result<Option<String>> {
        match js::nullish(item.get(key)) {
            None => Ok(None),
            Some(value) => {
                let side = require_side(value)?;
                Ok((side != "auto").then_some(side))
            }
        }
    };
    let from_side = side("fromSide")?;
    let to_side = side("toSide")?;
    let mut bend_points = None;
    if let Some(value) = js::nullish(item.get("bendPoints")) {
        let Value::Array(values) = value else {
            return Err("A saved Connection has malformed bend points.".into());
        };
        if values.len() > CONNECTION_BEND_LIMIT {
            return Err(format!("A Connection can have at most {CONNECTION_BEND_LIMIT} bend points."));
        }
        let bends = values.iter().map(|value| require_position(Some(value), "Bend point")).collect::<Result<Vec<_>>>()?;
        if !bends.is_empty() {
            bend_points = Some(bends);
        }
    }
    let label_offset = match js::nullish(item.get("labelOffset")) {
        Some(value) => Some(require_position(Some(value), "Label offset")?),
        None => None,
    };
    Ok(Route { from_side, to_side, bend_points, label_offset })
}

fn require_side(value: &Value) -> Result<String> {
    match value.as_str() {
        Some(side @ ("auto" | "top" | "right" | "bottom" | "left")) => Ok(side.to_owned()),
        _ => Err("A Connection side must be top, right, bottom, left, or auto.".into()),
    }
}

fn require_kind(value: Option<&Value>) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(kind) if is_system_component_kind(kind) => Ok(kind.to_owned()),
        _ => Err(format!("Unsupported Component kind \"{}\".", value.map_or("undefined".into(), js::to_js_string))),
    }
}

fn require_identity(value: Option<&Value>, label: &str) -> Result<String> {
    match value.and_then(Value::as_str) {
        Some(id) if !js::trim(id).is_empty() => Ok(id.to_owned()),
        _ => Err(format!("{label} is required.")),
    }
}

fn require_name(value: Option<&Value>, label: &str, limit: usize) -> Result<String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(format!("{label} is required."));
    };
    let trimmed = js::trim(text);
    if trimmed.is_empty() {
        return Err(format!("{label} is required."));
    }
    if js::length(trimmed) > limit {
        return Err(format!("{label} must be {limit} characters or fewer."));
    }
    Ok(trimmed.to_owned())
}

fn require_position(point: Option<&Value>, label: &str) -> Result<CanvasPoint> {
    let finite = |key: &str| point.and_then(Value::as_object).and_then(|point| point.get(key)).and_then(js::finite);
    match (finite("x"), finite("y")) {
        (Some(x), Some(y)) => Ok(CanvasPoint { x: js::round2(x), y: js::round2(y) }),
        _ => Err(format!("{label} must be finite.")),
    }
}

fn normalize_frame_size(size: Option<&Value>, default: Size, minimum: Size) -> Result<Size> {
    // A missing or non-record size falls back to the default; a record must carry finite numbers.
    let Some(record) = size.and_then(js::record) else { return Ok(normalize_size(default, minimum)) };
    match (record.get("width").and_then(js::finite), record.get("height").and_then(js::finite)) {
        (Some(width), Some(height)) => Ok(normalize_size(Size { width, height }, minimum)),
        _ => Err("Size must be finite.".into()),
    }
}

fn normalize_size(size: Size, minimum: Size) -> Size {
    Size { width: minimum.width.max(js::round(size.width)), height: minimum.height.max(js::round(size.height)) }
}

fn normalize_properties(values: &[Value]) -> Result<Vec<ComponentProperty>> {
    if values.len() > PROPERTY_LIMIT {
        return Err(format!("A Component can have at most {PROPERTY_LIMIT} properties."));
    }
    let mut keys = HashSet::new();
    values
        .iter()
        .map(|item| {
            let item = js::record(item).ok_or("A Component property is malformed.")?;
            let key = require_name(item.get("key"), "Property name", 60)?;
            if !keys.insert(key.clone()) {
                return Err(format!("Property \"{key}\" is duplicated."));
            }
            let Some(value) = item.get("value").and_then(Value::as_str) else {
                return Err(format!("Property \"{key}\" needs a text value."));
            };
            Ok(ComponentProperty { key, value: js::slice(value, 500) })
        })
        .collect()
}

fn optional_text(value: Option<&str>) -> Option<String> {
    let trimmed = js::trim(value?);
    (!trimmed.is_empty()).then(|| js::slice(trimmed, 500))
}

fn optional_icon(icon: Option<&Value>) -> Result<Option<String>> {
    match icon {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(icon)) if is_custom_icon(icon) => Ok(Some(icon.clone())),
        Some(other) => Err(format!("Unsupported Component icon \"{}\".", js::to_js_string(other))),
    }
}
