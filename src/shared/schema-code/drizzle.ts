import type { Design, DesignColumn, DesignIndex, DesignRelationship, DesignTable } from "../design";
import { renderDefaultExpression } from "../column-defaults";
import { planSchemaObjectNames } from "../../bun/sql";
import { postgresGeneratedObjectName } from "../postgres-identifiers";
import type { SchemaCodeGeneration } from "./types";

type RelationPlan = {
	relationship: DesignRelationship;
	table: DesignTable;
	column: DesignColumn;
	target: DesignTable;
	targetKey: DesignColumn;
	forward: string;
	inverse: string;
	relationName: string;
};

const RESERVED = new Set(
	[
		"await break case catch class const continue debugger default delete do else enum export",
		"extends false finally for function if import in instanceof new null return super switch",
		"this throw true try typeof var void while with yield let static implements interface package",
		"private protected public arguments eval abstract boolean byte char double final float goto",
		"int long native short synchronized throws transient volatile as satisfies unknown type from",
		"where of get set async constructor prototype __proto__ any number string symbol namespace",
		"module require declare global infer is asserts keyof unique never object readonly",
	]
		.join(" ")
		.split(" "),
);

/** Generates stable Drizzle PostgreSQL schema code for a PostgreSQL-valid design. */
export function generateDrizzleSchema(design: Design): SchemaCodeGeneration {
	const tables = design.tables;
	const reservedImports = new Set(["pg", "drizzleRelations", "AnyPgColumn", "sql"]);
	const tableVars = allocateNamed(
		tables.map((table) => [table.id, table.name] as const),
		reservedImports,
		"table",
	);
	const enumTypes = design.enumTypes ?? [];
	const enumVars = allocateNamed(
		enumTypes.map((item) => [item.id, item.name] as const),
		new Set([...tableVars.values(), ...reservedImports]),
		"enum",
	);
	const columnsByTable = new Map<string, Map<string, string>>();
	for (const table of tables) {
		columnsByTable.set(
			table.id,
			allocateNamed(
				table.columns.map((column) => [column.id, column.name] as const),
				new Set(),
				"field",
			),
		);
	}

	const objectNames = planSchemaObjectNames(design);
	const relationships = planRelations(design);
	const relationVars = allocateNamed(
		tables.map((table) => [table.id, `${tableVars.get(table.id)}Relations`] as const),
		new Set([...tableVars.values(), ...enumVars.values(), ...reservedImports]),
		"relations",
	);
	const needsAnyPgColumn = relationships.some((item) => item.table.id === item.target.id);
	const needsSql = tables.some((table) =>
		table.columns.some((column) => column.default.kind === "literal"),
	);
	const imports = [
		'import * as pg from "drizzle-orm/pg-core";',
		...(relationships.length
			? ['import { relations as drizzleRelations } from "drizzle-orm";']
			: []),
		...(needsAnyPgColumn
			? ['import type { AnyPgColumn } from "drizzle-orm/pg-core";']
			: []),
		...(needsSql ? ['import { sql } from "drizzle-orm";'] : []),
	];
	const lines: string[] = [...imports, ""];

	for (const enumType of enumTypes) {
		lines.push(
			`export const ${enumVars.get(enumType.id)} = pg.pgEnum(${JSON.stringify(enumType.name)}, ${JSON.stringify(enumType.labels)});`,
		);
	}
	if (enumTypes.length) lines.push("");

	for (const table of tables) {
		const tableVar = tableVars.get(table.id)!;
		const columnVars = columnsByTable.get(table.id)!;
		lines.push(`export const ${tableVar} = pg.pgTable(${JSON.stringify(table.name)}, {`);

		for (const column of table.columns) {
			const key = columnVars.get(column.id)!;
			const relationship = relationships.find(
				(item) => item.table.id === table.id && item.column.id === column.id,
			);
			const isForwardOrSelfReference =
				relationship &&
				(relationship.table.id === relationship.target.id ||
					tables.indexOf(relationship.target) > tables.indexOf(table));
			if (isForwardOrSelfReference) {
				lines.push(
					`\t// Drizzle assigns inline foreign keys its own name; use a raw SQL migration to preserve ${
						JSON.stringify(objectNames.foreignKeys.get(relationship.relationship.id))
					}.`,
				);
			}

			const builder = columnBuilder(
				column,
				table,
				design,
				enumVars,
				tableVars,
				columnsByTable,
				relationships,
				tables.indexOf(table),
			);
			lines.push(`\t${JSON.stringify(key)}: ${builder},`);
		}

		lines.push("}, (t) => [");
		const extras: string[] = [];
		for (const relationship of relationships.filter(
			(item) =>
				item.table.id === table.id &&
				item.target.id !== table.id &&
				tables.indexOf(item.target) < tables.indexOf(table),
		)) {
			const rel = relationship.relationship;
			const name = objectNames.foreignKeys.get(rel.id);
			const columnKey = columnVars.get(relationship.column.id)!;
			const targetColumns = columnsByTable.get(relationship.target.id)!;
			const targetKey = targetColumns.get(relationship.targetKey.id)!;
			const update = (rel.onUpdate ?? "NO ACTION").toLowerCase();
			const del = (rel.onDelete ?? "NO ACTION").toLowerCase();
			const actions = [
				update !== "no action" ? `.onUpdate(${JSON.stringify(update)})` : "",
				del !== "no action" ? `.onDelete(${JSON.stringify(del)})` : "",
			].join("");
			extras.push(
				`pg.foreignKey({ name: ${JSON.stringify(name)}, columns: [t[${JSON.stringify(columnKey)}]], ` +
					`foreignColumns: [${tableVars.get(relationship.target.id)}[${JSON.stringify(targetKey)}]] })${actions}`,
			);
		}
		for (const constraint of table.uniqueConstraints ?? []) {
			const keys = constraint.columnIds.map(
				(id) => `t[${JSON.stringify(columnVars.get(id) ?? "")}]`,
			);
			let value = `pg.unique(${JSON.stringify(objectNames.uniqueConstraints.get(constraint.id))}).on(${keys.join(", ")})`;
			if (constraint.nullsNotDistinct) value += ".nullsNotDistinct()";
			extras.push(value);
		}
		for (const item of relationships.filter((candidate) => candidate.table.id === table.id)) {
			if (
				item.relationship.cardinality !== "one-to-one" ||
				item.column.unique ||
				item.column.primaryKey
			) {
				continue;
			}
			const columnKey = columnVars.get(item.column.id)!;
			extras.push(
				`pg.unique(${JSON.stringify(objectNames.relationshipUniques.get(item.relationship.id))}).on(t[${JSON.stringify(columnKey)}])`,
			);
		}
		for (const association of design.manyToManyRelationships ?? []) {
			if (association.junctionTableId !== table.id) continue;
			const left = design.relationships.find(
				(item) => item.id === association.leftRelationshipId,
			);
			const right = design.relationships.find(
				(item) => item.id === association.rightRelationshipId,
			);
			const leftColumn = left && table.columns.find(
				(column) => column.id === left.referencingColumnId,
			);
			const rightColumn = right && table.columns.find(
				(column) => column.id === right.referencingColumnId,
			);
			if (leftColumn && rightColumn) {
				extras.push(
					`pg.unique(${JSON.stringify(objectNames.pairConstraints.get(association.id))}).on(` +
						`t[${JSON.stringify(columnVars.get(leftColumn.id))}], ` +
						`t[${JSON.stringify(columnVars.get(rightColumn.id))}])`,
				);
			}
		}
		for (const index of table.indexes ?? []) {
			extras.push(
				renderIndex(table, index, objectNames.indexes.get(index.id)!, columnVars),
			);
		}
		for (const [index, extra] of extras.entries()) {
			lines.push(`\t${extra}${index < extras.length - 1 ? "," : ""}`);
		}
		lines.push("]);", "");
	}

	for (const table of tables) {
		const tableRelations = relationships.filter(
			(item) => item.table.id === table.id || item.target.id === table.id,
		);
		if (!tableRelations.length) continue;
		const fields = [
			...tableRelations
				.filter((item) => item.table.id === table.id)
				.map((item) => {
					const column = columnsByTable.get(item.table.id)!.get(item.column.id)!;
					const targetKey = columnsByTable
						.get(item.target.id)!
						.get(item.targetKey.id)!;
					return (
						`\t\t${JSON.stringify(item.forward)}: helpers.one(${tableVars.get(item.target.id)}, ` +
						`{ fields: [${tableVars.get(item.table.id)}[${JSON.stringify(column)}]], ` +
						`references: [${tableVars.get(item.target.id)}[${JSON.stringify(targetKey)}]], ` +
						`relationName: ${JSON.stringify(item.relationName)} }),`
					);
				}),
			...tableRelations
				.filter((item) => item.target.id === table.id)
				.map(
					(item) =>
						`\t\t${JSON.stringify(item.inverse)}: helpers.many(${tableVars.get(item.table.id)}, { relationName: ${JSON.stringify(item.relationName)} }),`,
				),
		];
		lines.push(
			`export const ${relationVars.get(table.id)} = drizzleRelations(${tableVars.get(table.id)}, (helpers) => ({`,
			...fields,
			"}));",
			"",
		);
	}

	const code = lines.join("\n").replace(/\n+$/, "\n");
	return { ok: true, code };
}

