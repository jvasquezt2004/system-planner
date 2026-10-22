import { planSchemaObjectNames } from "../../bun/sql";
import { resolveRelationship } from "../relationships";
import type { Design, DesignColumn, DesignIndex, DesignTable } from "../design";
import type { SchemaCodeGeneration } from "./types";

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

function singular(value: string): string {
	const lower = value.toLowerCase();
	if (["status", "data"].includes(lower)) return value;
	if (/ies$/i.test(value) && value.length > 3) return `${value.slice(0, -3)}y`;
	if (/(sses|shes|ches|xes|zes)$/i.test(value)) return value.slice(0, -2);
	if (/s$/i.test(value) && !/(ss|us|is)$/i.test(value)) return value.slice(0, -1);
	return value;
}

function pascal(value: string): string {
	const parts = singular(value).match(/[A-Za-z0-9]+/g) ?? [];
	const name = parts.map((part) => part[0]!.toUpperCase() + part.slice(1)).join("") || "Table";
	return /^\d/.test(name) ? `Table${name}` : name;
}

function plural(value: string): string {
	if (/(s|x|z|ch|sh)$/i.test(value)) return `${value}es`;
	if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
	return `${value}s`;
}

function relationshipBase(column: string, table: string): string {
	const name = snake(column);
	if (name.endsWith("_id") && name.length > 3) return identifier(name.slice(0, -3));
	return identifier(singular(table));
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
	const keys = indexExpression(table, index).join(", ");
	const options = [
		...(index.unique ? ["unique=True"] : []),
		`postgresql_using=${py(index.method)}`,
		...(index.includeColumnIds?.length ? [`postgresql_include=[${index.includeColumnIds.map((id) => py(table.columns.find((column) => column.id === id)!.name)).join(", ")}]`] : []),
		...(index.unique && index.nullsNotDistinct ? ["postgresql_nulls_not_distinct=True"] : []),
	];
	const operatorClasses = index.keys.flatMap((key) => {
		if (!key.operatorClass) return [];
		const column = table.columns.find((candidate) => candidate.id === key.columnId)!;
		return [`${py(column.name)}: ${py(key.operatorClass)}`];
	});
	if (operatorClasses.length) options.push(`postgresql_ops={${operatorClasses.join(", ")}}`);
	const withOptions = storageOptions(index);
	return `Index(${py(name)}, ${keys}, ${options.join(", ")}${withOptions})`;
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
	for (const enumType of design.enumTypes ?? []) {
		const className = allocate(pascal(enumType.name), usedDeclarations);
		enumNames.set(enumType.id, className);
		usedDeclarations.add(`${className}Type`);
	}
	const classNames = new Map<string, string>();
	for (const table of design.tables) classNames.set(table.id, allocate(pascal(table.name), usedDeclarations));
	const fields = new Map<string, Map<string, string>>();
	const usedAttrs = new Map<string, Set<string>>();
	for (const table of design.tables) {
		const used = new Set<string>();
		const tableFields = new Map<string, string>();
		for (const column of table.columns) tableFields.set(column.id, allocate(identifier(column.name), used));
		fields.set(table.id, tableFields);
		usedAttrs.set(table.id, new Set(tableFields.values()));
	}
	const relations: Relation[] = [];
	for (const relationship of design.relationships) {
		const view = resolveRelationship(design, relationship);
		if (!view || !view.referencedColumn) continue;
		const fieldSet = usedAttrs.get(view.referencingTable.id)!;
		const backSet = usedAttrs.get(view.referencedTable.id)!;
		const self = view.referencingTable.id === view.referencedTable.id;
		const base = self ? "parent" : relationshipBase(view.referencingColumn.name, view.referencedTable.name);
		const relationCount = design.relationships.filter((candidate) => candidate.referencedTableId === view.referencedTable.id && candidate.referencingTableId === view.referencingTable.id).length;
		const cardinality = relationship.cardinality ?? "one-to-many";
		const role = singular(view.referencingTable.name);
		const backBase = self ? "replies" : cardinality === "one-to-one" ? role : relationCount > 1 ? `${base}_${plural(role)}` : plural(role);
		const relation: Relation = {
			id: relationship.id,
			from: view.referencingTable,
			to: view.referencedTable,
			column: view.referencingColumn,
			name: allocate(base, fieldSet),
			backName: allocate(identifier(backBase), backSet),
			cardinality,
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
		"    ARRAY, BigInteger, Boolean, CHAR, Date, DOUBLE_PRECISION, ForeignKey, Identity, Index, Integer,",
		"    Interval, LargeBinary, Numeric, REAL, SmallInteger, String, Text, Time, TIMESTAMP, UniqueConstraint,",
		"    column, text,",
		")",
		"from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSONB, MACADDR, MONEY, UUID as PGUUID, JSON",
		"from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship",
		"",
		"",
		"class Base(DeclarativeBase):",
		"    pass",
	];
	if (usesPgvector) lines.splice(15, 0, "from pgvector.sqlalchemy import BIT as VectorBit, HALFVEC, SPARSEVEC, Vector");
	if (usesPgvector) lines.splice(lines.indexOf("class Base(DeclarativeBase):"), 0, "# Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;", "");
	for (const enumType of design.enumTypes ?? []) {
		const className = enumNames.get(enumType.id)!;
		const memberNames = new Set<string>();
		lines.push("", `class ${className}(enum.Enum):`);
		for (const label of enumType.labels) {
			const member = allocate(identifier(label).toUpperCase(), memberNames);
			lines.push(`    ${member} = ${py(label)}`);
		}
		lines.push("", `${className}Type = ENUM(${className}, name=${py(enumType.name)}, create_type=True, values_callable=lambda members: [member.value for member in members])`);
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
			const columns = constraint.columnIds.map((id) => py(tableFields.get(id)!)).join(", ");
			const name = names.uniqueConstraints.get(constraint.id);
			const nullsNotDistinct = constraint.nullsNotDistinct ? ", postgresql_nulls_not_distinct=True" : "";
			constraints.push(`UniqueConstraint(${columns}, name=${py(name ?? constraint.name ?? `${table.name}_key`)}${nullsNotDistinct})`);
		}
		for (const relation of relations.filter((candidate) => candidate.from.id === table.id && candidate.cardinality === "one-to-one")) {
			const view = resolveRelationship(design, design.relationships.find((candidate) => candidate.id === relation.id)!);
			if (view?.ownsUniqueness) constraints.push(`UniqueConstraint(${py(tableFields.get(relation.column.id)!)}, name=${py(names.relationshipUniques.get(relation.id) ?? "")})`);
		}
		for (const association of design.manyToManyRelationships ?? []) {
			if (association.junctionTableId !== table.id) continue;
			const name = names.pairConstraints.get(association.id);
			const left = design.relationships.find((r) => r.id === association.leftRelationshipId);
			const right = design.relationships.find((r) => r.id === association.rightRelationshipId);
			const lv = left ? resolveRelationship(design, left) : null;
			const rv = right ? resolveRelationship(design, right) : null;
			if (lv && rv) constraints.push(`UniqueConstraint(${py(tableFields.get(lv.referencingColumn.id)!)}, ${py(tableFields.get(rv.referencingColumn.id)!)}, name=${py(name ?? "")})`);
		}
		for (const index of table.indexes ?? []) constraints.push(renderIndex(table, index, names.indexes.get(index.id) ?? index.name ?? `${table.name}_idx`));
		lines.push("", `class ${className}(Base):`, `    __tablename__ = ${py(table.name)}`);
		if (constraints.length) lines.push("    __table_args__ = (", ...constraints.map((constraint) => `        ${constraint},`), "    )");
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
				const actions = [
					...(relationship.onDelete && relationship.onDelete !== "NO ACTION" ? [`ondelete=${py(relationship.onDelete)}`] : []),
					...(relationship.onUpdate && relationship.onUpdate !== "NO ACTION" ? [`onupdate=${py(relationship.onUpdate)}`] : []),
				];
				args.push(`ForeignKey(${py(`${rel.to.name}.${targetPk.name}`)}, name=${py(fkName ?? "")}${actions.length ? `, ${actions.join(", ")}` : ""})`);
			}
			if (column.primaryKey) args.push("primary_key=True");
			if (column.unique && !column.primaryKey) args.push("unique=True");
			const defaultSql = defaultExpression(column);
			if (defaultSql !== null) args.push(`server_default=text(${py(defaultSql)})`);
			lines.push(`    ${attr}: Mapped[${annotation}] = mapped_column(${args.join(", ")})`);
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
			const type = collection ? `list[${targetName}]` : `${targetName}${!forward && relation.cardinality === "one-to-one" ? " | None" : forward && nullable ? " | None" : ""}`;
			const args = [py(targetName), `back_populates=${py(back)}`];
			args.push(`foreign_keys=${py(`[${classNames.get(relation.from.id)}.${fields.get(relation.from.id)!.get(relation.column.id)}]`)}`);
			if (relation.from.id === relation.to.id && forward) args.push(`remote_side=${py(`[${classNames.get(target.id)}.${fields.get(target.id)!.get(target.columns.find((candidate) => candidate.primaryKey)!.id)}]`)}`);
			if (!collection && (relation.cardinality === "one-to-one" || forward)) args.push("uselist=False");
			lines.push(`    ${name}: Mapped[${type}] = relationship(${args.join(", ")})`);
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
			const attr = allocate(identifier(plural(singular(other.name))), usedAttrs.get(table.id)!);
			const otherName = classNames.get(other.id)!;
			const junctionTable = design.tables.find((candidate) => candidate.id === association.junctionTableId)!;
			lines.push(`    ${attr}: Mapped[list[${otherName}]] = relationship(${py(otherName)}, secondary=${py(junctionTable.name)}, viewonly=True)`);
		}
	}
	return { ok: true, code: `${lines.join("\n")}\n` };
}
