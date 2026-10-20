import { PGlite } from "@electric-sql/pglite";
import type { SandboxAppliedTable } from "../shared/design";

export type SandboxApplyResult =
	| { ok: true; tables: SandboxAppliedTable[] }
	| { ok: false; error: string };

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
	is_nullable: string;
};

const CATALOG_QUERY = `
	SELECT c.table_name, c.column_name, c.data_type, c.is_identity, c.is_nullable
	FROM information_schema.columns c
	JOIN information_schema.tables t
		ON t.table_schema = c.table_schema AND t.table_name = c.table_name
	WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
	ORDER BY c.table_name, c.ordinal_position
`;

export function createPGliteSandbox(): SchemaSandbox {
	let database: PGlite | null = null;

	return {
		async apply(sql) {
			const instance = new PGlite();
			database = instance;
			try {
				await instance.exec(sql);
				const result = await instance.query<CatalogRow>(CATALOG_QUERY);
				return { ok: true, tables: groupCatalogRows(result.rows) };
			} catch (error) {
				return {
					ok: false,
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

function groupCatalogRows(rows: CatalogRow[]): SandboxAppliedTable[] {
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
			nullable: row.is_nullable === "YES",
		});
	}
	return [...tables.values()];
}
