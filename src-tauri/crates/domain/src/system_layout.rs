//! Applying an arrangement of the System design (`applySystemLayout` in
//! `src/shared/system-layout.ts`).
//!
//! The view computes where Components and frames go and sends the placement; the backend only
//! validates it and applies it. Computing a layout (`computeSystemLayout`) is needed again when the
//! Assistant's tools arrive.

use serde::Deserialize;
use serde_json::Value;

use crate::geometry::{CanvasPoint, Size};
use crate::js;
use crate::system_design::SystemDesign;
use crate::system_ops::{find_component, find_group, find_service, move_component};

type Result<T> = std::result::Result<T, String>;

/// A position as it arrives. `x` and `y` stay raw because a missing or non-numeric value must be
/// refused with the same message as a non-finite number.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct PointInput {
    #[serde(default)]
    pub x: Value,
    #[serde(default)]
    pub y: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SizeInput {
    #[serde(default)]
    pub width: Value,
    #[serde(default)]
    pub height: Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComponentPlacement {
    pub id: String,
    #[serde(default)]
    pub position: PointInput,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FramePlacement {
    pub id: String,
    #[serde(default)]
    pub position: PointInput,
    #[serde(default)]
    pub size: SizeInput,
}

/// The positions one arrangement produces. Only the listed items change.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct LayoutPlacement {
    #[serde(default)]
    pub components: Vec<ComponentPlacement>,
    #[serde(default)]
    pub services: Vec<FramePlacement>,
    #[serde(default)]
    pub groups: Vec<FramePlacement>,
}

/// `requireFinitePoint`: finite, then rounded to hundredths.
fn finite_point(point: &PointInput) -> Result<CanvasPoint> {
    match (js::finite(&point.x), js::finite(&point.y)) {
        (Some(x), Some(y)) => Ok(CanvasPoint { x: js::round2(x), y: js::round2(y) }),
        _ => Err("Layout positions must be finite.".into()),
    }
}

/// Applies a placement computed for this design. Unknown ids and non-finite positions refuse the
/// whole placement.
pub fn apply_system_layout(design: &SystemDesign, placement: &LayoutPlacement) -> Result<SystemDesign> {
    let mut next = design.clone();
    for item in &placement.components {
        if find_component(&next, &item.id).is_none() {
            return Err(format!("\"{}\" does not match a Component.", item.id));
        }
        next = move_component(&next, &item.id, finite_point(&item.position)?)?;
    }
    apply_frame_placements(&next, placement)
}

fn check_frames(items: &[FramePlacement], exists: impl Fn(&str) -> bool, label: &str) -> Result<()> {
    for item in items {
        if !exists(&item.id) {
            return Err(format!("\"{}\" does not match a {label}.", item.id));
        }
        finite_point(&item.position)?;
        // Sizes are checked, not rounded: the frame is applied exactly as given.
        finite_point(&PointInput { x: item.size.width.clone(), y: item.size.height.clone() })?;
    }
    Ok(())
}

fn apply_frame_placements(design: &SystemDesign, placement: &LayoutPlacement) -> Result<SystemDesign> {
    check_frames(&placement.services, |id| find_service(design, id).is_some(), "Service")?;
    check_frames(&placement.groups, |id| find_group(design, id).is_some(), "Group")?;
    let frame = |item: &FramePlacement| -> (CanvasPoint, Size) {
        let number = |value: &Value| js::finite(value).unwrap_or(0.0);
        (
            CanvasPoint { x: number(&item.position.x), y: number(&item.position.y) },
            Size { width: number(&item.size.width), height: number(&item.size.height) },
        )
    };
    let mut next = design.clone();
    for service in &mut next.services {
        // `new Map(...)`: a later entry for the same id wins.
        if let Some(item) = placement.services.iter().rev().find(|item| item.id == service.id) {
            (service.position, service.size) = frame(item);
        }
    }
    for group in &mut next.groups {
        if let Some(item) = placement.groups.iter().rev().find(|item| item.id == group.id) {
            (group.position, group.size) = frame(item);
        }
    }
    Ok(next)
}

/* ------------------------------------------------------------ computing a layout */

/// The size of one Component card.
pub const COMPONENT_SIZE: Size = Size { width: 180.0, height: 196.0 };
/// Spacing between layers and rows, sized around one Component card.
pub const LAYOUT_COLUMN_GAP: f64 = 240.0;
pub const LAYOUT_ROW_GAP: f64 = 240.0;
/// Space a frame leaves around its contents. The Service and Group header sits above the top padding.
pub const FRAME_PADDING: f64 = 32.0;
pub const FRAME_HEADER: f64 = 48.0;
/// Space between one Service's frame and the next band's frame.
pub const LAYOUT_BAND_GAP: f64 = 24.0;

#[derive(Debug, Clone, PartialEq)]
pub struct FrameResult {
    pub id: String,
    pub position: CanvasPoint,
    pub size: Size,
}

/// The positions one arrangement produces. Only the listed items change.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ComputedPlacement {
    pub components: Vec<(String, CanvasPoint)>,
    pub services: Vec<FrameResult>,
    pub groups: Vec<FrameResult>,
}

