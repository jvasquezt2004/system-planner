/**
 * Shared relationship vocabulary: resolving which columns a relationship
 * participates in, naming its generated foreign-key column, and describing
 * what a destructive edit would remove. SQL generation, workspace actions, and
 * the view all read relationships through this module.
 */

import type {
	AffectedRelationship,
	Design,
	DesignColumn,
	DesignRelationship,
	DesignTable,
	DesignManyToManyAssociation,
	RelationshipCardinality,
	RelationshipConstraint,
	RemovalPlan,
	RemovalTarget,
} from "./design";
import {
	truncatePostgresIdentifier,
	uniquePostgresIdentifier,
} from "./postgres-identifiers";

/** A relationship resolved against the current design. */
export type RelationshipView = {
	relationship: DesignRelationship;
	referencingTable: DesignTable;
	referencingColumn: DesignColumn;
	referencedTable: DesignTable;
	/** The referenced table's primary key, or null when it has no single key. */
	referencedColumn: DesignColumn | null;
	/**
	 * A reference is required unless its own foreign-key column accepts NULL.
	 * The column's nullability is the single source of truth, so the column
	 * editor and the relationship control can never disagree.
	 */
	required: boolean;
	/** At most one referencing record may name each referenced record. */
	oneToOne: boolean;
	/**
	 * True when this relationship contributes the uniqueness constraint itself,
	 * rather than relying on an independently configured key or unique column.
	 * Removal drops only what this flag describes.
	 */
	ownsUniqueness: boolean;
	manyToManyAssociation: DesignManyToManyAssociation | null;
};

export function isRelationshipCardinality(
	value: unknown,
): value is RelationshipCardinality {
	return value === "one-to-many" || value === "one-to-one";
}

/** Returns the table's primary key only when exactly one column claims it. */
export function primaryKeyColumn(table: DesignTable): DesignColumn | null {
	const keys = table.columns.filter((column) => column.primaryKey);
	return keys.length === 1 ? keys[0] : null;
}

/** Finds the many-to-many association that owns a relationship, if any. */
export function manyToManyAssociationForRelationship(
	design: Design,
	relationshipId: string,
): DesignManyToManyAssociation | null {
	return (
		design.manyToManyRelationships.find(
			(association) =>
				association.leftRelationshipId === relationshipId ||
				association.rightRelationshipId === relationshipId,
		) ?? null
	);
}

/** Returns null when the relationship points at something the design no longer has. */
export function resolveRelationship(
	design: Design,
	relationship: DesignRelationship,
): RelationshipView | null {
	const referencingTable = design.tables.find(
		(table) => table.id === relationship.referencingTableId,
	);
	if (!referencingTable) return null;
	const referencingColumn = referencingTable.columns.find(
		(column) => column.id === relationship.referencingColumnId,
	);
	if (!referencingColumn) return null;
	const referencedTable = design.tables.find(
		(table) => table.id === relationship.referencedTableId,
	);
	if (!referencedTable) return null;
	const referencedColumn = primaryKeyColumn(referencedTable);
	const manyToManyAssociation = manyToManyAssociationForRelationship(
		design,
		relationship.id,
	);
	return {
		relationship,
		referencingTable,
		referencingColumn,
		referencedTable,
		referencedColumn,
		required: !referencingColumn.nullable,
		oneToOne: relationship.cardinality === "one-to-one",
		ownsUniqueness:
			relationship.cardinality === "one-to-one" &&
			!referencingColumn.unique &&
			!referencingColumn.primaryKey,
		manyToManyAssociation,
	};
}

export function resolveRelationships(design: Design): RelationshipView[] {
	const views: RelationshipView[] = [];
	for (const relationship of design.relationships) {
		const view = resolveRelationship(design, relationship);
		if (view) views.push(view);
	}
	return views;
}

export function relationshipsForTable(
	design: Design,
	tableId: string,
): RelationshipView[] {
	return resolveRelationships(design).filter(
		(view) =>
			view.referencingTable.id === tableId || view.referencedTable.id === tableId,
	);
}