function columnBuilder(
	column: DesignColumn,
	table: DesignTable,
	design: Design,
	enumVars: Map<string, string>,
	tableVars: Map<string, string>,
	columnsByTable: Map<string, Map<string, string>>,
	relationships: RelationPlan[],
	tablePosition: number,
): string {
	const name = JSON.stringify(column.name);
	let expression: string;
	switch (column.type) {
		case "bigint":
			expression = `pg.bigint(${name}, { mode: "number" })`;
			break;
		case "integer":
			expression = `pg.integer(${name})`;
			break;
		case "smallint":
			expression = `pg.smallint(${name})`;
			break;
		case "text":
			expression = `pg.text(${name})`;
			break;
		case "varchar":
			expression = `pg.varchar(${name}${column.typeParameters?.length ? `, { length: ${column.typeParameters.length} }` : ""})`;
			break;
		case "char":
			expression = `pg.char(${name}, { length: ${column.typeParameters?.length ?? 1} })`;
			break;
		case "uuid":
			expression = `pg.uuid(${name})`;
			break;
		case "boolean":
			expression = `pg.boolean(${name})`;
			break;
		case "numeric": {
			const precision = column.typeParameters?.precision;
			const scale = column.typeParameters?.scale;
			const options = precision === undefined
				? ""
				: `, { precision: ${precision}${scale === undefined ? "" : `, scale: ${scale}`} }`;
			expression = `pg.numeric(${name}${options})`;
			break;
		}
		case "real":
			expression = `pg.real(${name})`;
			break;
		case "double precision":
			expression = `pg.doublePrecision(${name})`;
			break;
		case "date":
			expression = `pg.date(${name}, { mode: "string" })`;
			break;
		case "time":
			expression = `pg.time(${name})`;
			break;
		case "timetz":
			expression = `pg.time(${name}, { withTimezone: true })`;
			break;
		case "timestamp":
			expression = `pg.timestamp(${name}, { mode: "string" })`;
			break;
		case "timestamptz":
			expression = `pg.timestamp(${name}, { withTimezone: true, mode: "string" })`;
			break;
		case "interval":
			expression = `pg.interval(${name})`;
			break;
		case "json":
			expression = `pg.json(${name})`;
			break;
		case "jsonb":
			expression = `pg.jsonb(${name})`;
			break;
		case "bytea":
			expression = `pg.customType({ dataType: () => "bytea" })(${name})`;
			break;
		case "inet":
			expression = `pg.inet(${name})`;
			break;
		case "cidr":
			expression = `pg.cidr(${name})`;
			break;
		case "macaddr":
			expression = `pg.macaddr(${name})`;
			break;
		case "money":
			expression = `pg.customType({ dataType: () => "money" })(${name})`;
			break;
		case "bit":
			expression = `pg.bit(${name}, { dimensions: ${column.typeParameters?.length ?? 1} })`;
			break;
		case "vector":
			expression = `pg.vector(${name}, { dimensions: ${column.typeParameters?.dimensions ?? 1} })`;
			break;
		case "halfvec":
			expression = `pg.halfvec(${name}, { dimensions: ${column.typeParameters?.dimensions ?? 1} })`;
			break;
		case "sparsevec":
			expression = `pg.sparsevec(${name}, { dimensions: ${column.typeParameters?.dimensions ?? 1} })`;
			break;
		case "enum":
			expression = `${enumVars.get(column.enumTypeId ?? "") ?? "pg.text"}(${name})`;
			break;
	}

	if (column.typeParameters?.array) expression += ".array()";
	const relation = relationships.find(
		(item) => item.table.id === table.id && item.column.id === column.id,
	);
	if (
		relation &&
		(table.id === relation.target.id ||
			tablePosition < design.tables.indexOf(relation.target))
	) {
		const targetKey = columnsByTable.get(relation.target.id)!.get(relation.targetKey.id)!;
		const actions = [
			`onUpdate: ${JSON.stringify((relation.relationship.onUpdate ?? "NO ACTION").toLowerCase())}`,
			`onDelete: ${JSON.stringify((relation.relationship.onDelete ?? "NO ACTION").toLowerCase())}`,
		];
		const reference = table.id === relation.target.id
			? `references((): AnyPgColumn => ${tableVars.get(relation.target.id)}[${JSON.stringify(targetKey)}], { ${actions.join(", ")} })`
			: `references(() => ${tableVars.get(relation.target.id)}[${JSON.stringify(targetKey)}], { ${actions.join(", ")} })`;
		expression += `.${reference}`;
	}
	if (column.primaryKey) expression += ".primaryKey()";
	if (column.identity) expression += ".generatedAlwaysAsIdentity()";
	if (column.unique && !column.primaryKey) {
		const nullsOption = column.nullable ? ', { nulls: "distinct" }' : "";
		expression += `.unique(${JSON.stringify(uniqueColumnName(table.name, column.name))}${nullsOption})`;
	}
	if (column.default.kind === "generateUuid") {
		expression += ".defaultRandom()";
	} else if (column.default.kind === "currentTimestamp") {
		expression += ".defaultNow()";
	} else if (column.default.kind === "literal") {
		const rendered = renderDefaultExpression(column.default, column.type);
		expression += `.default(sql.raw(${JSON.stringify(rendered ?? "")}))`;
	}
	if (!column.nullable && !column.primaryKey && !column.identity) {
		expression += ".notNull()";
	}
	return expression;
}

