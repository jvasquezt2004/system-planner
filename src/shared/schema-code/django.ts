import { planSchemaObjectNames } from "../../bun/sql";
import type {
	Design,
	DesignColumn,
	DesignIndex,
	DesignRelationship,
	DesignTable,
} from "../design";
import { modelWords, planRelationshipNames, splitWords } from "./naming";
import { resolveRelationships } from "../relationships";
import type { SchemaCodeGeneration } from "./types";
import { unrepresentedPostgresqlLogicNotice } from "./postgresql-logic-notice";


type FieldInfo = { column: DesignColumn; name: string; relation?: DesignRelationship };

const RESERVED = new Set((
	"False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield " +
	"match case type objects pk Meta DoesNotExist MultipleObjectsReturned save delete clean full_clean refresh_from_db validate_unique validate_constraints"
).split(/\s+/));

/** Generate Django 6.1 models for a design already accepted by PostgreSQL. */
export function generateDjangoModels(design: Design): SchemaCodeGeneration {
	const names = planSchemaObjectNames(design);
	const relationshipNames = planRelationshipNames(design);
	const classNames = new Set(["PostgreSQLTypeField", "PgSmallAutoField"]);
	const modelNames = new Map<string, string>();
	for (const table of design.tables) {
		const name = allocateIdentifier(pascalWords(modelWords(table)), classNames);
		modelNames.set(table.id, name);
	}
	const enumNames = new Map(
		(design.enumTypes ?? []).map((value) => [
			value.id,
			allocateIdentifier(pascalWords(splitWords(value.name)), classNames),
		]),
	);
	const relations = resolveRelationships(design);
	const infos = new Map<string, FieldInfo[]>();
	const djangoObjectNames = new Set<string>();
	const comments: string[] = [];
	const migrationNotes = new Map<
		string,
		{ description: string; fields: Set<string> }
	>();
	const addMigrationNote = (
		key: string,
		description: string,
		table: string,
		column: string,
	) => {
		const note = migrationNotes.get(key) ?? {
			description,
			fields: new Set<string>(),
		};
		note.fields.add(`${table}.${column}`);
		migrationNotes.set(key, note);
	};
	for (const table of design.tables) {
		const used = new Set<string>();
		const tableRelations = relations.filter(
			(view) => view.referencingTable.id === table.id,
		);
		const fields = table.columns.map((column) => {
			const relation = tableRelations.find(
				(view) => view.referencingColumn.id === column.id,
			)?.relationship;
			const sharedName = relation
				? relationshipNames.relationships.get(relation.id)!.forward
				: splitWords(column.name);
			const name = allocateIdentifier(snakeWords(sharedName), used);
			return { column, name, relation };
		});
		infos.set(table.id, fields);
	}

	const imports = new Set<string>(["from django.db import models"]);
	const fieldsByColumn = new Map<string, FieldInfo>();
	for (const fields of infos.values()) {
		for (const field of fields) {
			fieldsByColumn.set(field.column.id, field);
		}
	}
	const customFields = new Set<string>();
	const indexClasses = new Set<string>();
	let hasOpClass = false;
	for (const table of design.tables) {
		for (const column of table.columns) {
			if (column.typeParameters?.array) {
				imports.add("from django.contrib.postgres.fields import ArrayField");
			}
			const vectorClass: Record<string, string> = {
				vector: "VectorField",
				halfvec: "HalfVectorField",
				sparsevec: "SparseVectorField",
				bit: "BitField",
			};
			const vectorImport = vectorClass[column.type];
			if (vectorImport) {
				imports.add(`from pgvector.django import ${vectorImport}`);
				if (column.type !== "bit") {
					addMigrationNote(
						"pgvector",
						"pgvector columns require VectorExtension() in a migration.",
						table.name,
						column.name,
					);
				}
			}
			if (column.default.kind === "currentTimestamp") {
				imports.add("from django.db.models.functions import Now");
			}
			if (column.default.kind === "literal") {
				if (column.default.literalType === "numeric") {
					imports.add("from decimal import Decimal");
				}
				if (
					["date", "time", "timestamp"].includes(
						column.default.literalType,
					) ||
					(column.default.literalType === "json" && column.type === "json")
				) {
					imports.add("from django.db.models import Value");
					imports.add("from django.db.models.functions import Cast");
				}
			}
			const type = customType(column);
			if (type) customFields.add(type);
		}
		for (const index of table.indexes ?? []) {
			const classByMethod: Record<string, string> = {
				hash: "HashIndex",
				gin: "GinIndex",
				gist: "GistIndex",
				spgist: "SpGistIndex",
				brin: "BrinIndex",
				hnsw: "HnswIndex",
				ivfflat: "IvfflatIndex",
			};
			const indexClass = classByMethod[index.method];
			if (indexClass) indexClasses.add(indexClass);
			if (index.method === "btree" && index.with?.fillfactor) {
				indexClasses.add("BTreeIndex");
			}
			hasOpClass ||= index.keys.some((key) => Boolean(key.operatorClass));
		}
	}
	if (indexClasses.size) {
		const djangoIndexes = Array.from(indexClasses).filter(
			(name) => !["HnswIndex", "IvfflatIndex"].includes(name),
		);
		const vectorIndexes = Array.from(indexClasses).filter((name) =>
			["HnswIndex", "IvfflatIndex"].includes(name),
		);
		if (djangoIndexes.length) {
			imports.add(
				`from django.contrib.postgres.indexes import ${djangoIndexes.sort().join(", ")}`,
			);
		}
		if (vectorIndexes.length) {
			imports.add(`from pgvector.django import ${vectorIndexes.sort().join(", ")}`);
		}
	}
	if (hasOpClass) {
		imports.add("from django.contrib.postgres.indexes import OpClass");
	}
	const hasSmallIdentity = design.tables.some((table) =>
		table.columns.some(
			(column) =>
				column.identity &&
				column.primaryKey &&
				column.type === "smallint",
		),
	);

	const importLines = renderImports(imports);
	const lines: string[] = [
		"# Generated schema code. Requires Django 6.1 and PostgreSQL.",
		...importLines,
		"",
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
			"        kwargs[\"pg_type\"] = self.pg_type",
			"        return name, path, args, kwargs",
			"",
			"",
		);
	}
	if (hasSmallIdentity) {
		lines.push(
			"class PgSmallAutoField(models.AutoField):",
			"    def db_type(self, connection):",
			"        return 'smallint'",
			"",
			"",
		);
	}
	for (const enumType of design.enumTypes ?? []) {
		const className = enumNames.get(enumType.id)!;
		lines.push(`class ${className}(models.TextChoices):`);
		const memberNames = new Set<string>();
		for (let index = 0; index < enumType.labels.length; index++) {
			const label = enumType.labels[index];
			lines.push(`    ${enumMember(label, index, memberNames)} = ${pyString(label)}`);
		}
		lines.push("");
		const createType = `CREATE TYPE ${quoteSql(enumType.name)} AS ENUM (${enumType.labels.map(quoteSqlLiteral).join(", ")}).`;
		for (const table of design.tables) {
			for (const column of table.columns) {
				if (column.type !== "enum" || column.enumTypeId !== enumType.id) {
					continue;
				}
				const arrayNote = column.typeParameters?.array
					? " Enum arrays also need an element-type cast."
					: "";
				addMigrationNote(
					`enum:${enumType.id}`,
					`${createType} Use RunSQL to alter each listed column to the named enum type.${arrayNote}`,
					table.name,
					column.name,
				);
			}
		}
		lines.push("");
	}
	for (const table of design.tables) {
		const className = modelNames.get(table.id)!;
		lines.push(`class ${className}(models.Model):`);
		const fields = infos.get(table.id)!;
		for (const field of fields) {
			const col = field.column;
			if (col.unique && !col.primaryKey) {
				addMigrationNote(
					"single-column-unique-name",
					"Django chooses the constraint name for unique=True fields.",
					table.name,
					col.name,
				);
			}
			if (
				col.unique &&
				["text", "varchar", "char"].includes(col.type)
			) {
				addMigrationNote(
					"unique-text-pattern-index",
					"Django's PostgreSQL backend adds a pattern_ops index for unique text fields.",
					table.name,
					col.name,
				);
			}
			if (col.default.kind === "currentTimestamp") {
				addMigrationNote(
					"timestamp",
					"Django uses STATEMENT_TIMESTAMP(); PostgreSQL CURRENT_TIMESTAMP is transaction-start time.",
					table.name,
					col.name,
				);
			}
			const view = relations.find(
				(candidate) => candidate.relationship.id === field.relation?.id,
			);
			const opts: string[] = [];
			if (view) {
				const targetClass = modelNames.get(view.referencedTable.id)!;
				const relationName = relationshipNames.relationships.get(
					field.relation!.id,
				)!;
				const onDelete = deleteAction(field.relation!.onDelete);
				const relationType =
					field.relation!.cardinality === "one-to-one"
						? "OneToOneField"
						: "ForeignKey";
				const relationArgs = [
					pyString(targetClass),
					onDelete,
					`related_name=${pyString(snakeWords(relationName.backward))}`,
					...(col.name !== field.name
						? [`db_column=${pyString(col.name)}`]
						: []),
					...(col.nullable ? ["null=True"] : []),
					...(relationType === "ForeignKey" ? ["db_index=False"] : []),
					...(col.primaryKey ? ["primary_key=True"] : []),
					...(col.unique && relationType !== "OneToOneField"
						? ["unique=True"]
						: []),
				];
				if (relationType === "ForeignKey") {
					addMigrationNote(
						"foreign-key-indexes",
						"ForeignKey fields disable Django's implicit index because the PostgreSQL preview defines none.",
						table.name,
						col.name,
					);
				}
				if (field.relation!.onDelete === "RESTRICT") {
					addMigrationNote(
						"restrict",
						"ON DELETE RESTRICT requires RunSQL; Django's DO_NOTHING emits NO ACTION.",
						table.name,
						col.name,
					);
				}
				if (
					field.relation!.onUpdate &&
					field.relation!.onUpdate !== "NO ACTION"
				) {
					addMigrationNote(
						"on-update",
						`ON UPDATE ${field.relation!.onUpdate} requires RunSQL.`,
						table.name,
						col.name,
					);
				}
				if (names.foreignKeys.has(field.relation!.id)) {
					addMigrationNote(
						"foreign-key-names",
						"Foreign-key constraint names are chosen by Django, not copied from PostgreSQL.",
						table.name,
						col.name,
					);
				}
				addMigrationNote(
					"foreign-key-deferrability",
					"Django creates DEFERRABLE INITIALLY DEFERRED foreign keys; the PostgreSQL preview uses immediate enforcement.",
					table.name,
					col.name,
				);
				if (col.default.kind !== "none") {
					relationArgs.push(defaultOption(col));
				}
				lines.push(
					...formatAssignment(
						field.name,
						`models.${relationType}(${relationArgs.join(", ")})`,
					),
				);
				continue;
			}
			if (col.primaryKey) opts.push("primary_key=True");
			if (!col.primaryKey && col.nullable) opts.push("null=True");
			if (col.name !== field.name) opts.push(`db_column=${pyString(col.name)}`);
			if (col.unique && !col.primaryKey) opts.push("unique=True");
			if (col.default.kind !== "none") opts.push(defaultOption(col));
			const fieldExpr = col.identity && col.primaryKey
				? `${col.type === "bigint" ? "models.BigAutoField" : col.type === "smallint" ? "PgSmallAutoField" : "models.AutoField"}(${opts.join(", ")})`
				: fieldExpression(col, field.name, design, enumNames, opts);
			if (col.identity && col.primaryKey) {
				addMigrationNote(
					"identity",
					"Django uses GENERATED BY DEFAULT AS IDENTITY; PostgreSQL uses GENERATED ALWAYS AS IDENTITY.",
					table.name,
					col.name,
				);
			}
			if (col.identity && !col.primaryKey) {
				addMigrationNote(
					"non-primary-identity",
					"Non-primary-key identity columns require a raw SQL migration.",
					table.name,
					col.name,
				);
			}
			lines.push(...formatAssignment(field.name, fieldExpr));
		}
		const memberNames = new Set(fields.map((field) => field.name));
		for (const association of design.manyToManyRelationships ?? []) {
			if (association.leftTableId !== table.id) continue;
			const rightTable = design.tables.find(
				(candidate) => candidate.id === association.rightTableId,
			)!;
			const junctionTable = design.tables.find(
				(candidate) => candidate.id === association.junctionTableId,
			)!;
			const leftRelationship = relations.find(
				(view) => view.relationship.id === association.leftRelationshipId,
			)!;
			const rightRelationship = relations.find(
				(view) => view.relationship.id === association.rightRelationshipId,
			)!;
			const sharedNames = relationshipNames.manyToMany.get(association.id)!;
			const name = allocateIdentifier(snakeWords(sharedNames.left), memberNames);
			const leftField = fieldsByColumn.get(
				leftRelationship.referencingColumn.id,
			)!.name;
			const rightField = fieldsByColumn.get(
				rightRelationship.referencingColumn.id,
			)!.name;
			const relation = `models.ManyToManyField(${pyString(modelNames.get(rightTable.id)!)}, through=${pyString(modelNames.get(junctionTable.id)!)}, through_fields=(${pyString(leftField)}, ${pyString(rightField)}), related_name=${pyString(snakeWords(sharedNames.right))})`;
			lines.push(...formatAssignment(name, relation));
		}
		const constraints: string[] = [];
		for (const unique of table.uniqueConstraints ?? []) {
			const constraintName = names.uniqueConstraints.get(unique.id)!;
			const djangoName = allocateDjangoName(constraintName, djangoObjectNames);
			if (djangoName !== constraintName) {
				comments.push(
					`# Constraint ${constraintName} exceeds Django's 30-character name limit; Django uses ${djangoName}. Use RunSQL to retain the PostgreSQL name.`,
				);
			}
			const fieldNames = unique.columnIds.map(
				(id) => fieldsByColumn.get(id)!.name,
			);
			const nullsDistinct = unique.nullsNotDistinct
				? ", nulls_distinct=False"
				: "";
			constraints.push(
				`models.UniqueConstraint(fields=[${fieldNames.map(pyString).join(", ")}], name=${pyString(djangoName)}${nullsDistinct})`,
			);
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
		lines.push("", "    class Meta:");
		lines.push(...formatAssignment("db_table", pyString(table.name), 8));
		if (constraints.length) {
			lines.push(...formatTupleAssignment("constraints", constraints, 8));
		}
		if (indexes.length) {
			lines.push(...formatTupleAssignment("indexes", indexes, 8));
		}
		lines.push("", "");
	}
	const migrationCommentLines = Array.from(migrationNotes.values()).flatMap(
		(note) => [
			`# - ${note.description}`,
			`#   Affected columns: ${Array.from(note.fields).join(", ")}.`,
		],
	);
	if (comments.length) {
		migrationCommentLines.push(...Array.from(new Set(comments)));
	}
	const omissionNotice = unrepresentedPostgresqlLogicNotice(design);
	if (omissionNotice) migrationCommentLines.push(`# ${omissionNotice}`);
	if (migrationCommentLines.length) {
		migrationCommentLines.unshift("# Migration notes:");
		lines.splice(
			1 + importLines.length,
			2,
			"",
			...migrationCommentLines.flatMap((comment) => wrapComment(comment)),
			"",
			"",
		);
	}
	return { ok: true, code: `${lines.join("\n").replace(/\n+$/, "")}\n` };
}

