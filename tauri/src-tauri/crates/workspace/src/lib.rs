//! The design workspace behind the view (`src/bun/workspace.ts`), first slice.
//!
//! It holds the open Project, applies edits to its database Design, autosaves to
//! SQLite, and rebuilds the disposable SQL preview in the background. Every change
//! to the observable state is pushed to listeners, which the app forwards to the view.
//!
//! The sequence for a schema edit mirrors the original: the draft is updated at
//! once (`saving`, SQL `checking`), saved straight away, and a debounced preview then
//! generates the SQL and validates it in the sandbox. The caller waits for that
//! preview, so the response the view receives is the settled state, not a stale one.
//!
//! This slice covers creating and opening Projects, switching views, and the table,
//! column and viewport edits. Undo/redo, relationships, System design and Walkthrough
//! edits, Scenarios and the rest arrive with later phases.

mod database;
mod edits;
mod history;
mod rpc;
mod state;
mod system;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use schema_domain::design::{Design, DesignTable};
use schema_domain::geometry::{CanvasPoint, CanvasViewport, DEFAULT_VIEWPORT};
use schema_domain::sql::{generate_design_sql, SqlGeneration};
use schema_domain::system_design::{create_empty_system_design, normalize_system_design, SystemViewName};
use schema_domain::walkthrough::normalize_walkthroughs;
use history::{HistoryAction, ProjectContent};
use schema_domain::project_history::ProjectHistory;
use schema_sandbox::Sandbox;
use schema_store::{DesignSave, ProjectSummary, Store};
use serde_json::{json, Value};

pub use rpc::NOT_IMPLEMENTED;
pub use state::WorkspaceState;
use state::{last_applied_sandbox, saved, saving};

pub type SandboxFactory = Arc<dyn Fn() -> Box<dyn Sandbox> + Send + Sync>;
pub type Listener = Arc<dyn Fn(&WorkspaceState) + Send + Sync>;

pub struct Options {
    pub database_path: PathBuf,
    pub sandbox: SandboxFactory,
    /// How long an edit waits for further edits before the preview is rebuilt.
    pub preview_delay: Duration,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub create_id: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Options {
    pub fn new(database_path: impl Into<PathBuf>, sandbox: SandboxFactory) -> Self {
        Self {
            database_path: database_path.into(),
            sandbox,
            preview_delay: Duration::from_millis(180),
            now: Arc::new(|| {
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis() as i64)
            }),
            create_id: Arc::new(|| uuid::Uuid::new_v4().to_string()),
        }
    }
}

type Result<T> = std::result::Result<T, String>;

struct ScheduledPreview {
    request_id: u64,
    /// Wakes the waiting preview thread so it stops without finishing.
    cancel: Sender<()>,
}

struct Inner {
    store: Store,
    state: WorkspaceState,
    active_project_id: Option<String>,
    active_design_id: Option<String>,
    /// Orders every stored document, including layout-only writes.
    document_revision: i64,
    /// Orders System design document writes; separate from the database Design's document revision.
    system_document_revision: i64,
    /// Orders Walkthrough document writes.
    walkthrough_document_revision: i64,
    last_generatable_sql: Option<(i64, String)>,
    preview_request_id: u64,
    scheduled: Option<ScheduledPreview>,
    /// Optional-key order of the System design's Components and Connections; see `system::KeyOrders`.
    key_orders: system::KeyOrders,
    /// Orders Scenario and Edge function document writes.
    scenario_revision: i64,
    edge_function_revision: i64,
    /// One content history per database design, for the session. Each design's Undo and Redo move
    /// only its own content, so switching designs never changes what another design's Undo reverses.
    histories: HashMap<String, ProjectHistory<ProjectContent>>,
}

/// A preview to build straight away, outside the debounce.
struct PreviewJob {
    project_id: String,
    revision: i64,
    design: Design,
    request_id: u64,
}

struct Shared {
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<Listener>>,
    options: Options,
}

/// Cheap to clone; every clone is the same workspace.
#[derive(Clone)]
pub struct Workspace {
    shared: Arc<Shared>,
}

