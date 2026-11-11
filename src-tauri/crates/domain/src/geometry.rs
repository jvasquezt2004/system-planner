use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js::{self, serialize_number};

/// A point in canvas space.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CanvasPoint {
    #[serde(serialize_with = "serialize_number")]
    pub x: f64,
    #[serde(serialize_with = "serialize_number")]
    pub y: f64,
}

/// Screen-space pan and zoom of a canvas.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CanvasViewport {
    #[serde(serialize_with = "serialize_number")]
    pub x: f64,
    #[serde(serialize_with = "serialize_number")]
    pub y: f64,
    #[serde(serialize_with = "serialize_number")]
    pub zoom: f64,
}

pub const DEFAULT_VIEWPORT: CanvasViewport = CanvasViewport { x: 0.0, y: 0.0, zoom: 1.0 };

impl CanvasViewport {
    /// `{ x: finiteOr(v.x, 0), y: finiteOr(v.y, 0), zoom: finiteOr(v.zoom, 1) }`.
    pub fn from_record_or_default(record: &serde_json::Map<String, Value>) -> Self {
        let get = |key: &str, fallback: f64| record.get(key).and_then(js::finite).unwrap_or(fallback);
        Self { x: get("x", 0.0), y: get("y", 0.0), zoom: get("zoom", 1.0) }
    }
}

/// Width and height of a framed region.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Size {
    #[serde(serialize_with = "serialize_number")]
    pub width: f64,
    #[serde(serialize_with = "serialize_number")]
    pub height: f64,
}
