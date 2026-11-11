import {
	columnDefaultProblem,
	renderDefaultExpression,
} from "./column-defaults";
import { columnTypeInfo, findColumnTypeInfo, isSupportedColumnType } from "./column-types";
import { renderColumnType } from "./column-types";
import type {
	Design,
	DesignColumn,
	DesignRelationship,
	DesignManyToManyAssociation,
	DesignIndex,
	DesignTable,
	DesignUniqueConstraint,
	DesignFunction,
	DesignTrigger,
} from "./design";
import {
	relationshipConstraintName,
	relationshipUniqueConstraintName,
	resolveRelationship,
	resolveRelationships,
	type RelationshipView,
} from "./relationships";
import {
	postgresGeneratedObjectName,
	truncatePostgresIdentifier,
	uniquePostgresIdentifier,
} from "./postgres-identifiers";
import { findIndexMethod, indexOperatorClasses } from "./index-methods";

export type SqlGeneration =
	| { ok: true; sql: string; /** Advice that does not stop the SQL: PostgreSQL accepts it, but it is usually a mistake. */ warnings: string[] }
	| { ok: false; errors: string[] };

type PairConstraint = {
	association: DesignManyToManyAssociation;
	junction: DesignTable;
	leftColumn: DesignColumn;
	rightColumn: DesignColumn;
};

const sameColumns = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/** Whether the table already makes exactly these columns unique, through a unique constraint or a unique index. */
function hasEquivalentUnique(table: DesignTable, columnIds: string[]): boolean {
	return (table.uniqueConstraints ?? []).some((constraint) => sameColumns(constraint.columnIds, columnIds)) ||
		(table.indexes ?? []).some((index) => index.unique && sameColumns(index.keys.map((key) => key.columnId), columnIds));
}

/**
 * The many-to-many links that still need a pair constraint of their own. A junction that is already unique on
 * its two columns does not get a second, identical constraint (and index).
 */
function pendingPairAssociations(design: Design) {
	return (design.manyToManyRelationships ?? []).flatMap((association) => {
		const junction = design.tables.find((table) => table.id === association.junctionTableId);
		if (!junction) return [];
		const ends = [association.leftRelationshipId, association.rightRelationshipId].map((id) => design.relationships.find((relationship) => relationship.id === id)?.referencingColumnId);
		if (ends.every((id): id is string => typeof id === "string") && hasEquivalentUnique(junction, ends)) return [];
		return [{ association, junction }];
	});
}

/** Names of the tables, identity sequences, and indexes in PostgreSQL's schema namespace. */
export function postgresSchemaRelationNames(design: Design): Set<string> {
	const relationships = resolveRelationships(design);
	const junctions = pendingPairAssociations(design).map(({ junction }) => junction);
	return planPostgresIdentifiers(design, relationships, junctions).relationNames;
}

/**
 * The exact constraint and index names the generated SQL uses, keyed by the
 * design object's id, so ORM schema code can name the same database objects.
 * Only meaningful for a design `generateDesignSql` accepts.
 */
export type SchemaObjectNames = {
	/** Foreign-key constraint name by relationship id. */
	foreignKeys: Map<string, string>;
	/** One-to-one uniqueness constraint name by relationship id. */
	relationshipUniques: Map<string, string>;
	/** Endpoint-pair unique constraint name by many-to-many association id. */
	pairConstraints: Map<string, string>;
	/** Index name by index id. */
	indexes: Map<string, string>;
	/** Composite unique constraint name by constraint id. */
	uniqueConstraints: Map<string, string>;
};

export function planSchemaObjectNames(design: Design): SchemaObjectNames {
	const relationships = resolveRelationships(design);
	const associations = pendingPairAssociations(design);
	const plan = planPostgresIdentifiers(
		design,
		relationships,
		associations.map(({ junction }) => junction),
	);
	const relationshipUniques = new Map<string, string>();
	for (const { view, uniqueConstraintName } of plan.namedRelationships) {
		if (uniqueConstraintName) relationshipUniques.set(view.relationship.id, uniqueConstraintName);
	}
	return {
		foreignKeys: new Map(
			plan.namedRelationships.map(({ view, foreignKeyConstraintName }) => [
				view.relationship.id,
				foreignKeyConstraintName,
			]),
		),
		relationshipUniques,
		pairConstraints: new Map(
			associations.map(({ association }, index) => [
				association.id,
				plan.pairConstraintNames[index] ?? "",
			]),
		),
		indexes: new Map(plan.indexes.map(({ index, name }) => [index.id, name])),
		uniqueConstraints: new Map(
			plan.uniqueConstraints.map(({ constraint, name }) => [constraint.id, name]),
		),
	};
}

/**
 * The text of a Design's schema.sql. An invalid draft is still written out as the SQL it would be, under
 * a comment naming its problems, so the file can be edited to fix them.
 */
export function renderSchemaFile(design: Design): string {
	const generated = generateDesignSql(design);
	if (generated.ok) {
		const notes = generated.warnings.map((warning) => `-- ${warning}`);
		return notes.length ? `-- Worth a look (the SQL is valid; these are advice, not errors):\n${notes.join("\n")}\n\n${generated.sql}` : generated.sql;
	}
	let body = "";
	try {
		const lenient = generateDesignSql(design, { lenient: true });
		if (lenient.ok) body = lenient.sql;
	} catch { /* Some drafts cannot be rendered at all; the problems are still listed. */ }
	return `-- This Design has problems. Fix them in this file, then apply it:\n${generated.errors.map((error) => `-- ${error}`).join("\n")}\n\n${body}`;
}

/**
 * Generates read-only PostgreSQL from the authoritative design. An incomplete
 * draft produces explicit errors instead of partial SQL.
 */
