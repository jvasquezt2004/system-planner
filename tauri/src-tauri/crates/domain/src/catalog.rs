//! Component kinds and custom icons from `src/shared/component-catalog.ts`.
//!
//! Only the identity lists live here for now: they decide which stored kinds are
//! valid. Labels, descriptors, and operation presets arrive with the System
//! design editing port.

pub const CLIENT_TRAFFIC_KINDS: &[&str] = &[
    "person", "browser", "mobile_app", "external_system", "dns", "cdn", "load_balancer", "api_gateway", "proxy",
];
pub const COMPUTE_KINDS: &[&str] = &["application", "api", "worker", "scheduled_job", "serverless_handler"];
pub const DATA_KINDS: &[&str] = &["database", "cache", "object_storage_bucket", "file_storage", "search_index"];
pub const MESSAGING_KINDS: &[&str] = &["queue", "topic", "event_bus", "event_stream"];
pub const SUPPORTING_KINDS: &[&str] = &["identity_provider", "secrets_store", "configuration", "observability"];
pub const CUSTOM_KINDS: &[&str] = &["custom"];

pub const CUSTOM_ICONS: &[&str] = &["rectangle", "hexagon", "diamond", "cylinder", "cloud", "document", "gear"];

/// `SYSTEM_COMPONENT_KINDS`: the original `generic` kind plus every catalog kind.
pub fn is_system_component_kind(kind: &str) -> bool {
    kind == "generic"
        || [CLIENT_TRAFFIC_KINDS, COMPUTE_KINDS, DATA_KINDS, MESSAGING_KINDS, SUPPORTING_KINDS, CUSTOM_KINDS]
            .iter()
            .any(|kinds| kinds.contains(&kind))
}

pub fn is_custom_icon(icon: &str) -> bool {
    CUSTOM_ICONS.contains(&icon)
}
