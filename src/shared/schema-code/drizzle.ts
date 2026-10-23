import type {
	ColumnType,
	Design,
	DesignColumn,
	DesignIndex,
	DesignRelationship,
	DesignTable,
} from "../design";
import { planSchemaObjectNames } from "../../bun/sql";
import { postgresGeneratedObjectName } from "../postgres-identifiers";
import { modelWords, planRelationshipNames, splitWords, type NameWords } from "./naming";
import { unrepresentedPostgresqlLogicNotice } from "./postgresql-logic-notice";

import type { SchemaCodeGeneration } from "./types";

type RelationPlan = {
	relationship: DesignRelationship;
	table: DesignTable;
	column: DesignColumn;
	target: DesignTable;
	targetKey: DesignColumn;
	forward: string;
	backward: string;
	backwardIsList: boolean;
	relationName?: string;
};

type TableExtra = {
	code: string;
	comments?: string[];
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

const COLUMN_BUILDERS: Record<ColumnType, string> = {
	bigint: "bigint",
	integer: "integer",
	smallint: "smallint",
	text: "text",
	varchar: "varchar",
	char: "char",
	uuid: "uuid",
	boolean: "boolean",
	numeric: "numeric",
	real: "real",
	"double precision": "doublePrecision",
	date: "date",
	time: "time",
	timetz: "time",
	timestamp: "timestamp",
	timestamptz: "timestamp",
	interval: "interval",
	json: "json",
	jsonb: "jsonb",
	bytea: "customType",
	inet: "inet",
	cidr: "cidr",
	macaddr: "macaddr",
	money: "customType",
	bit: "bit",
	vector: "vector",
	halfvec: "halfvec",
	sparsevec: "sparsevec",
	enum: "",
};

/** Generates stable Drizzle PostgreSQL schema code for a PostgreSQL-valid design. */
export function generateDrizzleSchema(design: Design): SchemaCodeGeneration {
	const tables = design.tables;
	const enumTypes = design.enumTypes ?? [];
	const relationships = planRelations(design);
	const objectNames = planSchemaObjectNames(design);
	const pgImports = requiredPgImports(design, relationships);
	const reservedNames = new Set(pgImports);
	if (relationships.length) reservedNames.add("relations");
	if (relationships.some((item) => item.table.id === item.target.id)) {
		reservedNames.add("AnyPgColumn");
	}

	const tableVars = allocateNamed(
		tables.map((table) => [table.id, camelCase(modelWords(table))] as const),
		reservedNames,
		"table",
	);
	const enumVars = allocateNamed(
		enumTypes.map((item) => [item.id, camelCase(splitWords(item.name))] as const),
		new Set([...tableVars.values(), ...reservedNames]),
		"enum",
	);
	const columnsByTable = new Map<string, Map<string, string>>();
	for (const table of tables) {
		columnsByTable.set(
			table.id,
			allocateNamed(
				table.columns.map((column) => [column.id, camelCase(splitWords(column.name))] as const),
				new Set(),
				"field",
			),
		);
	}
	const relationVars = allocateNamed(
		tables.map((table) => [table.id, `${tableVars.get(table.id)}Relations`] as const),
		new Set([...tableVars.values(), ...enumVars.values(), ...reservedNames]),
		"relations",
	);

	const omissionNotice = unrepresentedPostgresqlLogicNotice(design);
	const lines = [
		...(omissionNotice ? [`// ${omissionNotice}`] : []),
		...(pgImports.size ? renderNamedImport([...pgImports], "drizzle-orm/pg-core") : []),
		...(relationships.length ? ['import { relations } from "drizzle-orm";'] : []),
		...(relationships.some((item) => item.table.id === item.target.id)
			? ['import type { AnyPgColumn } from "drizzle-orm/pg-core";']
			: []),
		"",
	];

	for (const enumType of enumTypes) {
		lines.push(
			...renderEnum(
				enumVars.get(enumType.id)!,
				enumType.name,
				enumType.labels,
			),
			"",
		);
	}

	for (const table of tables) {
		const tableVar = tableVars.get(table.id)!;
		const columnVars = columnsByTable.get(table.id)!;
		const inlineForeignKeys = relationships
			.filter(
				(item) =>
					item.table.id === table.id &&
					(item.target.id === table.id ||
						tables.indexOf(item.target) > tables.indexOf(table)),
			)
			.map((item) => objectNames.foreignKeys.get(item.relationship.id));
		if (inlineForeignKeys.length) {
			lines.push(
				`// Raw SQL migration: preserve inline foreign-key names ${inlineForeignKeys.map((name) => JSON.stringify(name)).join(", ")}; Drizzle references() does not name constraints.`,
			);
		}

		const columns = table.columns.flatMap((column) =>
			renderProperty(
				columnVars.get(column.id)!,
				columnBuilder(
					column,
					table,
					design,
					enumVars,
					tableVars,
					columnsByTable,
					relationships,
					tables.indexOf(table),
				),
				"  ",
				true,
			),
		);
		const extras = tableExtras(
			design,
			table,
			columnVars,
			columnsByTable,
			tableVars,
			relationships,
			objectNames,
		);

		if (extras.length === 0) {
			const start = `export const ${tableVar} = pgTable(${JSON.stringify(table.name)}, {`;
			if (start.length <= 80) {
				lines.push(start, ...columns, "});", "");
			} else {
				lines.push(
					`export const ${tableVar} = pgTable(`,
					`  ${JSON.stringify(table.name)},`,
					"  {",
					...table.columns.flatMap((column) =>
						renderProperty(
							columnVars.get(column.id)!,
							columnBuilder(
								column,
								table,
								design,
								enumVars,
								tableVars,
								columnsByTable,
								relationships,
								tables.indexOf(table),
							),
							"    ",
							true,
						),
					),
					"  },",
					");",
					"",
				);
			}
			continue;
		}

		lines.push(
			`export const ${tableVar} = pgTable(`,
			`  ${JSON.stringify(table.name)},`,
			"  {",
			...table.columns.flatMap((column) =>
				renderProperty(
					columnVars.get(column.id)!,
					columnBuilder(
						column,
						table,
						design,
						enumVars,
						tableVars,
						columnsByTable,
						relationships,
						tables.indexOf(table),
					),
					"    ",
					true,
				),
			),
			"  },",
			"  (t) => [",
		);
		for (const extra of extras) {
			for (const comment of extra.comments ?? []) {
				lines.push(`    // ${comment}`);
			}
			lines.push(...renderExpression(extra.code, "    ", "    ", true));
		}
		lines.push("  ],", ");", "");
	}

	for (const table of tables) {
		const tableRelations = relationships.filter(
			(item) => item.table.id === table.id || item.target.id === table.id,
		);
		if (tableRelations.length === 0) continue;
		const fields = [
			...tableRelations
				.filter((item) => item.table.id === table.id)
				.flatMap((item) => {
					const column = columnsByTable.get(item.table.id)!.get(item.column.id)!;
					const targetKey = columnsByTable
						.get(item.target.id)!
						.get(item.targetKey.id)!;
					const relationName = item.relationName
						? `, relationName: ${JSON.stringify(item.relationName)}`
						: "";
					return renderProperty(
						item.forward,
						`one(${tableVars.get(item.target.id)}, { fields: [${tableVars.get(item.table.id)}.${column}], references: [${tableVars.get(item.target.id)}.${targetKey}]${relationName} })`,
						"  ",
						true,
					);
				}),
			...tableRelations
				.filter((item) => item.target.id === table.id)
				.flatMap((item) => {
					const relationName = item.relationName
						? `, { relationName: ${JSON.stringify(item.relationName)} }`
						: "";
					const helper = item.backwardIsList ? "many" : "one";
					return renderProperty(
						item.backward,
						`${helper}(${tableVars.get(item.table.id)}${relationName})`,
						"  ",
						true,
					);
				}),
		];
		const helpers = new Set<string>();
		if (tableRelations.some((item) => item.table.id === table.id)) {
			helpers.add("one");
		}
		for (const relation of tableRelations) {
			if (relation.target.id === table.id) {
				helpers.add(relation.backwardIsList ? "many" : "one");
			}
		}
		lines.push(
			`export const ${relationVars.get(table.id)} = relations(${tableVars.get(table.id)}, ({ ${["one", "many"].filter((helper) => helpers.has(helper)).join(", ")} }) => ({`,
			...fields,
			"}));",
			"",
		);
	}
	return { ok: true, code: `${lines.join("\n").replace(/\n+$/, "")}\n` };
}

function renderNamedImport(names: string[], moduleName: string): string[] {
	const singleLine = `import { ${names.join(", ")} } from "${moduleName}";`;
	if (singleLine.length <= 80) return [singleLine];
	return [
		"import {",
		...names.map((name) => `  ${name},`),
		`} from "${moduleName}";`,
	];
}

function renderEnum(name: string, databaseName: string, labels: string[]): string[] {
	const values = labels.map(jsStringLiteral);
	const labelArray = `[${values.join(", ")}]`;
	const singleLine = `export const ${name} = pgEnum(${jsStringLiteral(databaseName)}, ${labelArray});`;
	if (singleLine.length <= 80) return [singleLine];
	return [
		`export const ${name} = pgEnum(${jsStringLiteral(databaseName)}, [`,
		...values.map((value) => `  ${value},`),
		"]);",
	];
}

function renderProperty(
	key: string,
	expression: string,
	indent: string,
	trailingComma: boolean,
): string[] {
	return renderExpression(expression, `${indent}${key}: `, indent, trailingComma);
}

function renderExpression(
	expression: string,
	prefix: string,
	indent: string,
	trailingComma: boolean,
): string[] {
	const suffix = trailingComma ? "," : "";
	if (`${prefix}${expression}${suffix}`.length <= 80) {
		return [`${prefix}${expression}${suffix}`];
	}

	const chain = splitMethodChain(expression);
	const lines = renderCall(chain[0], prefix, indent);
	for (const method of chain.slice(1)) {
		const call = `.${method}`;
		const lastLine = lines[lines.length - 1]!;
		if (
			lastLine.endsWith(")") &&
			`${lastLine}${call}`.length <= 80
		) {
			lines[lines.length - 1] += call;
			continue;
		}
		const open = call.indexOf("(");
		const callHeader = open > 0
			? `${lastLine}${call.slice(0, open + 1)}`
			: "";
		if (
			open > 0 &&
			call.slice(open + 1, -1).trim().length > 0 &&
			callHeader.length <= 80 &&
			`${lastLine}${call}`.length > 80
		) {
			const args = splitTopLevel(call.slice(open + 1, -1));
			lines[lines.length - 1] = callHeader;
			lines.push(
				...args.map((argument) => `${indent}  ${argument},`),
				`${indent})`,
			);
			continue;
		}
		lines.push(...renderCall(call, `${indent}  `, `${indent}  `));
	}
	lines[lines.length - 1] += suffix;
	return lines;
}

function renderCall(call: string, prefix: string, indent: string): string[] {
	if (`${prefix}${call}`.length <= 80) return [`${prefix}${call}`];
	const open = call.indexOf("(");
	if (open < 0 || !call.endsWith(")")) return [`${prefix}${call}`];
	const callee = call.slice(0, open);
	const args = splitTopLevel(call.slice(open + 1, -1));
	const objectIndex = args.findIndex((argument) => argument.startsWith("{") && argument.endsWith("}"));
	if (objectIndex >= 0 && objectIndex === args.length - 1) {
		const earlier = args.slice(0, objectIndex);
		const objectFields = splitTopLevel(args[objectIndex].slice(1, -1));
		const header = `${prefix}${callee}(${earlier.length ? `${earlier.join(", ")}, ` : ""}{`;
		return [
			header,
			...objectFields.map((field) => `${indent}  ${field},`),
			`${indent}})`,
		];
	}
	const arrayIndex = args.findIndex((argument) => argument.startsWith("[") && argument.endsWith("]"));
	if (arrayIndex >= 0 && arrayIndex === args.length - 1) {
		const earlier = args.slice(0, arrayIndex);
		const values = splitTopLevel(args[arrayIndex].slice(1, -1));
		return [
			`${prefix}${callee}(${earlier.length ? `${earlier.join(", ")}, ` : ""}[`,
			...values.map((value) => `${indent}  ${value},`),
			`${indent}])`,
		];
	}
	return [
		`${prefix}${callee}(`,
		...args.map((argument) => `${indent}  ${argument},`),
		`${indent})`,
	];
}

function splitMethodChain(expression: string): string[] {
	const segments: string[] = [];
	let start = 0;
	let round = 0;
	let curly = 0;
	let square = 0;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < expression.length; index += 1) {
		const character = expression[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
		} else if (character === "(") round += 1;
		else if (character === ")") round -= 1;
		else if (character === "{") curly += 1;
		else if (character === "}") curly -= 1;
		else if (character === "[") square += 1;
		else if (character === "]") square -= 1;
		else if (
			character === "." &&
			round === 0 &&
			curly === 0 &&
			square === 0
		) {
			segments.push(expression.slice(start, index));
			start = index + 1;
		}
	}
	segments.push(expression.slice(start));
	return segments;
}