export function generateDesignSql(design: Design, options: { lenient?: boolean } = {}): SqlGeneration {
	// Errors are what PostgreSQL would reject. Warnings are best practice (Supabase's Postgres guide): never a reason to withhold SQL.
	const errors: string[] = [];
	const warnings: string[] = [];

	const tableNames = new Set<string>();
	for (const table of design.tables) {
		validateTable(table, tableNames, errors, design.enumTypes ?? [], warnings);
		validateIndexes(table, errors);
		validateUniqueConstraints(table, errors);
	}
	const enumNames = new Set<string>();
	for (const enumType of design.enumTypes ?? []) {
		const name = enumType.name.trim();
		if (!name || enumNames.has(name) || tableNames.has(name)) {
			errors.push(
				`Enum type name "${enumType.name}" is empty or already used in the PostgreSQL schema.`,
			);
		}
		enumNames.add(enumType.name.trim());
		const invalidLabels =
			enumType.name.includes("\u0000") ||
			enumType.labels.length === 0 ||
			enumType.labels.some((label) => !label.trim() || label.includes("\u0000")) ||
			new Set(enumType.labels).size !== enumType.labels.length;
		if (invalidLabels) {
			errors.push(`Enum type "${enumType.name}" needs non-empty, unique labels.`);
		}
	}
	for (const fn of design.functions ?? []) {
		if (!fn.name.trim() || fn.name.includes("\u0000")) errors.push(`Function name "${fn.name}" is invalid.`);
		for (const argument of fn.arguments) {
			if (!argument.name.trim() || argument.name.includes("\u0000")) errors.push(`Function "${fn.name}" has an invalid argument name.`);
			if (!isFunctionType(argument.type)) errors.push(`Function "${fn.name}" has unsupported argument type "${argument.type}".`);
		}
		for (const dependency of fn.tableDependencies ?? []) {
			if (!design.tables.some((table) => table.id === dependency)) {
				errors.push(`Function "${fn.name}" depends on a table that no longer exists.`);
			}
		}
		if (!isFunctionType(fn.returnType)) errors.push(`Function "${fn.name}" has unsupported return type "${fn.returnType}".`);
	}
	for (const trigger of design.triggers ?? []) {
		const table = design.tables.find((candidate) => candidate.id === trigger.tableId);
		const fn = design.functions?.find((candidate) => candidate.id === trigger.functionId);
		if (!trigger.name.trim() || trigger.name.includes("\u0000")) errors.push(`Trigger name "${trigger.name}" is invalid.`);
		if (!table) errors.push(`Trigger "${trigger.name}" depends on a table that no longer exists.`);
		if (!fn || fn.returnType.trim().toLowerCase() !== "trigger" || fn.language !== "plpgsql" || fn.arguments.length > 0) errors.push(`Trigger "${trigger.name}" needs a no-argument PL/pgSQL Function returning trigger.`);
		if (!Array.isArray(trigger.events) || trigger.events.length === 0) errors.push(`Trigger "${trigger.name}" needs at least one event.`);
		for (const event of trigger.events ?? []) {
			for (const columnId of event.columnIds ?? []) {
				if (!table?.columns.some((column) => column.id === columnId)) {
					errors.push(`Trigger "${trigger.name}" references a column that no longer exists.`);
				}
			}
		}
		if (typeof trigger.when !== "string" || trigger.when.includes("\u0000")) errors.push(`Trigger "${trigger.name}" has an invalid WHEN condition.`);
	}

	const occupiedNames = initialPostgresRelationNames(design);
	const explicitSchemaNames = new Set<string>();
	for (const table of design.tables) {
		const names = [
			...(table.indexes ?? []).map((index) => index.name?.trim()),
			...(table.uniqueConstraints ?? []).map((constraint) => constraint.name?.trim()),
		];
		for (const name of names) {
			if (!name) continue;
			const boundedName = truncatePostgresIdentifier(name);
			if (occupiedNames.has(boundedName) || explicitSchemaNames.has(boundedName)) {
				errors.push(
					`Index or constraint name "${name}" is already used in the PostgreSQL schema.`,
				);
			}
			explicitSchemaNames.add(boundedName);
		}
	}

	// A relationship that cannot be resolved stays in the saved draft and is
	// reported here, so an incompatible edit never silently drops the link.
	const relationships: RelationshipView[] = [];
	for (const relationship of design.relationships) {
		const view = validateRelationship(design, relationship, errors, warnings);
		if (view) relationships.push(view);
	}

	const pairConstraints: PairConstraint[] = [];
	for (const association of design.manyToManyRelationships ?? []) {
		const constraint = validateManyToManyAssociation(design, association, warnings);
		if (constraint) pairConstraints.push(constraint);
	}

	for (const view of relationships) warnForeignKeyIndex(view, warnings);
	const pendingPairs = new Set(pendingPairAssociations(design).map(({ association }) => association.id));
	const activePairs = pairConstraints.filter(({ association }) => pendingPairs.has(association.id));

	// A lenient render shows an invalid draft as the SQL it would be, problems and all, so it can be edited.
	if (errors.length > 0 && !options.lenient) return { ok: false, errors: [...new Set(errors)] };

	const namePlan = planPostgresIdentifiers(
		design,
		relationships,
		activePairs.map(({ junction }) => junction),
	);
	warnRedundantIndexes(namePlan, warnings);
	const pairConstraintSql = activePairs.map(
		({ junction, leftColumn, rightColumn }, index) => {
			const name = namePlan.pairConstraintNames[index];
			if (!name) throw new Error("A pair constraint has no planned name.");
			return renderPairConstraint(junction, leftColumn, rightColumn, name);
		},
	);
	const vectorUsed = design.tables.some((table) =>
		table.columns.some((column) =>
			["vector", "halfvec", "sparsevec"].includes(column.type),
		) ||
		(table.indexes ?? []).some((index) =>
			index.method === "hnsw" || index.method === "ivfflat",
		),
	);
	// A foreign key goes inside CREATE TABLE when the table it references is already created (itself included);
	// only references that are part of a cycle are added afterwards.
	const orderedTables = dependencyOrder(design, relationships);
	const tablePosition = new Map(orderedTables.map((table, position) => [table.id, position]));
	const inlineForeignKeys = new Set(namePlan.namedRelationships
		.filter(({ view }) => (tablePosition.get(view.referencedTable.id) ?? Infinity) <= (tablePosition.get(view.referencingTable.id) ?? -1))
		.map(({ view }) => view.relationship.id));
	const rawSql = (phase: "before" | "after") => (design.rawStatements ?? [])
		.filter((raw) => raw.phase === phase)
		.map((raw) => /;\s*$/.test(raw.sql) ? raw.sql.trim() : `${raw.sql.trim()};`);
	const statements = [
		...(vectorUsed ? ["CREATE EXTENSION IF NOT EXISTS vector;"] : []),
		...rawSql("before"),
		...(design.enumTypes ?? []).map((enumType) =>
			`CREATE TYPE ${quoteIdentifier(enumType.name)} AS ENUM (${enumType.labels.map(quoteString).join(", ")});`,
		),
		...orderedTables.map((table) =>
			renderTable(
				table,
				design,
				namePlan.uniqueConstraints.filter((entry) => entry.table.id === table.id),
				namePlan.namedRelationships.filter((entry) => inlineForeignKeys.has(entry.view.relationship.id) && entry.view.referencingTable.id === table.id),
			),
		),
		...[...namePlan.indexes].sort((a, b) => (tablePosition.get(a.table.id) ?? 0) - (tablePosition.get(b.table.id) ?? 0)).map(({ table, index, name }) => renderIndex(table, index, name)),
		...namePlan.namedRelationships.filter((entry) => !inlineForeignKeys.has(entry.view.relationship.id)).map(
			({ view, foreignKeyConstraintName, uniqueConstraintName }) =>
				renderRelationship(view, foreignKeyConstraintName, uniqueConstraintName),
		),
		...pairConstraintSql,
		...(design.functions ?? []).map((fn) => renderFunction(fn, design)),
		...(design.triggers ?? []).map((trigger) => renderTrigger(trigger, design)),
		...orderedTables.flatMap((table) => renderPolicies(table)),
		...rawSql("after"),
	];
	return { ok: true, sql: `${statements.join("\n\n")}\n`, warnings: [...new Set(warnings)] };
}

