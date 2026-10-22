import { planSchemaObjectNames } from "../../bun/sql";
import type {
	Design,
	DesignColumn,
	DesignIndex,
	DesignRelationship,
	DesignTable,
} from "../design";
import { resolveRelationships } from "../relationships";
import type { SchemaCodeGeneration } from "./types";
import { postgresGeneratedObjectName } from "../postgres-identifiers";

type FieldInfo = { column: DesignColumn; name: string; relation?: DesignRelationship };

const RESERVED = new Set((
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
	"match case type objects pk Meta DoesNotExist MultipleObjectsReturned save delete clean full_clean refresh_from_db validate_unique validate_constraints"
).split(/\s+/));

/** Generate Django 6.1 models for a design already accepted by PostgreSQL. */
export function generateDjangoModels(design: Design): SchemaCodeGeneration {
	const names = planSchemaObjectNames(design);
	const classNames = new Set(["PostgreSQLTypeField", "PgSmallAutoField"]);
	const modelNames = new Map<string, string>();
	for (const table of design.tables) modelNames.set(table.id, allocateIdentifier(pascal(table.name), classNames));
	const enumNames = new Map((design.enumTypes ?? []).map((value) => [value.id, allocateIdentifier(pascal(value.name), classNames)]));
	const relations = resolveRelationships(design);
	const infos = new Map<string, FieldInfo[]>();
	const djangoObjectNames = new Set<string>();
	const comments: string[] = [];
	for (const table of design.tables) {
		const used = new Set<string>();
		const tableRelations = relations.filter((view) => view.referencingTable.id === table.id);
		const fields = table.columns.map((column) => {
			const relation = tableRelations.find((view) => view.referencingColumn.id === column.id)?.relationship;
			const base = relation ? relationFieldName(column.name) : snake(column.name);
			const name = allocateIdentifier(base, used);
			return { column, name, relation };
		});
		infos.set(table.id, fields);
	}
	for (const table of design.tables) for (const column of table.columns) {
		if (column.type === "enum" && column.typeParameters?.array) comments.push(`# ${table.name}.${column.name} is rendered as an ArrayField; run SQL to change its element type to the named PostgreSQL enum.`);
	}

	const imports = new Set<string>(["from django.db import models"]);
	const fieldsByColumn = new Map<string, FieldInfo>();
	for (const fields of infos.values()) for (const field of fields) fieldsByColumn.set(field.column.id, field);
	for (const table of design.tables) for (const column of table.columns) {
		if (column.typeParameters?.array) imports.add("from django.contrib.postgres.fields import ArrayField");
		if (["vector", "halfvec", "sparsevec", "bit"].includes(column.type)) imports.add("from pgvector.django import BitField, HalfVectorField, SparseVectorField, VectorField");
		if (column.default.kind === "currentTimestamp") imports.add("from django.db.models.functions import Now");
		if (column.default.kind === "literal") imports.add("from django.db.models import Value");
	}
	const hasCast = design.tables.some((table) => table.columns.some((column) => column.default.kind === "literal" && ["date", "time", "timetz", "timestamp", "timestamptz", "json", "jsonb", "interval", "money", "inet", "cidr", "macaddr"].includes(column.type)));
	if (hasCast) imports.add("from django.db.models.functions import Cast");
	if (design.tables.some((table) => table.columns.some((column) => column.default.kind === "literal" && column.default.literalType === "numeric"))) imports.add("from decimal import Decimal");
	const hasIndexes = design.tables.some((table) => (table.indexes ?? []).length);
	if (hasIndexes) imports.add("from django.contrib.postgres.indexes import BTreeIndex, BrinIndex, GinIndex, GistIndex, HashIndex, SpGistIndex");
	if (design.tables.some((table) => (table.indexes ?? []).some((index) => index.method === "hnsw" || index.method === "ivfflat"))) imports.add("from pgvector.django import HnswIndex, IvfflatIndex");
	if (design.tables.some((table) => (table.indexes ?? []).some((index) => index.keys.some((key) => key.operatorClass)))) imports.add("from django.contrib.postgres.indexes import OpClass");
	if (design.tables.some((table) => (table.indexes ?? []).some((index) => index.keys.some((key) => key.order || key.nulls)))) imports.add("from django.db.models import F");
	const customFields = new Set<string>();
	const hasSmallIdentity = design.tables.some((table) => table.columns.some((column) => column.identity && column.primaryKey && column.type === "smallint"));
	for (const table of design.tables) for (const column of table.columns) {
		if (customType(column)) customFields.add(customType(column)!);
		if (column.default.kind === "literal" && ["date", "time", "timetz", "timestamp", "timestamptz", "json", "jsonb", "interval", "money", "inet", "cidr", "macaddr"].includes(column.type)) customFields.add("literal cast output fields");
	}
	if (customFields.size) imports.add("from django.db import models");

	const lines: string[] = [
		"# Generated schema code. Requires Django 6.1 and PostgreSQL.",
		"# Install pgvector and add pgvector.django.VectorExtension() in a migration when vector types are used.",
		...Array.from(imports).sort((a, b) => a.localeCompare(b)),
		"",
	];
	if (customFields.size) {
		lines.push(
			"class PostgreSQLTypeField(models.Field):",
			"    def __init__(self, *args, pg_type, **kwargs):",
			"        self.pg_type = pg_type",
			"        super().__init__(*args, **kwargs)",
			"",
			"    def db_type(self, connection):",
			"        return self.pg_type",
			"",
			"    def deconstruct(self):",
			"        name, path, args, kwargs = super().deconstruct()",
			"        kwargs['pg_type'] = self.pg_type",
			"        return name, path, args, kwargs",
			"",
		);
	}
	if (hasSmallIdentity) lines.push(
		"class PgSmallAutoField(models.AutoField):",
		"    def db_type(self, connection):",
		"        return 'smallint'",
		"",
	);
	for (const enumType of design.enumTypes ?? []) {
		const className = enumNames.get(enumType.id)!;
		lines.push(`class ${className}(models.TextChoices):`);
		const memberNames = new Set<string>();
		for (let index = 0; index < enumType.labels.length; index++) {
			const label = enumType.labels[index];
			lines.push(`    ${enumMember(label, index, memberNames)} = ${pyString(label)}`);
		}
		lines.push("");
		lines.push(`# PostgreSQL enum migration: CREATE TYPE ${quoteSql(enumType.name)} AS ENUM (${enumType.labels.map(quoteSqlLiteral).join(", ")});`);
		for (const table of design.tables) for (const column of table.columns) {
			if (column.type !== "enum" || column.enumTypeId !== enumType.id) continue;
			const enumArray = column.typeParameters?.array ? "[]" : "";
			const enumDbType = `${quoteSql(enumType.name)}${enumArray}`;
			const using = column.typeParameters?.array ? `${quoteSql(column.name)}::text[]::${enumDbType}` : `${quoteSql(column.name)}::text::${enumDbType}`;
			const dropDefault = column.default.kind === "none" ? "" : `ALTER TABLE ${quoteSql(table.name)} ALTER COLUMN ${quoteSql(column.name)} DROP DEFAULT; `;
			const setDefault = column.default.kind === "literal" ? ` ALTER TABLE ${quoteSql(table.name)} ALTER COLUMN ${quoteSql(column.name)} SET DEFAULT ${quoteSqlLiteral(column.default.value)}::${enumDbType};` : "";
			lines.push(`# Then RunSQL: ${dropDefault}ALTER TABLE ${quoteSql(table.name)} ALTER COLUMN ${quoteSql(column.name)} TYPE ${enumDbType} USING ${using};${setDefault}`);
		}
		lines.push("");
	}
	for (const table of design.tables) {
		const className = modelNames.get(table.id)!;
		lines.push(`class ${className}(models.Model):`);
		const fields = infos.get(table.id)!;
		for (const field of fields) {
			const col = field.column;
			if (col.default.kind === "currentTimestamp") comments.push(`# ${table.name}.${col.name}: Django Now() emits STATEMENT_TIMESTAMP(); PostgreSQL CURRENT_TIMESTAMP is transaction-start time. Use a RunSQL default for exact transaction-time behavior.`);
			const view = relations.find((candidate) => candidate.relationship.id === field.relation?.id);
			const opts: string[] = [];
			if (view) {
				const targetClass = modelNames.get(view.referencedTable.id)!;
				const relatedName = allocateIdentifier(`${snake(table.name)}_${field.name}_set`, new Set());
				const onDelete = deleteAction(field.relation!.onDelete);
				if (field.relation!.onDelete === "RESTRICT") comments.push(`# ${table.name}.${col.name}: Django has no database DB_RESTRICT; the generated FK defaults to PostgreSQL NO ACTION, so add ON DELETE RESTRICT with RunSQL.`);
				if (field.relation!.onUpdate && field.relation!.onUpdate !== "NO ACTION") comments.push(`# ${table.name}.${col.name}: Django has no on-update action; add ON UPDATE ${field.relation!.onUpdate} with RunSQL.`);
				const targetField = view.referencedColumn;
				const targetPython = targetField ? fieldsByColumn.get(targetField.id)?.name : undefined;
				const relationType = field.relation!.cardinality === "one-to-one" ? "OneToOneField" : "ForeignKey";
				const relationArgs = [pyString(targetClass), onDelete, `related_name=${pyString(relatedName)}`, `db_column=${pyString(col.name)}`, `null=${pyBool(col.nullable)}`, "db_index=False", ...(col.primaryKey ? ["primary_key=True"] : [])];
				const rawSqlName = names.foreignKeys.get(field.relation!.id);
				if (rawSqlName) comments.push(`# PostgreSQL FK constraint name is ${pyString(rawSqlName)}; Django chooses the physical name. Use RunSQL if that exact name is required.`);
				comments.push(`# ${table.name}.${col.name}: Django creates this FK DEFERRABLE INITIALLY DEFERRED; the PostgreSQL preview is immediate. Replace it with RunSQL if immediate enforcement is required.`);
				const effectiveDefault = col.default.kind === "none" ? "" : `, ${defaultOption(col)}`;
				if (effectiveDefault) relationArgs.push(effectiveDefault.slice(2));
				lines.push(`    ${field.name} = models.${relationType}(${relationArgs.join(", ")})`);
				if (col.name !== field.name) comments.push(`# ${table.name}.${col.name} maps to attribute ${field.name}.`);
				if (targetPython && targetPython !== "id") void targetPython;
				continue;
			}
			if (col.primaryKey) opts.push("primary_key=True");
			if (!col.primaryKey) opts.push(`null=${pyBool(col.nullable)}`);
			if (col.name !== field.name) opts.push(`db_column=${pyString(col.name)}`);
			if (col.default.kind !== "none") opts.push(defaultOption(col));
			const fieldExpr = col.identity && col.primaryKey
				? `${col.type === "bigint" ? "models.BigAutoField" : col.type === "smallint" ? "PgSmallAutoField" : "models.AutoField"}(${opts.join(", ")})`
				: fieldExpression(col, field.name, design, enumNames, opts);
			if (col.identity && col.primaryKey) comments.push(`# ${table.name}.${col.name}: Django uses GENERATED BY DEFAULT AS IDENTITY; PostgreSQL uses GENERATED ALWAYS AS IDENTITY here. Use a RunSQL migration if explicit-value inserts must be rejected.`);
			if (col.identity && !col.primaryKey) comments.push(`# ${table.name}.${col.name}: Django AutoField only supports primary keys; add GENERATED ALWAYS AS IDENTITY with RunSQL.`);
			lines.push(`    ${field.name} = ${fieldExpr}`);
		}
		const memberNames = new Set(fields.map((field) => field.name));
		for (const association of (design.manyToManyRelationships ?? []).filter((item) => item.leftTableId === table.id)) {
			const target = design.tables.find((candidate) => candidate.id === association.rightTableId)!;
			const junction = design.tables.find((candidate) => candidate.id === association.junctionTableId)!;
			const leftRel = relations.find((view) => view.relationship.id === association.leftRelationshipId)!;
			const rightRel = relations.find((view) => view.relationship.id === association.rightRelationshipId)!;
			const name = allocateIdentifier(snake(target.name), memberNames);
			const leftField = fieldsByColumn.get(leftRel.referencingColumn.id)!.name;
			const rightField = fieldsByColumn.get(rightRel.referencingColumn.id)!.name;
			const related = allocateIdentifier(`${snake(table.name)}_${name}_set`, new Set());
			lines.push(`    ${name} = models.ManyToManyField(${pyString(modelNames.get(target.id)!)}, through=${pyString(modelNames.get(junction.id)!)}, through_fields=(${pyString(leftField)}, ${pyString(rightField)}), related_name=${pyString(related)})`);
		}
		const constraints: string[] = [];
		for (const field of infos.get(table.id)!) {
			if (!field.column.unique || field.column.primaryKey) continue;
			const relation = relations.find((view) => view.referencingColumn.id === field.column.id);
			if (relation?.oneToOne) continue;
			const constraintName = postgresGeneratedObjectName(table.name, field.column.name, "key");
			const djangoName = allocateDjangoName(constraintName, djangoObjectNames);
			if (djangoName !== constraintName) comments.push(`# Unique constraint ${constraintName} exceeds Django's 30-character name limit; Django uses ${djangoName}. Use RunSQL to retain the PostgreSQL name.`);
			constraints.push(`models.UniqueConstraint(fields=[${pyString(field.name)}], name=${pyString(djangoName)})`);
		}
		for (const unique of table.uniqueConstraints ?? []) {
			const constraintName = names.uniqueConstraints.get(unique.id)!;
			const djangoName = allocateDjangoName(constraintName, djangoObjectNames);
			if (djangoName !== constraintName) comments.push(`# Constraint ${constraintName} exceeds Django's 30-character name limit; Django uses ${djangoName}. Use RunSQL to retain the PostgreSQL name.`);
			const fieldNames = unique.columnIds.map((id) => fieldsByColumn.get(id)!.name);
			constraints.push(`models.UniqueConstraint(fields=[${fieldNames.map(pyString).join(", ")}], name=${pyString(djangoName)}${unique.nullsNotDistinct ? ", nulls_distinct=False" : ""})`);
		}
		for (const association of design.manyToManyRelationships ?? []) {
			if (association.junctionTableId !== table.id) continue;
			const leftView = relations.find((view) => view.relationship.id === association.leftRelationshipId)!;
			const rightView = relations.find((view) => view.relationship.id === association.rightRelationshipId)!;
			const constraintName = names.pairConstraints.get(association.id)!;
			const djangoName = allocateDjangoName(constraintName, djangoObjectNames);
			if (djangoName !== constraintName) comments.push(`# Junction constraint ${constraintName} exceeds Django's 30-character name limit; Django uses ${djangoName}.`);
			const leftField = fieldsByColumn.get(leftView.referencingColumn.id)!.name;
			const rightField = fieldsByColumn.get(rightView.referencingColumn.id)!.name;
			constraints.push(`models.UniqueConstraint(fields=[${pyString(leftField)}, ${pyString(rightField)}], name=${pyString(djangoName)})`);
		}
		const renderedIndexes = (table.indexes ?? []).map((index) => renderIndex(index, table, fieldsByColumn, names.indexes.get(index.id)!, comments, djangoObjectNames));
		const indexes = renderedIndexes.filter((_, index) => !(table.indexes ?? [])[index].unique);
		constraints.push(...renderedIndexes.filter((_, index) => (table.indexes ?? [])[index].unique));
		if (indexes.length || constraints.length) {
			lines.push("", "    class Meta:", `        db_table = ${pyString(table.name)}`);
			if (constraints.length) lines.push(`        constraints = [${constraints.join(", ")}]`);
			if (indexes.length) lines.push(`        indexes = [${indexes.join(", ")}]`);
		} else {
			lines.push("", "    class Meta:", `        db_table = ${pyString(table.name)}`);
		}
		lines.push("");
	}
	if (comments.length) lines.splice(3, 0, ...Array.from(new Set(comments)), "");
	return { ok: true, code: `${lines.join("\n").replace(/\n+$/, "")}\n` };
}

