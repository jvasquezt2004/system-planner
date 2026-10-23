import { planSchemaObjectNames } from "../../bun/sql";
import { resolveRelationship } from "../relationships";
import type { Design, DesignColumn, DesignIndex, DesignTable } from "../design";
import type { SchemaCodeGeneration } from "./types";
import { modelWords, planRelationshipNames, splitWords } from "./naming";
import { hasUnrepresentedRowLevelSecurity } from "./rls-notice";


type Relation = {
	id: string;
	from: DesignTable;
	to: DesignTable;
	column: DesignColumn;
	name: string;
	backName: string;
	cardinality: "one-to-many" | "one-to-one";
};

const PYTHON_KEYWORDS = new Set((
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield"
).split(" "));
const SQLALCHEMY_RESERVED = new Set(["metadata", "registry"]);

function snake(value: string): string {
	const converted = value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
	return converted || "field";
}

function identifier(value: string): string {
	let name = snake(value);
	if (/^\d/.test(name)) name = `_${name}`;
	if (PYTHON_KEYWORDS.has(name) || SQLALCHEMY_RESERVED.has(name)) name += "_";
	return name;
}

function pascalWords(words: readonly string[]): string {
	const name = words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("") || "Table";
	return /^\d/.test(name) ? `Table${name}` : name;
}

function allocate(base: string, used: Set<string>): string {
	let candidate = base;
	for (let suffix = 2; used.has(candidate); suffix += 1) candidate = `${base}_${suffix}`;
	used.add(candidate);
	return candidate;
}

function py(value: string): string {
	return JSON.stringify(value);
}

function pythonCall(
	name: string,
	args: string[],
	indent = 0,
	linePrefixLength = 0,
): string {
	const prefix = " ".repeat(indent);
	const call = `${name}(${args.join(", ")})`;
	if (prefix.length + linePrefixLength + call.length <= 88) return call;
	const body = args.map((arg) => `${" ".repeat(indent + 4)}${arg},`).join("\n");
	return `${name}(\n${body}\n${prefix})`;
}

function mappedType(design: Design, column: DesignColumn, enumNames: Map<string, string>): { expression: string; annotation: string } {
	const p = column.typeParameters;
	const array = p?.array === true;
	let expression: string;
	let annotation: string;
	switch (column.type) {
		case "bigint": expression = "BigInteger()"; annotation = "int"; break;
		case "integer": expression = "Integer()"; annotation = "int"; break;
		case "smallint": expression = "SmallInteger()"; annotation = "int"; break;
		case "text": expression = "Text()"; annotation = "str"; break;
		case "varchar": expression = p?.length === undefined ? "String()" : `String(${p.length})`; annotation = "str"; break;
		case "char": expression = p?.length === undefined ? "CHAR()" : `CHAR(${p.length})`; annotation = "str"; break;
		case "uuid": expression = "PGUUID(as_uuid=True)"; annotation = "UUID"; break;
		case "boolean": expression = "Boolean()"; annotation = "bool"; break;
		case "numeric": expression = `Numeric(${p?.precision ?? "None"}${p?.scale === undefined ? "" : `, ${p.scale}`})`; annotation = "Decimal"; break;
		case "real": expression = "REAL()"; annotation = "float"; break;
		case "double precision": expression = "DOUBLE_PRECISION()"; annotation = "float"; break;
		case "date": expression = "Date()"; annotation = "date"; break;
		case "time": expression = "Time(timezone=False)"; annotation = "time"; break;
		case "timetz": expression = "Time(timezone=True)"; annotation = "time"; break;
		case "timestamp": expression = "TIMESTAMP(timezone=False)"; annotation = "datetime"; break;
		case "timestamptz": expression = "TIMESTAMP(timezone=True)"; annotation = "datetime"; break;
		case "interval": expression = "Interval()"; annotation = "timedelta"; break;
		case "bytea": expression = "LargeBinary()"; annotation = "bytes"; break;
		case "json": expression = "JSON()"; annotation = "dict"; break;
		case "jsonb": expression = "JSONB()"; annotation = "dict"; break;
		case "inet": expression = "INET()"; annotation = "str"; break;
		case "cidr": expression = "CIDR()"; annotation = "str"; break;
		case "macaddr": expression = "MACADDR()"; annotation = "str"; break;
		case "money": expression = "MONEY()"; annotation = "Decimal"; break;
		case "bit": expression = `VectorBit(${p?.length ?? "None"})`; annotation = "str"; break;
		case "vector": expression = `Vector(${p?.dimensions ?? "None"})`; annotation = "list[float]"; break;
		case "halfvec": expression = `HALFVEC(${p?.dimensions ?? "None"})`; annotation = "list[float]"; break;
		case "sparsevec": expression = `SPARSEVEC(${p?.dimensions ?? "None"})`; annotation = "object"; break;
		case "enum": {
			const enumType = design.enumTypes?.find((candidate) => candidate.id === column.enumTypeId);
			const name = enumType ? enumNames.get(enumType.id) : undefined;
			expression = `${name ?? "ENUM"}Type`;
			annotation = name ?? "str";
			break;
		}
	}
	if (array) {
		expression = `ARRAY(${expression})`;
		annotation = `list[${annotation}]`;
	}
	return { expression, annotation };
}