function renderFunction(fn: DesignFunction, design: Design): string {
	const argumentsSql = fn.arguments
		.map((argument) => `${quoteIdentifier(argument.name)} ${renderFunctionType(argument.type, design)}`)
		.join(", ");
	let delimiter = "$function$";
	for (let suffix = 1; fn.body.includes(delimiter); suffix++) delimiter = `$function_${suffix}$`;
	return [
		`CREATE FUNCTION ${quoteIdentifier(fn.name)}(${argumentsSql})`,
		`RETURNS ${fn.returnsSet && !/^TABLE\s*\(/i.test(fn.returnType) ? "SETOF " : ""}${renderFunctionType(fn.returnType, design)}`,
		`LANGUAGE ${fn.language.toUpperCase()}`,
		`${fn.volatility.toUpperCase()}`,
		`SECURITY ${fn.security.toUpperCase()}`,
		`AS ${delimiter}${fn.body}${delimiter};`,
	].join("\n");
}
function renderTrigger(trigger: DesignTrigger, design: Design): string {
	const table = design.tables.find((candidate) => candidate.id === trigger.tableId);
	const fn = design.functions?.find((candidate) => candidate.id === trigger.functionId);
	if (!table || !fn) return "";
	const events = (trigger.events ?? []).map(({ event, columnIds }) => {
		const columns = (columnIds ?? []).flatMap((id) => {
			const column = table.columns.find((candidate) => candidate.id === id);
			return column ? [column.name] : [];
		});
		return event === "UPDATE" && columns.length
			? `UPDATE OF ${columns.map(quoteIdentifier).join(", ")}`
			: event;
	});
	return `CREATE TRIGGER ${quoteIdentifier(trigger.name)} ${trigger.timing} ${events.join(" OR ")} ON ${quoteIdentifier(table.name)}${trigger.level === "ROW" ? " FOR EACH ROW" : " FOR EACH STATEMENT"}${trigger.when ? ` WHEN (${trigger.when})` : ""} EXECUTE FUNCTION ${quoteIdentifier(fn.name)}();`;
}

function renderFunctionType(value: string, design: Design): string {
	const normalized = value.trim();
	const arraySuffix = normalized.endsWith("[]") ? "[]" : "";
	const baseType = arraySuffix ? normalized.slice(0, -2).trim() : normalized;
	const customType = [...design.tables.map((table) => table.name), ...(design.enumTypes ?? []).map((type) => type.name)]
		.find((name) => name === baseType);
	return customType ? `${quoteIdentifier(customType)}${arraySuffix}` : normalized;
}

function isFunctionType(value: string): boolean {
	const normalized = value.trim();
	if (!normalized || normalized.includes("\u0000") || /[;'"`$]/.test(normalized)) return false;
	if (/^[A-Za-z_][A-Za-z0-9_ .]*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])*$/.test(normalized)) return true;
	const table = /^TABLE\s*\((.*)\)$/is.exec(normalized);
	if (!table) return false;
	return table[1]!.split(",").every((column) =>
		/^\s*[A-Za-z_][A-Za-z0-9_]*\s+[A-Za-z_][A-Za-z0-9_ .]*(?:\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?:\[\])*\s*$/.test(column),
	);
}

/** PostgreSQL lets integer types reference each other, and text, varchar and char alike; other mixes it refuses. */
function referenceTypesCompatible(referencing: DesignColumn, referenced: DesignColumn): boolean {
	if (referencing.type === "enum" || referenced.type === "enum") {
		return referencing.type === referenced.type && referencing.enumTypeId === referenced.enumTypeId;
	}
	if (referencing.type === referenced.type) return true;
	const family = (type: DesignColumn["type"]) => findColumnTypeInfo(type)?.family.id;
	return family(referencing.type) === family(referenced.type) && (family(referencing.type) === "integer" || family(referencing.type) === "text");
}

function validateRelationship(
	design: Design,
	relationship: DesignRelationship,
	errors: string[],
	warnings: string[],
): RelationshipView | null {
	const view = resolveRelationship(design, relationship);
	if (!view) {
		errors.push("A relationship refers to a table or column that no longer exists.");
		return null;
	}

	const label = `Relationship from "${view.referencingTable.name}" to "${view.referencedTable.name}"`;
	if (!view.referencedColumn) {
		errors.push(
			`${label} needs "${view.referencedTable.name}" to have exactly one primary key column.`,
		);
		return null;
	}
	if (!referenceTypesCompatible(view.referencingColumn, view.referencedColumn)) {
		const referencing = view.referencingColumn;
		const referenced = view.referencedColumn;
		errors.push(
				`${label} needs matching types; "${referencing.name}" is ${referencing.type} ` +
					`but "${view.referencedTable.name}"."${referenced.name}" is ${referenced.type}.`,
		);
		return null;
	}
	const actions = [
		["delete", relationship.onDelete ?? "NO ACTION"],
		["update", relationship.onUpdate ?? "NO ACTION"],
	] as const;
	for (const [kind, action] of actions) {
		if (!["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"].includes(action)) {
			errors.push(`${label} has an unsupported ON ${kind.toUpperCase()} action.`);
		}
		// PostgreSQL accepts both of these; they only fail later, when a row is actually deleted or updated.
		if (action === "SET NULL" && !view.referencingColumn.nullable) {
			warnings.push(
				`${label} uses ON ${kind.toUpperCase()} SET NULL but its foreign-key column is required.`,
			);
		}
		if (action === "SET DEFAULT" && view.referencingColumn.default.kind === "none") {
			warnings.push(
				`${label} uses ON ${kind.toUpperCase()} SET DEFAULT but its foreign-key column has no default.`,
			);
		}
	}
	return view;
}