function splitTopLevel(value: string): string[] {
	const pieces: string[] = [];
	let start = 0;
	let round = 0;
	let curly = 0;
	let square = 0;
	let quote = "";
	let escaped = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
			continue;
		}
		if (character === '"' || character === "'" || character === "`") {
			quote = character;
		} else if (character === "(") round += 1;
		else if (character === ")") round -= 1;
		else if (character === "{") curly += 1;
		else if (character === "}") curly -= 1;
		else if (character === "[") square += 1;
		else if (character === "]") square -= 1;
		else if (character === "," && round === 0 && curly === 0 && square === 0) {
			pieces.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	const last = value.slice(start).trim();
	if (last) pieces.push(last);
	return pieces;
}
function renderJsValue(value: unknown): string {
	if (typeof value === "string") return jsStringLiteral(value);
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(renderJsValue).join(", ")}]`;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		return `{ ${entries
			.map(([key, item]) => `${key}: ${renderJsValue(item)}`)
			.join(", ")} }`;
	}
	return "undefined";
}

function jsStringLiteral(value: string): string {
	const doubleQuoted = JSON.stringify(value);
	const singleQuoted = `'${value
		.replaceAll("\\", "\\\\")
		.replaceAll("'", "\\'")
		.replaceAll("\n", "\\n")
		.replaceAll("\r", "\\r")
		.replaceAll("\t", "\\t")}'`;
	return singleQuoted.length < doubleQuoted.length ? singleQuoted : doubleQuoted;
}