impl ComputedPlacement {
    /// The placement as the view sends it and `arrangeSystemLayout` takes it.
    pub fn to_value(&self) -> Value {
        let point = |point: &CanvasPoint| serde_json::json!({ "x": js_number(point.x), "y": js_number(point.y) });
        let frame = |frame: &FrameResult| {
            serde_json::json!({ "id": frame.id, "position": point(&frame.position), "size": { "width": js_number(frame.size.width), "height": js_number(frame.size.height) } })
        };
        serde_json::json!({
            "components": self.components.iter().map(|(id, position)| serde_json::json!({ "id": id, "position": point(position) })).collect::<Vec<_>>(),
            "services": self.services.iter().map(frame).collect::<Vec<_>>(),
            "groups": self.groups.iter().map(frame).collect::<Vec<_>>(),
        })
    }
}

/// A whole number as an integer, as JSON written by JavaScript has it.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9.0e15 { Value::from(value as i64) } else { serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number) }
}

#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The frame that covers the rectangles with padding and a header, or `None` when there is nothing to cover.
fn fit_frame(boxes: &[Rect], minimum: Size) -> Option<(CanvasPoint, Size)> {
    if boxes.is_empty() {
        return None;
    }
    let left = boxes.iter().map(|b| b.x).fold(f64::INFINITY, f64::min);
    let top = boxes.iter().map(|b| b.y).fold(f64::INFINITY, f64::min);
    let right = boxes.iter().map(|b| b.x + b.width).fold(f64::NEG_INFINITY, f64::max);
    let bottom = boxes.iter().map(|b| b.y + b.height).fold(f64::NEG_INFINITY, f64::max);
    Some((
        CanvasPoint { x: js::round(left - FRAME_PADDING), y: js::round(top - FRAME_PADDING - FRAME_HEADER) },
        Size {
            width: minimum.width.max(js::round(right - left + FRAME_PADDING * 2.0)),
            height: minimum.height.max(js::round(bottom - top + FRAME_PADDING * 2.0 + FRAME_HEADER)),
        },
    ))
}

fn member_rects(design: &SystemDesign, member_ids: &[String]) -> Vec<Rect> {
    let mut rects = Vec::new();
    for id in member_ids {
        if let Some(component) = find_component(design, id) {
            rects.push(Rect { x: component.position.x, y: component.position.y, width: COMPONENT_SIZE.width, height: COMPONENT_SIZE.height });
        } else if let Some(service) = find_service(design, id) {
            rects.push(Rect { x: service.position.x, y: service.position.y, width: service.size.width, height: service.size.height });
        } else if let Some(group) = find_group(design, id) {
            rects.push(Rect { x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height });
        }
    }
    rects
}

/// The frame an added Group takes when it is given members and no position: it covers those
/// members as the arrangement would. `None` when none of them exist.
pub fn frame_around_members(design: &SystemDesign, member_ids: &[String]) -> Option<(CanvasPoint, Size)> {
    fit_frame(&member_rects(design, member_ids), crate::system_design::GROUP_MIN_SIZE)
}

/// Layers Components by longest path along Connections inside the scope. A Connection that closes
/// a cycle is ignored for layering, so every Component still gets a layer.
fn layer_components(design: &SystemDesign, ids: &[String], scope: &std::collections::HashSet<&str>) -> std::collections::HashMap<String, i64> {
    use std::collections::{HashMap, HashSet};
    let edges: Vec<_> = design.connections.iter().filter(|c| scope.contains(c.source_id.as_str()) && scope.contains(c.target_id.as_str()) && c.source_id != c.target_id).collect();
    let mut outgoing: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &edges {
        outgoing.entry(&edge.source_id).or_default().push(&edge.target_id);
    }
    fn visit<'a>(id: &'a str, outgoing: &HashMap<&'a str, Vec<&'a str>>, visiting: &mut HashSet<&'a str>, finished: &mut HashSet<&'a str>, back: &mut HashSet<(String, String)>) {
        visiting.insert(id);
        for target in outgoing.get(id).into_iter().flatten() {
            if visiting.contains(target) {
                back.insert((id.to_owned(), (*target).to_owned()));
            } else if !finished.contains(target) {
                visit(target, outgoing, visiting, finished, back);
            }
        }
        visiting.remove(id);
        finished.insert(id);
    }
    let (mut visiting, mut finished, mut back) = (HashSet::new(), HashSet::new(), HashSet::new());
    for id in ids {
        if !finished.contains(id.as_str()) {
            visit(id, &outgoing, &mut visiting, &mut finished, &mut back);
        }
    }
    let mut incoming: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &edges {
        if !back.contains(&(edge.source_id.clone(), edge.target_id.clone())) {
            incoming.entry(&edge.target_id).or_default().push(&edge.source_id);
        }
    }
    fn layer_of<'a>(id: &'a str, incoming: &HashMap<&'a str, Vec<&'a str>>, layers: &mut HashMap<String, i64>) -> i64 {
        if let Some(known) = layers.get(id) {
            return *known;
        }
        let sources = incoming.get(id).cloned().unwrap_or_default();
        let layer = if sources.is_empty() { 0 } else { sources.iter().map(|source| layer_of(source, incoming, layers)).max().unwrap_or(0) + 1 };
        layers.insert(id.to_owned(), layer);
        layer
    }
    let mut layers = HashMap::new();
    for id in ids {
        layer_of(id, &incoming, &mut layers);
    }
    layers
}

