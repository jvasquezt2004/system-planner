//! SQLite persistence for Projects, Designs, Scenarios, Edge functions, System
//! designs, and Walkthroughs.
//!
//! A port of `src/bun/store.ts`. It reads and writes the same file the Electrobun
//! app does, with the same tables, ordering rules, and error messages, so either
//! app can open a database the other wrote. Documents are stored and returned as
//! JSON values; normalizing them is the workspace's job, as it is in TypeScript.

mod migrations;
mod types;

use std::fmt;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use schema_domain::system_design::{SystemViewName, create_empty_system_design};
use serde::Serialize;
use serde_json::Value;

pub use types::*;

#[derive(Debug)]
pub enum StoreError {
    /// A rule of the store, such as a design that does not belong to its Project.
    Message(String),
    Sqlite(rusqlite::Error),
    Json(serde_json::Error),
    Io(std::io::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Message(message) => f.write_str(message),
            Self::Sqlite(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}
impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}
impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

fn rule(message: impl Into<String>) -> StoreError {
    StoreError::Message(message.into())
}

fn not_owned(design_id: &str, project_id: &str) -> StoreError {
    rule(format!("Database design \"{design_id}\" does not belong to project \"{project_id}\"."))
}

fn json<T: Serialize>(value: &T) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}

pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (creating if needed) the database at `path`, migrating anything an
    /// older version of the app left behind.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        // The TypeScript store's SQLite driver starts with foreign keys off and the
        // migrations rely on that; they are switched on once the schema is current.
        conn.execute_batch("PRAGMA foreign_keys = OFF")?;

        migrations::migrate_to_explicit_design_identity(&mut conn)?;
        migrations::migrate_design_scoped_artifacts(&mut conn)?;

        conn.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))?;
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        conn.execute_batch(migrations::SCHEMA)?;
        conn.execute_batch(&format!("PRAGMA user_version = {}", migrations::DESIGN_SCOPED_ARTIFACTS_VERSION))?;

        migrations::migrate_document_revision(&conn)?;
        migrations::migrate_system_designs(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn close(self) -> Result<()> {
        self.conn.close().map_err(|(_, error)| error.into())
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let mut statement =
            self.conn.prepare("SELECT id, name FROM projects ORDER BY updated_at DESC, name ASC, rowid DESC")?;
        let rows = statement
            .query_map([], |row| Ok(ProjectSummary { id: row.get(0)?, name: row.get(1)? }))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Creates a Project with its first database design and an empty System design.
    pub fn create_project(&mut self, project: &ProjectSummary, design: &Value, save: DesignSave, design_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![project.id, project.name, save.saved_at, save.saved_at],
        )?;
        insert_design(&tx, design_id, &project.id, "", design, save)?;
        tx.execute(
            "INSERT INTO system_designs (project_id, document, revision, document_revision, last_view, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)",
            params![project.id, json(&create_empty_system_design())?, save.revision, save.document_revision, "system", save.saved_at],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Adds an independent database design to an existing Project.
    pub fn create_design(&mut self, project_id: &str, design_id: &str, name: &str, design: &Value, save: DesignSave) -> Result<()> {
        let tx = self.conn.transaction()?;
        let exists = tx.query_row("SELECT id FROM projects WHERE id = ?", [project_id], |_| Ok(())).optional()?;
        if exists.is_none() {
            return Err(rule(format!("Project \"{project_id}\" does not exist.")));
        }
        insert_design(&tx, design_id, project_id, name, design, save)?;
        touch_project(&tx, save.saved_at, project_id)?;
        tx.commit()?;
        Ok(())
    }

    pub fn rename_design(&mut self, project_id: &str, design_id: &str, name: &str, saved_at: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let changed = tx.execute("UPDATE designs SET name = ? WHERE id = ? AND project_id = ?", params![name, design_id, project_id])?;
        if changed == 0 {
            return Err(not_owned(design_id, project_id));
        }
        touch_project(&tx, saved_at, project_id)?;
        tx.commit()?;
        Ok(())
    }

    /// Saves a design document unless a newer one is already stored.
    pub fn save_design(&mut self, project_id: &str, design: &Value, save: DesignSave, design_id: &str) -> Result<()> {
        let tx = self.conn.transaction()?;
        require_owner(&tx, design_id, project_id)?;
        if update_design(&tx, project_id, design_id, design, save)? > 0 {
            touch_project(&tx, save.saved_at, project_id)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Saves several documents in one transaction. Unlike the single-document
    /// saves, a stale revision here is an error, so the caller learns that nothing was kept.
    pub fn save_project_artifacts(&mut self, input: &ProjectArtifacts) -> Result<()> {
        let tx = self.conn.transaction()?;
        require_owner(&tx, &input.design_id, &input.project_id)?;
        if let Some(DesignWrite { design, save }) = &input.design {
            if update_design(&tx, &input.project_id, &input.design_id, design, *save)? == 0 {
                return Err(rule("Stale design document revision during atomic save."));
            }
            touch_project(&tx, save.saved_at, &input.project_id)?;
        }
        if let Some(ScenariosWrite { scenarios, save }) = &input.scenarios {
            if current_revision(&tx, "scenario_documents", &input.design_id)?.is_some_and(|current| current >= save.revision) {
                return Err(rule("Stale scenario revision during atomic save."));
            }
            write_sources(&tx, "scenarios", &input.project_id, &input.design_id, scenarios, *save)?;
        }
        if let Some(EdgeFunctionsWrite { edge_functions, save }) = &input.edge_functions {
            if current_revision(&tx, "edge_function_documents", &input.design_id)?.is_some_and(|current| current >= save.revision) {
                return Err(rule("Stale edge function revision during atomic save."));
            }
            write_sources(&tx, "edge_functions", &input.project_id, &input.design_id, edge_functions, *save)?;
        }
        if let Some(SystemDesignWrite { system_design, save }) = &input.system_design {
            write_system_design(&tx, &input.project_id, system_design, *save)?;
        }
        if let Some(WalkthroughsWrite { walkthroughs, save }) = &input.walkthroughs {
            write_walkthroughs(&tx, &input.project_id, walkthroughs, *save)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The Project's first design with its stored document, or `None` for an unknown Project.
    pub fn load_project(&self, project_id: &str) -> Result<Option<ProjectRecord>> {
        let row = self
            .conn
            .query_row(
                "SELECT projects.id, projects.name, designs.id, designs.revision, designs.document_revision,
					designs.document, designs.updated_at
				 FROM projects JOIN designs ON designs.project_id = projects.id
				 WHERE projects.id = ? ORDER BY designs.rowid ASC LIMIT 1",
                [project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, name, design_id, revision, document_revision, document, saved_at)) = row else { return Ok(None) };
        Ok(Some(ProjectRecord {
            project: ProjectSummary { id, name },
            design: serde_json::from_str(&document)?,
            design_id,
            revision,
            document_revision,
            saved_at,
        }))
    }

    pub fn list_designs(&self, project_id: &str) -> Result<Vec<DatabaseDesignSummary>> {
        let mut statement = self.conn.prepare("SELECT id, project_id, name FROM designs WHERE project_id = ? ORDER BY rowid ASC")?;
        let rows = statement
            .query_map([project_id], |row| {
                Ok(DatabaseDesignSummary { id: row.get(0)?, project_id: row.get(1)?, name: row.get(2)? })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    pub fn load_design(&self, design_id: &str) -> Result<Option<DatabaseDesignRecord>> {
        let row = self
            .conn
            .query_row(
                "SELECT id, project_id, name, revision, document_revision, document, updated_at FROM designs WHERE id = ?",
                [design_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, project_id, name, revision, document_revision, document, saved_at)) = row else { return Ok(None) };
        Ok(Some(DatabaseDesignRecord {
            id,
            project_id,
            name,
            design: serde_json::from_str(&document)?,
            revision,
            document_revision,
            saved_at,
        }))
    }

    pub fn load_system_design(&self, project_id: &str) -> Result<Option<SystemDesignRecord>> {
        let row = self
            .conn
            .query_row(
                "SELECT document, revision, document_revision, last_view, updated_at FROM system_designs WHERE project_id = ?",
                [project_id],
                |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?))
                },
            )
            .optional()?;
        let Some((document, revision, document_revision, last_view, saved_at)) = row else { return Ok(None) };
        Ok(Some(SystemDesignRecord {
            document: serde_json::from_str(&document)?,
            revision,
            document_revision,
            saved_at,
            last_view: SystemViewName::from_stored(&last_view),
        }))
    }

    pub fn save_system_design(&mut self, project_id: &str, document: &Value, save: DesignSave) -> Result<()> {
        let tx = self.conn.transaction()?;
        write_system_design(&tx, project_id, document, save)?;
        tx.commit()?;
        Ok(())
    }

    pub fn save_last_view(&self, project_id: &str, view: SystemViewName) -> Result<()> {
        self.conn.execute("UPDATE system_designs SET last_view = ? WHERE project_id = ?", params![view.as_str(), project_id])?;
        Ok(())
    }

    /// The Project's Walkthroughs, or `None` when none have been saved yet.
    pub fn load_walkthroughs(&self, project_id: &str) -> Result<Option<WalkthroughDocumentRecord>> {
        let row = self
            .conn
            .query_row(
                "SELECT document, revision, updated_at FROM walkthrough_documents WHERE project_id = ?",
                [project_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()?;
        let Some((document, revision, saved_at)) = row else { return Ok(None) };
        Ok(Some(WalkthroughDocumentRecord { document: serde_json::from_str(&document)?, revision, saved_at }))
    }

    pub fn save_walkthroughs(&mut self, project_id: &str, walkthroughs: &Value, save: ScenarioSave) -> Result<()> {
        let tx = self.conn.transaction()?;
        write_walkthroughs(&tx, project_id, walkthroughs, save)?;
        tx.commit()?;
        Ok(())
    }

    /// Writes a whole imported Project in one transaction: all of it is stored, or none of it.
    pub fn import_project(&mut self, prepared: &PreparedProjectImport, saved_at: i64) -> Result<()> {
        let tx = self.conn.transaction()?;
        let project_id = &prepared.project.id;
        tx.execute(
            "INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
            params![project_id, prepared.project.name, saved_at, saved_at],
        )?;
        let first_save = DesignSave { revision: 1, document_revision: 1, saved_at };
        for design in &prepared.designs {
            insert_design(&tx, &design.id, project_id, &design.name, &design.design, first_save)?;
        }
        for design in &prepared.designs {
            insert_sources(&tx, "scenarios", project_id, &design.id, &design.scenarios)?;
            tx.execute(
                "INSERT INTO scenario_documents (project_id, design_id, revision, updated_at) VALUES (?, ?, 1, ?)",
                params![project_id, design.id, saved_at],
            )?;
            insert_sources(&tx, "edge_functions", project_id, &design.id, &design.edge_functions)?;
            tx.execute(
                "INSERT INTO edge_function_documents (project_id, design_id, revision, updated_at) VALUES (?, ?, 1, ?)",
                params![project_id, design.id, saved_at],
            )?;
        }
        tx.execute(
            "INSERT INTO system_designs (project_id, document, revision, document_revision, last_view, updated_at)
			 VALUES (?, ?, 1, 1, ?, ?)",
            params![project_id, json(&prepared.system_design)?, prepared.active_view.as_str(), saved_at],
        )?;
        tx.execute(
            "INSERT INTO walkthrough_documents (project_id, document, revision, updated_at) VALUES (?, ?, 1, ?)",
            params![project_id, json(&prepared.walkthroughs)?, saved_at],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn load_scenarios(&self, project_id: &str, design_id: &str) -> Result<ScenarioDocumentRecord> {
        self.require_owner(design_id, project_id)?;
        let (scenarios, revision, saved_at) = self.load_sources("scenarios", "scenario_documents", design_id)?;
        Ok(ScenarioDocumentRecord { scenarios, revision, saved_at, design_id: design_id.to_owned() })
    }

    /// Replaces a design's Scenarios unless a revision at least this new is already stored.
    pub fn save_scenarios(&mut self, project_id: &str, scenarios: &[StoredScenario], save: ScenarioSave, design_id: &str) -> Result<()> {
        self.save_sources("scenarios", "scenario_documents", project_id, design_id, scenarios, save)
    }

    pub fn load_edge_functions(&self, project_id: &str, design_id: &str) -> Result<EdgeFunctionDocumentRecord> {
        self.require_owner(design_id, project_id)?;
        let (edge_functions, revision, saved_at) = self.load_sources("edge_functions", "edge_function_documents", design_id)?;
        Ok(EdgeFunctionDocumentRecord { edge_functions, revision, saved_at, design_id: design_id.to_owned() })
    }

    pub fn save_edge_functions(&mut self, project_id: &str, edge_functions: &[StoredEdgeFunction], save: ScenarioSave, design_id: &str) -> Result<()> {
        self.save_sources("edge_functions", "edge_function_documents", project_id, design_id, edge_functions, save)
    }

    fn require_owner(&self, design_id: &str, project_id: &str) -> Result<()> {
        require_owner(&self.conn, design_id, project_id)
    }

    fn load_sources(&self, table: &str, documents: &str, design_id: &str) -> Result<(Vec<StoredSource>, i64, Option<i64>)> {
        let mut statement = self.conn.prepare(&format!(
            "SELECT id, name, source, design_id FROM {table} WHERE design_id = ? ORDER BY position ASC"
        ))?;
        let sources = statement
            .query_map([design_id], |row| {
                let owner: Option<String> = row.get(3)?;
                Ok(StoredSource {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source: row.get(2)?,
                    design_id: Some(owner.unwrap_or_else(|| design_id.to_owned())),
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        let document = self
            .conn
            .query_row(&format!("SELECT revision, updated_at FROM {documents} WHERE design_id = ?"), [design_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
            })
            .optional()?;
        Ok(match document {
            Some((revision, updated_at)) => (sources, revision, Some(updated_at)),
            None => (sources, 0, None),
        })
    }

    fn save_sources(
        &mut self,
        table: &str,
        documents: &str,
        project_id: &str,
        design_id: &str,
        sources: &[StoredSource],
        save: ScenarioSave,
    ) -> Result<()> {
        let tx = self.conn.transaction()?;
        require_owner(&tx, design_id, project_id)?;
        if current_revision(&tx, documents, design_id)?.is_some_and(|current| current >= save.revision) {
            return Ok(());
        }
        write_sources(&tx, table, project_id, design_id, sources, save)?;
        tx.commit()?;
        Ok(())
    }
}

fn require_owner(conn: &Connection, design_id: &str, project_id: &str) -> Result<()> {
    let owner = conn
        .query_row("SELECT id FROM designs WHERE id = ? AND project_id = ?", params![design_id, project_id], |_| Ok(()))
        .optional()?;
    owner.ok_or_else(|| not_owned(design_id, project_id))
}

fn touch_project(conn: &Connection, saved_at: i64, project_id: &str) -> Result<()> {
    conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", params![saved_at, project_id])?;
    Ok(())
}

fn insert_design(conn: &Connection, design_id: &str, project_id: &str, name: &str, design: &Value, save: DesignSave) -> Result<()> {
    conn.execute(
        "INSERT INTO designs (id, project_id, name, revision, document_revision, document, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![design_id, project_id, name, save.revision, save.document_revision, json(design)?, save.saved_at],
    )?;
    Ok(())
}

/// Updates a design document only when this write is newer. Returns the rows changed.
fn update_design(conn: &Connection, project_id: &str, design_id: &str, design: &Value, save: DesignSave) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE designs SET revision = ?, document_revision = ?, document = ?, updated_at = ?
		 WHERE id = ? AND project_id = ? AND document_revision < ?",
        params![save.revision, save.document_revision, json(design)?, save.saved_at, design_id, project_id, save.document_revision],
    )?)
}

fn current_revision(conn: &Connection, documents: &str, design_id: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(&format!("SELECT revision FROM {documents} WHERE design_id = ?"), [design_id], |row| row.get(0))
        .optional()?)
}

fn insert_sources(conn: &Connection, table: &str, project_id: &str, design_id: &str, sources: &[StoredSource]) -> Result<()> {
    for (position, source) in sources.iter().enumerate() {
        conn.execute(
            &format!("INSERT INTO {table} (project_id, design_id, id, position, name, source) VALUES (?, ?, ?, ?, ?, ?)"),
            params![project_id, design_id, source.id, position as i64, source.name, source.source],
        )?;
    }
    Ok(())
}

/// Replaces a design's Scenarios or Edge functions and records the new revision.
fn write_sources(tx: &Transaction, table: &str, project_id: &str, design_id: &str, sources: &[StoredSource], save: ScenarioSave) -> Result<()> {
    let documents = if table == "scenarios" { "scenario_documents" } else { "edge_function_documents" };
    tx.execute(&format!("DELETE FROM {table} WHERE design_id = ?"), [design_id])?;
    insert_sources(tx, table, project_id, design_id, sources)?;
    tx.execute(
        &format!(
            "INSERT INTO {documents} (project_id, design_id, revision, updated_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(design_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, project_id = excluded.project_id
			 WHERE {documents}.revision < excluded.revision"
        ),
        params![project_id, design_id, save.revision, save.saved_at],
    )?;
    touch_project(tx, save.saved_at, project_id)
}

fn write_system_design(tx: &Transaction, project_id: &str, system_design: &Value, save: DesignSave) -> Result<()> {
    let changed = tx.execute(
        "UPDATE system_designs SET document = ?, revision = ?, document_revision = ?, updated_at = ?
		 WHERE project_id = ? AND document_revision < ?",
        params![json(system_design)?, save.revision, save.document_revision, save.saved_at, project_id, save.document_revision],
    )?;
    if changed == 0 {
        return Err(rule("Stale System design revision during save."));
    }
    touch_project(tx, save.saved_at, project_id)
}

fn write_walkthroughs(tx: &Transaction, project_id: &str, walkthroughs: &Value, save: ScenarioSave) -> Result<()> {
    let changed = tx.execute(
        "INSERT INTO walkthrough_documents (project_id, document, revision, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET document = excluded.document, revision = excluded.revision, updated_at = excluded.updated_at
		 WHERE walkthrough_documents.revision < excluded.revision",
        params![project_id, json(walkthroughs)?, save.revision, save.saved_at],
    )?;
    if changed == 0 {
        return Err(rule("Stale Walkthrough revision during save."));
    }
    touch_project(tx, save.saved_at, project_id)
}
