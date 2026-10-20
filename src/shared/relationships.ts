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
	RelationshipCardinality,
	RelationshipConstraint,
	RemovalPlan,
	RemovalTarget,
} from "./design";

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
 * (for example `author_id`) and never reuses an existing column name.
 */
export function foreignKeyColumnName(
	referencingTable: DesignTable,
	referencedTable: DesignTable,
	referencedColumn: DesignColumn,
): string {
	const owner = singularize(toSnakeCase(referencedTable.name)) || "referenced";
	const key = toSnakeCase(referencedColumn.name) || "id";
	const base = key === "id" ? `${owner}_id` : `${owner}_${key}`;
	const taken = new Set(referencingTable.columns.map((column) => column.name));
	if (!taken.has(base)) return base;
	let index = 2;
	while (taken.has(`${base}_${index}`)) index += 1;
	return `${base}_${index}`;
}

/** PostgreSQL names foreign keys by table and column; ours is explicit and stable. */
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
	return {
		target: removalTargetLabel(design, target),
		relationships: affectedRelationships(design, target),
	};
}

/** Lists the relationships a removal would delete alongside its target. */
function affectedRelationships(
	design: Design,
	target: RemovalTarget,
): AffectedRelationship[] {
	const affected: AffectedRelationship[] = [];
	for (const relationship of design.relationships) {
		const view = resolveRelationship(design, relationship);
		const ownsTarget =
			target.kind === "table"
				? relationship.referencingTableId === target.tableId ||
					relationship.referencedTableId === target.tableId
				: (relationship.referencingTableId === target.tableId &&
						relationship.referencingColumnId === target.columnId) ||
					(relationship.referencedTableId === target.tableId &&
						view?.referencedColumn?.id === target.columnId);
		if (!ownsTarget) continue;
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

function removalTargetLabel(design: Design, target: RemovalTarget): string {
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

/** Just enough English plural handling for table names such as Authors. */
function singularize(word: string): string {
	if (/ies$/.test(word)) return `${word.slice(0, -3)}y`;
	if (/(ss|x|ch|sh)$/.test(word)) return word;
	if (/s$/.test(word)) return word.slice(0, -1);
	return word;
}
