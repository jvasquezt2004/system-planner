/**
 * Domain vocabulary shared by the Bun main process and the React view.
 * See GLOSSARY.md: Project, Design, Sandbox, Table card, SQL preview.
 */

import type { ColumnDefault } from "./column-defaults";
import type { ColumnType } from "./column-types";

export type { ColumnType } from "./column-types";
export type { ColumnDefault } from "./column-defaults";

export type ProjectSummary = {
	id: string;
	name: string;
};

export type CanvasPoint = {
	x: number;
	y: number;
};

/** Screen-space pan and zoom of the infinite canvas. */
export type CanvasViewport = {
	x: number;
	y: number;
	zoom: number;
};

/** The view and the workspace both clamp zoom, so they share the limits. */
export const CANVAS_MIN_ZOOM = 0.3;
export const CANVAS_MAX_ZOOM = 2.5;

export type DesignColumn = {
	id: string;
	name: string;
	type: ColumnType;
	nullable: boolean;
	primaryKey: boolean;
	unique: boolean;
	identity: boolean;
	/** Structured default chosen from the options the column type supports. */
	default: ColumnDefault;
	/** Design-time intent for the column; never rendered as SQL. */
	notes: string;
};

export type DesignTable = {
	id: string;
	name: string;
	position: CanvasPoint;
	columns: DesignColumn[];
};

/**
 * How many referencing records may name the same referenced record. A
 * one-to-one association adds relationship-owned uniqueness on the referencing
 * column; neither cardinality requires the referenced side to participate.
 */
export type RelationshipCardinality = "one-to-many" | "one-to-one";

/**
 * An association backed by a real foreign key. The referencing side owns a
 * generated foreign-key column and, for a one-to-one association, the
 * uniqueness constraint on it; the referenced side is targeted through its
 * primary key. Relationship identity and participating columns are tracked by
 * id, so renames never disconnect them.
 */
export type DesignRelationship = {
	id: string;
	/** Defaults to one-to-many for documents saved before cardinality existed. */
	cardinality: RelationshipCardinality;
	referencingTableId: string;
	referencingColumnId: string;
	referencedTableId: string;
};

export type Design = {
	tables: DesignTable[];
	relationships: DesignRelationship[];
	viewport: CanvasViewport;
};

export type SaveState =
	| { status: "idle" }
	| { status: "saving"; revision: number }
	| { status: "saved"; revision: number; savedAt: number }
	| { status: "failed"; revision: number; error: string };

export type SqlState =
	| { status: "empty"; draftRevision: number; errors: string[] }
	| {
			status: "checking";
			draftRevision: number;
			availableRevision: number | null;
			sql: string | null;
	  }
	| { status: "current"; revision: number; sql: string }
	| {
			status: "stale";
			revision: number;
			draftRevision: number;
			sql: string;
			errors: string[];
	  };

/** Immutable SQL and status represented by the preview when an action starts. */
export type DisplayedSqlPreview = Readonly<{
	status: "current" | "checking" | "stale";
	revision: number;
	draftRevision: number;
	sql: string;
}>;

/** Result of copying the read-only SQL preview to the system clipboard. */
export type SqlPreviewCopyResult =
	| { status: "copied"; revision: number }
	| { status: "failed"; revision: number; error: string };

/** Result of exporting a read-only SQL preview to a new file. */
export type SqlPreviewExportResult =
	| { status: "saved"; revision: number; path: string }
	| { status: "cancelled"; revision: number }
	| { status: "failed"; revision: number; error: string };

/** Returns the SQL text currently visible, including an older stale snapshot. */
export function getDisplayedSqlPreview(sql: SqlState): DisplayedSqlPreview | null {
	switch (sql.status) {
		case "current":
			return {
				status: "current",
				revision: sql.revision,
				draftRevision: sql.revision,
				sql: sql.sql,
			};
		case "checking":
			return sql.sql === null || sql.availableRevision === null
				? null
				: {
						status: "checking",
						revision: sql.availableRevision,
						draftRevision: sql.draftRevision,
						sql: sql.sql,
					};
		case "stale":
			return {
				status: "stale",
				revision: sql.revision,
				draftRevision: sql.draftRevision,
				sql: sql.sql,
			};
		case "empty":
			return null;
	}
}

export type SandboxAppliedColumn = {
	name: string;
	dataType: string;
	isIdentity: boolean;
	/** PostgreSQL's own default expression, or null when the column has none. */
	defaultExpression: string | null;
	nullable: boolean;
	primaryKey: boolean;
	unique: boolean;
};