impl Workspace {
    /// Opens the database and, as the original does, the most recently updated Project.
    pub fn open(options: Options) -> Result<Self> {
        let store = Store::open(&options.database_path).map_err(|error| error.to_string())?;
        let projects = store.list_projects().map_err(|error| error.to_string())?;
        let state = WorkspaceState::initial(projects.clone());
        let workspace = Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    store,
                    state,
                    active_project_id: None,
                    active_design_id: None,
                    document_revision: 0,
                    system_document_revision: 0,
                    walkthrough_document_revision: 0,
                    last_generatable_sql: None,
                    preview_request_id: 0,
                    scheduled: None,
                    key_orders: Default::default(),
                    scenario_revision: 0,
                    edge_function_revision: 0,
                    histories: HashMap::new(),
                }),
                listeners: Mutex::new(Vec::new()),
                options,
            }),
        };
        if let Some(most_recent) = projects.first() {
            workspace.open_project(&most_recent.id)?;
        }
        Ok(workspace)
    }

    pub fn subscribe(&self, listener: Listener) {
        self.shared.listeners.lock().expect("listeners").push(listener);
    }

    pub fn state(&self) -> WorkspaceState {
        self.lock().state.clone()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.shared.inner.lock().expect("workspace lock")
    }

    fn now(&self) -> i64 {
        (self.shared.options.now)()
    }

    fn new_id(&self) -> String {
        (self.shared.options.create_id)()
    }

    /// Replaces the observable state and tells every listener. Listeners must not call back in.
    fn set_state(&self, inner: &mut Inner, next: WorkspaceState) {
        inner.state = next;
        Self::refresh_undo_redo(inner);
        self.notify(&inner.state);
    }

    fn update(&self, inner: &mut Inner, change: impl FnOnce(&mut WorkspaceState)) {
        change(&mut inner.state);
        Self::refresh_undo_redo(inner);
        self.notify(&inner.state);
    }

    /// Every state carries what Undo and Redo would do next for the active design.
    fn refresh_undo_redo(inner: &mut Inner) {
        let description = Self::describe_history(inner);
        inner.state.undo_redo = json!({ "canUndo": description.can_undo, "canRedo": description.can_redo });
        inner.state.undo_action_name = description.undo_action_name;
        inner.state.redo_action_name = description.redo_action_name;
    }

    fn notify(&self, state: &WorkspaceState) {
        for listener in self.shared.listeners.lock().expect("listeners").iter() {
            listener(state);
        }
    }

    /* ------------------------------------------------------------ Projects */

    pub fn create_project(&self, name: &str) -> Result<WorkspaceState> {
        let name = schema_domain::js::trim(name);
        if name.is_empty() {
            return Err("Project name is required.".into());
        }
        let project = ProjectSummary { id: self.new_id(), name: name.to_owned() };
        let design = Design {
            tables: vec![],
            relationships: vec![],
            many_to_many_relationships: vec![],
            viewport: DEFAULT_VIEWPORT,
            enum_types: None,
            functions: None,
            triggers: None,
            raw_statements: None,
        };
        let revision = 1;
        let saved_at = self.now();
        let design_id = self.new_id();
        let mut inner = self.lock();
        inner
            .store
            .create_project(&project, &to_json(&design)?, DesignSave { revision, document_revision: revision, saved_at }, &design_id)
            .map_err(|error| error.to_string())?;
        invalidate_preview(&mut inner);
        inner.active_project_id = Some(project.id.clone());
        inner.active_design_id = Some(design_id.clone());
        inner.document_revision = revision;
        inner.system_document_revision = revision;
        inner.walkthrough_document_revision = 0;
        inner.key_orders = Default::default();
        inner.last_generatable_sql = None;
        let projects = inner.store.list_projects().map_err(|error| error.to_string())?;
        let designs = inner.store.list_designs(&project.id).map_err(|error| error.to_string())?;
        let next = WorkspaceState {
            projects,
            project: Some(project),
            designs,
            design: Some(design),
            active_design_id: Some(design_id.clone()),
            revision,
            save: saved(revision, saved_at, &design_id),
            sql: json!({ "status": "empty", "draftRevision": revision, "errors": [], "designId": design_id }),
            sandbox: json!({ "status": "idle" }),
            system_design: Some(create_empty_system_design()),
            system_save: saved(revision, saved_at, &design_id),
            active_view: SystemViewName::System,
            ..WorkspaceState::initial(vec![])
        };
        self.set_state(&mut inner, next);
        Ok(inner.state.clone())
    }

    pub fn open_project(&self, project_id: &str) -> Result<WorkspaceState> {
        let record = self.lock().store.load_project(project_id).map_err(|error| error.to_string())?;
        let Some(record) = record else { return Err("That project could not be found.".into()) };
        self.activate(record.project, &record.design_id, true)
    }

    /// Makes one stored design the active one and, when it has tables, builds its preview at once.
    /// Unlike an edit, opening does not wait for further edits before it checks the schema.
    fn activate(&self, project: ProjectSummary, design_id: &str, opening: bool) -> Result<WorkspaceState> {
        let job = {
            let mut inner = self.lock();
            self.activate_design(&mut inner, project, design_id, opening)?
        };
        if let Some(job) = job {
            self.generate_and_apply(&job.project_id, job.revision, &job.design, job.request_id, design_id);
        }
        Ok(self.state())
    }

    /// Makes one stored design of a Project the active one. Opening the Project also loads its own
    /// documents (System design, Walkthroughs, last view); switching designs keeps what is loaded.
    fn activate_design(&self, inner: &mut Inner, project: ProjectSummary, design_id: &str, opening: bool) -> Result<Option<PreviewJob>> {
        let store_error = |error: schema_store::StoreError| error.to_string();
        let record = inner.store.load_design(design_id).map_err(store_error)?;
        let Some(record) = record.filter(|record| record.project_id == project.id) else {
            return Err("That design could not be found in this project.".into());
        };
        let design = Design::load(&record.design)?;
        let scenario_document = inner.store.load_scenarios(&project.id, design_id).map_err(store_error)?;
        let edge_document = inner.store.load_edge_functions(&project.id, design_id).map_err(store_error)?;
        let system_record = if opening { inner.store.load_system_design(&project.id).map_err(store_error)? } else { None };
        let walkthrough_record = if opening { inner.store.load_walkthroughs(&project.id).map_err(store_error)? } else { None };

        invalidate_preview(inner);
        inner.active_project_id = Some(project.id.clone());
        inner.active_design_id = Some(design_id.to_owned());
        inner.document_revision = record.document_revision;
        // Revisions only move forward within a session, so a save still in flight for an earlier
        // activation can never share a revision with a new one.
        inner.edge_function_revision = inner.edge_function_revision.max(edge_document.revision);
        inner.scenario_revision = scenario_document.revision;
        if opening {
            inner.system_document_revision = system_record.as_ref().map_or(0, |record| record.document_revision);
            inner.walkthrough_document_revision = walkthrough_record.as_ref().map_or(0, |record| record.revision);
        }
        inner.last_generatable_sql = None;

        // Project-level documents load when the Project opens and are carried over when only the design changes.
        let carried = inner.state.clone();
        let (system_design, system_save, active_view, walkthroughs, walkthrough_save) = if opening {
            (
                Some(match &system_record {
                    Some(record) => normalize_system_design(&record.document)?,
                    None => create_empty_system_design(),
                }),
                match &system_record {
                    Some(record) => saved(record.revision, record.saved_at, design_id),
                    None => json!({ "status": "idle" }),
                },
                system_record.as_ref().map_or(SystemViewName::System, |record| record.last_view),
                match &walkthrough_record {
                    Some(record) => normalize_walkthroughs(&record.document)?,
                    None => vec![],
                },
                match &walkthrough_record {
                    Some(record) => saved(record.revision, record.saved_at, design_id),
                    None => json!({ "status": "idle" }),
                },
            )
        } else {
            (carried.system_design, carried.system_save, carried.active_view, carried.walkthroughs, carried.walkthrough_save)
        };
        let source_values = |sources: &[schema_store::StoredSource]| -> Vec<Value> { sources.iter().map(|source| json!(source)).collect() };
        let has_tables = !design.tables.is_empty();
        // Loading rebuilds every object in canonical key order; switching designs keeps what is loaded.
        if opening {
            inner.key_orders = match &system_design {
                Some(system) => system::canonical_key_orders(system),
                None => Default::default(),
            };
        }
        let preview_design = design.clone();
        let next = WorkspaceState {
            projects: inner.store.list_projects().map_err(store_error)?,
            designs: inner.store.list_designs(&project.id).map_err(store_error)?,
            project: Some(project.clone()),
            design: Some(design),
            active_design_id: Some(design_id.to_owned()),
            revision: record.revision,
            save: saved(record.revision, record.saved_at, design_id),
            sql: json!({ "status": "empty", "draftRevision": record.revision, "errors": [], "designId": design_id }),
            sandbox: json!({ "status": "idle" }),
            scenarios: source_values(&scenario_document.scenarios),
            scenario_save: match scenario_document.saved_at {
                None => json!({ "status": "idle" }),
                Some(saved_at) => saved(scenario_document.revision, saved_at, design_id),
            },
            edge_functions: source_values(&edge_document.edge_functions),
            edge_function_save: match edge_document.saved_at {
                None => json!({ "status": "idle" }),
                Some(saved_at) => saved(edge_document.revision, saved_at, design_id),
            },
            system_design,
            system_save,
            active_view,
            walkthroughs,
            walkthrough_save,
            ..WorkspaceState::initial(vec![])
        };
        self.set_state(inner, next);
        if !has_tables {
            return Ok(None);
        }
        inner.preview_request_id += 1;
        Ok(Some(PreviewJob { project_id: project.id, revision: record.revision, design: preview_design, request_id: inner.preview_request_id }))
    }

    pub fn set_active_view(&self, view: SystemViewName) -> Result<WorkspaceState> {
        let mut inner = self.lock();
        let (project_id, _) = require_open_project(&inner)?;
        if inner.state.active_view == view {
            return Ok(inner.state.clone());
        }
        inner.store.save_last_view(&project_id, view).map_err(|error| error.to_string())?;
        self.update(&mut inner, |state| state.active_view = view);
        Ok(inner.state.clone())
    }

    /* ------------------------------------------------------- Design edits */

    fn require_open_design(&self, inner: &Inner, target_design_id: &str) -> Result<(String, Design, String)> {
        let (Some(project_id), Some(design_id), Some(design)) = (&inner.active_project_id, &inner.active_design_id, &inner.state.design) else {
            return Err("Open a project before editing its design.".into());
        };
        if target_design_id.is_empty() {
            return Err("A database design ID is required.".into());
        }
        if target_design_id != design_id {
            return Err(format!("Target database design '{target_design_id}' is not the active design."));
        }
        Ok((project_id.clone(), design.clone(), design_id.clone()))
    }

    pub fn add_table(&self, design_id: &str, name: &str, position: Option<CanvasPoint>) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let name = schema_domain::js::trim(name);
        if name.is_empty() {
            return Err("Table name is required.".into());
        }
        let position = match position {
            Some(point) => edits::require_point(point, "Table position")?,
            None => edits::default_table_position(&design),
        };
        let table = edits::create_default_table(name, position, &mut || self.new_id());
        let mut next = design;
        next.tables.push(table);
        self.apply_structural_change(&project_id, next, Some(HistoryAction::named(format!("Add table “{name}”"))), &design_id)
    }

    pub fn rename_table(&self, design_id: &str, table_id: &str, name: &str) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let name = schema_domain::js::trim(name);
        if name.is_empty() {
            return Err("Table name is required.".into());
        }
        let table = edits::require_table(&design, table_id)?;
        if table.name == name {
            return Ok(self.state());
        }
        let action = HistoryAction::coalescing(format!("Rename table to “{name}”"), format!("table-name:{}", table.id));
        let next = edits::replace_table(&design, DesignTable { name: name.to_owned(), ..table.clone() });
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub fn move_table(&self, design_id: &str, table_id: &str, position: CanvasPoint) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        let position = edits::require_point(position, "Table position")?;
        if table.position == position {
            return Ok(self.state());
        }
        let action = HistoryAction::named(format!("Move table “{}”", table.name));
        let next = edits::replace_table(&design, DesignTable { position, ..table.clone() });
        self.apply_non_schema_change(&project_id, next, Some(action), &design_id)
    }

    pub fn add_column(&self, design_id: &str, table_id: &str, name: Option<&str>, column_type: Option<&str>) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let table = edits::require_table(&design, table_id)?;
        let name = match name {
            None => edits::next_column_name(table),
            Some(name) => edits::require_name(name, "Column name")?,
        };
        let column_type = match column_type {
            None => "text".to_owned(),
            Some(value) => edits::require_column_type(value)?,
        };
        let action = HistoryAction::named(format!("Add column “{name}”"));
        let column = edits::new_column(self.new_id(), name, column_type);
        let mut table = table.clone();
        table.columns.push(column);
        let next = edits::replace_table(&design, table);
        self.apply_structural_change(&project_id, next, Some(action), &design_id)
    }

    pub fn update_column(&self, design_id: &str, table_id: &str, column_id: &str, changes: &Value) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let outcome = edits::update_column(&design, table_id, column_id, changes)?;
        match outcome {
            edits::ColumnEdit::Unchanged => Ok(self.state()),
            edits::ColumnEdit::Schema { design: next, name } => {
                self.apply_structural_change(&project_id, next, Some(HistoryAction::named(format!("Edit column “{name}”"))), &design_id)
            }
            edits::ColumnEdit::NotesOnly { design: next, name, column_id } => {
                let action = HistoryAction::coalescing(format!("Edit notes on “{name}”"), format!("column-notes:{column_id}"));
                self.apply_non_schema_change(&project_id, next, Some(action), &design_id)
            }
        }
    }

    pub fn set_viewport(&self, design_id: &str, x: f64, y: f64, zoom: f64) -> Result<WorkspaceState> {
        let (project_id, design, design_id) = self.require_open_design(&self.lock(), design_id)?;
        let viewport = CanvasViewport {
            x: edits::require_number(x, "Canvas position")?,
            y: edits::require_number(y, "Canvas position")?,
            zoom: edits::require_number(zoom, "Canvas zoom")?.clamp(0.3, 2.5),
        };
        if design.viewport == viewport {
            return Ok(self.state());
        }
        self.apply_non_schema_change(&project_id, Design { viewport, ..design }, None, &design_id)
    }

    /* ----------------------------------------------------- Save and preview */

    /// Saves the draft immediately and debounces its disposable preview rebuild.
    fn apply_structural_change(&self, project_id: &str, design: Design, action: Option<HistoryAction>, design_id: &str) -> Result<WorkspaceState> {
        let (revision, document_revision, waiting) = {
            let mut inner = self.lock();
            self.record_design_change(&mut inner, action.as_ref(), &design, true)?;
            let revision = inner.state.revision + 1;
            let document_revision = inner.document_revision + 1;
            inner.document_revision = document_revision;
            let last_applied = last_applied_sandbox(&inner.state.sandbox);
            let available = inner.last_generatable_sql.clone();
            self.update(&mut inner, |state| {
                state.design = Some(design.clone());
                state.revision = revision;
                state.save = saving(revision, design_id);
                state.sql = json!({
                    "status": "checking",
                    "draftRevision": revision,
                    "availableRevision": available.as_ref().map(|(revision, _)| *revision),
                    "sql": available.as_ref().map(|(_, sql)| sql),
                    "designId": design_id,
                });
                state.sandbox = match last_applied {
                    None => json!({ "status": "idle" }),
                    Some(applied) => with_status_applied(applied, design_id),
                };
            });
            let waiting = self.schedule_preview(&mut inner, project_id, revision, design.clone(), design_id);
            (revision, document_revision, waiting)
        };
        self.save_document(project_id, revision, document_revision, &design, design_id);
        // The preview resolves when it finishes, or at once if a newer edit replaces it.
        let _ = waiting.recv();
        Ok(self.state())
    }

    /// Applies an edit that does not change the schema: card layout, canvas viewport, and column notes.
    /// The schema revision, SQL preview, and applied sandbox stay exactly as they were.
    fn apply_non_schema_change(&self, project_id: &str, design: Design, action: Option<HistoryAction>, design_id: &str) -> Result<WorkspaceState> {
        let (revision, document_revision) = {
            let mut inner = self.lock();
            self.record_design_change(&mut inner, action.as_ref(), &design, false)?;
            let revision = inner.state.revision;
            let document_revision = inner.document_revision + 1;
            inner.document_revision = document_revision;
            self.update(&mut inner, |state| {
                state.design = Some(design.clone());
                state.save = saving(revision, design_id);
            });
            (revision, document_revision)
        };
        self.save_document(project_id, revision, document_revision, &design, design_id);
        Ok(self.state())
    }

    /// Records a Design edit against the Design the Project holds now, unless the edit is not an action.
    fn record_design_change(&self, inner: &mut Inner, action: Option<&HistoryAction>, design: &Design, structural: bool) -> Result<()> {
        let Some(action) = action else { return Ok(()) };
        let before = inner.state.design.clone().ok_or("Open a project before editing its design.")?;
        let (before, after) = (
            self.project_content(inner, &before, None, None, &inner.key_orders),
            self.project_content(inner, design, None, None, &inner.key_orders),
        );
        self.record_content_change(inner, action, before, after, structural);
        Ok(())
    }

    fn save_document(&self, project_id: &str, revision: i64, document_revision: i64, design: &Design, design_id: &str) {
        let saved_at = self.now();
        let outcome = match to_json(design) {
            Ok(document) => {
                let mut inner = self.lock();
                inner
                    .store
                    .save_design(project_id, &document, DesignSave { revision, document_revision, saved_at }, design_id)
                    .map_err(|error| error.to_string())
            }
            Err(error) => Err(error),
        };
        let mut inner = self.lock();
        if !is_current_save(&inner, project_id, revision, document_revision, design_id) {
            return;
        }
        match outcome {
            Ok(()) => {
                let projects = inner.store.list_projects().unwrap_or_default();
                self.update(&mut inner, |state| {
                    state.projects = projects;
                    state.save = saved(revision, saved_at, design_id);
                });
            }
            Err(error) => self.update(&mut inner, |state| {
                state.save = json!({ "status": "failed", "revision": revision, "error": error, "designId": design_id });
            }),
        }
    }

    /// Starts the debounced rebuild and returns a handle that resolves when it finishes or is replaced.
    fn schedule_preview(&self, inner: &mut Inner, project_id: &str, revision: i64, design: Design, design_id: &str) -> Receiver<()> {
        cancel_scheduled_preview(inner);
        inner.preview_request_id += 1;
        let request_id = inner.preview_request_id;
        let (cancel, cancelled) = mpsc::channel::<()>();
        let (done, waiting) = mpsc::channel::<()>();
        inner.scheduled = Some(ScheduledPreview { request_id, cancel });
        let workspace = self.clone();
        let (project_id, design_id) = (project_id.to_owned(), design_id.to_owned());
        std::thread::spawn(move || {
            // Any message, or the sender going away, means a newer edit replaced this preview.
            if cancelled.recv_timeout(workspace.shared.options.preview_delay) != Err(mpsc::RecvTimeoutError::Timeout) {
                return;
            }
            {
                let mut inner = workspace.lock();
                if inner.scheduled.as_ref().is_some_and(|scheduled| scheduled.request_id == request_id) {
                    inner.scheduled = None;
                }
            }
            workspace.generate_and_apply(&project_id, revision, &design, request_id, &design_id);
            let _ = done.send(());
        });
        waiting
    }

    fn generate_and_apply(&self, project_id: &str, revision: i64, design: &Design, request_id: u64, design_id: &str) {
        if !is_current_preview(&self.lock(), project_id, revision, request_id, design_id) {
            return;
        }
        let generation = match generate_design_sql(design, false) {
            Ok(generation) => generation,
            Err(error) => SqlGeneration::Errors(vec![error]),
        };
        let (sql, warnings) = match generation {
            SqlGeneration::Errors(errors) => {
                let mut inner = self.lock();
                let available = inner.last_generatable_sql.clone();
                let last_applied = last_applied_sandbox(&inner.state.sandbox);
                self.update(&mut inner, |state| {
                    state.sql = match &available {
                        None => json!({ "status": "empty", "draftRevision": revision, "errors": errors, "designId": design_id }),
                        Some((available_revision, sql)) => json!({
                            "status": "stale", "revision": available_revision, "draftRevision": revision,
                            "sql": sql, "errors": errors, "designId": design_id,
                        }),
                    };
                    state.sandbox = match last_applied {
                        None => json!({ "status": "idle" }),
                        Some(applied) => with_status_applied(applied, design_id),
                    };
                });
                return;
            }
            SqlGeneration::Ok { sql, warnings } => (sql, warnings),
        };

        let last_applied = {
            let mut inner = self.lock();
            if !is_current_preview(&inner, project_id, revision, request_id, design_id) {
                return;
            }
            inner.last_generatable_sql = Some((revision, sql.clone()));
            let last_applied = last_applied_sandbox(&inner.state.sandbox);
            self.update(&mut inner, |state| {
                let mut current = json!({ "status": "current", "revision": revision, "sql": sql, "designId": design_id });
                if !warnings.is_empty() {
                    current["warnings"] = json!(warnings);
                }
                state.sql = current;
                state.sandbox = json!({
                    "status": "applying", "revision": revision, "attemptedSql": sql,
                    "lastApplied": last_applied, "designId": design_id,
                });
            });
            last_applied
        };

        // The sandbox runs without the lock held: it takes a moment, and edits must stay responsive.
        let mut sandbox = (self.shared.options.sandbox)();
        let result = sandbox.apply(&sql);
        drop(sandbox);

        let mut inner = self.lock();
        if !is_current_preview(&inner, project_id, revision, request_id, design_id) {
            return;
        }
        let next = state::sandbox_state(result, design, revision, &sql, design_id, last_applied);
        self.update(&mut inner, |state| state.sandbox = next);
    }
}

