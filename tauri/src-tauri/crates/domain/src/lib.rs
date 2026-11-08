//! Domain models for Schema Designer.
//!
//! Every type here mirrors a document the Electrobun app already stores, so a
//! database written by that app opens unchanged. The TypeScript implementation is
//! the oracle: fixtures under `tauri/fixtures` hold the two to identical behaviour.

pub mod catalog;
pub mod column_defaults;
pub mod design;
pub mod geometry;
pub mod js;
pub mod system_design;
pub mod walkthrough;