export type SandboxAppliedTable = {
	name: string;
	columns: SandboxAppliedColumn[];
};

/** A foreign key reported by the applied sandbox, not by the draft. */
export type SandboxAppliedRelationship = {
	name: string;
	referencingTable: string;
	referencingColumn: string;
	referencedTable: string;
	referencedColumn: string;
	updateRule: string;
	deleteRule: string;
};

/** One successful, disposable sandbox build for a specific design revision. */
export type SandboxSnapshot = {
	revision: number;
	tables: SandboxAppliedTable[];
	relationships: SandboxAppliedRelationship[];
	sql: string;
};

export type SandboxFailure = "sql-rejected" | "sandbox-error";

export type SandboxState =
	| { status: "idle" }
	| {
			status: "applying";
			revision: number;
			attemptedSql: string;
			lastApplied: SandboxSnapshot | null;
	  }
	| ({ status: "applied" } & SandboxSnapshot)
	| {
			status: "failed";
			failure: "sql-rejected";
			revision: number;
			attemptedSql: string;
			error: string;
			lastApplied: SandboxSnapshot | null;
	  }
	| {
			status: "failed";
			failure: "sandbox-error";
			revision: number;
			error: string;
			lastApplied: SandboxSnapshot | null;
	  };

export function getSqlValidationErrors(sql: SqlState): string[] {
	return sql.status === "empty" || sql.status === "stale" ? sql.errors : [];
}

export function getLastAppliedSandbox(
	sandbox: SandboxState,
): SandboxSnapshot | null {
	if (sandbox.status === "applied") return sandbox;
	if (sandbox.status === "idle") return null;
	return sandbox.lastApplied;
}

/**
 * Observable workspace state. `revision` identifies the current draft,
 * `sql.revision` identifies available SQL, and an applied sandbox's revision
 * or a non-null `sandbox.lastApplied.revision` identifies the last success.
 */
export type WorkspaceState = {
	projects: ProjectSummary[];
	project: ProjectSummary | null;
	design: Design | null;
	revision: number;
	save: SaveState;
	sql: SqlState;
	sandbox: SandboxState;
};

export type CreateProjectAction = { name: string };
export type OpenProjectAction = { projectId: string };
export type AddTableAction = { name: string; position?: CanvasPoint };
export type RenameTableAction = { tableId: string; name: string };
/** Removing a table that relationships depend on requires explicit confirmation. */
export type RemoveTableAction = { tableId: string; confirmed?: boolean };
export type MoveTableAction = { tableId: string; position: CanvasPoint };
export type SetViewportAction = CanvasViewport;

export type AddColumnAction = {
	tableId: string;
	name?: string;
	type?: ColumnType;
};

/** Editable column properties. Omitted properties stay as they are. */
export type ColumnChanges = Partial<
	Pick<
		DesignColumn,
		"name" | "type" | "nullable" | "primaryKey" | "unique" | "notes" | "identity" | "default"
	>
>;

export type UpdateColumnAction = {
	tableId: string;
	columnId: string;
	changes: ColumnChanges;
};

export type RemoveColumnAction = {
	tableId: string;
	columnId: string;
	confirmed?: boolean;
};

/**
 * Relates two tables: the referencing side receives the foreign key and, for a
 * one-to-one association, its uniqueness. An omitted cardinality means
 * one-to-many.
 */
export type AddRelationshipAction = {
	referencingTableId: string;
	referencedTableId: string;
	cardinality?: RelationshipCardinality;
};

/** An omitted property keeps its current value. */
export type UpdateRelationshipAction = {
	relationshipId: string;
	required?: boolean;
	cardinality?: RelationshipCardinality;
};

/** Constraints a relationship owns and a destructive edit would remove. */
export type RelationshipConstraint = "foreign-key" | "unique";

export type RemoveRelationshipAction = { relationshipId: string };

export type RemovalTarget =
	| { kind: "table"; tableId: string }
	| { kind: "column"; tableId: string; columnId: string };

/** A relationship a pending removal would also delete. */
export type AffectedRelationship = {
	relationshipId: string;
	cardinality: RelationshipCardinality;
	referencingTable: string;
	referencingColumn: string;
	referencedTable: string;
	referencedColumn: string | null;
	/** The relationship-owned constraints, never independent column settings. */
	constraints: RelationshipConstraint[];
};

/**
 * What a destructive edit would remove, so the designer can inspect it before
 * confirming. Cancelling leaves the design exactly as it was.
 */
export type RemovalPlan = {
	target: string;
	relationships: AffectedRelationship[];
};
