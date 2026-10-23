import type {
	Design,
	DesignColumn,
	DesignEnumType,
	DesignIndex,
	DesignTable,
} from "../design";
import { planSchemaObjectNames, type SchemaObjectNames } from "../../bun/sql";
import { renderColumnType } from "../column-types";
import {
	modelWords,
	planRelationshipNames,
	splitWords,
} from "./naming";
import type { SchemaCodeGeneration } from "./types";
import { hasUnrepresentedRowLevelSecurity } from "./rls-notice";


type RelationshipFields = {
	forward: string;
	backward: string;
	backwardIsList: boolean;
	relationName: string;
};

type Names = {
	models: Map<string, string>;
	fields: Map<string, Map<string, string>>;
	enums: Map<string, string>;
	enumValues: Map<string, Map<string, string>>;
	relationships: Map<string, RelationshipFields>;
};

const reserved = new Set([
	"model", "enum", "datasource", "generator", "type", "view", "index", "maps",
	"true", "false", "null", "Int", "BigInt", "Float", "Decimal", "String",
	"Boolean", "DateTime", "Json", "Bytes", "Unsupported",
]);

/** Generates the Prisma schema for a design PostgreSQL already accepts. */
export function generatePrismaSchema(design: Design): SchemaCodeGeneration {
	const names = allocateNames(design);
	const objectNames = planSchemaObjectNames(design);
	const lines = [
		"// Generated schema for Prisma ORM 7.10.1. Connection URL belongs in prisma.config.ts.",
		"generator client {",
		...(usesVector(design)
			? [
					'  provider        = "prisma-client"',
					'  output          = "../generated/prisma"',
					'  previewFeatures = ["postgresqlExtensions"]',
				]
			: [
					'  provider = "prisma-client"',
					'  output   = "../generated/prisma"',
				]),
		"}",
		"",
		"datasource db {",
		...(usesVector(design)
			? ['  provider   = "postgresql"', "  extensions = [vector]"]
			: ['  provider = "postgresql"']),
		"}",
		"",
	];

	for (const enumType of design.enumTypes ?? []) {
		lines.push(...renderEnum(enumType, names), "");
	}
	for (const table of design.tables) {
		lines.push(...renderModel(design, table, names, objectNames), "");
	}
	const comments = renderMigrationNotes(design, names, objectNames);
	if (hasUnrepresentedRowLevelSecurity(design)) {
		comments.push("// Row-level security and policies are not represented; preserve them in PostgreSQL migrations.");
	}
	if (comments.length) lines.push(...comments, "");
	while (lines[lines.length - 1] === "") lines.pop();
	return { ok: true, code: formatSchema(`${lines.join("\n")}\n`) };
}

function usesVector(design: Design): boolean {
	return design.tables.some((table) =>
		table.columns.some((column) => ["vector", "halfvec", "sparsevec"].includes(column.type)) ||
		(table.indexes ?? []).some((index) => index.method === "hnsw" || index.method === "ivfflat"),
	);
}