function requiredPgImports(
	design: Design,
	relationships: RelationPlan[],
): Set<string> {
	const imports = new Set<string>();
	if (design.tables.length) imports.add("pgTable");
	if (design.enumTypes?.length) imports.add("pgEnum");
	for (const table of design.tables) {
		for (const column of table.columns) {
			if (column.type !== "enum") imports.add(COLUMN_BUILDERS[column.type]);
		}
		if ((table.uniqueConstraints ?? []).length) imports.add("unique");
		if ((table.indexes ?? []).length) {
			for (const index of table.indexes ?? []) {
				imports.add(index.unique ? "uniqueIndex" : "index");
			}
		}
	}
	if (
		relationships.some(
			(item) => item.table.id !== item.target.id &&
				design.tables.indexOf(item.target) < design.tables.indexOf(item.table),
		)
	) {
		imports.add("foreignKey");
	}
	if (
		relationships.some(
			(item) =>
				item.relationship.cardinality === "one-to-one" &&
				!item.column.unique &&
				!item.column.primaryKey,
		) || (design.manyToManyRelationships ?? []).length > 0
	) {
		imports.add("unique");
	}
	return imports;
}

function tableExtras(
	design: Design,
	table: DesignTable,
	columnVars: Map<string, string>,
	columnsByTable: Map<string, Map<string, string>>,
	tableVars: Map<string, string>,
	relationships: RelationPlan[],
	objectNames: ReturnType<typeof planSchemaObjectNames>,
): TableExtra[] {
	const extras: TableExtra[] = [];
	for (const relation of relationships) {
		if (
			relation.table.id !== table.id ||
			relation.target.id === table.id ||
			design.tables.indexOf(relation.target) >= design.tables.indexOf(table)
		) {
			continue;
		}
		const update = relation.relationship.onUpdate ?? "NO ACTION";
		const del = relation.relationship.onDelete ?? "NO ACTION";
		const actions = [
			...(update === "NO ACTION"
				? []
				: [`.onUpdate(${JSON.stringify(update.toLowerCase())})`]),
			...(del === "NO ACTION"
				? []
				: [`.onDelete(${JSON.stringify(del.toLowerCase())})`]),
		].join("");
		const targetKey = columnsByTable
			.get(relation.target.id)!
			.get(relation.targetKey.id)!;
		extras.push({
			code: `foreignKey({ name: ${JSON.stringify(objectNames.foreignKeys.get(relation.relationship.id))}, columns: [t.${columnVars.get(relation.column.id)}], foreignColumns: [${tableVars.get(relation.target.id)}.${targetKey}] })${actions}`,
		});

	}
	for (const constraint of table.uniqueConstraints ?? []) {
		const columns = constraint.columnIds.map((id) => `t.${columnVars.get(id)}`);
		const nullsNotDistinct = constraint.nullsNotDistinct
			? ".nullsNotDistinct()"
			: "";
		extras.push({
			code: `unique(${JSON.stringify(objectNames.uniqueConstraints.get(constraint.id))}).on(${columns.join(", ")})${nullsNotDistinct}`,
		});
	}
	for (const relation of relationships) {
		if (
			relation.table.id !== table.id ||
			relation.relationship.cardinality !== "one-to-one" ||
			relation.column.unique ||
			relation.column.primaryKey
		) {
			continue;
		}
		extras.push({
			code: `unique(${JSON.stringify(objectNames.relationshipUniques.get(relation.relationship.id))}).on(t.${columnVars.get(relation.column.id)})`,
		});
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
		if (!leftColumn || !rightColumn) continue;
		extras.push({
			code: `unique(${JSON.stringify(objectNames.pairConstraints.get(association.id))}).on(t.${columnVars.get(leftColumn.id)}, t.${columnVars.get(rightColumn.id)})`,
		});
	}
	for (const index of table.indexes ?? []) {
		const rendered = renderIndex(
			table,
			index,
			objectNames.indexes.get(index.id)!,
			columnVars,
		);
		extras.push(rendered);
	}
	return extras;
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
	const name = jsStringLiteral(column.name);
	let expression: string;
	switch (column.type) {
		case "bigint":
			expression = `bigint(${name}, { mode: "bigint" })`;
			break;
		case "integer":
			expression = `integer(${name})`;
			break;
		case "smallint":
			expression = `smallint(${name})`;
			break;
		case "text":
			expression = `text(${name})`;
			break;
		case "varchar":
			expression = `varchar(${name}${column.typeParameters?.length ? `, { length: ${column.typeParameters.length} }` : ""})`;
			break;
		case "char":
			expression = `char(${name}, { length: ${column.typeParameters?.length ?? 1} })`;
			break;
		case "uuid":
			expression = `uuid(${name})`;
			break;
		case "boolean":
			expression = `boolean(${name})`;
			break;
		case "numeric": {
			const precision = column.typeParameters?.precision;
			const scale = column.typeParameters?.scale;
			const options = precision === undefined
				? ""
				: `, { precision: ${precision}${scale === undefined ? "" : `, scale: ${scale}`} }`;
			expression = `numeric(${name}${options})`;
			break;
		}
		case "real":
			expression = `real(${name})`;
			break;
		case "double precision":
			expression = `doublePrecision(${name})`;
			break;
		case "date":
			expression = `date(${name}, { mode: "string" })`;
			break;
		case "time":
			expression = `time(${name})`;
			break;
		case "timetz":
			expression = `time(${name}, { withTimezone: true })`;
			break;
		case "timestamp":
			expression = `timestamp(${name}, { mode: "string" })`;
			break;
		case "timestamptz":
			expression = `timestamp(${name}, { withTimezone: true, mode: "string" })`;
			break;
		case "interval":
			expression = `interval(${name})`;
			break;
		case "json":
			expression = `json(${name})`;
			break;
		case "jsonb":
			expression = `jsonb(${name})`;
			break;
		case "bytea":
			expression = `customType({ dataType: () => "bytea" })(${name})`;
			break;
		case "inet":
			expression = `inet(${name})`;
			break;
		case "cidr":
			expression = `cidr(${name})`;
			break;
		case "macaddr":
			expression = `macaddr(${name})`;
			break;
		case "money":
			expression = `customType({ dataType: () => "money" })(${name})`;
			break;
		case "bit":
			expression = `bit(${name}, { dimensions: ${column.typeParameters?.length ?? 1} })`;
			break;
		case "vector":
			expression = `vector(${name}, { dimensions: ${column.typeParameters?.dimensions ?? 1} })`;
			break;
		case "halfvec":
			expression = `halfvec(${name}, { dimensions: ${column.typeParameters?.dimensions ?? 1} })`;
			break;
		case "sparsevec":
			expression = `sparsevec(${name}, { dimensions: ${column.typeParameters?.dimensions ?? 1} })`;
			break;
		case "enum":
			expression = `${enumVars.get(column.enumTypeId ?? "") ?? "text"}(${name})`;
			break;
	}

	if (column.typeParameters?.array) expression += ".array()";
	const relation = relationships.find(
		(item) => item.table.id === table.id && item.column.id === column.id,
	);
	if (
		relation &&
		(relation.table.id === relation.target.id ||
			tablePosition < design.tables.indexOf(relation.target))
	) {
		const targetKey = columnsByTable.get(relation.target.id)!.get(relation.targetKey.id)!;
		const actions = [
			...(relation.relationship.onUpdate && relation.relationship.onUpdate !== "NO ACTION"
				? [`onUpdate: ${JSON.stringify(relation.relationship.onUpdate.toLowerCase())}`]
				: []),
			...(relation.relationship.onDelete && relation.relationship.onDelete !== "NO ACTION"
				? [`onDelete: ${JSON.stringify(relation.relationship.onDelete.toLowerCase())}`]
				: []),
		];
		const options = actions.length ? `, { ${actions.join(", ")} }` : "";
		const reference = table.id === relation.target.id
			? `references((): AnyPgColumn => ${tableVars.get(relation.target.id)}.${targetKey}${options})`
			: `references(() => ${tableVars.get(relation.target.id)}.${targetKey}${options})`;
		expression += `.${reference}`;
	}
	if (column.primaryKey) expression += ".primaryKey()";
	if (column.identity) expression += ".generatedAlwaysAsIdentity()";
	if (column.unique && !column.primaryKey) {
		expression += `.unique(${JSON.stringify(uniqueColumnName(table.name, column.name))})`;
	}
	if (column.default.kind === "generateUuid") {
		expression += ".defaultRandom()";
	} else if (column.default.kind === "currentTimestamp") {
		expression += ".defaultNow()";
	} else if (column.default.kind === "literal") {
		expression += `.default(${renderTypedDefault(column)})`;
	}
	if (!column.nullable && !column.primaryKey && !column.identity) {
		expression += ".notNull()";
	}
	return expression;
}

