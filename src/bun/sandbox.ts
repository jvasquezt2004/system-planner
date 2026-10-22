import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type {
	SandboxAppliedRelationship,
	SandboxAppliedTable,
	SandboxFailure,
} from "../shared/design";

export type SandboxApplyResult =
	| { ok: true; tables: SandboxAppliedTable[]; relationships: SandboxAppliedRelationship[] }
	| { ok: false; failure: SandboxFailure; error: string };

/**
 * A disposable PostgreSQL preview. Applying always builds a fresh database, so
 * a design change never has to migrate or preserve sandbox data.
 */
export interface SchemaSandbox {
	apply(sql: string): Promise<SandboxApplyResult>;
	dispose(): Promise<void>;
}

type CatalogRow = {
	table_name: string;
	column_name: string;
	data_type: string;
	is_identity: string;
	column_default: string | null;
	is_nullable: string;
	is_primary_key: boolean;
	is_unique: boolean;
};
type IndexRow = { table_name: string; index_name: string; method: string; is_unique: boolean; definition: string };
const INDEX_QUERY = `SELECT t.relname AS table_name, i.relname AS index_name, am.amname AS method, ix.indisunique AS is_unique, pg_get_indexdef(i.oid) AS definition FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_am am ON am.oid = i.relam JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = 'public' AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid) ORDER BY t.relname, i.relname`;

const CATALOG_QUERY = `
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
`;

type RelationshipRow = {
	constraint_name: string;
	referencing_table: string;
	referencing_column: string;
	referenced_table: string;
	referenced_column: string;
	update_code: string;
	delete_code: string;
};

/** Reads the foreign keys PostgreSQL actually created, not the intended draft. */
const RELATIONSHIP_QUERY = `
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
`;

/** PostgreSQL stores referential actions as single-character codes. */
const REFERENTIAL_ACTIONS: Record<string, string> = {
	a: "NO ACTION",
	r: "RESTRICT",
	c: "CASCADE",
	n: "SET NULL",
	d: "SET DEFAULT",
};

export function createPGliteSandbox(): SchemaSandbox {
	let database: PGlite | null = null;

	return {
		async apply(sql) {
			const instance = new PGlite({ extensions: { vector } });
			database = instance;
			let failure: SandboxFailure = "sandbox-error";
			try {
				await instance.waitReady;
				failure = "sql-rejected";
				await instance.exec(sql);
				failure = "sandbox-error";
				const result = await instance.query<CatalogRow>(CATALOG_QUERY);
				const relationships = await instance.query<RelationshipRow>(
					RELATIONSHIP_QUERY,
				);
				const indexes = await instance.query<IndexRow>(INDEX_QUERY);
				return {
					ok: true,
					tables: groupCatalogRows(result.rows, indexes.rows),
					relationships: groupRelationshipRows(relationships.rows),
				};
			} catch (error) {
				return {
					ok: false,
					failure,
					error: error instanceof Error ? error.message : String(error),
				};
			}
		},
		async dispose() {
			const instance = database;
			database = null;
			if (instance) await instance.close();
		},
	};
}

function groupCatalogRows(rows: CatalogRow[], indexRows: IndexRow[]): SandboxAppliedTable[] {
	const tables = new Map<string, SandboxAppliedTable>();
	for (const row of rows) {
		let table = tables.get(row.table_name);
		if (!table) {
			table = { name: row.table_name, columns: [] };
			tables.set(row.table_name, table);
		}
		table.columns.push({
			name: row.column_name,
			dataType: row.data_type,
			isIdentity: row.is_identity === "YES",
			defaultExpression: row.column_default,
			nullable: row.is_nullable === "YES",
			primaryKey: Boolean(row.is_primary_key),
			unique: Boolean(row.is_unique),
		});
	}
	for (const row of indexRows) {
		let table = tables.get(row.table_name);
		if (!table) { table = { name: row.table_name, columns: [] }; tables.set(row.table_name, table); }
		(table.indexes ??= []).push({ name: row.index_name, method: row.method, unique: row.is_unique, definition: row.definition });
	}
	return [...tables.values()];
}

function groupRelationshipRows(rows: RelationshipRow[]): SandboxAppliedRelationship[] {
	return rows.map((row) => ({
		name: row.constraint_name,
		referencingTable: row.referencing_table,
		referencingColumn: row.referencing_column,
		referencedTable: row.referenced_table,
		referencedColumn: row.referenced_column,
		updateRule: REFERENTIAL_ACTIONS[row.update_code] ?? row.update_code,
		deleteRule: REFERENTIAL_ACTIONS[row.delete_code] ?? row.delete_code,
	}));
}