function allocateNames(design: Design): Names {
	const occupied = new Set<string>();
	const models = new Map<string, string>();
	for (const table of design.tables) {
		const name = pascalCase(modelWords(table));
		models.set(table.id, unique(name, occupied));
	}
	const enums = new Map<string, string>();
	for (const enumType of design.enumTypes ?? []) {
		enums.set(enumType.id, unique(pascalCase(splitWords(enumType.name)), occupied));
	}

	const fields = new Map<string, Map<string, string>>();
	const fieldNamesByTable = new Map<string, Set<string>>();
	for (const table of design.tables) {
		const fieldNames = new Set<string>();
		const tableFields = table.columns.map((column): [string, string] => [
			column.id,
			unique(camelCase(splitWords(column.name)), fieldNames),
		]);
		fields.set(table.id, new Map(tableFields));
		fieldNamesByTable.set(table.id, fieldNames);
	}

	const enumValues = new Map<string, Map<string, string>>();
	for (const enumType of design.enumTypes ?? []) {
		const valueNames = new Set<string>();
		const values = enumType.labels.map((label): [string, string] => [
			label,
			unique(pascalCase(splitWords(label)), valueNames),
		]);
		enumValues.set(enumType.id, new Map(values));
	}

	const plan = planRelationshipNames(design);
	const relationships = new Map<string, RelationshipFields>();
	const relationNames = new Set<string>();
	for (const relationship of design.relationships) {
		const planned = plan.relationships.get(relationship.id);
		const referencingTable = design.tables.find(
			(table) => table.id === relationship.referencingTableId,
		);
		const referencedTable = design.tables.find(
			(table) => table.id === relationship.referencedTableId,
		);
		if (!planned || !referencingTable || !referencedTable) continue;

		const referencingFields = fieldNamesByTable.get(referencingTable.id)!;
		const referencedFields = fieldNamesByTable.get(referencedTable.id)!;
		const forward = unique(camelCase(planned.forward), referencingFields);
		const backward = unique(camelCase(planned.backward), referencedFields);
		const relationNameBase =
			`${models.get(referencingTable.id)}${pascalCase(planned.forward)}`;
		const relationName = unique(relationNameBase, relationNames);
		relationships.set(relationship.id, {
			forward,
			backward,
			backwardIsList: planned.backwardIsList,
			relationName,
		});
	}

	return { models, fields, enums, enumValues, relationships };

}

function unique(base: string, occupied: Set<string>): string {
	let candidate = validIdentifier(base);
	let suffix = 2;
	while (occupied.has(candidate) || reserved.has(candidate)) candidate = `${validIdentifier(base)}_${suffix++}`;
	occupied.add(candidate);
	return candidate;
}

function validIdentifier(value: string): string {
	let candidate = value.replace(/[^A-Za-z0-9_]/g, "_");
	if (!/^[A-Za-z]/.test(candidate)) candidate = `Generated${candidate}`;
	return candidate || "Generated";
}

function pascalCase(words: readonly string[]): string {
	const value = words
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join("");
	return value || "Generated";
}

function camelCase(words: readonly string[]): string {
	const pascal = pascalCase(words);
	return pascal[0].toLowerCase() + pascal.slice(1);
}

function mapped(name: string, databaseName: string): string {
	return name === databaseName ? "" : ` @map(${quote(databaseName)})`;
}

function renderEnum(enumType: DesignEnumType, names: Names): string[] {
	const enumName = names.enums.get(enumType.id)!;
	const valueNames = names.enumValues.get(enumType.id)!;
	return [
		`enum ${enumName} {`,
		...enumType.labels.map((label) => `  ${valueNames.get(label)}${mapped(valueNames.get(label)!, label)}`),
		`  @@map(${quote(enumType.name)})`,
		"}",
	];
}