function renderTypedDefault(column: DesignColumn): string {
	if (column.default.kind !== "literal") return "";
	const value = column.default.value;
	switch (column.default.literalType) {
		case "text":
		case "date":
		case "time":
		case "timestamp":
			return jsStringLiteral(value);
		case "integer":
			return column.type === "bigint"
				? `BigInt(${jsStringLiteral(value)})`
				: value;
		case "numeric":
			return jsStringLiteral(value);
		case "boolean":
			return value;
		case "json":
			return renderJsValue(JSON.parse(value));
	}
}

function uniqueColumnName(table: string, column: string): string {
	return postgresGeneratedObjectName(table, column, "key");
}

function renderIndex(
	table: DesignTable,
	index: DesignIndex,
	name: string,
	vars: Map<string, string>,
): TableExtra {
	const keys = index.keys.map((key) => {
		let value = `t.${vars.get(key.columnId)}`;
		if (key.operatorClass) value += `.op(${jsStringLiteral(key.operatorClass)})`;
		if (key.order) value += `.${key.order}()`;
		if (key.nulls) {
			value += `.nulls${key.nulls === "first" ? "First" : "Last"}()`;
		}
		return value;
	});
	const indexFn = index.unique ? "uniqueIndex" : "index";
	let value = `${indexFn}(${jsStringLiteral(name)})`;
	value += `.using(${jsStringLiteral(index.method)}, ${keys.join(", ")})`;

	const withOptions: string[] = [];
	for (const [key, option] of Object.entries(index.with ?? {})) {
		const optionName = key === "efConstruction"
			? "ef_construction"
			: key === "pagesPerRange"
				? "pages_per_range"
				: key;
		withOptions.push(`${optionName}: ${renderJsValue(option)}`);
	}
	if (withOptions.length) {
		value += `.with({ ${withOptions.join(", ")} })`;
	}

	const comments: string[] = [];
	if (index.includeColumnIds?.length) {
		const columns = index.includeColumnIds
			.map((id) => table.columns.find((column) => column.id === id)?.name)
			.filter(Boolean);
		comments.push(
			`PostgreSQL migration: add INCLUDE (${columns.join(", ")}); Drizzle ORM does not model INCLUDE columns.`,
		);
	}
	if (index.unique && index.nullsNotDistinct) {
		comments.push(
			"PostgreSQL migration: add NULLS NOT DISTINCT; Drizzle ORM does not model this index option.",
		);
	}
	return { code: value, comments };
}

