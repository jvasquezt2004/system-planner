//! Records the store reads and writes. Field names serialize as the TypeScript
//! store's do, so the same JSON describes a record on both sides.

use schema_domain::system_design::SystemViewName;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
}

/// A write of one stored design document. `revision` counts structural schema
/// edits, while `document_revision` orders every write, layout-only ones
/// included, so a delayed older save can never replace a newer document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSave {
    pub revision: i64,
    pub document_revision: i64,
    pub saved_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioSave {
    pub revision: i64,
    pub saved_at: i64,
}

/// A Project's first database design, with its stored document exactly as saved.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub project: ProjectSummary,
    pub design: Value,
    pub design_id: String,
    pub revision: i64,
    pub document_revision: i64,
    pub saved_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDesignSummary {
    pub id: String,
    pub project_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseDesignRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub design: Value,
    pub revision: i64,
    pub document_revision: i64,
    pub saved_at: i64,
}

/// Saved TypeScript source (a Scenario or an Edge function), scoped to one Design.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSource {
    pub id: String,
    pub name: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub design_id: Option<String>,
}

pub type StoredScenario = StoredSource;
pub type StoredEdgeFunction = StoredSource;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioDocumentRecord {
    pub scenarios: Vec<StoredScenario>,
    pub revision: i64,
    pub saved_at: Option<i64>,
    pub design_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeFunctionDocumentRecord {
    pub edge_functions: Vec<StoredEdgeFunction>,
    pub revision: i64,
    pub saved_at: Option<i64>,
    pub design_id: String,
}

/// The stored System design of a Project, with its last-used view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDesignRecord {
    pub document: Value,
    pub revision: i64,
    pub document_revision: i64,
    pub saved_at: i64,
    pub last_view: SystemViewName,
}

/// The stored Walkthroughs of a Project. The Walkthrough model validates them on load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkthroughDocumentRecord {
    pub document: Value,
    pub revision: i64,
    pub saved_at: i64,
}

/// Several documents saved in one transaction: all of them are stored, or none.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectArtifacts {
    pub project_id: String,
    pub design_id: String,
    #[serde(default)]
    pub design: Option<DesignWrite>,
    #[serde(default)]
    pub scenarios: Option<ScenariosWrite>,
    #[serde(default)]
    pub edge_functions: Option<EdgeFunctionsWrite>,
    #[serde(default)]
    pub system_design: Option<SystemDesignWrite>,
    #[serde(default)]
    pub walkthroughs: Option<WalkthroughsWrite>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignWrite {
    pub design: Value,
    pub save: DesignSave,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenariosWrite {
    pub scenarios: Vec<StoredScenario>,
    pub save: ScenarioSave,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeFunctionsWrite {
    pub edge_functions: Vec<StoredEdgeFunction>,
    pub save: ScenarioSave,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemDesignWrite {
    pub system_design: Value,
    pub save: DesignSave,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalkthroughsWrite {
    pub walkthroughs: Value,
    pub save: ScenarioSave,
}

/// One Design of an imported Project, with every identity already assigned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedDesign {
    pub id: String,
    pub name: String,
    pub design: Value,
    pub scenarios: Vec<StoredScenario>,
    pub edge_functions: Vec<StoredEdgeFunction>,
}

/// What an import creates: every identity is new and every reference remapped.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedProjectImport {
    pub project: ProjectSummary,
    pub active_design_id: String,
    pub active_view: SystemViewName,
    pub designs: Vec<PreparedDesign>,
    pub system_design: Value,
    pub walkthroughs: Value,
}

/// A document the designer attached to a Project to give the Assistant background.
/// The Design never depends on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileSummary {
    pub id: String,
    pub name: String,
    pub size: i64,
    pub mime: String,
    pub added_at: i64,
    /// Whether the Assistant can read the file as text.
    pub has_text: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<i64>,
    /// Why there is no text, such as an image or a password-protected PDF.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}