function renderModel(
	design: Design,
	table: DesignTable,
	names: Names,
	objectNames: SchemaObjectNames,
): string[] {
	const modelName = names.models.get(table.id)!;
	const fields = names.fields.get(table.id)!;
	const relations = design.relationships.filter((relation) => relation.referencingTableId === table.id);
	const lines = [`model ${modelName} {`];
	for (const column of table.columns) {
		const relation = relations.find((item) => item.referencingColumnId === column.id);
		const field = fields.get(column.id)!;
		const type = prismaType(column, names);
		const attributes = columnAttributes(column, table, relation, objectNames, names, field);
		lines.push(`  ${field} ${type}${attributes}`);
	}
	for (const relationship of design.relationships) {
		const planned = names.relationships.get(relationship.id)!;
		const referencedTable = design.tables.find(
			(item) => item.id === relationship.referencedTableId,
		)!;
		const referencingTable = design.tables.find(
			(item) => item.id === relationship.referencingTableId,
		)!;
		const foreignKeyColumn = referencingTable.columns.find(
			(item) => item.id === relationship.referencingColumnId,
		)!;
		const selfReference = referencedTable.id === referencingTable.id;

		if (referencingTable.id === table.id) {
			const referencedKey = referencedTable.columns.find((column) => column.primaryKey)!;
			const optional = foreignKeyColumn.nullable ? "?" : "";
			const relationField =
				`  ${planned.forward} ${names.models.get(referencedTable.id)}${optional} ` +
				`@relation(${quote(planned.relationName)}, fields: [${fields.get(foreignKeyColumn.id)}], ` +
				`references: [${names.fields.get(referencedTable.id)!.get(referencedKey.id)}], ` +
				`onDelete: ${action(relationship.onDelete)}, onUpdate: ${action(relationship.onUpdate)}, ` +
				`map: ${quote(objectNames.foreignKeys.get(relationship.id) ?? "")})`;
			lines.push(relationField);
			if (selfReference) {
				const cardinality = planned.backwardIsList ? "[]" : "?";
				lines.push(
					`  ${planned.backward} ${names.models.get(referencedTable.id)}${cardinality} ` +
						`@relation(${quote(planned.relationName)})`,
				);
			}
		}

		if (relationship.referencedTableId === table.id && !selfReference) {
			const model = names.models.get(referencingTable.id)!;
			const cardinality = planned.backwardIsList ? "[]" : "?";
			lines.push(
				`  ${planned.backward} ${model}${cardinality} ` +
					`@relation(${quote(planned.relationName)})`,
			);
		}
	}
	const uniqueAttributes: string[] = [];
	const indexAttributes: string[] = [];
	for (const constraint of table.uniqueConstraints ?? []) {
		const columns = constraint.columnIds.map((id) => fields.get(id));
		uniqueAttributes.push(`  @@unique([${columns.join(", ")}], map: ${quote(objectNames.uniqueConstraints.get(constraint.id) ?? "")})`);
		if (constraint.nullsNotDistinct) {
			uniqueAttributes.push("  // NULLS NOT DISTINCT needs a raw SQL migration.");
		}
	}
	for (const index of table.indexes ?? []) {
		const usesVectorIndex =
			index.method === "hnsw" ||
			index.method === "ivfflat" ||
			index.keys.some((key) =>
				["vector", "halfvec", "sparsevec"].includes(
					table.columns.find((column) => column.id === key.columnId)?.type ?? "",
				),
			);
		if (usesVectorIndex) continue;
		const name = objectNames.indexes.get(index.id) ?? "";
		const keys = index.keys.map((key) => {
			const column = table.columns.find((item) => item.id === key.columnId)!;
			const field = fields.get(column.id)!;
			const op = key.operatorClass ? `(ops: ${operatorClassName(key.operatorClass)})` : "";
			const sort = key.order ? `(sort: ${key.order === "asc" ? "Asc" : "Desc"}${key.nulls ? `, nulls: ${key.nulls === "first" ? "First" : "Last"}` : ""})` : "";
			return `${field}${op}${sort}`;
		});
		const attribute = index.unique
			? `  @@unique([${keys.join(", ")}], map: ${quote(name)})`
			: `  @@index([${keys.join(", ")}], type: ${indexType(index.method)}, map: ${quote(name)})`;
		(index.unique ? uniqueAttributes : indexAttributes).push(attribute);
		if (index.nullsNotDistinct) {
			indexAttributes.push("  // NULLS NOT DISTINCT needs a raw SQL migration.");
		}
		const includedColumnIds = index.includeColumnIds ?? [];
		if (includedColumnIds.length > 0) {
			const included = includedColumnIds
				.map((id) => table.columns.find((column) => column.id === id)!.name)
				.map(sqlIdentifier)
				.join(", ");
			indexAttributes.push(`  // INCLUDE (${included}) needs a raw SQL migration.`);
		}
		if (Object.keys(index.with ?? {}).length > 0) {
			indexAttributes.push(
				`  // WITH (${formatStorage(index)}) needs a raw SQL migration.`,
			);
		}
	}
	lines.push(...uniqueAttributes, ...indexAttributes);
	for (const association of design.manyToManyRelationships ?? []) {
		if (association.junctionTableId !== table.id) continue;
		const left = design.relationships.find((relation) => relation.id === association.leftRelationshipId);
		const right = design.relationships.find((relation) => relation.id === association.rightRelationshipId);
		if (left && right) {
			const columns = [
				fields.get(left.referencingColumnId),
				fields.get(right.referencingColumnId),
			];
			const name = objectNames.pairConstraints.get(association.id) ?? "";
			lines.push(`  @@unique([${columns.join(", ")}], map: ${quote(name)})`);
		}
	}
	lines.push(`  @@map(${quote(table.name)})`);
	lines.push("}");
	return lines;
}