function wrapComment(comment: string, width = 88): string[] {
	const prefix = /^(#(?: - |   | ))/.exec(comment)?.[1] ?? "# ";
	const continuation = "#   ";
	const words = comment.slice(prefix.length).split(/\s+/);
	const lines: string[] = [];
	let line = prefix;
	for (const word of words) {
		const next = line === prefix ? `${line}${word}` : `${line} ${word}`;
		if (next.length > width && line !== prefix) {
			lines.push(line);
			line = continuation + word;
		} else {
			line = next;
		}
	}
	if (line.length > prefix.length) lines.push(line);
	return lines;
}

function renderImports(imports: Set<string>): string[] {
	const importedNames = new Map<string, Set<string>>();
	const standalone: string[] = [];
	for (const statement of imports) {
		const match = /^from (.+) import (.+)$/.exec(statement);
		if (!match) {
			standalone.push(statement);
			continue;
		}
		const names = importedNames.get(match[1]) ?? new Set<string>();
		for (const name of match[2].split(",").map((value) => value.trim())) {
			names.add(name);
		}
		importedNames.set(match[1], names);
	}
	const sortedStatements = [
		...standalone,
		...Array.from(importedNames, ([module, names]) =>
			`from ${module} import ${Array.from(names).sort().join(", ")}`,
		),
	].sort((left, right) => left.localeCompare(right));
	const standardLibrary = sortedStatements.filter((statement) =>
		/^from (collections|datetime|decimal|math|typing|uuid) import /.test(statement),
	);
	const thirdParty = sortedStatements.filter(
		(statement) => !standardLibrary.includes(statement),
	);
	const statements = [
		...standardLibrary,
		...(standardLibrary.length && thirdParty.length ? [""] : []),
		...thirdParty,
	];
	return statements.flatMap((statement) => {
		if (statement.length <= 88) return [statement];
		const [prefix, names] = statement.split(" import ");
		return [
			`${prefix} import (`,
			...names.split(", ").map((name) => `    ${name},`),
			")",
		];
	});
}
function formatAssignment(
	name: string,
	expression: string,
	indentation = 4,
): string[] {
	const indent = " ".repeat(indentation);
	const line = `${indent}${name} = ${expression}`;
	if (line.length <= 88) return [line];
	const formatted = formatExpression(expression, indentation, true);
	formatted[0] = `${indent}${name} = ${formatted[0].trimStart()}`;
	return formatted;
}

function formatTupleAssignment(
	name: string,
	values: string[],
	indentation: number,
): string[] {
	const indent = " ".repeat(indentation);
	const line = `${indent}${name} = (${values.join(", ")},)`;
	if (line.length <= 88) return [line];
	return [
		`${indent}${name} = (`,
		...values.flatMap((value) => {
			const formatted = formatExpression(value, indentation + 4);
			formatted[formatted.length - 1] += ",";
			return formatted;
		}),
		`${indent})`,
	];
}

function formatExpression(
	expression: string,
	indentation: number,
	force = false,
): string[] {
	const indent = " ".repeat(indentation);
	if (!force && indentation + expression.length <= 88) {
		return [`${indent}${expression}`];
	}
	const openParen = expression.indexOf("(");
	const closeParen = expression.lastIndexOf(")");
	if (openParen < 0 || closeParen !== expression.length - 1) {
		return [`${indent}${expression}`];
	}
	const callee = expression.slice(0, openParen);
	const args = splitArguments(expression.slice(openParen + 1, closeParen));
	return [
		`${indent}${callee}(`,
		...args.flatMap((argument) => {
			const equals = argument.indexOf("=");
			const nested = equals < 0 ? argument : argument.slice(equals + 1).trim();
			const prefix = equals < 0 ? "" : argument.slice(0, equals + 1);
			const renderedLength = indentation + 4 + argument.length;
			if (renderedLength <= 88 && nested.length <= 60) {
				return [`${indent}    ${argument},`];
			}
			const wrapped = formatExpression(
				nested,
				indentation + 4,
				indentation + 4 + prefix.length + nested.length > 88,
			);
			wrapped[0] = `${indent}    ${prefix}${wrapped[0].trimStart()}`;
			wrapped[wrapped.length - 1] += ",";
			return wrapped;
		}),
		`${indent})`,
	];
}

function splitArguments(value: string): string[] {
	const argumentsList: string[] = [];
	let depth = 0;
	let quote = "";
	let escaped = false;
	let start = 0;
	for (let index = 0; index < value.length; index++) {
		const character = value[index];
		if (quote) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === quote) quote = "";
		} else if (character === "'" || character === '"') {
			quote = character;
		} else if (character === "(" || character === "[" || character === "{") {
			depth++;
		} else if (character === ")" || character === "]" || character === "}") {
			depth--;
		} else if (character === "," && depth === 0) {
			argumentsList.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (start < value.length) argumentsList.push(value.slice(start).trim());
	return argumentsList;
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
		bigint: "BigIntegerField",
		integer: "IntegerField",
		smallint: "SmallIntegerField",
		text: "TextField",
		varchar: "CharField",
		uuid: "UUIDField",
		boolean: "BooleanField",
		numeric: "DecimalField",
		date: "DateField",
		time: "TimeField",
		timestamptz: "DateTimeField",
		"double precision": "FloatField",
		bytea: "BinaryField",
		jsonb: "JSONField",
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
	if (["timetz", "interval", "money", "timestamp", "real", "json"].includes(type)) {
		return `${type}${p.precision === undefined ? "" : `(${p.precision})`}`;
	}
	if (type === "time" && p.precision !== undefined) {
		return `time(${p.precision})`;
	}
	if (type === "timestamptz" && p.precision !== undefined) {
		return `timestamptz(${p.precision})`;
	}
	if (["inet", "cidr", "macaddr"].includes(type)) return type;
	if (type === "char") {
		return `character${p.length === undefined ? "" : `(${p.length})`}`;
	}
	if (type === "bit") {
		return `bit${p.length === undefined ? " varying" : `(${p.length})`}`;
	}
	if (type === "varchar" && p.length === undefined) return "character varying";
	if (type === "numeric" && p.precision === undefined) return "numeric";
	return null;
}

function defaultOption(column: DesignColumn): string {
	const value = column.default;
	if (value.kind === "currentTimestamp") return "db_default=Now()";
	if (value.kind === "generateUuid") {
		return 'db_default=models.Func(function="gen_random_uuid", output_field=models.UUIDField())';
	}
	if (value.kind !== "literal") return "";
	if (value.literalType === "boolean") {
		return `db_default=${value.value === "true" ? "True" : "False"}`;
	}
	if (value.literalType === "json" && column.type === "jsonb") {
		return `db_default=${pyRepr(JSON.parse(value.value))}`;
	}
	if (value.literalType === "json") {
		return `db_default=Cast(Value(${pyString(value.value)}), output_field=PostgreSQLTypeField(pg_type="json"))`;
	}
	if (value.literalType === "numeric") {
		return `db_default=Decimal(${pyString(value.value)})`;
	}
	if (value.literalType === "integer") {
		return `db_default=${value.value}`;
	}
	if (!["date", "time", "timestamp", "json", "enum"].includes(value.literalType)) {
		return `db_default=${pyString(value.value)}`;
	}
	if (column.type === "enum") {
		return `db_default=${pyString(value.value)}`;
	}
	const outputFields: Record<string, string> = {
		date: "models.DateField()",
		time: "models.TimeField()",
		timestamptz: "models.DateTimeField()",
		jsonb: "models.JSONField()",
	};
	const outputField = outputFields[column.type]
		?? `PostgreSQLTypeField(pg_type=${pyString(customType(column) ?? column.type)})`;
	return `db_default=Cast(Value(${pyString(value.value)}), output_field=${outputField})`;
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

function snakeWords(words: readonly string[]): string {
	return words.join("_") || "field";
}

function pascalWords(words: readonly string[]): string {
	const name = words
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join("");
	return /^[A-Za-z_]/.test(name) ? name : `Model${name}`;
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
	const member = snakeWords(splitWords(value)).toUpperCase() || `VALUE_${index + 1}`;
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
function pyString(value: string): string {
	const quote =
		(value.match(/"/g)?.length ?? 0) > (value.match(/'/g)?.length ?? 0)
			? "'"
			: '"';
	let escaped = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0)!;
		if (character === "\\") escaped += "\\\\";
		else if (character === quote) escaped += `\\${quote}`;
		else if (character === "\n") escaped += "\\n";
		else if (character === "\r") escaped += "\\r";
		else if (character === "\t") escaped += "\\t";
		else if (codePoint === 0x2028 || codePoint === 0x2029) {
			escaped += `\\u${codePoint.toString(16)}`;
		} else if (codePoint < 0x20) {
			escaped += `\\x${codePoint.toString(16).padStart(2, "0")}`;
		} else escaped += character;
	}
	return `${quote}${escaped}${quote}`;
}
function pyRepr(value: unknown): string {
	if (value === null) return "None";
	if (typeof value === "string") return pyString(value);
	if (typeof value === "boolean") return value ? "True" : "False";
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map(pyRepr).join(", ")}]`;
	if (typeof value === "object") {
		return `{${Object.entries(value)
			.map(([key, item]) => `${pyString(key)}: ${pyRepr(item)}`)
			.join(", ")}}`;
	}
	return "None";
}
function pyBool(value: boolean): string { return value ? "True" : "False"; }
function quoteSql(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
function quoteSqlLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