/**
 * The generated foreign-key column is named after the referenced table and key
 * (for example `author_id`) and never reuses an existing PostgreSQL column name.
 */
export function foreignKeyColumnName(
	referencingTable: DesignTable,
	referencedTable: DesignTable,
	referencedColumn: DesignColumn,
): string {
	const owner = singularize(toSnakeCase(referencedTable.name)) || "referenced";
	const key = toSnakeCase(referencedColumn.name) || "id";
	const base = key === "id" ? `${owner}_id` : `${owner}_${key}`;
	const taken = new Set(
		referencingTable.columns.map((column) =>
			truncatePostgresIdentifier(column.name),
		),
	);
	return uniquePostgresIdentifier(base, taken);
}

/** Preferred foreign-key name; SQL generation bounds and deconflicts it. */
export function relationshipConstraintName(view: RelationshipView): string {
	return `${view.referencingTable.name}_${view.referencingColumn.name}_fkey`;
}

/** The relationship-owned uniqueness constraint, removed with the relationship. */
export function relationshipUniqueConstraintName(view: RelationshipView): string {
	return `${view.referencingTable.name}_${view.referencingColumn.name}_key`;
}

/** Reports the constraints a removal of this relationship would drop. */
export function relationshipConstraints(
	view: RelationshipView,
): RelationshipConstraint[] {
	return view.ownsUniqueness ? ["foreign-key", "unique"] : ["foreign-key"];
}

/** Lists the relationships a removal would delete alongside its target. */
export function removalPlan(design: Design, target: RemovalTarget): RemovalPlan {
	if (target.kind === "function") {
		const triggers = (design.triggers ?? []).flatMap((trigger) => {
			const table = design.tables.find((candidate) => candidate.id === trigger.tableId);
			return trigger.functionId === target.functionId
				? [{ triggerId: trigger.id, name: trigger.name, table: table?.name ?? "(missing table)" }]
				: [];
		});
		return { target: removalTargetLabel(design, target), relationships: [], indexes: [], uniqueConstraints: [], triggers };
	}
	const affectedIndexes = design.tables.flatMap((table) =>
		(table.indexes ?? []).flatMap((index) => {
			const inTargetTable = table.id === target.tableId;
			const removedKeys = index.keys.filter((key) =>
				inTargetTable && (target.kind === "table" || key.columnId === target.columnId),
			).length;
			const removedIncludes = (index.includeColumnIds ?? []).filter((id) =>
				inTargetTable && (target.kind === "table" || id === target.columnId),
			).length;
			return removedKeys + removedIncludes > 0
				? [{
					table: table.name,
					indexId: index.id,
					name: index.name?.trim() || `${table.name} index`,
					removedKeys,
					removedIncludes,
				}]
				: [];
		}),
	);
	const affectedUniqueConstraints = design.tables.flatMap((table) =>
		(table.uniqueConstraints ?? []).flatMap((constraint) => {
			const affected = table.id === target.tableId &&
				(target.kind === "table" || constraint.columnIds.includes(target.columnId));
			return affected
				? [{
					table: table.name,
					constraintId: constraint.id,
					name: constraint.name?.trim() || `${table.name} unique constraint`,
				}]
				: [];
		}),
	);
	const affectedTriggers = (design.triggers ?? []).flatMap((trigger) => {
		const table = design.tables.find((candidate) => candidate.id === trigger.tableId);
		const affected = trigger.tableId === target.tableId ||
			(target.kind === "column" && trigger.events.some((event) => event.columnIds?.includes(target.columnId)));
		return affected ? [{ triggerId: trigger.id, name: trigger.name, table: table?.name ?? "(missing table)" }] : [];
	});
	return {
		target: removalTargetLabel(design, target),
		relationships: affectedRelationships(design, target),
		indexes: affectedIndexes,
		uniqueConstraints: affectedUniqueConstraints,
		triggers: affectedTriggers,
	};
}

