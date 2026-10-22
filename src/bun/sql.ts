import {
	columnDefaultProblem,
	renderDefaultExpression,
} from "../shared/column-defaults";
import { columnTypeInfo, isSupportedColumnType } from "../shared/column-types";
import { renderColumnType } from "../shared/column-types";
import type {
	Design,
	DesignColumn,
	DesignRelationship,
	DesignManyToManyAssociation,
	DesignIndex,
	DesignTable,
	DesignUniqueConstraint,
} from "../shared/design";
import {
	relationshipConstraintName,
	relationshipUniqueConstraintName,
	resolveRelationship,
	resolveRelationships,
	type RelationshipView,
} from "../shared/relationships";
import {
	postgresGeneratedObjectName,
	truncatePostgresIdentifier,
	uniquePostgresIdentifier,
} from "../shared/postgres-identifiers";
import { findIndexMethod, indexOperatorClasses } from "../shared/index-methods";

export type SqlGeneration =
	| { ok: true; sql: string }
	| { ok: false; errors: string[] };

type PairConstraint = {
	junction: DesignTable;
	leftColumn: DesignColumn;
	rightColumn: DesignColumn;
};

/** Names of the tables, identity sequences, and indexes in PostgreSQL's schema namespace. */
export function postgresSchemaRelationNames(design: Design): Set<string> {
	const relationships = resolveRelationships(design);
	const junctions = (design.manyToManyRelationships ?? []).flatMap((association) => {
		const junction = design.tables.find((table) => table.id === association.junctionTableId);
		return junction ? [junction] : [];
	});
	return planPostgresIdentifiers(design, relationships, junctions).relationNames;
}

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
		validateTable(table, tableNames, errors, design.enumTypes ?? []);
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
		const view = validateRelationship(design, relationship, errors);
		if (view) relationships.push(view);
	}

	const pairConstraints: PairConstraint[] = [];
	for (const association of design.manyToManyRelationships ?? []) {
		const constraint = validateManyToManyAssociation(design, association, errors);
		if (constraint) pairConstraints.push(constraint);
	}

	if (errors.length > 0) return { ok: false, errors };

	const namePlan = planPostgresIdentifiers(
		design,
		relationships,
		pairConstraints.map(({ junction }) => junction),
	);
	const pairConstraintSql = pairConstraints.map(
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
	const statements = [
		...(vectorUsed ? ["CREATE EXTENSION IF NOT EXISTS vector;"] : []),
		...(design.enumTypes ?? []).map((enumType) =>
			`CREATE TYPE ${quoteIdentifier(enumType.name)} AS ENUM (${enumType.labels.map(quoteString).join(", ")});`,
		),
		...design.tables.map((table) =>
			renderTable(
				table,
				design,
				namePlan.uniqueConstraints.filter((entry) => entry.table.id === table.id),
			),
		),
		...namePlan.indexes.map(({ table, index, name }) => renderIndex(table, index, name)),
		...namePlan.namedRelationships.map(
			({ view, foreignKeyConstraintName, uniqueConstraintName }) =>
				renderRelationship(view, foreignKeyConstraintName, uniqueConstraintName),
		),
		...pairConstraintSql,
	];
	return { ok: true, sql: `${statements.join("\n\n")}\n` };
}

function validateRelationship(
	design: Design,
	relationship: DesignRelationship,
	errors: string[],
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
	if (view.referencedColumn.type !== view.referencingColumn.type) {
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
		if (action === "SET NULL" && !view.referencingColumn.nullable) {
			errors.push(
				`${label} uses ON ${kind.toUpperCase()} SET NULL but its foreign-key column is required.`,
			);
		}
		if (action === "SET DEFAULT" && view.referencingColumn.default.kind === "none") {
			errors.push(
				`${label} uses ON ${kind.toUpperCase()} SET DEFAULT but its foreign-key column has no default.`,
			);
		}
	}
	return view;
}

function validateManyToManyAssociation(
	design: Design,
	association: DesignManyToManyAssociation,
	errors: string[],
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
		errors.push("A many-to-many relationship refers to a missing junction or reference.");
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
		errors.push(
			`Many-to-many junction "${junction.name}" needs two distinct references to its endpoint tables.`,
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
		errors.push(
			`Many-to-many junction "${junction.name}" needs required references without individual defaults or uniqueness.`,
		);
		return null;
	}

	return { junction, leftColumn, rightColumn };
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
		if (constraint.columnIds.length < 2) {
			errors.push(
				`Composite unique constraint on "${table.name}" needs at least two columns.`,
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
) {
	const name = table.name.trim();
	const label = name.length > 0 ? `"${name}"` : "(unnamed table)";

	if (name.length === 0) errors.push("Every table needs a name.");
	else if (tableNames.has(name)) errors.push(`Table name ${label} is used more than once.`);
	tableNames.add(name);

	if (table.columns.length === 0) errors.push(`Table ${label} needs at least one column.`);

	const columnNames = new Set<string>();
	let primaryKeys = 0;
	for (const column of table.columns) {
		validateColumn(table, column, columnNames, errors, enumTypes);
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
	enumTypes: NonNullable<Design["enumTypes"]>,
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

	// A nullable primary key or identity column is contradictory; keep the
	// draft saved but block SQL until the designer resolves it.
	if (column.primaryKey && column.nullable) {
		errors.push(
			`Primary key column ${label} in table ${tableLabel} must be required; turn off Nullable.`,
		);
	}
	if (column.identity && column.nullable) {
		errors.push(
			`Identity column ${label} in table ${tableLabel} must be required; turn off Nullable.`,
		);
	}
}

function renderTable(
	table: DesignTable,
	design: Design,
	uniqueConstraints: { constraint: DesignUniqueConstraint; name: string }[],
): string {
	const primaryKey = table.columns.find((column) => column.primaryKey);
	const lines = table.columns.map((column) => renderColumn(column, design));
	if (primaryKey) lines.push(`  PRIMARY KEY (${quoteIdentifier(primaryKey.name)})`);
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
