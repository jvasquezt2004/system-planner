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
