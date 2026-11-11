//! A disposable PostgreSQL preview (`src/bun/sandbox.ts`).
//!
//! Applying always builds a fresh database, so a design change never has to migrate
//! or preserve sandbox data. The engine is PGlite (real PostgreSQL 17 compiled to
//! WebAssembly) with pgvector, run in-process through `pglite-oxide`.

use pglite_oxide::{extensions, Pglite, PgliteError};
use serde::Serialize;
use serde_json::Value;

/// One column as PostgreSQL itself reports it after the SQL was applied.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedColumn {
    pub name: String,
    pub data_type: String,
    /// The applied enum type, when this is a user-defined enum column.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_type_name: Option<String>,
    pub is_identity: bool,
    /// PostgreSQL's own default expression, or null when the column has none.
    pub default_expression: Option<String>,
    pub nullable: bool,
    pub primary_key: bool,
    pub unique: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppliedIndex {
    pub name: String,
    pub method: String,
    pub unique: bool,
    pub definition: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AppliedTable {
    pub name: String,
    pub columns: Vec<AppliedColumn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexes: Option<Vec<AppliedIndex>>,
}

/// A foreign key reported by the applied sandbox, not by the draft.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedRelationship {
    pub name: String,
    pub referencing_table: String,
    pub referencing_column: String,
    pub referenced_table: String,
    pub referenced_column: String,
    pub update_rule: String,
    pub delete_rule: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// PostgreSQL refused the generated SQL.
    SqlRejected,
    /// The sandbox itself failed.
    SandboxError,
}