function planRelations(design: Design): RelationPlan[] {
	const plan = planRelationshipNames(design);
	const tableById = new Map(design.tables.map((table) => [table.id, table]));
	const pairs = new Map<string, number>();
	for (const relationship of design.relationships) {
		const pair = `${relationship.referencingTableId}\0${relationship.referencedTableId}`;
		pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
	}

	const relationships: RelationPlan[] = [];
	for (const relationship of design.relationships) {
		const table = tableById.get(relationship.referencingTableId);
		const column = table?.columns.find(
			(candidate) => candidate.id === relationship.referencingColumnId,
		);
		const target = tableById.get(relationship.referencedTableId);
		const targetKey = target?.columns.find((candidate) => candidate.primaryKey);
		const names = plan.relationships.get(relationship.id);
		if (!table || !column || !target || !targetKey || !names) continue;
		const pair = `${table.id}\0${target.id}`;
		const relationName = pairs.get(pair)! > 1 || table.id === target.id
			? `${camelCase(modelWords(table))}_${names.forward.join("_")}`
			: undefined;
		relationships.push({
			relationship,
			table,
			column,
			target,
			targetKey,
			forward: camelCase(names.forward),
			backward: camelCase(names.backward),
			backwardIsList: names.backwardIsList,
			relationName,
		});
	}

	for (const table of design.tables) {
		const columns = design.tables.find((candidate) => candidate.id === table.id)?.columns ?? [];
		const used = new Set(columns.map((column) => camelCase(splitWords(column.name))));
		for (const relation of relationships) {
			if (relation.table.id === table.id) {
				relation.forward = allocateOne(relation.forward, used, "related");
			}
			if (relation.target.id === table.id) {
				relation.backward = allocateOne(relation.backward, used, "related");
			}
		}
	}
	return relationships;
}
function allocateNamed(
	entries: readonly (readonly [string, string])[],
	initial: Set<string>,
	fallback: string,
): Map<string, string> {
	const used = new Set(initial);
	const output = new Map<string, string>();
	for (const [id, name] of entries) {
		output.set(id, allocateOne(name, used, fallback));
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

function camelCase(words: NameWords): string {
	const [first, ...rest] = words;
	if (!first) return "";
	return [first, ...rest.map((word) => word[0].toUpperCase() + word.slice(1))].join("");
}