/// Groups ordered so every nested Group comes before the Group that contains it.
fn groups_in_nesting_order(design: &SystemDesign) -> Vec<String> {
    fn visit(design: &SystemDesign, id: &str, seen: &mut Vec<String>, ordered: &mut Vec<String>) {
        if seen.iter().any(|seen| seen == id) {
            return;
        }
        seen.push(id.to_owned());
        if let Some(group) = find_group(design, id) {
            for member in &group.member_ids {
                if find_group(design, member).is_some() {
                    visit(design, member, seen, ordered);
                }
            }
        }
        ordered.push(id.to_owned());
    }
    let (mut seen, mut ordered) = (Vec::new(), Vec::new());
    for group in &design.groups {
        visit(design, &group.id, &mut seen, &mut ordered);
    }
    ordered
}

fn placement_of(services: &[FrameResult], groups: &[FrameResult]) -> LayoutPlacement {
    let value = ComputedPlacement { components: vec![], services: services.to_vec(), groups: groups.to_vec() }.to_value();
    serde_json::from_value(value).unwrap_or_default()
}

/// Computes a layered arrangement of `component_ids`, or of every Component when omitted. Layers
/// flow left to right along the Connections between arranged Components. Each Service's Components
/// form their own band of rows, stacked top to bottom, so Service boundaries never overlap;
/// system-scope Components go in a final band. Cycles are broken where the walk first closes them.
/// Frames of Services and Groups that hold an arranged Component are refitted; others keep their place.
pub fn compute_system_layout(design: &SystemDesign, component_ids: Option<&[String]>) -> Result<ComputedPlacement> {
    let mut scope: Vec<&crate::system_design::SystemComponent> = Vec::new();
    match component_ids {
        None => scope.extend(design.components.iter()),
        Some(ids) => {
            let mut seen: Vec<&str> = Vec::new();
            for id in ids {
                if seen.contains(&id.as_str()) {
                    continue;
                }
                seen.push(id);
                scope.push(find_component(design, id).ok_or_else(|| format!("\"{id}\" does not match a Component."))?);
            }
        }
    }
    if scope.is_empty() {
        return Ok(ComputedPlacement::default());
    }
    let scope_ids: std::collections::HashSet<&str> = scope.iter().map(|component| component.id.as_str()).collect();
    let ordered_ids: Vec<String> = scope.iter().map(|component| component.id.clone()).collect();
    let layers = layer_components(design, &ordered_ids, &scope_ids);
    let origin = CanvasPoint {
        x: scope.iter().map(|c| c.position.x).fold(f64::INFINITY, f64::min),
        y: scope.iter().map(|c| c.position.y).fold(f64::INFINITY, f64::min),
    };

    let mut components: Vec<(String, CanvasPoint)> = Vec::new();
    let mut band_top = origin.y;
    let bands: Vec<Option<&str>> = design.services.iter().map(|service| Some(service.id.as_str())).chain(std::iter::once(None)).collect();
    for owner in bands {
        let members: Vec<&str> = scope.iter().filter(|component| component.service_id.as_deref() == owner).map(|component| component.id.as_str()).collect();
        if members.is_empty() {
            continue;
        }
        let mut rows_by_layer: Vec<(i64, Vec<&str>)> = Vec::new();
        for id in &members {
            let layer = layers.get(*id).copied().unwrap_or(0);
            match rows_by_layer.iter_mut().find(|(candidate, _)| *candidate == layer) {
                Some((_, ids)) => ids.push(id),
                None => rows_by_layer.push((layer, vec![id])),
            }
        }
        let mut rows = 1usize;
        for (layer, ids) in &rows_by_layer {
            for (row, id) in ids.iter().enumerate() {
                components.push(((*id).to_owned(), CanvasPoint { x: origin.x + *layer as f64 * LAYOUT_COLUMN_GAP, y: band_top + row as f64 * LAYOUT_ROW_GAP }));
            }
            rows = rows.max(ids.len());
        }
        band_top += (rows - 1) as f64 * LAYOUT_ROW_GAP + COMPONENT_SIZE.height + FRAME_PADDING * 2.0 + FRAME_HEADER + LAYOUT_BAND_GAP;
    }

    // The design as it will look once the Components move, used to fit frames around them.
    let mut arranged = design.clone();
    for (id, position) in &components {
        arranged = move_component(&arranged, id, *position)?;
    }

    let mut changed: std::collections::HashSet<String> = scope_ids.iter().map(|id| (*id).to_owned()).collect();
    let mut services: Vec<FrameResult> = Vec::new();
    for service in &design.services {
        let owned: Vec<Rect> = arranged
            .components
            .iter()
            .filter(|component| component.service_id.as_deref() == Some(service.id.as_str()))
            .map(|component| Rect { x: component.position.x, y: component.position.y, width: COMPONENT_SIZE.width, height: COMPONENT_SIZE.height })
            .collect();
        if !arranged.components.iter().any(|component| component.service_id.as_deref() == Some(service.id.as_str()) && changed.contains(&component.id)) {
            continue;
        }
        let (position, size) = fit_frame(&owned, crate::system_design::SERVICE_MIN_SIZE).unwrap_or((service.position, service.size));
        services.push(FrameResult { id: service.id.clone(), position, size });
        changed.insert(service.id.clone());
    }
    arranged = apply_frame_placements(&arranged, &placement_of(&services, &[]))?;

    let mut groups: Vec<FrameResult> = Vec::new();
    for group_id in groups_in_nesting_order(design) {
        let Some(group) = find_group(&arranged, &group_id) else { continue };
        if !group.member_ids.iter().any(|member| changed.contains(member)) {
            continue;
        }
        let (position, size) = fit_frame(&member_rects(&arranged, &group.member_ids), crate::system_design::GROUP_MIN_SIZE).unwrap_or((group.position, group.size));
        let result = FrameResult { id: group.id.clone(), position, size };
        changed.insert(group.id.clone());
        arranged = apply_frame_placements(&arranged, &placement_of(&[], std::slice::from_ref(&result)))?;
        groups.push(result);
    }
    Ok(ComputedPlacement { components, services, groups })
}