function defaultExpression(column: DesignColumn): string | null {
	const value = column.default;
	switch (value.kind) {
		case "none": return null;
		case "currentTimestamp": return "CURRENT_TIMESTAMP";
		case "generateUuid": return "gen_random_uuid()";
		case "literal": {
			switch (value.literalType) {
				case "text": return `'${value.value.replace(/'/g, "''")}'`;
				case "integer": case "numeric": case "boolean": return value.value;
				case "date": return `DATE '${value.value.replace(/'/g, "''")}'`;
				case "time": return `${column.type === "timetz" ? "TIME WITH TIME ZONE" : "TIME"} '${value.value.replace(/'/g, "''")}'`;
				case "timestamp": return `TIMESTAMP WITH TIME ZONE '${value.value.replace(/'/g, "''")}'`;
				case "json": return `JSONB '${value.value.replace(/'/g, "''")}'`;
			}
		}
	}
}

function storageOptions(index: DesignIndex): string {
	const values = Object.entries(index.with ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => {
		const name = key === "efConstruction" ? "ef_construction" : key === "pagesPerRange" ? "pages_per_range" : key;
		return `${py(name)}: ${typeof value === "boolean" ? (value ? "True" : "False") : value}`;
	});
	return values.length ? `, postgresql_with={${values.join(", ")}}` : "";
}

function indexExpression(table: DesignTable, index: DesignIndex): string[] {
	return index.keys.map((key) => {
		const column = table.columns.find((candidate) => candidate.id === key.columnId)!;
		let expression = `column(${py(column.name)})`;
		if (key.order?.toUpperCase() === "DESC") expression += ".desc()";
		if (key.nulls?.toUpperCase() === "LAST") expression += ".nulls_last()";
		if (key.nulls?.toUpperCase() === "FIRST") expression += ".nulls_first()";
		return expression;
	});
}

function renderIndex(table: DesignTable, index: DesignIndex, name: string): string {
	const args = [py(name), ...indexExpression(table, index)];
	if (index.unique) args.push("unique=True");
	args.push(`postgresql_using=${py(index.method)}`);
	if (index.includeColumnIds?.length) {
		args.push(`postgresql_include=[${index.includeColumnIds.map((id) => py(table.columns.find((column) => column.id === id)!.name)).join(", ")}]`);
	}
	if (index.unique && index.nullsNotDistinct) args.push("postgresql_nulls_not_distinct=True");
	const operatorClasses = index.keys.flatMap((key) => {
		if (!key.operatorClass) return [];
		const column = table.columns.find((candidate) => candidate.id === key.columnId)!;
		return [`${py(column.name)}: ${py(key.operatorClass)}`];
	});
	if (operatorClasses.length) args.push(`postgresql_ops={${operatorClasses.join(", ")}}`);
	const storage = storageOptions(index);
	if (storage) args.push(storage.slice(2));
	return pythonCall("Index", args, 8);
}