function columnAttributes(
	column: DesignColumn,
	table: DesignTable,
	relation: Design["relationships"][number] | undefined,
	objectNames: SchemaObjectNames,
	names: Names,
	fieldName: string,
): string {
	const attrs: string[] = [];
	if (column.primaryKey) attrs.push("@id");
	if (column.identity) attrs.push("@default(autoincrement())");
	else if (column.default.kind === "currentTimestamp") attrs.push("@default(now())");
	else if (column.default.kind === "generateUuid") attrs.push('@default(dbgenerated("gen_random_uuid()"))');
	else if (column.default.kind === "literal") {
		if (column.type === "enum") {
			const enumValues = names.enumValues.get(column.enumTypeId ?? "");
			const value = enumValues?.get(column.default.value);
			if (value) attrs.push(`@default(${value})`);
		} else {
			attrs.push(defaultAttribute(column));
		}
	}
	if (column.unique && !column.primaryKey) {
		const name = `${table.name}_${column.name}_key`;
		attrs.push(`@unique(map: ${quote(name)})`);
	}
	if (relation?.cardinality === "one-to-one" && !column.unique && !column.primaryKey) {
		const name = objectNames.relationshipUniques.get(relation.id) ?? "";
		attrs.push(`@unique(map: ${quote(name)})`);
	}
	if (fieldName !== column.name) attrs.push(`@map(${quote(column.name)})`);
	const native = nativeType(column);
	if (native) attrs.push(native);
	return attrs.length ? ` ${attrs.join(" ")}` : "";
}

function prismaType(column: DesignColumn, names: Names): string {
	if (column.type === "enum") {
		const enumName = names.enums.get(column.enumTypeId ?? "") ?? "GeneratedEnum";
		const array = column.typeParameters?.array ? "[]" : "";
		const nullable = column.nullable && !column.typeParameters?.array ? "?" : "";
		return `${enumName}${array}${nullable}`;
	}
	let base: string;
	switch (column.type) {
		case "bigint":
			base = "BigInt";
			break;
		case "integer":
		case "smallint":
			base = "Int";
			break;
		case "real":
		case "double precision":
			base = "Float";
			break;
		case "numeric":
		case "money":
			base = "Decimal";
			break;
		case "boolean":
			base = "Boolean";
			break;
		case "date":
		case "time":
		case "timetz":
		case "timestamp":
		case "timestamptz":
			base = "DateTime";
			break;
		case "json":
		case "jsonb":
			base = "Json";
			break;
		case "bytea":
			base = "Bytes";
			break;
		case "text":
		case "varchar":
		case "char":
		case "uuid":
		case "inet":
		case "bit":
			base = "String";
			break;
		default:
			base = `Unsupported(${quote(renderColumnType(column.type, column.typeParameters))})`;
	}
	const array = column.typeParameters?.array ? "[]" : "";
	const nullable = column.nullable && !column.typeParameters?.array ? "?" : "";
	return `${base}${array}${nullable}`;
}

function nativeType(column: DesignColumn): string {
	const p = column.typeParameters ?? {};
	const native: Record<string, string> = {
		smallint: "SmallInt",
		uuid: "Uuid",
		real: "Real",
		date: "Date",
		time: `Time(${p.precision ?? 6})`,
		timetz: `Timetz(${p.precision ?? 6})`,
		timestamp: `Timestamp(${p.precision ?? 6})`,
		timestamptz: `Timestamptz(${p.precision ?? 6})`,
		json: "Json",
		inet: "Inet",
		money: "Money",
	};
	if (column.type === "varchar" && p.length !== undefined) return `@db.VarChar(${p.length})`;
	if (column.type === "char" && p.length !== undefined) return `@db.Char(${p.length})`;
	if (column.type === "numeric") return `@db.Decimal${p.precision === undefined ? "" : `(${p.precision}${p.scale === undefined ? "" : `, ${p.scale}`})`}`;
	if (column.type === "bit") return `@db.Bit(${p.length})`;
	if (column.type === "enum") return "";
	const value = native[column.type];
	return value ? `@db.${value}` : "";
}

