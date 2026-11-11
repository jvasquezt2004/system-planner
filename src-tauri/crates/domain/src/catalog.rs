//! The component catalog: which Component kinds exist, their labels and default
//! names. Identity data only; the editor, playback, and artwork stay in the view.
//!
//! The data is generated from `src/shared/component-catalog.ts` by
//! `src-tauri/fixtures/export-catalog.ts` and embedded here, so the two never drift by
//! hand-copying. Re-run `bun run fixtures` in `tauri/` after changing the catalog.

use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Descriptor {
    pub key: String,
    pub placeholder: String,
}

#[derive(Debug, Deserialize)]
pub struct Operation {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub kind: String,
    pub label: String,
    pub family: String,
    /// The stem of a new Component's default name, such as "Message queue".
    pub default_name: String,
    pub descriptors: Vec<Descriptor>,
    pub operations: Vec<Operation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub kinds: Vec<String>,
    pub custom_icons: Vec<String>,
    pub entries: Vec<CatalogEntry>,
}

pub fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../data/component-catalog.json")).expect("embedded component catalog is valid")
    })
}

pub fn entry_for(kind: &str) -> Option<&'static CatalogEntry> {
    catalog().entries.iter().find(|entry| entry.kind == kind)
}

/// `SYSTEM_COMPONENT_KINDS`: the original `generic` kind plus every catalog kind.
pub fn is_system_component_kind(kind: &str) -> bool {
    kind == "generic" || catalog().kinds.iter().any(|known| known == kind)
}

pub fn is_custom_icon(icon: &str) -> bool {
    catalog().custom_icons.iter().any(|known| known == icon)
}

/// `componentDefaultNameStem`: the stem for a new Component's name; `generic` is outside the catalog.
pub fn default_name_stem(kind: &str) -> &'static str {
    entry_for(kind).map_or("Component", |entry| entry.default_name.as_str())
}

/// `componentKindLabel`.
pub fn kind_label(kind: &str) -> &'static str {
    entry_for(kind).map_or("Component", |entry| entry.label.as_str())
}
