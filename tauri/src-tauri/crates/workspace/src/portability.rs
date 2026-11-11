//! Exporting the open Project to the portable document and importing one as a new Project
//! (`exportProject` and `importProject` in `src/bun/workspace.ts`).

use schema_domain::project_portability::{create_project_export_document, prepare_project_import, ExportDesign, ExportInput, ExportSource};
use schema_domain::system_design::{create_empty_system_design, normalize_system_design, SystemViewName};
use schema_domain::walkthrough::normalize_walkthroughs;
use schema_store::{PreparedDesign, PreparedProjectImport, ProjectSummary, StoredSource};
use serde_json::Value;

use crate::{to_json, Result, Workspace, WorkspaceState};

fn export_sources(items: &[StoredSource]) -> Vec<ExportSource> {
    items.iter().map(|item| ExportSource { id: item.id.clone(), name: item.name.clone(), source: item.source.clone() }).collect()
}

fn stored_sources(items: &[ExportSource]) -> Vec<StoredSource> {
    items.iter().map(|item| StoredSource { id: item.id.clone(), name: item.name.clone(), source: item.source.clone(), design_id: None }).collect()
}

impl Workspace {
    /// The open Project as a portable document.
    pub fn export_project(&self) -> Result<Value> {
        let inner = self.lock();
        let store_error = |error: schema_store::StoreError| error.to_string();
        let (Some(project), Some(active_design_id)) = (inner.state.project.clone(), inner.active_design_id.clone()) else {
            return Err("Open a project before exporting it.".into());
        };
        if inner.active_project_id.is_none() {
            return Err("Open a project before exporting it.".into());
        }
        let system_record = inner.store.load_system_design(&project.id).map_err(store_error)?;
        let walkthrough_record = inner.store.load_walkthroughs(&project.id).map_err(store_error)?;
        let mut designs = Vec::new();
        for summary in inner.store.list_designs(&project.id).map_err(store_error)? {
            let Some(record) = inner.store.load_design(&summary.id).map_err(store_error)? else {
                let label = if summary.name.is_empty() { summary.id.as_str() } else { summary.name.as_str() };
                return Err(format!("Design \"{label}\" could not be read."));
            };
            designs.push(ExportDesign {
                id: summary.id.clone(),
                name: summary.name.clone(),
                design: record.design,
                scenarios: export_sources(&inner.store.load_scenarios(&project.id, &summary.id).map_err(store_error)?.scenarios),
                edge_functions: export_sources(&inner.store.load_edge_functions(&project.id, &summary.id).map_err(store_error)?.edge_functions),
            });
        }
        let system_design = match &system_record {
            Some(record) => normalize_system_design(&record.document)?,
            None => create_empty_system_design(),
        };
        let walkthroughs = match &walkthrough_record {
            Some(record) => normalize_walkthroughs(&record.document)?,
            None => vec![],
        };
        Ok(create_project_export_document(&ExportInput {
            project_name: &project.name,
            active_design_id: &active_design_id,
            active_view: system_record.as_ref().map_or(SystemViewName::System, |record| record.last_view),
            system_design: &system_design,
            walkthroughs: &walkthroughs,
            designs,
        }))
    }

    /// Creates a new Project from a portable document and opens it. Everything is validated and
    /// given fresh identities before the first write.
    pub fn import_project(&self, document: &Value) -> Result<WorkspaceState> {
        let prepared = prepare_project_import(document, &mut || self.new_id())?;
        let project = ProjectSummary { id: prepared.project_id.clone(), name: prepared.project_name.clone() };
        {
            let mut inner = self.lock();
            let saved_at = self.now();
            let designs = prepared
                .designs
                .iter()
                .map(|design| {
                    Ok(PreparedDesign {
                        id: design.id.clone(),
                        name: design.name.clone(),
                        design: to_json(&design.design)?,
                        scenarios: stored_sources(&design.scenarios),
                        edge_functions: stored_sources(&design.edge_functions),
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let record = PreparedProjectImport {
                project: project.clone(),
                active_design_id: prepared.active_design_id.clone(),
                active_view: prepared.active_view,
                designs,
                system_design: to_json(&prepared.system_design)?,
                walkthroughs: to_json(&prepared.walkthroughs)?,
            };
            inner.store.import_project(&record, saved_at).map_err(|error| error.to_string())?;
            let projects = inner.store.list_projects().map_err(|error| error.to_string())?;
            self.update(&mut inner, |state| state.projects = projects);
        }
        self.activate(project, &prepared.active_design_id, true)
    }
}