/** Lists the relationships a removal would delete alongside its target. */
function affectedRelationships(
	design: Design,
	target: RemovalTarget,
): AffectedRelationship[] {
	if (target.kind === "function") return [];
	const affected: AffectedRelationship[] = [];
	const associationRelationshipIds = new Set(
		design.manyToManyRelationships.flatMap((association) => [
			association.leftRelationshipId,
			association.rightRelationshipId,
		]),
	);

	for (const association of design.manyToManyRelationships) {
		const leftRelationship = design.relationships.find(
			(relationship) => relationship.id === association.leftRelationshipId,
		);
		const rightRelationship = design.relationships.find(
			(relationship) => relationship.id === association.rightRelationshipId,
		);
		if (
			![leftRelationship, rightRelationship].some(
				(relationship) =>
					relationship !== undefined &&
					relationshipTouchesTarget(design, relationship, target),
			)
		) {
			continue;
		}

		const leftTable = design.tables.find((table) => table.id === association.leftTableId);
		const rightTable = design.tables.find((table) => table.id === association.rightTableId);
		const leftView = leftRelationship
			? resolveRelationship(design, leftRelationship)
			: null;
		const rightView = rightRelationship
			? resolveRelationship(design, rightRelationship)
			: null;
		affected.push({
			relationshipId: association.id,
			cardinality: "many-to-many",
			referencingTable: leftTable?.name ?? "(missing table)",
			referencingColumn: leftView?.referencedColumn?.name ?? "(no primary key)",
			referencedTable: rightTable?.name ?? "(missing table)",
			referencedColumn: rightView?.referencedColumn?.name ?? null,
			junctionTable:
				design.tables.find((table) => table.id === association.junctionTableId)?.name ??
				"(missing table)",
			constraints: ["foreign-key", "foreign-key", "pair-unique"],
		});
	}

	for (const relationship of design.relationships) {
		if (associationRelationshipIds.has(relationship.id)) continue;
		if (!relationshipTouchesTarget(design, relationship, target)) continue;
		const view = resolveRelationship(design, relationship);
		affected.push({
			relationshipId: relationship.id,
			cardinality: relationship.cardinality,
			referencingTable: view?.referencingTable.name ?? "(missing table)",
			referencingColumn: view?.referencingColumn.name ?? "(missing column)",
			referencedTable: view?.referencedTable.name ?? "(missing table)",
			referencedColumn: view?.referencedColumn?.name ?? null,
			constraints: view ? relationshipConstraints(view) : ["foreign-key"],
		});
	}
	return affected;
}

function relationshipTouchesTarget(
	design: Design,
	relationship: DesignRelationship,
	target: RemovalTarget,
): boolean {
	if (target.kind === "function") return false;
	if (target.kind === "table") {
		return (
			relationship.referencingTableId === target.tableId ||
			relationship.referencedTableId === target.tableId
		);
	}
	const view = resolveRelationship(design, relationship);
	return (
		(relationship.referencingTableId === target.tableId &&
			relationship.referencingColumnId === target.columnId) ||
		(relationship.referencedTableId === target.tableId &&
			view?.referencedColumn?.id === target.columnId)
	);
}

function removalTargetLabel(design: Design, target: RemovalTarget): string {
	if (target.kind === "function") return design.functions?.find((fn) => fn.id === target.functionId)?.name ?? "(missing function)";
	const table = design.tables.find((candidate) => candidate.id === target.tableId);
	const tableName = table?.name ?? "(missing table)";
	if (target.kind === "table") return tableName;
	const column = table?.columns.find((candidate) => candidate.id === target.columnId);
	return column ? `${tableName}.${column.name}` : tableName;
}

function toSnakeCase(value: string): string {
	return value
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

/**
 * Just enough English plural handling for table names such as Authors. Words
 * that already end in -us or -is (Campus, Status, Analysis) are left whole.
 */
function singularize(word: string): string {
	if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
	if (/(ss|us|is|x|ch|sh)$/.test(word)) return word;
	if (/s$/.test(word)) return word.slice(0, -1);
	return word;
}
