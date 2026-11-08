import type { Design, DesignTable } from "../shared/design";
import { planSchemaObjectNames } from "./sql";

/**
 * A Design read back from SQL has fresh ids and default positions. This gives everything that still
 * exists (by name) the id, canvas position, and notes it had before, so the canvas, Walkthroughs'
 * links, and history keep following the same tables and columns across a file edit.
 * Renaming in the file therefore reads as a removal plus an addition.
 */
export function adoptIdentities(previous: Design, next: Design): Design {
	const result = structuredClone(next);
	const ids = new Map<string, string>(); // next id -> previous id
	// A name the generated SQL gave an object is not a name the designer chose, so it is not stored.
	let planned: ReturnType<typeof planSchemaObjectNames> | null = null;
	try { planned = planSchemaObjectNames(previous); } catch { /* An incomplete draft has no planned names. */ }
	const claim = (nextId: string, previousId: string) => { if (nextId !== previousId) ids.set(nextId, previousId); };

	const tableName = (design: Design, id: string) => design.tables.find((table) => table.id === id)?.name ?? "";
	const columnName = (table: DesignTable, id: string) => table.columns.find((column) => column.id === id)?.name ?? "";

	for (const table of result.tables) {
		const old = previous.tables.find((candidate) => candidate.name === table.name);
		if (!old) continue;
		claim(table.id, old.id);
		table.position = { ...old.position };
		for (const column of table.columns) {
			const oldColumn = old.columns.find((candidate) => candidate.name === column.name);
			if (!oldColumn) continue;
			claim(column.id, oldColumn.id);
			// Notes live only in the Design, never in the SQL.
			if (!column.notes && oldColumn.notes) column.notes = oldColumn.notes;
		}
		const uniqueKey = (t: DesignTable, ids: string[]) => ids.map((id) => columnName(t, id)).sort().join(",");
		for (const constraint of table.uniqueConstraints ?? []) {
			const match = (old.uniqueConstraints ?? []).find((candidate) => uniqueKey(old, candidate.columnIds) === uniqueKey(table, constraint.columnIds));
			if (!match) continue;
			claim(constraint.id, match.id);
			if (!match.name && constraint.name === planned?.uniqueConstraints.get(match.id)) delete constraint.name;
		}
		const indexKey = (t: DesignTable, index: NonNullable<DesignTable["indexes"]>[number]) =>
			`${index.method}|${index.unique ? "u" : ""}|${index.keys.map((key) => columnName(t, key.columnId)).join(",")}`;
		for (const index of table.indexes ?? []) {
			const candidates = (old.indexes ?? []).filter((candidate) => indexKey(old, candidate) === indexKey(table, index));
			const match = candidates.find((candidate) => candidate.name === index.name || planned?.indexes.get(candidate.id) === index.name) ?? candidates[0];
			if (!match) continue;
			claim(index.id, match.id);
			if (!match.name && index.name === planned?.indexes.get(match.id)) delete index.name;
		}
		for (const policy of table.policies ?? []) {
			const match = (old.policies ?? []).find((candidate) => candidate.name === policy.name);
			if (match) claim(policy.id, match.id);
		}
	}

	for (const enumType of result.enumTypes ?? []) {
		const match = (previous.enumTypes ?? []).find((candidate) => candidate.name === enumType.name);
		if (match) claim(enumType.id, match.id);
	}
	const signature = (fn: NonNullable<Design["functions"]>[number]) => `${fn.name}(${fn.arguments.map((argument) => argument.type).join(",")})`;
	for (const fn of result.functions ?? []) {
		const match = (previous.functions ?? []).find((candidate) => signature(candidate) === signature(fn));
		if (match) claim(fn.id, match.id);
	}
	for (const trigger of result.triggers ?? []) {
		const table = tableName(result, trigger.tableId);
		const match = (previous.triggers ?? []).find((candidate) => candidate.name === trigger.name && tableName(previous, candidate.tableId) === table);
		if (match) claim(trigger.id, match.id);
	}

	const relationshipKey = (design: Design, r: Design["relationships"][number]) => {
		const from = design.tables.find((table) => table.id === r.referencingTableId);
		return `${from?.name}.${from ? columnName(from, r.referencingColumnId) : ""}->${tableName(design, r.referencedTableId)}`;
	};
	for (const relationship of result.relationships) {
		const match = previous.relationships.find((candidate) => relationshipKey(previous, candidate) === relationshipKey(result, relationship));
		if (match) claim(relationship.id, match.id);
	}
	for (const association of result.manyToManyRelationships) {
		const junction = tableName(result, association.junctionTableId);
		const match = previous.manyToManyRelationships.find((candidate) => tableName(previous, candidate.junctionTableId) === junction);
		if (match) claim(association.id, match.id);
	}

	// Raw SQL has no name, so identical text keeps its id, in order.
	const unclaimed = [...(previous.rawStatements ?? [])];
	for (const raw of result.rawStatements ?? []) {
		const position = unclaimed.findIndex((candidate) => candidate.sql === raw.sql);
		if (position >= 0) claim(raw.id, unclaimed.splice(position, 1)[0].id);
	}

	const rename = (value: unknown): unknown => {
		if (typeof value === "string") return ids.get(value) ?? value;
		if (Array.isArray(value)) return value.map(rename);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rename(entry)]));
		return value;
	};
	const adopted = rename(result) as Design;
	adopted.viewport = { ...previous.viewport };
	for (const table of adopted.tables) { table.rowLevelSecurity ??= false; table.policies ??= []; }
	return adopted;
}
