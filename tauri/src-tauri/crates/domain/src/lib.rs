//! Domain models for Schema Designer.
//!
//! Every type here mirrors a document the Electrobun app already stores, so a
//! database written by that app opens unchanged. The TypeScript implementation is
//! the oracle: fixtures under `tauri/fixtures` hold the two to identical behaviour.

pub mod catalog;
pub mod column_defaults;
pub mod column_types;
pub mod design;
pub mod design_edits;
pub mod geometry;
pub mod index_methods;
pub mod js;
pub mod patch;
pub mod postgres_identifiers;
pub mod project_history;
pub mod project_portability;
pub mod relationships;
pub mod schema_identity;
pub mod sql;
pub mod system_design;
pub mod system_layout;
pub mod system_ops;
pub mod walkthrough;
pub mod walkthrough_ops;
