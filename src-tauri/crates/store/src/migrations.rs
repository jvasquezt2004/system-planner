//! Schema migrations, ported from `src/bun/store.ts`.
//!
//! A database written by the Electrobun app, at any past schema version, must
//! open here and end up in the same shape the TypeScript store would leave it.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params};
use schema_domain::system_design::create_migrated_system_design;
use uuid::Uuid;

use crate::{Result, StoreError};

/// Schema version that scopes scenario and Edge function keys to their owning
/// Design. Version 1 (and unversioned databases) keyed them by Project.
pub const DESIGN_SCOPED_ARTIFACTS_VERSION: i64 = 2;

pub const SCHEMA: &str = "
	CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS designs (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		name TEXT NOT NULL DEFAULT '',
		revision INTEGER NOT NULL,
		document_revision INTEGER NOT NULL DEFAULT 0,
		document TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_designs_project_id ON designs(project_id);

	CREATE TABLE IF NOT EXISTS scenarios (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		position INTEGER NOT NULL,
		name TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (design_id, id)
	);

	CREATE INDEX IF NOT EXISTS idx_scenarios_design_id ON scenarios(design_id);

	CREATE TABLE IF NOT EXISTS scenario_documents (
		design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS edge_functions (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		position INTEGER NOT NULL,
		name TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (design_id, id),
		UNIQUE (design_id, name)
	);

	CREATE INDEX IF NOT EXISTS idx_edge_functions_design_id ON edge_functions(design_id);

	CREATE TABLE IF NOT EXISTS edge_function_documents (
		design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS system_designs (
		project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
		document TEXT NOT NULL,
		revision INTEGER NOT NULL,
		document_revision INTEGER NOT NULL,
		last_view TEXT NOT NULL DEFAULT 'system',
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS walkthrough_documents (
		project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
		document TEXT NOT NULL,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
";

fn table_names(conn: &Connection) -> Result<HashSet<String>> {
    let mut statement = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
    let names = statement.query_map([], |row| row.get::<_, String>(0))?.collect::<std::result::Result<_, _>>()?;
    Ok(names)
}

fn column_names(conn: &Connection, table: &str) -> Result<HashSet<String>> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = statement.query_map([], |row| row.get::<_, String>(1))?.collect::<std::result::Result<_, _>>()?;
    Ok(names)
}

/// Migrates legacy databases where the `designs` table had no `id` column: gives
/// each existing design a stable UUID and attaches existing scenarios and Edge
/// functions to it. A failure rolls everything back, leaving the legacy database.
pub fn migrate_to_explicit_design_identity(conn: &mut Connection) -> Result<()> {
    let tables = table_names(conn)?;
    if !tables.contains("designs") {
        return Ok(());
    }
    let columns = column_names(conn, "designs")?;
    if columns.contains("id") {
        return Ok(());
    }
    let has_document_revision = columns.contains("document_revision");

    let tx = conn.transaction()?;
    tx.execute_batch(
        "CREATE TABLE designs_migrating (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name TEXT NOT NULL DEFAULT '',
			revision INTEGER NOT NULL,
			document_revision INTEGER NOT NULL DEFAULT 0,
			document TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);",
    )?;

    type OldDesign = (String, i64, i64, String, i64);
    let old_designs: Vec<OldDesign> = if has_document_revision {
        let mut statement =
            tx.prepare("SELECT project_id, revision, document_revision, document, updated_at FROM designs")?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
            .collect::<std::result::Result<_, _>>()?
    } else {
        let mut statement = tx.prepare("SELECT project_id, revision, document, updated_at FROM designs")?;
        statement
            .query_map([], |row| {
                let revision: i64 = row.get(1)?;
                Ok((row.get(0)?, revision, revision, row.get(2)?, row.get(3)?))
            })?
            .collect::<std::result::Result<_, _>>()?
    };

    let mut project_design: HashMap<String, String> = HashMap::new();
    for (project_id, revision, document_revision, document, updated_at) in old_designs {
        let design_id = Uuid::new_v4().to_string();
        project_design.insert(project_id.clone(), design_id.clone());
        tx.execute(
            "INSERT INTO designs_migrating (id, project_id, name, revision, document_revision, document, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![design_id, project_id, "", revision, document_revision, document, updated_at],
        )?;
    }

    for table in ["scenarios", "scenario_documents", "edge_functions", "edge_function_documents"] {
        if !tables.contains(table) {
            continue;
        }
        if !column_names(&tx, table)?.contains("design_id") {
            tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN design_id TEXT"))?;
        }
        for (project_id, design_id) in &project_design {
            tx.execute(&format!("UPDATE {table} SET design_id = ? WHERE project_id = ?"), params![design_id, project_id])?;
        }
    }

    tx.execute_batch("DROP TABLE designs")?;
    tx.execute_batch("ALTER TABLE designs_migrating RENAME TO designs")?;
    tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_designs_project_id ON designs(project_id)")?;
    if tables.contains("scenarios") {
        tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_scenarios_design_id ON scenarios(design_id)")?;
    }
    if tables.contains("edge_functions") {
        tx.execute_batch("CREATE INDEX IF NOT EXISTS idx_edge_functions_design_id ON edge_functions(design_id)")?;
    }
    tx.commit()?;
    Ok(())
}

/// Re-keys scenario and Edge function storage by owning Design (version 2).
/// Rows whose Design is missing attach to the Project's first Design. The DDL
/// below is the frozen version-2 shape and is independent of [`SCHEMA`].
pub fn migrate_design_scoped_artifacts(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version >= DESIGN_SCOPED_ARTIFACTS_VERSION {
        return Ok(());
    }
    let tables = table_names(conn)?;
    // A database without a designs table is new; SCHEMA creates the scoped tables directly.
    if !tables.contains("designs") {
        return Ok(());
    }

    struct Migration {
        table: &'static str,
        columns: &'static [&'static str],
        ddl: &'static str,
    }
    let migrations = [
        Migration {
            table: "scenarios",
            columns: &["project_id", "id", "position", "name", "source"],
            ddl: "(
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				position INTEGER NOT NULL,
				name TEXT NOT NULL,
				source TEXT NOT NULL,
				PRIMARY KEY (design_id, id)
			)",
        },
        Migration {
            table: "scenario_documents",
            columns: &["project_id", "revision", "updated_at"],
            ddl: "(
				design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)",
        },
        Migration {
            table: "edge_functions",
            columns: &["project_id", "id", "position", "name", "source"],
            ddl: "(
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				position INTEGER NOT NULL,
				name TEXT NOT NULL,
				source TEXT NOT NULL,
				PRIMARY KEY (design_id, id),
				UNIQUE (design_id, name)
			)",
        },
        Migration {
            table: "edge_function_documents",
            columns: &["project_id", "revision", "updated_at"],
            ddl: "(
				design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)",
        },
    ];

    let tx = conn.transaction()?;
    for Migration { table, columns, ddl } in migrations {
        if !tables.contains(table) {
            continue;
        }
        let existing = column_names(&tx, table)?;
        let first_design = "(SELECT d.id FROM designs d WHERE d.project_id = t.project_id ORDER BY d.rowid LIMIT 1)";
        let owner = if existing.contains("design_id") {
            format!("COALESCE(t.design_id, {first_design})")
        } else {
            first_design.to_string()
        };
        let staging = format!("{table}_design_scoped");
        let list = columns.join(", ");
        let qualified = columns.iter().map(|column| format!("t.{column}")).collect::<Vec<_>>().join(", ");
        tx.execute_batch(&format!("DROP TABLE IF EXISTS {staging}"))?;
        tx.execute_batch(&format!("CREATE TABLE {staging} {ddl}"))?;
        tx.execute_batch(&format!(
            "INSERT INTO {staging} (design_id, {list})
			 SELECT owner_id, {list} FROM (
				SELECT {owner} AS owner_id, {qualified} FROM {table} t
			 ) WHERE owner_id IS NOT NULL"
        ))?;
        tx.execute_batch(&format!("DROP TABLE {table}"))?;
        tx.execute_batch(&format!("ALTER TABLE {staging} RENAME TO {table}"))?;
    }
    tx.commit()?;
    Ok(())
}