function fieldExpression(column: DesignColumn, name: string, design: Design, enumNames: Map<string, string>, options: string[]): string {
	const p = column.typeParameters ?? {};
	if (column.type === "enum") {
		const enumType = design.enumTypes?.find((candidate) => candidate.id === column.enumTypeId)!;
		if (p.array) {
			const inner = fieldExpression({ ...column, typeParameters: { ...p, array: false } }, name, design, enumNames, []);
			return `ArrayField(${inner}, ${options.join(", ")})`;
		}
		options.push(`choices=${enumNames.get(enumType.id)}.choices`, `max_length=${Math.max(1, ...enumType.labels.map((label) => label.length))}`);
		return `models.CharField(${options.join(", ")})`;
	}
	const pgvector: Record<string, string> = { vector: "VectorField", halfvec: "HalfVectorField", sparsevec: "SparseVectorField", bit: "BitField" };
	if (pgvector[column.type]) {
		const args = column.type === "bit" ? p.length === undefined ? "" : `length=${p.length}` : p.dimensions === undefined ? "" : `dimensions=${p.dimensions}`;
		return `${pgvector[column.type]}(${[args, ...options].filter(Boolean).join(", ")})`;
	}
	if (p.array) {
		const base = { ...column, typeParameters: { ...p, array: false } };
		const baseExpr = fieldExpression(base, name, design, enumNames, []);
		return `ArrayField(${baseExpr}, ${options.join(", ")})`;
	}
	const standard: Record<string, string> = {
		bigint: "BigIntegerField", integer: "IntegerField", smallint: "SmallIntegerField", text: "TextField", varchar: "CharField", char: "CharField", uuid: "UUIDField", boolean: "BooleanField", numeric: "DecimalField", date: "DateField", jsonb: "JSONField",
	};
	const pgType = customType(column);
	if (pgType) return `PostgreSQLTypeField(pg_type=${pyString(pgType)}, ${options.join(", ")})`;
	const cls = standard[column.type] ?? "TextField";
	const extra = column.type === "varchar" || column.type === "char" ? `max_length=${p.length ?? 255}`
		: column.type === "numeric" ? `max_digits=${p.precision ?? 38}, decimal_places=${p.scale ?? 0}`
		: "";
	return `models.${cls}(${[extra, ...options].filter(Boolean).join(", ")})`;
}