/// A free top-left spot for a new Component card near `center`.
pub fn open_spot_near(design: &SystemDesign, center: CanvasPoint) -> CanvasPoint {
    let step = 40.0;
    let free = |point: CanvasPoint| {
        design.components.iter().all(|component| {
            (component.position.x - point.x).abs() >= COMPONENT_SIZE.width + 16.0 || (component.position.y - point.y).abs() >= COMPONENT_SIZE.height + 16.0
        })
    };
    for ring in 0..20 {
        let ring = f64::from(ring);
        let mut dx = -ring;
        while dx <= ring {
            for dy in [-ring, ring] {
                let candidate = CanvasPoint { x: js::round(center.x + dx * step), y: js::round(center.y + dy * step) };
                if free(candidate) {
                    return candidate;
                }
            }
            dx += 1.0;
        }
    }
    CanvasPoint { x: js::round(center.x), y: js::round(center.y) }
}

/// A free top-left spot for a new Service boundary of the default size, clear of other Services.
pub fn open_service_spot_near(design: &SystemDesign, center: CanvasPoint) -> CanvasPoint {
    let step = 40.0;
    let size = crate::system_design::SERVICE_DEFAULT_SIZE;
    let origin = CanvasPoint { x: js::round(center.x - size.width / 2.0), y: js::round(center.y - size.height / 2.0) };
    let gap = 16.0;
    let free = |point: CanvasPoint| {
        design.services.iter().all(|service| {
            service.position.x + service.size.width + gap <= point.x
                || point.x + size.width + gap <= service.position.x
                || service.position.y + service.size.height + gap <= point.y
                || point.y + size.height + gap <= service.position.y
        })
    };
    for ring in 0..20 {
        let ring = f64::from(ring);
        let mut dx = -ring;
        while dx <= ring {
            for dy in [-ring, ring] {
                let candidate = CanvasPoint { x: js::round(origin.x + dx * step), y: js::round(origin.y + dy * step) };
                if free(candidate) {
                    return candidate;
                }
            }
            dx += 1.0;
        }
    }
    origin
}