pub(crate) fn to_json<T: serde::Serialize>(value: &T) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn require_open_project(inner: &Inner) -> Result<(String, String)> {
    match (&inner.active_project_id, &inner.active_design_id, &inner.state.system_design) {
        (Some(project_id), Some(design_id), Some(_)) => Ok((project_id.clone(), design_id.clone())),
        _ => Err("Open a project before editing its System design.".into()),
    }
}

fn with_status_applied(mut applied: Value, design_id: &str) -> Value {
    if let Some(object) = applied.as_object_mut() {
        object.insert("status".into(), json!("applied"));
        object.insert("designId".into(), json!(design_id));
    }
    applied
}

fn is_current_save(inner: &Inner, project_id: &str, revision: i64, document_revision: i64, design_id: &str) -> bool {
    inner.active_project_id.as_deref() == Some(project_id)
        && inner.active_design_id.as_deref() == Some(design_id)
        && inner.state.revision == revision
        && inner.document_revision == document_revision
}

fn is_current_preview(inner: &Inner, project_id: &str, revision: i64, request_id: u64, design_id: &str) -> bool {
    inner.preview_request_id == request_id
        && inner.active_project_id.as_deref() == Some(project_id)
        && inner.active_design_id.as_deref() == Some(design_id)
        && inner.state.revision == revision
}

fn cancel_scheduled_preview(inner: &mut Inner) {
    if let Some(scheduled) = inner.scheduled.take() {
        let _ = scheduled.cancel.send(());
    }
}

fn invalidate_preview(inner: &mut Inner) {
    inner.preview_request_id += 1;
    cancel_scheduled_preview(inner);
}