function customType(column: DesignColumn): string | null {
	const type = column.type;
	const p = column.typeParameters ?? {};
	if (["time", "timetz", "interval", "money", "bytea", "timestamp", "timestamptz", "real", "json"].includes(type)) return `${type}${p.precision === undefined ? "" : `(${p.precision})`}`;
	if (["inet", "cidr", "macaddr"].includes(type)) return type;
	if (type === "char") return `character${p.length === undefined ? "" : `(${p.length})`}`;
	if (type === "bit") return `bit${p.length === undefined ? " varying" : `(${p.length})`}`;
	if (type === "varchar" && p.length === undefined) return "character varying";
	if (type === "numeric" && p.precision === undefined) return "numeric";
	if (type === "double precision") return "double precision";
	return null;
}

function defaultOption(column: DesignColumn): string {
	const value = column.default;
	if (value.kind === "currentTimestamp") return "db_default=Now()";
	if (value.kind === "generateUuid") return "db_default=models.Func(function=\"gen_random_uuid\", output_field=models.UUIDField())";
	if (value.kind === "literal") {
		const raw = value.literalType === "integer" ? Number(value.value) : value.literalType === "numeric" ? `Decimal(${pyString(value.value)})` : value.literalType === "boolean" ? value.value === "true" : value.literalType === "json" ? JSON.parse(value.value) : value.value;
		const expr = `Value(${typeof raw === "string" && raw.startsWith("Decimal(") ? raw : pyRepr(raw)})`;
		if (["date", "time", "timetz", "timestamp", "timestamptz", "json", "jsonb", "interval", "money", "inet", "cidr", "macaddr", "enum"].includes(column.type)) {
			const targetType = column.type === "timestamptz" ? "timestamp with time zone" : column.type === "timetz" ? "time with time zone" : column.type;
			if (column.type === "enum") return `db_default=${expr}`;
			return `db_default=Cast(${expr}, output_field=PostgreSQLTypeField(pg_type=${pyString(targetType)}))`;
		}
		return `db_default=${expr}`;
	}
	return "";
}

