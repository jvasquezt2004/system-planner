import { generateDesignSql, renderSchemaFile } from "./sql";
import { translateDdlText } from "./assistant-ddl";
import { adoptIdentities } from "./schema-identity";
import { createPGliteSandbox } from "./sandbox";
import { errorMessage } from "../shared/error-message";
import type { Design, WorkspaceState } from "../shared/design";
import type { DesignWorkspace } from "./workspace";

export type SchemaFileResult =
	| { status: "unchanged" }
	| { status: "applied"; state: WorkspaceState; tablesAdded: string[]; tablesRemoved: string[]; tablesChanged: string[]; keptAsSql: string[] };

const normalize = (sql: string) => sql.replace(/\r\n/g, "\n").trim();

/**
 * Turns the edited text of a Design's schema.sql back into that Design. Tables, columns and the rest are
 * read by name, so everything that still exists keeps its identity, position, and notes. PostgreSQL has to
 * accept the result before anything changes.
 */
export async function applySchemaFile(
	workspace: DesignWorkspace,
	text: string,
	options: { expectedProjectId?: string; expectedDesignId?: string; assistantTurnId?: string; idFactory?: () => string } = {},
): Promise<SchemaFileResult> {
	const state = workspace.getState();
	if (!state.project || !state.design || !state.activeDesignId) throw new Error("Open a database Design before applying its schema file.");
	if (options.expectedProjectId && state.project.id !== options.expectedProjectId) throw new Error("The project changed before the schema file was applied.");
	if (options.expectedDesignId && state.activeDesignId !== options.expectedDesignId) throw new Error("The Design changed before the schema file was applied.");
	const current: Design = state.design;
	const generated = generateDesignSql(current);
	// A Design with problems is never "unchanged": applying its file is how it gets repaired.
	if (generated.ok && normalize(renderSchemaFile(current)) === normalize(text)) return { status: "unchanged" };

	const empty: Design = { tables: [], relationships: [], manyToManyRelationships: [], viewport: { ...current.viewport } };
	let translated;
	try { translated = await translateDdlText(empty, text, options.idFactory); }
	catch (error) { throw new Error(`schema.sql could not be read: ${errorMessage(error)}`); }
	if (translated.statementCount === 0 && (current.tables.length > 0 || (current.rawStatements ?? []).length > 0)) {
		throw new Error(`schema.sql has no SQL statements (only comments or nothing), which would delete the whole schema. Nothing was applied. ${generated.ok ? "Edit the SQL in the file instead." : `The Design has problems (${generated.errors.slice(0, 3).join(" ")}), so the file may have been shortened; read it again.`}`);
	}
	const next = adoptIdentities(current, translated.design);
	const nextSql = generateDesignSql(next);
	if (!nextSql.ok) throw new Error(`The schema in schema.sql is incomplete: ${nextSql.errors.join(" ")} Nothing was applied.`);

	const scratch = createPGliteSandbox();
	try {
		const result = await scratch.apply(nextSql.sql);
		if (!result.ok) throw new Error(`PostgreSQL rejected schema.sql, so nothing was applied: ${result.error}`);
	} finally { await scratch.dispose(); }

	const latest = workspace.getState();
	if (latest.project?.id !== state.project.id || latest.activeDesignId !== state.activeDesignId || latest.revision !== state.revision) {
		throw new Error("The Design changed while schema.sql was being applied. Read schema.sql again and repeat the edit.");
	}
	const applied = await workspace.applyAssistantDesign(next, state.activeDesignId, options.assistantTurnId);
	const fingerprint = (design: Design) => new Map(design.tables.map((table) => [table.name, JSON.stringify({ ...table, position: undefined })]));
	const before = fingerprint(current);
	const after = fingerprint(applied.design ?? next);
	return {
		status: "applied",
		state: applied,
		tablesAdded: [...after.keys()].filter((name) => !before.has(name)),
		tablesRemoved: [...before.keys()].filter((name) => !after.has(name)),
		tablesChanged: [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)),
		keptAsSql: translated.keptAsSql,
	};
}