/** The junction's foreign keys are ordinary relationships, so a malformed association only loses its pair constraint. */
function validateManyToManyAssociation(
	design: Design,
	association: DesignManyToManyAssociation,
	warnings: string[],
): PairConstraint | null {
	const junction = design.tables.find(
		(table) => table.id === association.junctionTableId,
	);
	const leftRelationship = design.relationships.find(
		(relationship) => relationship.id === association.leftRelationshipId,
	);
	const rightRelationship = design.relationships.find(
		(relationship) => relationship.id === association.rightRelationshipId,
	);
	if (!junction || !leftRelationship || !rightRelationship) {
		warnings.push("A many-to-many relationship refers to a missing junction or reference.");
		return null;
	}

	const leftColumn = junction.columns.find(
		(column) => column.id === leftRelationship.referencingColumnId,
	);
	const rightColumn = junction.columns.find(
		(column) => column.id === rightRelationship.referencingColumnId,
	);
	if (
		leftRelationship.id === rightRelationship.id ||
		leftRelationship.referencingTableId !== junction.id ||
		rightRelationship.referencingTableId !== junction.id ||
		leftRelationship.referencedTableId !== association.leftTableId ||
		rightRelationship.referencedTableId !== association.rightTableId ||
		leftRelationship.cardinality !== "one-to-many" ||
		rightRelationship.cardinality !== "one-to-many" ||
		!leftColumn ||
		!rightColumn ||
		leftColumn.id === rightColumn.id
	) {
		warnings.push(
			`Many-to-many junction "${junction.name}" needs two distinct references to its endpoint tables, so no pair constraint was added.`,
		);
		return null;
	}

	if (
		leftColumn.nullable ||
		rightColumn.nullable ||
		leftColumn.primaryKey ||
		rightColumn.primaryKey ||
		leftColumn.unique ||
		rightColumn.unique ||
		leftColumn.identity ||
		rightColumn.identity ||
		leftColumn.default.kind !== "none" ||
		rightColumn.default.kind !== "none"
	) {
		warnings.push(
			`Many-to-many junction "${junction.name}" needs required references without individual defaults or uniqueness, so no pair constraint was added.`,
		);
		return null;
	}

	return { association, junction, leftColumn, rightColumn };
}

function planPostgresIdentifiers(
	design: Design,
	relationships: RelationshipView[],
	junctions: DesignTable[],
) {
	const relationNames = initialPostgresRelationNames(design);
	const constraintNames = new Set(relationNames);
	const explicitNames = design.tables.flatMap((table) => [
		...(table.indexes ?? []).map((index) => index.name?.trim()),
		...(table.uniqueConstraints ?? []).map((constraint) => constraint.name?.trim()),
	].filter((name): name is string => Boolean(name)));
	for (const name of explicitNames) {
		const bounded = truncatePostgresIdentifier(name);
		constraintNames.add(bounded);
		relationNames.add(bounded);
	}
	const namedRelationships = relationships.map((view) => {
		const foreignKeyConstraintName = allocateConstraintName(
			constraintNames,
			relationshipConstraintName(view),
		);
		const uniqueConstraintName = view.ownsUniqueness
			? allocateConstraintName(constraintNames, relationshipUniqueConstraintName(view))
			: null;
		if (uniqueConstraintName) relationNames.add(uniqueConstraintName);
		return { view, foreignKeyConstraintName, uniqueConstraintName };
	});
	const pairConstraintNames = junctions.map((junction) => {
		const name = allocateConstraintName(
			constraintNames,
			`${junction.name}_pair_key`,
		);
		relationNames.add(name);
		return name;
	});
	const indexes = design.tables.flatMap((table) => (table.indexes ?? []).map((index, position) => {
		const keyNames = index.keys.map((key) => table.columns.find((column) => column.id === key.columnId)?.name ?? "column");
		const preferred = index.name?.trim() || `${table.name}_${keyNames.join("_")}_idx`;
		const name = index.name?.trim() || allocateConstraintName(constraintNames, preferred);
		if (index.name?.trim()) constraintNames.add(truncatePostgresIdentifier(name));
		relationNames.add(name);
		return { table, index, name, position };
	}));
	const uniqueConstraints = design.tables.flatMap((table) => (table.uniqueConstraints ?? []).map((constraint) => {
		const names = constraint.columnIds.map((id) => table.columns.find((column) => column.id === id)?.name ?? "column");
		const preferred = constraint.name?.trim() || `${table.name}_${names.join("_")}_key`;
		const name = constraint.name?.trim() || allocateConstraintName(constraintNames, preferred);
		if (constraint.name?.trim()) constraintNames.add(truncatePostgresIdentifier(name));
		relationNames.add(name);
		return { table, constraint, name };
	}));
	return { namedRelationships, pairConstraintNames, relationNames, indexes, uniqueConstraints };
}

function validateUniqueConstraints(table: DesignTable, errors: string[]) {
	const names = new Set<string>();
	for (const constraint of table.uniqueConstraints ?? []) {
		if (constraint.columnIds.length < 1) {
			errors.push(
				`Unique constraint on "${table.name}" needs at least one column.`,
			);
		}
		const missingOrDuplicateColumn =
			new Set(constraint.columnIds).size !== constraint.columnIds.length ||
			constraint.columnIds.some(
				(id) => !table.columns.some((column) => column.id === id),
			);
		if (missingOrDuplicateColumn) {
			errors.push(
				`Composite unique constraint on "${table.name}" refers to missing or duplicate columns.`,
			);
		}
		if (constraint.name && names.has(constraint.name)) {
			errors.push(
				`Composite unique constraint name "${constraint.name}" is repeated on "${table.name}".`,
			);
		}
		if (constraint.name) names.add(constraint.name);
	}
}