function uniqueColumnName(table: string, column: string): string {
	return postgresGeneratedObjectName(table, column, "key");
}

function renderIndex(
	table: DesignTable,
	index: DesignIndex,
	name: string,
	vars: Map<string, string>,
): string {
	const keys = index.keys.map((key) => {
		let value = `t[${JSON.stringify(vars.get(key.columnId) ?? "")}]`;
		if (key.operatorClass) value += `.op(${JSON.stringify(key.operatorClass)})`;
		if (key.order) value += `.${key.order}()`;
		if (key.nulls) {
			value += `.nulls${key.nulls === "first" ? "First" : "Last"}()`;
		}
		return value;
	});
	const indexFn = index.unique ? "uniqueIndex" : "index";
	let value = `pg.${indexFn}(${JSON.stringify(name)})`;
	value += `.using(${JSON.stringify(index.method)}, ${keys.join(", ")})`;

	const withOptions: Record<string, unknown> = {};
	for (const [key, option] of Object.entries(index.with ?? {})) {
		const optionName = key === "efConstruction"
			? "ef_construction"
			: key === "pagesPerRange"
				? "pages_per_range"
				: key;
		withOptions[optionName] = option;
	}
	if (Object.keys(withOptions).length) {
		value += `.with(${JSON.stringify(withOptions)})`;
	}

	const migrationNotes: string[] = [];
	if (index.includeColumnIds?.length) {
		const columns = index.includeColumnIds
			.map((id) => table.columns.find((column) => column.id === id)?.name)
			.filter(Boolean);
		migrationNotes.push(
			`add INCLUDE (${columns.join(", ")}); Drizzle ORM does not model INCLUDE columns`,
		);
	}
	if (index.unique && index.nullsNotDistinct) {
		migrationNotes.push(
			"add NULLS NOT DISTINCT; Drizzle ORM does not model this index option",
		);
	}
	if (!migrationNotes.length) return value;

	const note = migrationNotes
		.join("; ")
		.replaceAll("*/", "* /")
		.replace(/[\r\n]/g, " ");
	return `${value} /* PostgreSQL migration follow-up: ${note} */`;
}