function defaultAttribute(column: DesignColumn): string {
	const value = column.default;
	if (value.kind !== "literal") return "";
	if (value.literalType === "text" && ["interval", "cidr", "macaddr"].includes(column.type)) {
		const expression = `${sqlLiteral(value.value)}::${column.type}`;
		return `@default(dbgenerated(${quote(expression)}))`;
	}
	if (
		value.literalType === "integer" ||
		value.literalType === "numeric" ||
		value.literalType === "boolean"
	) {
		return `@default(${value.value})`;
	}
	if (value.literalType === "json") return `@default(${quote(value.value)})`;
	if (value.literalType === "date") return `@default(dbgenerated(${quote(`'${value.value}'::date`)}))`;
	if (value.literalType === "time") {
		const sqlType = column.type === "timetz" ? "timetz" : "time";
		return `@default(dbgenerated(${quote(`'${value.value}'::${sqlType}`)}))`;
	}
	if (value.literalType === "timestamp") {
		const sqlType = column.type === "timestamp" ? "timestamp" : "timestamptz";
		return `@default(dbgenerated(${quote(`'${value.value}'::${sqlType}`)}))`;
	}
	return `@default(${quote(value.value)})`;
}


function action(value: string | undefined): string {
	const normalized = value ?? "NO ACTION";
	return ({ "NO ACTION": "NoAction", RESTRICT: "Restrict", CASCADE: "Cascade", "SET NULL": "SetNull", "SET DEFAULT": "SetDefault" } as Record<string, string>)[normalized] ?? "NoAction";
}

function indexType(method: string): string {
	return ({ btree: "BTree", hash: "Hash", gin: "Gin", gist: "Gist", spgist: "SpGist", brin: "Brin" } as Record<string, string>)[method] ?? "BTree";
}

function operatorClassName(value: string): string {
	return value.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
}

function formatStorage(index: DesignIndex): string {
	return Object.entries(index.with ?? {}).map(([key, value]) => `${key === "efConstruction" ? "ef_construction" : key === "pagesPerRange" ? "pages_per_range" : key} = ${value}`).join(", ");
}

function renderMigrationNotes(
	design: Design,
	names: Names,
	objectNames: SchemaObjectNames,
): string[] {
	const notes: string[] = [];
	const identityUsed = design.tables.some((table) =>
		table.columns.some((column) => column.identity),
	);
	if (identityUsed) {
		notes.push(
			"// Prisma autoincrement() cannot distinguish GENERATED ALWAYS identity; SQL uses GENERATED ALWAYS.",
		);
	}

	const nullableArrays = design.tables.flatMap((table) => {
		const model = names.models.get(table.id)!;
		const fields = names.fields.get(table.id)!;
		return table.columns
			.filter((column) => column.typeParameters?.array && column.nullable)
			.map((column) => `${model}.${fields.get(column.id)}`);
	});
	if (nullableArrays.length > 0) {
		notes.push(
			`// Prisma cannot model nullable lists; PostgreSQL nullable arrays: ${nullableArrays.join(", ")}.`,
		);
	}

	for (const table of design.tables) {
		for (const constraint of table.uniqueConstraints ?? []) {
			if (!constraint.nullsNotDistinct) continue;
			const name = objectNames.uniqueConstraints.get(constraint.id) ?? "";
			notes.push(
				`// ${renderUniqueConstraintSql(table, constraint.columnIds, name)}`,
			);
		}
		for (const index of table.indexes ?? []) {
			const vectorIndex =
				index.method === "hnsw" ||
				index.method === "ivfflat" ||
				index.keys.some((key) =>
					["vector", "halfvec", "sparsevec"].includes(
						table.columns.find((column) => column.id === key.columnId)?.type ?? "",
					),
				);
			const needsSql =
				vectorIndex ||
				index.nullsNotDistinct ||
				(index.includeColumnIds?.length ?? 0) > 0 ||
				Object.keys(index.with ?? {}).length > 0;
			if (!needsSql) continue;
			const name = objectNames.indexes.get(index.id) ?? "";
			notes.push(`// ${renderIndexSql(table, index, name)}`);
		}
	}

	return notes.length > 0 ? ["// PostgreSQL migration notes", ...notes] : [];
}