/** Tables, PostgreSQL-generated identity sequences, and indexes. */
function initialPostgresRelationNames(design: Design): Set<string> {
	const names = new Set(
		design.tables.map((table) => truncatePostgresIdentifier(table.name)),
	);
	for (const enumType of design.enumTypes ?? []) names.add(truncatePostgresIdentifier(enumType.name));
	for (const table of design.tables) {
		const tableName = truncatePostgresIdentifier(table.name);
		for (const column of table.columns) {
			if (column.identity) {
				addPostgresGeneratedRelationName(
					names,
					tableName,
					truncatePostgresIdentifier(column.name),
					"seq",
				);
			}
		}
		for (const column of table.columns) {
			if (column.unique && !column.primaryKey) {
				addPostgresGeneratedRelationName(
					names,
					tableName,
					truncatePostgresIdentifier(column.name),
					"key",
				);
			}
		}
		if (table.columns.some((column) => column.primaryKey)) {
			addPostgresGeneratedRelationName(names, tableName, null, "pkey");
		}
	}
	return names;
}

function validateIndexes(table: DesignTable, errors: string[]) {
	const names = new Set<string>();
	for (const index of table.indexes ?? []) {
		const label = `Index on table "${table.name}"`;
		const method = findIndexMethod(index.method);
		if (!method) {
			errors.push(`${label} uses an unsupported access method.`);
			continue;
		}
		validateIndexName(index.name, label, names, errors);
		validateIndexKeys(table, index, method, label, errors);
		validateIndexOptions(index, method.storageOptions, label, errors);
		if (index.nullsNotDistinct && !index.unique) {
			errors.push(`${label} can use NULLS NOT DISTINCT only when it is unique.`);
		}
	}
}

function validateIndexName(name: string | undefined, label: string, names: Set<string>, errors: string[]) {
	const explicit = name?.trim();
	if (!explicit) return;
	if (names.has(explicit)) errors.push(`${label} name "${explicit}" is used more than once.`);
	names.add(explicit);
}

function validateIndexKeys(
	table: DesignTable,
	index: NonNullable<DesignTable["indexes"]>[number],
	method: NonNullable<ReturnType<typeof findIndexMethod>>,
	label: string,
	errors: string[],
) {
	const columns = index.keys.map((key) => table.columns.find((column) => column.id === key.columnId));
	if (index.keys.length === 0) {
		errors.push(`${label} needs at least one key column.`);
	}
	if (new Set(index.keys.map((key) => key.columnId)).size !== index.keys.length) {
		errors.push(`${label} cannot use the same column more than once.`);
	}
	if (columns.some((column) => !column)) {
		errors.push(`${label} refers to a missing key column.`);
	}
	if (index.keys.some((key) =>
		(key.order !== undefined && key.order !== "asc" && key.order !== "desc") ||
		(key.nulls !== undefined && key.nulls !== "first" && key.nulls !== "last"),
	)) {
		errors.push(`${label} has an unsupported key ordering option.`);
	}
	if (index.method === "hash" && (index.keys.length !== 1 || index.unique)) {
		errors.push(`${label} using hash must have one key and cannot be unique.`);
	}
	if (index.unique && !method.unique) {
		errors.push(`${label} can be unique only with btree.`);
	}
	if (index.keys.some((key) => (key.order || key.nulls) && !method.ordering)) {
		errors.push(`${label} using ${index.method} does not support key sort ordering.`);
	}
	for (const [position, column] of columns.entries()) {
		if (!column) continue;
		const key = index.keys[position];
		const classes = indexOperatorClasses(index.method, column.type, column.typeParameters?.array);
		if (key.operatorClass && !classes.some((option) => option.name === key.operatorClass)) {
			errors.push(
				index.method === "hnsw" || index.method === "ivfflat"
					? `${label} needs a compatible pgvector column and operator class.`
					: `${label} has an operator class incompatible with ${index.method} on ${column.type}.`,
			);
		} else if (!key.operatorClass && !classes.some((option) => option.default)) {
			errors.push(
				`${label} using ${index.method} needs an explicit compatible ` +
					`operator class for ${column.type}.`,
			);
		}
		if (key.operatorClass && !/^[a-z_][a-z0-9_]*$/.test(key.operatorClass)) {
			errors.push(`${label} has an invalid operator class identifier.`);
		}
		validateVectorIndexKey(index, column.type, column.typeParameters?.dimensions, label, errors);
	}
	if ((index.includeColumnIds?.length ?? 0) > 0 && !method.include) {
		errors.push(`${label} using ${index.method} cannot have INCLUDE columns.`);
	}
	if ((index.includeColumnIds ?? []).some((id) =>
		index.keys.some((key) => key.columnId === id),
	)) {
		errors.push(`${label} cannot INCLUDE a key column.`);
	}
	if (new Set(index.includeColumnIds ?? []).size !== (index.includeColumnIds ?? []).length) {
		errors.push(`${label} repeats an INCLUDE column.`);
	}
	for (const id of index.includeColumnIds ?? []) {
		if (!table.columns.some((column) => column.id === id)) {
			errors.push(`${label} refers to a missing INCLUDE column.`);
		}
	}
	if ((index.method === "hnsw" || index.method === "ivfflat") && index.keys.length !== 1) {
		errors.push(`${label} using ${index.method} must have exactly one key.`);
	}
}

function validateVectorIndexKey(
	index: NonNullable<DesignTable["indexes"]>[number],
	type: string,
	dimensions: number | undefined,
	label: string,
	errors: string[],
) {
	if (index.method !== "hnsw" && index.method !== "ivfflat") return;
	const limit = type === "vector" ? 2000 : type === "halfvec" ? 4000 : type === "bit" ? 64000 : undefined;
	if (limit && dimensions && dimensions > limit) {
		errors.push(
			`${label} exceeds the ${type} ${index.method} dimension limit of ${limit}.`,
		);
	}
}