impl Failure {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SqlRejected => "sql-rejected",
            Self::SandboxError => "sandbox-error",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ApplyResult {
    Applied { tables: Vec<AppliedTable>, relationships: Vec<AppliedRelationship> },
    Failed { failure: Failure, error: String },
}

/// Something that can build a throwaway database from SQL and report what it contains.
/// The workspace depends on this, not on PGlite, so tests can substitute it.
pub trait Sandbox: Send {
    fn apply(&mut self, sql: &str) -> ApplyResult;
}

/// Sandbox environment installed before design SQL; never generated from the Design.
pub const SUPABASE_SANDBOX_BOOTSTRAP: &str = r#"
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
"#;

/// Existing public objects get the same grants as objects covered by defaults.
pub const SUPABASE_SANDBOX_GRANTS: &str = "
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
";

const INDEX_QUERY: &str = "SELECT t.relname AS table_name, i.relname AS index_name, am.amname AS method, ix.indisunique AS is_unique, pg_get_indexdef(i.oid) AS definition FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_am am ON am.oid = i.relam JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid) ORDER BY t.relname, i.relname";

const CATALOG_QUERY: &str = "
	SELECT c.table_name, c.column_name, c.data_type, c.is_identity, c.column_default,
		c.is_nullable,
		COALESCE(constraints.is_primary_key, false) AS is_primary_key,
		COALESCE(constraints.is_unique, false) AS is_unique
	FROM information_schema.columns c
	JOIN information_schema.tables t
		ON t.table_schema = c.table_schema AND t.table_name = c.table_name
	LEFT JOIN (
		SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
			bool_or(tc.constraint_type = 'PRIMARY KEY') AS is_primary_key,
			bool_or(
				tc.constraint_type = 'UNIQUE' AND constraint_columns.column_count = 1
			) AS is_unique
		FROM information_schema.table_constraints tc
		JOIN information_schema.key_column_usage kcu
			ON kcu.constraint_catalog = tc.constraint_catalog
			AND kcu.constraint_schema = tc.constraint_schema
			AND kcu.constraint_name = tc.constraint_name
			AND kcu.table_schema = tc.table_schema
			AND kcu.table_name = tc.table_name
		LEFT JOIN (
			SELECT constraint_catalog, constraint_schema, constraint_name,
				table_schema, table_name, COUNT(*) AS column_count
			FROM information_schema.key_column_usage
			GROUP BY constraint_catalog, constraint_schema, constraint_name,
				table_schema, table_name
		) constraint_columns
			ON constraint_columns.constraint_catalog = kcu.constraint_catalog
			AND constraint_columns.constraint_schema = kcu.constraint_schema
			AND constraint_columns.constraint_name = kcu.constraint_name
			AND constraint_columns.table_schema = kcu.table_schema
			AND constraint_columns.table_name = kcu.table_name
		WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
		GROUP BY kcu.table_schema, kcu.table_name, kcu.column_name
	) constraints
		ON constraints.table_schema = c.table_schema
		AND constraints.table_name = c.table_name
		AND constraints.column_name = c.column_name
	WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
	ORDER BY c.table_name, c.ordinal_position
";

/// Reads the foreign keys PostgreSQL actually created, not the intended draft.
const RELATIONSHIP_QUERY: &str = "
	SELECT con.conname AS constraint_name,
		referencing.relname AS referencing_table,
		referencing_column.attname AS referencing_column,
		referenced.relname AS referenced_table,
		referenced_column.attname AS referenced_column,
		con.confupdtype::text AS update_code,
		con.confdeltype::text AS delete_code
	FROM pg_constraint con
	JOIN pg_class referencing ON referencing.oid = con.conrelid
	JOIN pg_class referenced ON referenced.oid = con.confrelid
	JOIN pg_namespace namespace ON namespace.oid = referencing.relnamespace
	JOIN pg_attribute referencing_column
		ON referencing_column.attrelid = con.conrelid
		AND referencing_column.attnum = con.conkey[1]
	JOIN pg_attribute referenced_column
		ON referenced_column.attrelid = con.confrelid
		AND referenced_column.attnum = con.confkey[1]
	WHERE con.contype = 'f' AND namespace.nspname = 'public'
	ORDER BY referencing.relname, con.conname
";

/// PostgreSQL stores referential actions as single-character codes.
fn referential_action(code: &str) -> String {
    match code {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        other => other,
    }
    .to_owned()
}

/// The PostgreSQL message when the failure came from the database, otherwise the full error text.
fn message_of(error: &anyhow::Error) -> String {
    match error.downcast_ref::<PgliteError>() {
        Some(database) => database.database_error().message.clone(),
        None => format!("{error:#}"),
    }
}

fn text(row: &Value, key: &str) -> String {
    row[key].as_str().unwrap_or_default().to_owned()
}

fn flag(row: &Value, key: &str) -> bool {
    row[key].as_bool().unwrap_or(false)
}

/// PGlite-backed sandbox. Every `apply` opens a fresh in-memory database.
#[derive(Default)]
pub struct PgliteSandbox;

impl Sandbox for PgliteSandbox {
    fn apply(&mut self, sql: &str) -> ApplyResult {
        let mut failure = Failure::SandboxError;
        let outcome = (|| -> anyhow::Result<ApplyResult> {
            let mut db = Pglite::builder().temporary().extension(extensions::VECTOR).open()?;
            let applied = (|| -> anyhow::Result<ApplyResult> {
                db.exec(SUPABASE_SANDBOX_BOOTSTRAP, None)?;
                failure = Failure::SqlRejected;
                db.exec(sql, None)?;
                failure = Failure::SandboxError;
                db.exec(SUPABASE_SANDBOX_GRANTS, None)?;
                let columns = db.query(CATALOG_QUERY, &[], None)?;
                let relationships = db.query(RELATIONSHIP_QUERY, &[], None)?;
                let indexes = db.query(INDEX_QUERY, &[], None)?;
                Ok(ApplyResult::Applied {
                    tables: group_catalog_rows(&columns.rows, &indexes.rows),
                    relationships: relationships
                        .rows
                        .iter()
                        .map(|row| AppliedRelationship {
                            name: text(row, "constraint_name"),
                            referencing_table: text(row, "referencing_table"),
                            referencing_column: text(row, "referencing_column"),
                            referenced_table: text(row, "referenced_table"),
                            referenced_column: text(row, "referenced_column"),
                            update_rule: referential_action(&text(row, "update_code")),
                            delete_rule: referential_action(&text(row, "delete_code")),
                        })
                        .collect(),
                })
            })();
            let _ = db.close();
            applied
        })();
        outcome.unwrap_or_else(|error| ApplyResult::Failed { failure, error: message_of(&error) })
    }
}

fn group_catalog_rows(rows: &[Value], index_rows: &[Value]) -> Vec<AppliedTable> {
    let mut tables: Vec<AppliedTable> = Vec::new();
    for row in rows {
        let name = text(row, "table_name");
        let position = tables.iter().position(|table| table.name == name).unwrap_or_else(|| {
            tables.push(AppliedTable { name: name.clone(), columns: vec![], indexes: None });
            tables.len() - 1
        });
        tables[position].columns.push(AppliedColumn {
            name: text(row, "column_name"),
            data_type: text(row, "data_type"),
            enum_type_name: None,
            is_identity: text(row, "is_identity") == "YES",
            default_expression: row["column_default"].as_str().map(str::to_owned),
            nullable: text(row, "is_nullable") == "YES",
            primary_key: flag(row, "is_primary_key"),
            unique: flag(row, "is_unique"),
        });
    }
    for row in index_rows {
        let name = text(row, "table_name");
        let position = tables.iter().position(|table| table.name == name).unwrap_or_else(|| {
            tables.push(AppliedTable { name: name.clone(), columns: vec![], indexes: None });
            tables.len() - 1
        });
        tables[position].indexes.get_or_insert_with(Vec::new).push(AppliedIndex {
            name: text(row, "index_name"),
            method: text(row, "method"),
            unique: flag(row, "is_unique"),
            definition: text(row, "definition"),
        });
    }
    tables
}