function renderUniqueConstraintSql(
	table: DesignTable,
	columnIds: string[],
	name: string,
): string {
	const columns = columnIds.map((id) => {
		const column = table.columns.find((item) => item.id === id)!;
		return sqlIdentifier(column.name);
	});
	return `ALTER TABLE ${sqlIdentifier(table.name)} ADD CONSTRAINT ${sqlIdentifier(name)} UNIQUE NULLS NOT DISTINCT (${columns.join(", ")});`;
}

function sqlIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
function sqlLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}


function renderIndexSql(table: DesignTable, index: DesignIndex, name: string): string {
	const keyText = index.keys.map((key) => {
		const column = table.columns.find((item) => item.id === key.columnId)!;
		return `"${column.name.replace(/"/g, '""')}"${key.operatorClass ? ` ${key.operatorClass}` : ""}${key.order ? ` ${key.order.toUpperCase()}` : ""}${key.nulls ? ` NULLS ${key.nulls.toUpperCase()}` : ""}`;
	}).join(", ");
	const include = index.includeColumnIds?.length ? ` INCLUDE (${index.includeColumnIds.map((id) => `"${table.columns.find((column) => column.id === id)!.name.replace(/"/g, '""')}"`).join(", ")})` : "";
	const options = Object.entries(index.with ?? {}).map(([key, value]) => `${key === "efConstruction" ? "ef_construction" : key === "pagesPerRange" ? "pages_per_range" : key} = ${value}`).join(", ");
	return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX "${name.replace(/"/g, '""')}" ON "${table.name.replace(/"/g, '""')}" USING ${index.method} (${keyText})${include}${index.unique && index.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""}${options ? ` WITH (${options})` : ""};`;
}

function quote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Match the stable whitespace conventions emitted by `prisma format`. */
function formatSchema(source: string): string {
	const lines = source.trimEnd().split("\n");
	const result: string[] = [];
	for (let position = 0; position < lines.length;) {
		const line = lines[position];
		if (!/^enum |^model /.test(line)) {
			result.push(line);
			position++;
			continue;
		}
		const isEnum = line.startsWith("enum ");
		const block = [line];
		position++;
		while (position < lines.length && lines[position] !== "}") block.push(lines[position++]);
		if (position < lines.length) block.push(lines[position++]);
		result.push(...formatBlock(block, isEnum));
	}
	return `${result.join("\n").trimEnd()}\n`;
}

function formatBlock(block: string[], isEnum: boolean): string[] {
	const body = block.slice(1, -1);
	const parsed: { original: string; name: string; type: string; attributes: string }[] = [];
	for (const line of body) {
		const match = /^  (\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
		if (!match || match[1].startsWith("@") || match[1].startsWith("@@") || match[1].startsWith("//")) continue;
		parsed.push({ original: line, name: match[1], type: match[2], attributes: match[3] ?? "" });
	}
	const maxName = Math.max(0, ...parsed.map((entry) => entry.name.length));
	const maxType = Math.max(0, ...parsed.map((entry) => entry.type.length));
	const formatted = body.map((line) => {
		const entry = parsed.find((item) => item.original === line);
		if (!entry) return line;
		const nameGap = " ".repeat(maxName - entry.name.length + 1);
		if (isEnum) return `  ${entry.name}${nameGap}${entry.type}${entry.attributes ? ` ${entry.attributes}` : ""}`;
		const typeGap = " ".repeat(maxType - entry.type.length + 1);
		return `  ${entry.name}${nameGap}${entry.type}${entry.attributes ? `${typeGap}${entry.attributes}` : ""}`;
	});
	const attrIndex = formatted.findIndex((line) => /^  @@/.test(line));
	if (attrIndex > 0 && formatted[attrIndex - 1] !== "") formatted.splice(attrIndex, 0, "");
	return [block[0], ...formatted, block[block.length - 1]];
}