function validateIndexOptions(
	index: NonNullable<DesignTable["indexes"]>[number],
	allowed: readonly string[],
	label: string,
	errors: string[],
) {
	for (const [key, value] of Object.entries(index.with ?? {})) {
		if (!allowed.includes(key)) errors.push(`${label} does not support the ${key} storage option.`);
		if (key === "fastupdate" && typeof value !== "boolean") errors.push(`${label} fastupdate must be true or false.`);
		if (key !== "fastupdate" && (!Number.isInteger(value) || Number(value) < 1)) errors.push(`${label} storage options must be positive integers.`);
		if (key === "fillfactor" && (Number(value) < 10 || Number(value) > 100)) errors.push(`${label} fillfactor must be between 10 and 100.`);
		if (key === "m" && Number(value) > 100) errors.push(`${label} HNSW m must be at most 100.`);
		if (key === "efConstruction" && Number(value) < 4) errors.push(`${label} HNSW efConstruction must be at least 4.`);
	}
}

function addPostgresGeneratedRelationName(
	names: Set<string>,
	tableName: string,
	columnName: string | null,
	label: string,
): void {
	for (let index = 0; ; index += 1) {
		const generatedLabel = index === 0 ? label : `${label}${index}`;
		const name = postgresGeneratedObjectName(
			tableName,
			columnName,
			generatedLabel,
		);
		if (names.has(name)) continue;
		names.add(name);
		return;
	}
}

function allocateConstraintName(names: Set<string>, preferred: string): string {
	const name = uniquePostgresIdentifier(preferred, names);
	names.add(name);
	return name;
}

function renderPairConstraint(
	junction: DesignTable,
	leftColumn: DesignColumn,
	rightColumn: DesignColumn,
	constraintName: string,
): string {
	const columns = [
		quoteIdentifier(leftColumn.name),
		quoteIdentifier(rightColumn.name),
	].join(", ");
	return `ALTER TABLE ${quoteIdentifier(junction.name)}\n  ADD CONSTRAINT ${quoteIdentifier(constraintName)} UNIQUE (${columns});`;
}

function validateTable(
	table: DesignTable,
	tableNames: Set<string>,
	errors: string[],
	enumTypes: NonNullable<Design["enumTypes"]>,
	warnings: string[],
) {
	const name = table.name.trim();
	const label = name.length > 0 ? `"${name}"` : "(unnamed table)";

	if (name.length === 0) errors.push("Every table needs a name.");
	else if (tableNames.has(name)) errors.push(`Table name ${label} is used more than once.`);
	tableNames.add(name);
	if (name !== name.toLowerCase() && name.length > 0) warnings.push(`Table ${label} is mixed case, so every query must quote it. Lowercase snake_case works everywhere.`);

	// PostgreSQL allows a table with no columns; it is almost never intended.
	if (table.columns.length === 0) warnings.push(`Table ${label} has no columns.`);
	else if (!table.columns.some((column) => column.primaryKey)) warnings.push(`Table ${label} has no primary key. Give every table one, so rows can be addressed and referenced.`);

	const columnNames = new Set<string>();
	for (const column of table.columns) {
		validateColumn(table, column, columnNames, errors, enumTypes, warnings);
		if (column.name !== column.name.toLowerCase()) warnings.push(`Column "${column.name}" of ${label} is mixed case, so every query must quote it.`);
		if (column.type === "timestamp") warnings.push(`Column "${column.name}" of ${label} is timestamp without time zone; timestamptz avoids time zone surprises.`);
	}
}

/** Postgres does not index foreign keys itself; without one, joins and cascading deletes scan the whole table. */
function warnForeignKeyIndex(view: RelationshipView, warnings: string[]) {
	const table = view.referencingTable;
	const column = view.referencingColumn;
	const firstKey = (columnIds: string[]) => columnIds[0] === column.id;
	const covered =
		column.primaryKey || column.unique || view.relationship.cardinality === "one-to-one" ||
		(table.uniqueConstraints ?? []).some((constraint) => firstKey(constraint.columnIds)) ||
		(table.indexes ?? []).some((index) => index.keys[0]?.columnId === column.id) ||
		table.columns.filter((candidate) => candidate.primaryKey).length > 1 && table.columns.find((candidate) => candidate.primaryKey)?.id === column.id;
	if (!covered) warnings.push(`Foreign key "${table.name}"."${column.name}" has no index, so joins and cascading deletes scan "${table.name}". Add one.`);
}

function validateColumn(
	table: DesignTable,
	column: DesignColumn,
	columnNames: Set<string>,
	errors: string[],
	enumTypes: NonNullable<Design["enumTypes"]>,
	warnings: string[],
) {
	const tableLabel = table.name.trim().length > 0 ? `"${table.name.trim()}"` : "(unnamed table)";
	const name = column.name.trim();
	const label = name.length > 0 ? `"${name}"` : "(unnamed column)";

	if (name.length === 0) errors.push(`Table ${tableLabel} has a column that needs a name.`);
	else if (columnNames.has(name)) {
		errors.push(`Column name ${label} is used more than once in table ${tableLabel}.`);
	}
	columnNames.add(name);

	if (!isSupportedColumnType(column.type)) {
		errors.push(`Column ${label} in table ${tableLabel} uses an unsupported type.`);
	} else if (column.identity && !columnTypeInfo(column.type).identity) {
		errors.push(`Column ${label} in table ${tableLabel} can only use identity on integer types.`);
	} else {
		const problem = columnDefaultProblem(column.type, column.default);
		if (problem) {
			errors.push(
				`Column ${label} in table ${tableLabel} has an invalid default: ${problem}.`,
			);
		}
	}
	if (
		column.type === "enum" &&
		!enumTypes.some((enumType) => enumType.id === column.enumTypeId)
	) {
		errors.push(`Column ${label} in table ${tableLabel} needs a valid enum type.`);
	}
	const parameters = column.typeParameters ?? {};
	const invalidLength =
		parameters.length !== undefined &&
		(!Number.isInteger(parameters.length) ||
			parameters.length < 1 ||
			parameters.length > 10_485_760);
	if (["varchar", "char", "bit"].includes(column.type) && invalidLength) {
		errors.push(`Column ${label} in table ${tableLabel} needs a valid positive length.`);
	}
	const invalidPrecision =
		parameters.precision !== undefined &&
		(!Number.isInteger(parameters.precision) ||
			parameters.precision < 1 ||
			parameters.precision > 1000);
	const invalidScale =
		parameters.scale !== undefined &&
		(parameters.precision === undefined ||
			!Number.isInteger(parameters.scale) ||
			parameters.scale < -1000 ||
			parameters.scale > 1000);
	if (column.type === "numeric" && (invalidPrecision || invalidScale)) {
		errors.push(
			`Column ${label} in table ${tableLabel} has invalid numeric precision or scale.`,
		);
	}
	const invalidDimensions =
		!Number.isInteger(parameters.dimensions) ||
		(parameters.dimensions ?? 0) < 1 ||
		(parameters.dimensions ?? 0) > 1_000_000_000;
	if (["vector", "halfvec", "sparsevec"].includes(column.type) && invalidDimensions) {
		errors.push(
			`Column ${label} in table ${tableLabel} needs a valid positive vector dimension.`,
		);
	}

	// Identity generation and a default both supply a value, so PostgreSQL
	// cannot accept them together. The draft stays saved until resolved.
	if (column.identity && column.default.kind !== "none") {
		errors.push(
			`Column ${label} in table ${tableLabel} cannot use identity generation and a default; choose one.`,
		);
	}

	// PostgreSQL makes primary key and identity columns required whatever the flag says, and the SQL below
	// says NOT NULL for them, so a contradictory flag is advice rather than an error.
	if (column.primaryKey && column.nullable) {
		warnings.push(
			`Primary key column ${label} in table ${tableLabel} is marked Nullable, but PostgreSQL requires it; turn off Nullable.`,
		);
	}
	if (column.identity && column.nullable) {
		warnings.push(
			`Identity column ${label} in table ${tableLabel} is marked Nullable, but PostgreSQL requires it; turn off Nullable.`,
		);
	}
}