function renderIndex(index: DesignIndex, table: DesignTable, fields: Map<string, FieldInfo>, name: string, comments: string[], usedNames: Set<string>): string {
	const djangoName = allocateDjangoName(name, usedNames);
	if (djangoName !== name) comments.push(`# Index ${name} exceeds Django's 30-character name limit; Django uses ${djangoName}.`);
	const keys = index.keys.map((key) => {
		const field = fields.get(key.columnId)!.name;
		const col = table.columns.find((candidate) => candidate.id === key.columnId)!;
		let expr = `models.F(${pyString(field)})`;
		if (key.operatorClass) expr = `OpClass(${expr}, name=${pyString(key.operatorClass)})`;
		if (key.order || key.nulls) {
			const direction = key.order ?? "asc";
			const nulls = key.nulls === "first" ? ", nulls_first=True" : key.nulls === "last" ? ", nulls_last=True" : "";
			expr += `.${direction}(${nulls ? nulls.slice(2) : ""})`;
		}
		return { field, col, expr };
	});
	const include = (index.includeColumnIds ?? []).map((id) => fields.get(id)!.name);
	const storage: string[] = [];
	for (const [key, value] of Object.entries(index.with ?? {})) {
		if (value === undefined) continue;
		const option = key === "pagesPerRange" ? "pages_per_range" : key === "efConstruction" ? "ef_construction" : key;
		if (["m", "ef_construction"].includes(option)) storage.push(`${option}=${value}`);
		else if (["lists", "fillfactor"].includes(option)) storage.push(`${option}=${value}`);
		else if (option === "fastupdate") storage.push(`${option}=${pyBool(Boolean(value))}`);
		else if (option === "pages_per_range") storage.push(`${option}=${value}`);
	}
	let cls = index.method === "btree" ? (index.with?.fillfactor ? "BTreeIndex" : "models.Index") : ({ hash: "HashIndex", gin: "GinIndex", gist: "GistIndex", spgist: "SpGistIndex", brin: "BrinIndex", hnsw: "HnswIndex", ivfflat: "IvfflatIndex" } as Record<string, string>)[index.method];
	const kwargs = [`name=${pyString(djangoName)}`];
	const plain = keys.every((key) => !key.col.typeParameters?.array && !key.expr.includes("OpClass") && !key.expr.includes(".desc") && !key.expr.includes(".asc"));
	const args = plain ? [`fields=[${keys.map((key) => pyString(key.field)).join(", ")}]`] : keys.map((key) => key.expr);
	if (include.length) kwargs.push(`include=[${include.map(pyString).join(", ")}]`);
	if (index.method === "brin" && index.with?.pagesPerRange) kwargs.push(`pages_per_range=${index.with.pagesPerRange}`);
	if (index.method === "gin" && index.with?.fastupdate !== undefined) kwargs.push(`fastupdate=${pyBool(index.with.fastupdate)}`);
	if (index.method === "hnsw") {
		if (index.with?.m) kwargs.push(`m=${index.with.m}`);
		if (index.with?.efConstruction) kwargs.push(`ef_construction=${index.with.efConstruction}`);
	}
	if (index.method === "ivfflat" && index.with?.lists) kwargs.push(`lists=${index.with.lists}`);
	if (index.method === "btree" && index.with?.fillfactor && !index.unique) kwargs.push(`fillfactor=${index.with.fillfactor}`);
	if (index.unique) {
		comments.push(`# Unique index ${name} is represented by UniqueConstraint; PostgreSQL catalogs it as a constraint rather than a standalone index.`);
		if (index.keys.some((key) => key.order || key.nulls)) comments.push(`# Unique index ${name}: uniqueness is preserved, but key ordering/null placement may require RunSQL to reproduce its scan ordering.`);
		if (index.with?.fillfactor) comments.push(`# Unique index ${name}: add WITH (fillfactor = ${index.with.fillfactor}) using RunSQL.`);
		const opclasses = index.keys.some((key) => key.operatorClass) ? `, opclasses=[${index.keys.map((key) => pyString(key.operatorClass ?? "")).join(", ")}]` : "";
		return `models.UniqueConstraint(fields=[${keys.map((key) => pyString(key.field)).join(", ")}], name=${pyString(djangoName)}${index.nullsNotDistinct ? ", nulls_distinct=False" : ""}${include.length ? `, include=[${include.map(pyString).join(", ")}]` : ""}${opclasses})`;
	}
	if (index.nullsNotDistinct) comments.push(`# Index ${name}: NULLS NOT DISTINCT is only supported for unique indexes; Django cannot emit it for this index.`);
	if (["hash", "gin", "gist", "spgist", "brin"].includes(index.method) && index.method !== "gin" && (index.with?.fillfactor || index.with?.fastupdate !== undefined || index.with?.pagesPerRange)) {
		// Passed below when supported by the field class.
	}
	if (index.method === "brin" && index.with?.fillfactor) kwargs.push(`fillfactor=${index.with.fillfactor}`);
	if (index.method === "gist" && index.with?.fillfactor) kwargs.push(`fillfactor=${index.with.fillfactor}`);
	if (index.method === "spgist" && index.with?.fillfactor) kwargs.push(`fillfactor=${index.with.fillfactor}`);
	if (index.method === "hash" && index.with?.fillfactor) kwargs.push(`fillfactor=${index.with.fillfactor}`);
	if (storage.length && index.method !== "gin" && index.method !== "brin" && index.method !== "hnsw" && index.method !== "ivfflat") comments.push(`# Index ${name}: storage options ${storage.join(", ")} need a RunSQL migration if unsupported by Django's index class.`);
	return `${cls}(${[...args, ...kwargs].join(", ")})`;
}