/// Databases written before layout-only saves existed have no document revision;
/// their stored revision is a safe starting point for write ordering.
pub fn migrate_document_revision(conn: &Connection) -> Result<()> {
    if column_names(conn, "designs")?.contains("document_revision") {
        return Ok(());
    }
    conn.execute_batch("ALTER TABLE designs ADD COLUMN document_revision INTEGER NOT NULL DEFAULT 0")?;
    conn.execute_batch("UPDATE designs SET document_revision = revision WHERE document_revision = 0")?;
    Ok(())
}

/// Gives every Project without a System design the overview it needs. A migrated
/// Project keeps its database as the one system-scope Database component and
/// opens its database view first. One transaction: a failure changes nothing.
pub fn migrate_system_designs(conn: &mut Connection) -> Result<()> {
    type Row = (String, String, i64, i64, i64);
    let rows: Vec<Row> = {
        let mut statement = conn.prepare(
            "SELECT projects.id, designs.id AS design_id, designs.revision, designs.document_revision, designs.updated_at AS saved_at
			 FROM projects
			 JOIN designs ON designs.project_id = projects.id
			 WHERE projects.id NOT IN (SELECT project_id FROM system_designs)
			   AND designs.rowid = (SELECT MIN(rowid) FROM designs WHERE project_id = projects.id)",
        )?;
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
            .collect::<std::result::Result<_, _>>()?
    };
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    for (project_id, design_id, revision, document_revision, saved_at) in rows {
        let component_id = Uuid::new_v4().to_string();
        let document = serde_json::to_string(&create_migrated_system_design(&design_id, &component_id, "Database"))
            .map_err(StoreError::from)?;
        tx.execute(
            "INSERT INTO system_designs (project_id, document, revision, document_revision, last_view, updated_at)
			 VALUES (?, ?, ?, ?, 'database', ?)",
            params![project_id, document, revision, document_revision, saved_at],
        )?;
    }
    tx.commit()?;
    Ok(())
}