type Plan = ReturnType<typeof planPostgresIdentifiers>;

/**
 * An index whose columns are the start of another index, a unique constraint, or the primary key is served by
 * it already, and only slows writes and takes space (Supabase's composite-index guidance).
 */
function warnRedundantIndexes(plan: Plan, warnings: string[]) {
	type Cover = { name: string; keys: string[]; unique: boolean };
	for (const entry of plan.indexes) {
		const { table, index } = entry;
		const keys = index.keys.map((key) => key.columnId);
		if (index.method === "btree" && index.unique && (index.includeColumnIds?.length ?? 0) === 0) {
			// A unique index next to a unique constraint on the same columns builds the same index twice.
			const twin = plan.uniqueConstraints.find((other) => other.table.id === table.id && sameColumns(other.constraint.columnIds, keys));
			if (twin) warnings.push(`Unique index "${entry.name}" on "${table.name}" repeats constraint "${twin.name}" on the same columns, so the same index is built twice. Keep one.`);
			continue;
		}
		if (index.method !== "btree" || index.unique || (index.includeColumnIds?.length ?? 0) > 0) continue;
		const covers: Cover[] = [
			...plan.indexes.filter((other) => other.table.id === table.id && other.index.id !== index.id && other.index.method === "btree").map((other) => ({ name: `index "${other.name}"`, keys: other.index.keys.map((key) => key.columnId), unique: Boolean(other.index.unique) })),
			...plan.uniqueConstraints.filter((other) => other.table.id === table.id).map((other) => ({ name: `constraint "${other.name}"`, keys: other.constraint.columnIds, unique: true })),
			...table.columns.filter((column) => column.unique && !column.primaryKey).map((column) => ({ name: `unique column "${column.name}"`, keys: [column.id], unique: true })),
			...(table.columns.some((column) => column.primaryKey) ? [{ name: "the primary key", keys: table.columns.filter((column) => column.primaryKey).map((column) => column.id), unique: true }] : []),
		];
		const covering = covers.find((cover) => cover.keys.length >= keys.length && keys.every((id, position) => cover.keys[position] === id) &&
			// Two identical plain indexes are redundant with each other; only the later one is reported.
			(cover.keys.length > keys.length || cover.unique || plan.indexes.findIndex((other) => other.index.id === index.id) > plan.indexes.findIndex((other) => `index "${other.name}"` === cover.name)));
		if (covering) warnings.push(`Index "${entry.name}" on "${table.name}" is already covered by ${covering.name}, which starts with the same columns. It only costs writes and space.`);
	}
}

/** Tables in an order where each comes after the tables it references, keeping the designed order otherwise. */
function dependencyOrder(design: Design, relationships: RelationshipView[]): DesignTable[] {
	const references = new Map<string, string[]>();
	for (const view of relationships) {
		if (view.referencingTable.id === view.referencedTable.id) continue;
		references.set(view.referencingTable.id, [...(references.get(view.referencingTable.id) ?? []), view.referencedTable.id]);
	}
	const byId = new Map(design.tables.map((table) => [table.id, table]));
	const state = new Map<string, "visiting" | "done">();
	const ordered: DesignTable[] = [];
	const visit = (table: DesignTable) => {
		if (state.has(table.id)) return; // Done, or part of a cycle: that reference is added after the tables.
		state.set(table.id, "visiting");
		for (const id of references.get(table.id) ?? []) {
			const target = byId.get(id);
			if (target) visit(target);
		}
		state.set(table.id, "done");
		ordered.push(table);
	};
	for (const table of design.tables) visit(table);
	return ordered;
}

function renderTable(
	table: DesignTable,
	design: Design,
	uniqueConstraints: { constraint: DesignUniqueConstraint; name: string }[],
	foreignKeys: Array<{ view: RelationshipView; foreignKeyConstraintName: string; uniqueConstraintName: string | null }> = [],
): string {
	const primaryKeys = table.columns.filter((column) => column.primaryKey);
	const lines = table.columns.map((column) => renderColumn(column, design));
	if (primaryKeys.length) lines.push(`  PRIMARY KEY (${primaryKeys.map((key) => quoteIdentifier(key.name)).join(", ")})`);
	for (const { constraint, name } of uniqueConstraints) {
		const columns = constraint.columnIds.map((id) =>
			quoteIdentifier(table.columns.find((column) => column.id === id)!.name),
		);
		const nullsNotDistinct = constraint.nullsNotDistinct
			? " NULLS NOT DISTINCT"
			: "";
		lines.push(
			`  CONSTRAINT ${quoteIdentifier(name)} UNIQUE${nullsNotDistinct} (${columns.join(", ")})`,
		);
	}
	for (const { view, foreignKeyConstraintName, uniqueConstraintName } of foreignKeys) {
		lines.push(
			`  CONSTRAINT ${quoteIdentifier(foreignKeyConstraintName)} FOREIGN KEY (${quoteIdentifier(view.referencingColumn.name)}) ` +
			`REFERENCES ${quoteIdentifier(view.referencedTable.name)} (${quoteIdentifier(view.referencedColumn!.name)}) ` +
			`ON UPDATE ${view.relationship.onUpdate ?? "NO ACTION"} ON DELETE ${view.relationship.onDelete ?? "NO ACTION"}`,
		);
		if (view.ownsUniqueness && uniqueConstraintName) lines.push(`  CONSTRAINT ${quoteIdentifier(uniqueConstraintName)} UNIQUE (${quoteIdentifier(view.referencingColumn.name)})`);
	}
	return `CREATE TABLE ${quoteIdentifier(table.name)} (\n${lines.join(",\n")}\n);`;
}