export function generateSqlAlchemyModels(design: Design): SchemaCodeGeneration {
	const names = planSchemaObjectNames(design);
	const enumNames = new Map<string, string>();
	const usedDeclarations = new Set([
		"Base", "enum", "date", "datetime", "time", "timedelta", "Decimal", "UUID",
		"ARRAY", "BigInteger", "Boolean", "CHAR", "Date", "DOUBLE_PRECISION", "ForeignKey", "Identity", "Index", "Integer",
		"Interval", "LargeBinary", "Numeric", "REAL", "SmallInteger", "String", "Text", "Time", "TIMESTAMP", "UniqueConstraint", "text", "column",
		"CIDR", "ENUM", "INET", "JSONB", "MACADDR", "MONEY", "PGUUID", "JSON", "DeclarativeBase", "Mapped", "mapped_column", "relationship",
		"HALFVEC", "SPARSEVEC", "Vector", "VectorBit",
	]);
	const relationshipPlan = planRelationshipNames(design);
	for (const enumType of design.enumTypes ?? []) {
		const className = allocate(pascalWords(splitWords(enumType.name)), usedDeclarations);
		enumNames.set(enumType.id, className);
		usedDeclarations.add(`${className}Type`);
	}
	const classNames = new Map<string, string>();
	for (const table of design.tables) {
		classNames.set(table.id, allocate(pascalWords(modelWords(table)), usedDeclarations));
	}
	const fields = new Map<string, Map<string, string>>();
	for (const table of design.tables) {
		const used = new Set<string>();
		const tableFields = new Map<string, string>();
		for (const column of table.columns) tableFields.set(column.id, allocate(identifier(column.name), used));
		fields.set(table.id, tableFields);
	}
	const relations: Relation[] = [];
	for (const relationship of design.relationships) {
		const view = resolveRelationship(design, relationship);
		const planned = relationshipPlan.relationships.get(relationship.id);
		if (!view || !view.referencedColumn || !planned) continue;
		const relation: Relation = {
			id: relationship.id,
			from: view.referencingTable,
			to: view.referencedTable,
			column: view.referencingColumn,
			name: identifier(planned.forward.join("_")),
			backName: identifier(planned.backward.join("_")),
			cardinality: planned.backwardIsList ? "one-to-many" : "one-to-one",
		};
		relations.push(relation);
	}
	const usesPgvector = design.tables.some((table) => table.columns.some((column) => ["bit", "vector", "halfvec", "sparsevec"].includes(column.type)));

	const lines: string[] = [
		"from __future__ import annotations",
		"",
		"import enum",
		"from datetime import date, datetime, time, timedelta",
		"from decimal import Decimal",
		"from uuid import UUID",
		"",
		"from sqlalchemy import (",
		"    ARRAY,",
		"    BigInteger,",
		"    Boolean,",
		"    CHAR,",
		"    Date,",
		"    DOUBLE_PRECISION,",
		"    ForeignKey,",
		"    Identity,",
		"    Index,",
		"    Integer,",
		"    Interval,",
		"    LargeBinary,",
		"    Numeric,",
		"    REAL,",
		"    SmallInteger,",
		"    String,",
		"    Text,",
		"    Time,",
		"    TIMESTAMP,",
		"    UniqueConstraint,",
		"    column,",
		"    text,",
		")",
		"from sqlalchemy.dialects.postgresql import (",
		"    CIDR,",
		"    ENUM,",
		"    INET,",
		"    JSONB,",
		"    MACADDR,",
		"    MONEY,",
		"    UUID as PGUUID,",
		"    JSON,",
		")",
		"from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship",
		"",
		"",
		"class Base(DeclarativeBase):",
		"    pass",
	];
	if (usesPgvector) lines.splice(lines.indexOf("class Base(DeclarativeBase):"), 0, "# Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;", "", "");
	for (const enumType of design.enumTypes ?? []) {
		const className = enumNames.get(enumType.id)!;
		const memberNames = new Set<string>();
		lines.push("", "", `class ${className}(enum.Enum):`);
		for (const label of enumType.labels) {
			const member = allocate(identifier(label).toUpperCase(), memberNames);
			lines.push(`    ${member} = ${py(label)}`);
		}
		const enumArgs = [
			className,
			`name=${py(enumType.name)}`,
			"create_type=True",
			"values_callable=lambda members: [member.value for member in members]",
		];
		lines.push("", "", `${className}Type = ${pythonCall("ENUM", enumArgs, 0, `${className}Type = `.length)}`);
	}
	const tableRelationships = new Map<string, { relation: Relation; forward: boolean }[]>();
	for (const relation of relations) {
		tableRelationships.set(relation.from.id, [...(tableRelationships.get(relation.from.id) ?? []), { relation, forward: true }]);
		tableRelationships.set(relation.to.id, [...(tableRelationships.get(relation.to.id) ?? []), { relation, forward: false }]);
	}
	for (const table of design.tables) {
		const className = classNames.get(table.id)!;
		const tableFields = fields.get(table.id)!;
		const tableRels = tableRelationships.get(table.id) ?? [];
		const constraints: string[] = [];
		for (const constraint of table.uniqueConstraints ?? []) {
			const name = names.uniqueConstraints.get(constraint.id);
			const nullsNotDistinct = constraint.nullsNotDistinct
				? ["postgresql_nulls_not_distinct=True"]
				: [];
			constraints.push(
				pythonCall(
					"UniqueConstraint",
					[
						...constraint.columnIds.map((id) => py(tableFields.get(id)!)),
						`name=${py(name ?? constraint.name ?? `${table.name}_key`)}`,
						...nullsNotDistinct,
					],
					8,
				),
			);
		}
		for (const relation of relations.filter((candidate) => candidate.from.id === table.id && candidate.cardinality === "one-to-one")) {
			const view = resolveRelationship(design, design.relationships.find((candidate) => candidate.id === relation.id)!);
			if (view?.ownsUniqueness) constraints.push(pythonCall("UniqueConstraint", [py(tableFields.get(relation.column.id)!), `name=${py(names.relationshipUniques.get(relation.id) ?? "")}`], 8));
		}
		for (const association of design.manyToManyRelationships ?? []) {
			if (association.junctionTableId !== table.id) continue;
			const name = names.pairConstraints.get(association.id);
			const left = design.relationships.find((r) => r.id === association.leftRelationshipId);
			const right = design.relationships.find((r) => r.id === association.rightRelationshipId);
			const lv = left ? resolveRelationship(design, left) : null;
			const rv = right ? resolveRelationship(design, right) : null;
			if (lv && rv) constraints.push(pythonCall("UniqueConstraint", [py(tableFields.get(lv.referencingColumn.id)!), py(tableFields.get(rv.referencingColumn.id)!), `name=${py(name ?? "")}`], 8));
		}
		for (const index of table.indexes ?? []) constraints.push(renderIndex(table, index, names.indexes.get(index.id) ?? index.name ?? `${table.name}_idx`));
		lines.push("", "", `class ${className}(Base):`, `    __tablename__ = ${py(table.name)}`);
		if (constraints.length) {
			const inline = `    __table_args__ = (${constraints.join(", ")},)`;
			if (inline.length <= 88) {
				lines.push(inline);
			} else {
				lines.push("    __table_args__ = (");
				for (const constraint of constraints) {
					const formatted = constraint.split("\n");
					formatted[0] = `        ${formatted[0]}`;
					formatted[formatted.length - 1] += ",";
					lines.push(...formatted);
				}
				lines.push("    )");
			}
		}
		for (const column of table.columns) {
			const attr = tableFields.get(column.id)!;
			const type = mappedType(design, column, enumNames);
			const nullable = column.nullable && !column.primaryKey && !column.identity;
			const annotation = nullable ? `${type.annotation} | None` : type.annotation;
			const args: string[] = attr === column.name ? [type.expression] : [py(column.name), type.expression];
			if (column.identity) args.push("Identity(always=True)");
			const relationship = design.relationships.find((candidate) => candidate.referencingTableId === table.id && candidate.referencingColumnId === column.id);
			if (relationship) {
				const rel = relations.find((candidate) => candidate.id === relationship.id)!;
				const targetPk = rel.to.columns.find((candidate) => candidate.primaryKey)!;
				const fkName = names.foreignKeys.get(rel.id);
				args.push(
					pythonCall(
						"ForeignKey",
						[
							py(`${rel.to.name}.${targetPk.name}`),
							`name=${py(fkName ?? "")}`,
							...(relationship.onDelete && relationship.onDelete !== "NO ACTION" ? [`ondelete=${py(relationship.onDelete)}`] : []),
							...(relationship.onUpdate && relationship.onUpdate !== "NO ACTION" ? [`onupdate=${py(relationship.onUpdate)}`] : []),
						],
						8,
					),
				);
			}
			if (column.primaryKey) args.push("primary_key=True");
			if (column.unique && !column.primaryKey) args.push("unique=True");
			const defaultSql = defaultExpression(column);
			if (defaultSql !== null) args.push(`server_default=text(${py(defaultSql)})`);
			lines.push(`    ${attr}: Mapped[${annotation}] = ${pythonCall("mapped_column", args, 4, `${attr}: Mapped[${annotation}] = `.length)}`);
		}
		for (const entry of tableRels) {
			const relation = entry.relation;
			const forward = entry.forward;
			const name = forward ? relation.name : relation.backName;
			const target = forward ? relation.to : relation.from;
			const targetName = classNames.get(target.id)!;
			const back = forward ? relation.backName : relation.name;
			const collection = forward ? false : relation.cardinality === "one-to-many";
			const nullable = relation.column.nullable;
			const type = collection
				? `list["${targetName}"]`
				: `"${targetName}${!forward && relation.cardinality === "one-to-one" ? " | None" : forward && nullable ? " | None" : ""}"`;
			const args = [py(targetName), `back_populates=${py(back)}`];
			args.push(`foreign_keys=${py(`[${classNames.get(relation.from.id)}.${fields.get(relation.from.id)!.get(relation.column.id)}]`)}`);
			if (relation.from.id === relation.to.id && forward) args.push(`remote_side=${py(`[${classNames.get(target.id)}.${fields.get(target.id)!.get(target.columns.find((candidate) => candidate.primaryKey)!.id)}]`)}`);
			if (!collection && (relation.cardinality === "one-to-one" || forward)) args.push("uselist=False");
			lines.push(`    ${name}: Mapped[${type}] = ${pythonCall("relationship", args, 4, `${name}: Mapped[${type}] = `.length)}`);
		}
		for (const association of design.manyToManyRelationships ?? []) {
			const left = design.relationships.find((candidate) => candidate.id === association.leftRelationshipId);
			const right = design.relationships.find((candidate) => candidate.id === association.rightRelationshipId);
			if (!left || !right) continue;
			const lv = resolveRelationship(design, left);
			const rv = resolveRelationship(design, right);
			if (!lv || !rv) continue;
			const isLeft = lv.referencedTable.id === table.id;
			const isRight = rv.referencedTable.id === table.id;
			if (!isLeft && !isRight) continue;
			const other = isLeft ? rv.referencedTable : lv.referencedTable;
			const planned = relationshipPlan.manyToMany.get(association.id);
			if (!planned) continue;
			const attr = identifier((isLeft ? planned.left : planned.right).join("_"));
			const otherName = classNames.get(other.id)!;
			const junctionTable = design.tables.find((candidate) => candidate.id === association.junctionTableId)!;
			const annotation = `list["${otherName}"]`;
			const attrPrefix = `${attr}: Mapped[${annotation}] = `;
			lines.push(`    ${attrPrefix}${pythonCall("relationship", [py(otherName), `secondary=${py(junctionTable.name)}`, "viewonly=True"], 4, attrPrefix.length)}`);
		}
	}
	const bodyStart = usesPgvector
		? lines.indexOf("# Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;")
		: lines.indexOf("class Base(DeclarativeBase):");
	const body = lines.slice(bodyStart);
	const bodyText = body.join("\n");
	const referenced = (name: string) => new RegExp(`\\b${name}\\b`).test(bodyText);
	const importBlock = (module: string, names: string[]) => {
		const used = names.filter((name) => referenced(name.split(" as ")[1] ?? name));
		if (!used.length) return [];
		const inline = `from ${module} import ${used.join(", ")}`;
		if (inline.length <= 88) return [inline];
		return [`from ${module} import (`, ...used.map((name) => `    ${name},`), ")"];
	};
	const imports = [
		...(["enum"].filter(referenced).map((name) => `import ${name}`)),
		...importBlock("datetime", ["date", "datetime", "time", "timedelta"]),
		...importBlock("decimal", ["Decimal"]),
		...importBlock("uuid", ["UUID"]),
	];
	const coreImports = [
		"ARRAY", "CHAR", "DOUBLE_PRECISION", "REAL", "TIMESTAMP",
		"BigInteger", "Boolean", "Date", "ForeignKey", "Identity", "Index",
		"Integer", "Interval", "LargeBinary", "Numeric", "SmallInteger",
		"String", "Text", "Time", "UniqueConstraint", "column", "text",
	];
	const dialectImports = ["CIDR", "ENUM", "INET", "JSON", "JSONB", "MACADDR", "MONEY"];
	if (imports.length) imports.push("");
	if (usesPgvector) {
		imports.push(
			"from pgvector.sqlalchemy import BIT as VectorBit",
			"from pgvector.sqlalchemy import HALFVEC, SPARSEVEC, Vector",
		);
	}
	imports.push(
		...importBlock("sqlalchemy", coreImports),
		...importBlock("sqlalchemy.dialects.postgresql", dialectImports),
		...importBlock("sqlalchemy.dialects.postgresql", ["UUID as PGUUID"]),
		...importBlock("sqlalchemy.orm", ["DeclarativeBase", "Mapped", "mapped_column", "relationship"]),
		...(usesPgvector ? [""] : ["", ""]),
	);
	return {
		ok: true,
		code: `${[
			...(hasUnrepresentedRowLevelSecurity(design)
				? ["# Row-level security, policies, and functions are not represented; preserve them in PostgreSQL migrations.", ""]
				: []),
			...imports,
			...body,
		].join("\n")}\n`,
	};
}