function planRelations(design: Design): RelationPlan[] {
	const relationships: RelationPlan[] = [];
	for (const relationship of design.relationships) {
		const table = design.tables.find(
			(candidate) => candidate.id === relationship.referencingTableId,
		);
		const column = table?.columns.find(
			(candidate) => candidate.id === relationship.referencingColumnId,
		);
		const target = design.tables.find(
			(candidate) => candidate.id === relationship.referencedTableId,
		);
		const targetKey = target?.columns.find((candidate) => candidate.primaryKey);
		if (!table || !column || !target || !targetKey) continue;
		relationships.push({
			relationship,
			table,
			column,
			target,
			targetKey,
			forward: "",
			inverse: "",
			relationName: relationship.id,
		});
	}
	for (const table of design.tables) {
		const used = new Set<string>();
		allocateRelationFields(
			relationships.filter((item) => item.table.id === table.id),
			"forward",
			used,
		);
		allocateRelationFields(
			relationships.filter((item) => item.target.id === table.id),
			"inverse",
			used,
		);
	}
	return relationships;
}

function allocateRelationFields(
	relationships: RelationPlan[],
	direction: "forward" | "inverse",
	used: Set<string>,
): void {
	for (const item of relationships) {
		const isForward = direction === "forward";
		const base = isForward
			? singular(
					toIdentifier(item.column.name.replace(/_(id|key)$/, "")) ||
						toIdentifier(item.target.name),
				)
			: plural(toIdentifier(item.table.name));
		const allocated = allocateOne(base, used, "related");
		if (isForward) item.forward = allocated;
		else item.inverse = allocated;
	}
}

function allocateNamed(
	entries: readonly (readonly [string, string])[],
	initial: Set<string>,
	fallback: string,
): Map<string, string> {
	const used = new Set(initial);
	const output = new Map<string, string>();
	for (const [id, name] of entries) {
		output.set(id, allocateOne(toIdentifier(name) || fallback, used, fallback));
	}
	return output;
}

function allocateOne(base: string, used: Set<string>, fallback: string): string {
	let value = base || fallback;
	if (RESERVED.has(value)) value += "Table";
	if (!/^[$A-Z_a-z][$\w]*$/.test(value)) value = `${fallback}${value}`;
	const first = value;
	let suffix = 2;
	while (used.has(value) || RESERVED.has(value)) value = `${first}_${suffix++}`;
	used.add(value);
	return value;
}

function toIdentifier(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^A-Za-z0-9$]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((part, index) =>
			index === 0
				? part[0].toLowerCase() + part.slice(1)
				: part[0].toUpperCase() + part.slice(1),
		)
		.join("");
}

function singular(value: string): string {
	if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
	if (value.endsWith("s")) return value.slice(0, -1);
	return value;
}

function plural(value: string): string {
	return value.endsWith("s") ? value : `${value}s`;
}