function deleteAction(action: DesignRelationship["onDelete"]): string {
	switch (action) {
		case "CASCADE": return "models.DB_CASCADE";
		case "SET NULL": return "models.DB_SET_NULL";
		case "SET DEFAULT": return "models.DB_SET_DEFAULT";
		case "RESTRICT":
		case "NO ACTION":
		default: return "models.DO_NOTHING";
	}
}

function relationFieldName(value: string): string {
	const normalized = snake(value);
	return normalized.endsWith("_id") ? normalized.slice(0, -3) || "relation" : normalized;
}
function snake(value: string): string {
	return value.normalize("NFKD").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "field";
}
function pascal(value: string): string {
	const out = snake(value).split("_").filter(Boolean).map((part) => part[0].toUpperCase() + part.slice(1)).join("");
	return /^[A-Za-z_]/.test(out) ? out : `Model${out}`;
}
function allocateIdentifier(base: string, used: Set<string>): string {
	let normalized = base.replace(/[^A-Za-z0-9_]/g, "_") || "field";
	if (!/^[A-Za-z_]/.test(normalized)) normalized = `field_${normalized}`;
	if (RESERVED.has(normalized)) normalized += "_field";
	let candidate = normalized;
	let suffix = 2;
	while (used.has(candidate)) candidate = `${normalized}_${suffix++}`;
	used.add(candidate);
	return candidate;
}
function enumMember(value: string, index: number, used: Set<string>): string {
	let member = snake(value).toUpperCase() || `VALUE_${index + 1}`;
	if (!/^[A-Z_]/.test(member)) member = `VALUE_${member}`;
	return allocateIdentifier(member, used).toUpperCase();
}
function allocateDjangoName(value: string, used: Set<string>): string {
	let candidate = value;
	if (candidate.length > 30) candidate = `${value.slice(0, 23)}_${fnv1a(value).toString(36).slice(0, 6)}`;
	let suffix = 2;
	while (used.has(candidate)) {
		const tail = `_${suffix++}`;
		candidate = `${value.slice(0, 30 - tail.length)}${tail}`;
	}
	used.add(candidate);
	return candidate;
}
function fnv1a(value: string): number { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193); return hash >>> 0; }
function pyString(value: string): string { return JSON.stringify(value).replace(/\u2028|\u2029/g, (x) => x === "\u2028" ? "\\u2028" : "\\u2029"); }
function pyRepr(value: unknown): string { return typeof value === "string" ? pyString(value) : typeof value === "boolean" ? (value ? "True" : "False") : JSON.stringify(value); }
function pyBool(value: boolean): string { return value ? "True" : "False"; }
function quoteSql(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function quoteSqlLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
