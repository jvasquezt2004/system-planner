import type { ColumnType, Design, DesignColumn, DesignTable } from "../shared/design";

export type SqlGeneration =
	| { ok: true; sql: string }
	| { ok: false; errors: string[] };

const SUPPORTED_TYPES = new Set<ColumnType>([
	"bigint",
	"integer",
	"smallint",
	"text",
	"uuid",
	"boolean",
	"numeric",
	"date",
	"timestamptz",
	"jsonb",
]);

const INTEGER_TYPES = new Set<ColumnType>(["bigint", "integer", "smallint"]);

/**
 * Generates read-only PostgreSQL from the authoritative design. An incomplete
 * draft produces explicit errors instead of partial SQL.
 */
export function generateDesignSql(design: Design): SqlGeneration {
	const errors: string[] = [];
	if (design.tables.length === 0) {
		errors.push("Add a table to generate SQL.");
	}

	const tableNames = new Set<string>();
	for (const table of design.tables) {
		validateTable(table, tableNames, errors);
	}

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, sql: `${design.tables.map(renderTable).join("\n\n")}\n` };
}

function validateTable(table: DesignTable, tableNames: Set<string>, errors: string[]) {
	const name = table.name.trim();
	const label = name.length > 0 ? `"${name}"` : "(unnamed table)";

	if (name.length === 0) errors.push("Every table needs a name.");
	else if (tableNames.has(name)) errors.push(`Table name ${label} is used more than once.`);
	tableNames.add(name);

	if (table.columns.length === 0) errors.push(`Table ${label} needs at least one column.`);

	const columnNames = new Set<string>();
	let primaryKeys = 0;
	for (const column of table.columns) {
		validateColumn(table, column, columnNames, errors);
		if (column.primaryKey) primaryKeys += 1;
	}
	if (primaryKeys !== 1) {
		errors.push(`Table ${label} needs exactly one primary key column.`);
	}
}

function validateColumn(
	table: DesignTable,
	column: DesignColumn,
	columnNames: Set<string>,
	errors: string[],
) {
	const tableLabel = table.name.trim().length > 0 ? `"${table.name.trim()}"` : "(unnamed table)";
	const name = column.name.trim();
	const label = name.length > 0 ? `"${name}"` : "(unnamed column)";

	if (name.length === 0) errors.push(`Table ${tableLabel} has a column that needs a name.`);
	else if (columnNames.has(name)) {
		errors.push(`Column name ${label} is used more than once in table ${tableLabel}.`);
	}
	columnNames.add(name);

	if (!SUPPORTED_TYPES.has(column.type)) {
		errors.push(`Column ${label} in table ${tableLabel} uses an unsupported type.`);
	}
	if (column.identity && !INTEGER_TYPES.has(column.type)) {
		errors.push(`Column ${label} in table ${tableLabel} can only use identity on integer types.`);
	}
}

function renderTable(table: DesignTable): string {
	const primaryKey = table.columns.find((column) => column.primaryKey);
	const lines = table.columns.map(renderColumn);
	if (primaryKey) lines.push(`  PRIMARY KEY (${quoteIdentifier(primaryKey.name)})`);
	return `CREATE TABLE ${quoteIdentifier(table.name)} (\n${lines.join(",\n")}\n);`;
}

function renderColumn(column: DesignColumn): string {
	const parts = [`  ${quoteIdentifier(column.name)} ${column.type}`];
	if (column.identity) parts.push("GENERATED ALWAYS AS IDENTITY");
	if (column.primaryKey || column.identity || !column.nullable) parts.push("NOT NULL");
	return parts.join(" ");
}

/** Quotes an identifier so a name can never become an unintended SQL statement. */
export function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
