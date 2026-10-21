import {
	columnDefaultProblem,
	renderDefaultExpression,
} from "../shared/column-defaults";
import { columnTypeInfo, isSupportedColumnType } from "../shared/column-types";
import type {
	Design,
	DesignColumn,
	DesignRelationship,
	DesignManyToManyAssociation,
	DesignTable,
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
		validateTable(table, tableNames, errors);
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
	const statements = [
		...design.tables.map(renderTable),
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
		errors.push(
			`${label} needs matching types; "${view.referencingColumn.name}" is ${view.referencingColumn.type} but "${view.referencedTable.name}"."${view.referencedColumn.name}" is ${view.referencedColumn.type}.`,
		);
		return null;
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
	return { namedRelationships, pairConstraintNames, relationNames };
}

/** Tables, PostgreSQL-generated identity sequences, and indexes. */
function initialPostgresRelationNames(design: Design): Set<string> {
	const names = new Set(
		design.tables.map((table) => truncatePostgresIdentifier(table.name)),
	);
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
	return `ALTER TABLE ${quoteIdentifier(junction.name)}\n  ADD CONSTRAINT ${quoteIdentifier(constraintName)} UNIQUE (${quoteIdentifier(leftColumn.name)}, ${quoteIdentifier(rightColumn.name)});`;
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

function renderTable(table: DesignTable): string {
	const primaryKey = table.columns.find((column) => column.primaryKey);
	const lines = table.columns.map(renderColumn);
	if (primaryKey) lines.push(`  PRIMARY KEY (${quoteIdentifier(primaryKey.name)})`);
	return `CREATE TABLE ${quoteIdentifier(table.name)} (\n${lines.join(",\n")}\n);`;
}

function renderColumn(column: DesignColumn): string {
	const parts = [`  ${quoteIdentifier(column.name)} ${column.type}`];
	if (column.identity) parts.push("GENERATED ALWAYS AS IDENTITY");
	const defaultExpression = renderDefaultExpression(column.default);
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
		`ALTER TABLE ${quoteIdentifier(view.referencingTable.name)}\n  ADD CONSTRAINT ${quoteIdentifier(foreignKeyConstraintName)} FOREIGN KEY (${quoteIdentifier(view.referencingColumn.name)}) REFERENCES ${quoteIdentifier(view.referencedTable.name)} (${quoteIdentifier(referencedColumn.name)}) ON UPDATE NO ACTION ON DELETE NO ACTION;`,
	];
	// A one-to-one association owns uniqueness on its referencing column. An
	// independent key or unique setting already supplies uniqueness, so the
	// relationship does not repeat it.
	if (view.ownsUniqueness) {
		if (!uniqueConstraintName) {
			throw new Error("A one-to-one relationship needs a unique constraint name.");
		}
		statements.push(
			`ALTER TABLE ${quoteIdentifier(view.referencingTable.name)}\n  ADD CONSTRAINT ${quoteIdentifier(uniqueConstraintName)} UNIQUE (${quoteIdentifier(view.referencingColumn.name)});`,
		);
	}
	return statements.join("\n");
}

/** Quotes an identifier so a name can never become an unintended SQL statement. */
export function quoteIdentifier(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}
