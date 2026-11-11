//! Keeps a readable copy of the open Project on disk: written when the app starts, rewritten a
//! moment after the Project changes, and on demand for "Reveal Project folder".

use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

use schema_files::ProjectFiles;
use schema_folder::ProjectFolderMirror;
use schema_workspace::Workspace;

const DEBOUNCE: Duration = Duration::from_millis(300);

/// `DB_PLANNER_PROJECTS_PATH` wins, as in the Electrobun app; otherwise `~/Schema Designer`.
pub fn projects_root() -> PathBuf {
    std::env::var_os("DB_PLANNER_PROJECTS_PATH")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(|home| PathBuf::from(home).join("Schema Designer")))
        .unwrap_or_else(|| PathBuf::from("Schema Designer"))
}

pub struct Folder {
    mirror: Arc<ProjectFolderMirror>,
    workspace: Workspace,
    files: Option<Arc<ProjectFiles>>,
    signal: Sender<()>,
}

impl Folder {
    pub fn start(root: PathBuf, workspace: Workspace, files: Option<Arc<ProjectFiles>>) -> Arc<Self> {
        let (signal, changes): (Sender<()>, Receiver<()>) = mpsc::channel();
        let folder = Arc::new(Self { mirror: Arc::new(ProjectFolderMirror::new(root)), workspace, files, signal });
        let worker = folder.clone();
        std::thread::spawn(move || {
            // The first copy is written at once; later ones wait for the Project to stop changing.
            let _ = worker.sync(false);
            while changes.recv().is_ok() {
                loop {
                    match changes.recv_timeout(DEBOUNCE) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                if let Err(error) = worker.sync(false) {
                    eprintln!("[project-folder] sync failed: {error}");
                }
            }
        });
        folder
    }

    /// Asks for a rewrite once the Project settles.
    pub fn changed(&self) {
        let _ = self.signal.send(());
    }

    /// Writes the open Project's pending changes now and returns its folder, if a Project is open.
    pub fn sync(&self, force: bool) -> Result<Option<PathBuf>, String> {
        let Some(project_id) = self.workspace.state().project.map(|project| project.id) else { return Ok(None) };
        let document = self.workspace.export_project()?;
        let context = self.files.as_deref().map(|files| files as &dyn schema_folder::ContextSource);
        self.mirror.sync(&document, &project_id, context, force).map(Some)
    }

    pub fn schema_file(&self, design_id: &str) -> Option<PathBuf> {
        self.mirror.schema_file(design_id)
    }
}