function renderIndex(table: DesignTable, index: DesignIndex, name: string): string {
	const keys = index.keys.map((key) => {
		const column = table.columns.find((candidate) => candidate.id === key.columnId)!;
		const ordering = [
			key.order ? key.order.toUpperCase() : "",
			key.nulls ? `NULLS ${key.nulls.toUpperCase()}` : "",
		]
			.filter(Boolean)
			.join(" ");
		const operatorClass = key.operatorClass ? ` ${key.operatorClass}` : "";
		const keyOrdering = ordering ? ` ${ordering}` : "";
		return `${quoteIdentifier(column.name)}${operatorClass}${keyOrdering}`;
	}).join(", ");
	const include = (index.includeColumnIds ?? [])
		.map((id) => table.columns.find((column) => column.id === id)!)
		.map((column) => quoteIdentifier(column.name));
	const options: string[] = [];
	for (const [key, value] of Object.entries(index.with ?? {})) {
		if (value === undefined) continue;
		const optionName =
			key === "efConstruction"
				? "ef_construction"
				: key === "pagesPerRange"
					? "pages_per_range"
					: key;
		const optionValue = typeof value === "string" ? quoteString(value) : value;
		options.push(`${optionName} = ${optionValue}`);
	}
	const clauses = [
		`CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdentifier(name)} ON ${quoteIdentifier(table.name)} USING ${index.method} (${keys})`,
		...(include.length ? [`INCLUDE (${include.join(", ")})`] : []),
		...(index.unique && index.nullsNotDistinct ? ["NULLS NOT DISTINCT"] : []),
		...(options.length ? [`WITH (${options.join(", ")})`] : []),
	];
	const clause = clauses.join(" ");
	return `${clause};`;
}
function renderPolicies(table: DesignTable): string[] {
	const statements = table.rowLevelSecurity
		? [`ALTER TABLE ${quoteIdentifier(table.name)} ENABLE ROW LEVEL SECURITY;`]
		: [];
	for (const policy of table.policies ?? []) {
		const roles = policy.roles.length > 0
			? policy.roles.map(quoteIdentifier).join(", ")
			: "PUBLIC";
		const clauses = [
			policy.using.trim() ? `USING (${policy.using.trim()})` : "",
			policy.withCheck.trim() ? `WITH CHECK (${policy.withCheck.trim()})` : "",
		].filter(Boolean);
		statements.push(
			`CREATE POLICY ${quoteIdentifier(policy.name)} ON ${quoteIdentifier(table.name)} AS ${policy.mode.toUpperCase()} FOR ${policy.command} TO ${roles}${clauses.length ? ` ${clauses.join(" ")}` : ""};`,
		);
	}
	return statements;
}

function quoteString(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function renderColumn(column: DesignColumn, design: Design): string {
	const enumName =
		column.type === "enum"
			? design.enumTypes?.find((value) => value.id === column.enumTypeId)?.name
			: undefined;
	const sqlType = enumName
		? `${quoteIdentifier(enumName)}${column.typeParameters?.array ? "[]" : ""}`
		: renderColumnType(column.type, column.typeParameters);
	const parts = [`  ${quoteIdentifier(column.name)} ${sqlType}`];
	if (column.identity) parts.push("GENERATED ALWAYS AS IDENTITY");
	const defaultExpression = renderDefaultExpression(column.default, column.type);
	if (defaultExpression !== null) parts.push(`DEFAULT ${defaultExpression}`);
	if (column.primaryKey || column.identity || !column.nullable) parts.push("NOT NULL");
	// A primary key is already unique, so it does not repeat the constraint.
	if (column.unique && !column.primaryKey) parts.push("UNIQUE");
	return parts.join(" ");
}

/**
 * Foreign keys are added after every table exists, so the order of table cards
 * never has to satisfy a dependency. NO ACTION keeps relationships from
 * changing or deleting referencing rows without the designer's intent.
 */
function renderRelationship(
	view: RelationshipView,
	foreignKeyConstraintName: string,
	uniqueConstraintName: string | null,
): string {
	const referencedColumn = view.referencedColumn;
	if (!referencedColumn) {
		throw new Error("A rendered relationship needs a referenced primary key.");
	}
	const statements = [
		[
			`ALTER TABLE ${quoteIdentifier(view.referencingTable.name)}`,
			`\n  ADD CONSTRAINT ${quoteIdentifier(foreignKeyConstraintName)}`,
			` FOREIGN KEY (${quoteIdentifier(view.referencingColumn.name)})`,
			` REFERENCES ${quoteIdentifier(view.referencedTable.name)}`,
			` (${quoteIdentifier(referencedColumn.name)})`,
			` ON UPDATE ${view.relationship.onUpdate ?? "NO ACTION"}`,
			` ON DELETE ${view.relationship.onDelete ?? "NO ACTION"};`,
		].join(""),
	];
	// A one-to-one association owns uniqueness on its referencing column. An
	// independent key or unique setting already supplies uniqueness, so the
	// relationship does not repeat it.
	if (view.ownsUniqueness) {
		if (!uniqueConstraintName) {
			throw new Error("A one-to-one relationship needs a unique constraint name.");
		}
		statements.push(
			[
				`ALTER TABLE ${quoteIdentifier(view.referencingTable.name)}`,
				`\n  ADD CONSTRAINT ${quoteIdentifier(uniqueConstraintName)}`,
				` UNIQUE (${quoteIdentifier(view.referencingColumn.name)});`,
			].join(""),
		);
	}
	return statements.join("\n");
}

/** Quotes an identifier so a name can never become an unintended SQL statement. */
export function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
