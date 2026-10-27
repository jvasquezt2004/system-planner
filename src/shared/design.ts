import type { SystemDesign, SystemViewName } from "./system-design";
/**
 * Domain vocabulary shared by the Bun main process and the React view.
 * See GLOSSARY.md: Project, Design, Sandbox, Table card, SQL preview.
 */

import type { ColumnDefault } from "./column-defaults";
import type { ColumnType, ColumnTypeParameters } from "./column-types";

export type { ColumnType, ColumnTypeParameters } from "./column-types";
export type { ColumnDefault } from "./column-defaults";

export type ProjectSummary = {
	id: string;
	name: string;
};

/** Summary of an authoritative database design belonging to a project. */
export type DatabaseDesignSummary = {
	id: string;
	projectId: string;
	name: string;
};

/** Stored record of an authoritative database design. */
export type DatabaseDesignRecord = {
	id: string;
	projectId: string;
	name: string;
	design: Design;
	revision: number;
	documentRevision: number;
	savedAt: number;
};
/** Saved TypeScript source managed independently from the design history. */
export type Scenario = { id: string; name: string; source: string; designId?: string };

/** Saved TypeScript server handler managed independently from design history. */
export type EdgeFunction = { id: string; name: string; source: string; designId?: string };

export type EdgeFunctionSaveState = ScenarioSaveState;
export type CreateEdgeFunctionAction = { name: string; designId: string; assistantTurnId?: string };
export type RenameEdgeFunctionAction = { edgeFunctionId: string; name: string; designId: string; assistantTurnId?: string };
export type RemoveEdgeFunctionAction = { edgeFunctionId: string; designId: string; assistantTurnId?: string };
export type UpdateEdgeFunctionSourceAction = { edgeFunctionId: string; source: string; designId: string; assistantTurnId?: string };

export type ScenarioExpectationResult = {
	description: string;
	passed: boolean;
	message: string;
};
export type ScenarioRunStatus = "running" | "passed" | "failed" | "errored";
export type ScenarioResultGrid = {
	table: string;
	columns: string[];
	rows: Record<string, unknown>[];
	total: number;
};
export type ScenarioRun = {
	id: string;
	designId?: string;
	scenarioId?: string;
	status: ScenarioRunStatus;
	revision: number;
	scenarioRevision: number;
	edgeFunctionRevision: number;
	stale: boolean;
	requests: ScenarioRequestLogEntry[];
	console: string[];
	grids: ScenarioResultGrid[];
	expectations: ScenarioExpectationResult[];
	reason?: "exception" | "stopped" | "timed out";
};

export type ScenarioIdentity = { role: "anon" | "authenticated" | "service_role"; userId?: string; claims: Record<string, unknown> };
export type ScenarioRequestLogEntry = {
	order: number;
	method: string;
	table: string;
	filters: Record<string, string>;
	identity: ScenarioIdentity;
	status: number;
	result: unknown;
	invocation?: { functionName: string; status: number; response: unknown };
	invocationRef?: string;
};
export type SandboxApiRequest = {
	method: string;
	path: string;
	query: string;
	headers: Record<string, string>;
	body: string | null;
	invocationRef?: string;
	invocation?: { functionName: string; status: number; response: unknown };
};
export type SandboxApiResponse = { status: number; headers: Record<string, string>; body: unknown };
export type ScenarioSaveState =
	| { status: "idle" }
	| { status: "saving"; revision: number; designId?: string }
	| { status: "saved"; revision: number; savedAt: number; designId?: string }
	| { status: "failed"; revision: number; error: string; designId?: string };

export type CreateScenarioAction = { name: string; designId: string; assistantTurnId?: string };
export type RenameScenarioAction = { scenarioId: string; name: string; designId: string; assistantTurnId?: string };
export type RemoveScenarioAction = { scenarioId: string; designId: string; assistantTurnId?: string };
export type UpdateScenarioSourceAction = { scenarioId: string; source: string; designId: string; assistantTurnId?: string };


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
	/** Structured PostgreSQL type modifiers; absent values preserve older documents. */
	typeParameters?: ColumnTypeParameters;
	enumTypeId?: string;
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
	indexes?: DesignIndex[];
	uniqueConstraints?: DesignUniqueConstraint[];
	rowLevelSecurity?: boolean;
	policies?: DesignPolicy[];
};
export type DesignPolicy = {
	id: string;
	name: string;
	command: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";
	roles: string[];
	mode: "permissive" | "restrictive";
	using: string;
	withCheck: string;
};
/** A composite uniqueness rule declared independently of a relationship. */
export type DesignUniqueConstraint = {
	id: string;
	name?: string;
	columnIds: string[];
	nullsNotDistinct?: boolean;
};
/** A named PostgreSQL enum and its ordered labels. */
export type DesignEnumType = { id: string; name: string; labels: string[] };
export type DesignFunctionArgument = { name: string; type: string };
export type DesignFunction = {
	id: string;
	name: string;
	arguments: DesignFunctionArgument[];
	returnType: string;
	returnsSet: boolean;
	language: "sql" | "plpgsql";
	volatility: "volatile" | "stable" | "immutable";
	security: "invoker" | "definer";
	body: string;
	/** Referenced project tables, tracked so removing one rejects the draft. */
	tableDependencies?: string[];
};
export type DesignTriggerEvent = { event: "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE"; columnIds?: string[] };
export type DesignTrigger = {
	id: string;
	name: string;
	tableId: string;
	timing: "BEFORE" | "AFTER" | "INSTEAD OF";
	events: DesignTriggerEvent[];
	level: "ROW" | "STATEMENT";
	functionId: string;
	when: string;
};



/** PostgreSQL access method used by an index. */
export type IndexAccessMethod = "btree" | "hash" | "gin" | "gist" | "spgist" | "brin" | "hnsw" | "ivfflat";
/** One ordered index key, addressed by stable column id. */
export type DesignIndexKey = { columnId: string; order?: "asc" | "desc"; nulls?: "first" | "last"; operatorClass?: string };
/** A structured PostgreSQL index with optional explicit name and storage options. */
export type DesignIndex = {
	id: string;
	name?: string;
	method: IndexAccessMethod;
	keys: DesignIndexKey[];
	unique?: boolean;
	nullsNotDistinct?: boolean;
	includeColumnIds?: string[];
	with?: { fillfactor?: number; fastupdate?: boolean; pagesPerRange?: number; lists?: number; m?: number; efConstruction?: number };
};

/**
 * How many referencing records may name the same referenced record. A
 * one-to-one association adds relationship-owned uniqueness on the referencing
 * column; neither cardinality requires the referenced side to participate.
 */
export type RelationshipCardinality = "one-to-many" | "one-to-one";
export type ReferentialAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";
/** Cardinality choices available when the designer starts a relationship. */
export type RelationshipCreationCardinality =
	| RelationshipCardinality
	| "many-to-many";

export type AffectedRelationshipCardinality =
	| RelationshipCardinality
	| "many-to-many";

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
	onDelete?: ReferentialAction;
	onUpdate?: ReferentialAction;
};

/** One visible junction table groups its two required endpoint references. */
export type DesignManyToManyAssociation = {
	id: string;
	leftTableId: string;
	rightTableId: string;
	junctionTableId: string;
	leftRelationshipId: string;
	rightRelationshipId: string;
};

export type Design = {
	tables: DesignTable[];
	relationships: DesignRelationship[];
	manyToManyRelationships: DesignManyToManyAssociation[];
	viewport: CanvasViewport;
	enumTypes?: DesignEnumType[];
	functions?: DesignFunction[];
	triggers?: DesignTrigger[];
};
export type UpdateFunctionsAction = { functions: DesignFunction[]; designId: string };
export type UpdateTriggersAction = { triggers: DesignTrigger[]; designId: string };
export type RemoveFunctionAction = { functionId: string; confirmed?: boolean; designId: string };

export type SaveState =
	| { status: "idle" }
	| { status: "saving"; revision: number; designId?: string }
	| { status: "saved"; revision: number; savedAt: number; designId?: string }
	| { status: "failed"; revision: number; error: string; designId?: string };

export type SqlState =
	| { status: "empty"; draftRevision: number; errors: string[]; designId?: string }
	| {
			status: "checking";
			draftRevision: number;
			availableRevision: number | null;
			sql: string | null;
			designId?: string;
	  }
	| { status: "current"; revision: number; sql: string; designId?: string }
	| {
			status: "stale";
			revision: number;
			draftRevision: number;
			sql: string;
			errors: string[];
			designId?: string;
	  };

/** Immutable SQL and status represented by the preview when an action starts. */
export type DisplayedSqlPreview = Readonly<{
	status: "current" | "checking" | "stale";
	revision: number;
	draftRevision: number;
	sql: string;
	/** The Design whose generated SQL this preview shows. */
	designId?: string;
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
				designId: sql.designId,
			};
		case "checking":
			return sql.sql === null || sql.availableRevision === null
				? null
				: {
						status: "checking",
						revision: sql.availableRevision,
						draftRevision: sql.draftRevision,
						sql: sql.sql,
						designId: sql.designId,
					};
		case "stale":
			return {
				status: "stale",
				revision: sql.revision,
				draftRevision: sql.draftRevision,
				sql: sql.sql,
				designId: sql.designId,
			};
		case "empty":
			return null;
	}
}

export type SandboxAppliedColumn = {
	name: string;
	dataType: string;
	/** The applied enum type, when this is a user-defined enum column. */
	enumTypeName?: string;
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
	indexes?: SandboxAppliedIndex[];
};

export type SandboxAppliedIndex = { name: string; method: string; unique: boolean; definition: string };

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
	designId?: string;
	revision: number;
	tables: SandboxAppliedTable[];
	relationships: SandboxAppliedRelationship[];
	sql: string;
	enumTypes?: DesignEnumType[];
	functions?: DesignFunction[];
};

export type SandboxFailure = "sql-rejected" | "sandbox-error";

export type SandboxState =
	| { status: "idle" }
	| {
			status: "applying";
			revision: number;
			attemptedSql: string;
			lastApplied: SandboxSnapshot | null;
			designId?: string;
	  }
	| ({ status: "applied" } & SandboxSnapshot)
	| {
			status: "failed";
			failure: "sql-rejected";
			revision: number;
			attemptedSql: string;
			error: string;
			lastApplied: SandboxSnapshot | null;
			designId?: string;
	  }
	| {
			status: "failed";
			failure: "sandbox-error";
			revision: number;
			error: string;
			lastApplied: SandboxSnapshot | null;
			designId?: string;
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
	/** Stable identity of the active database design when a project is open. */
	activeDesignId?: string | null;
	/** Every database design of the open Project, in creation order. */
	designs: DatabaseDesignSummary[];
	revision: number;
	save: SaveState;
	sql: SqlState;
	sandbox: SandboxState;
	scenarios: Scenario[];
	edgeFunctions: EdgeFunction[];
	edgeFunctionSave: EdgeFunctionSaveState;
	scenarioSave: ScenarioSaveState;
	scenarioRuns: Record<string, ScenarioRun | null>;
	/** In-memory undo/redo availability for the open Project's session history. */
	undoRedo: { canUndo: boolean; canRedo: boolean };
	/** Name of the action Undo will reverse, when one exists. */
	undoActionName?: string;
	/** Name of the action Redo will reapply, when one exists. */
	redoActionName?: string;
	/** The Project's System design; null until a Project is open. */
	systemDesign?: SystemDesign | null;
	/** Save status of the System design document, kept apart from the database Design. */
	systemSave?: SaveState;
	/** The view opened for this Project: the system overview or the database workspace. */
	activeView?: SystemViewName;
};

/** How the displayed SQL relates to sandbox validation for the current draft. */
export type SqlPreviewValidationStatus =
	| { status: "accepted"; tone: "success"; revision: number }
	| {
			status: "out-of-date";
			tone: "info";
			sqlRevision: number;
			draftRevision: number;
	  }
	| {
			status: "not-yet-validated";
			tone: "info";
			sqlRevision: number;
			draftRevision: number;
			reason: "checking" | "rebuilding" | "not-started";
	  }
	| {
			status: "sandbox-error";
			tone: "error";
			revision: number;
			error: string;
	  }
	| {
			status: "rejected";
			tone: "error";
			revision: number;
			error: string;
	  };

/** Derives validation feedback for the exact SQL preview visible in the workspace. */
export function getSqlPreviewValidationStatus(
	state: WorkspaceState,
): SqlPreviewValidationStatus | null {
	const preview = getDisplayedSqlPreview(state.sql);
	if (!preview) return null;

	if (state.sql.status === "stale") {
		return {
			status: "out-of-date",
			tone: "info",
			sqlRevision: preview.revision,
			draftRevision: state.revision,
		};
	}

	if (state.sql.status === "checking") {
		return {
			status: "not-yet-validated",
			tone: "info",
			sqlRevision: preview.revision,
			draftRevision: state.revision,
			reason: "checking",
		};
	}

	const { sandbox } = state;
	if (sandbox.status === "failed" && sandbox.revision === preview.revision) {
		return sandbox.failure === "sql-rejected"
			? {
					status: "rejected",
					tone: "error",
					revision: preview.revision,
					error: sandbox.error,
				}
			: {
					status: "sandbox-error",
					tone: "error",
					revision: preview.revision,
					error: sandbox.error,
				};
	}

	if (sandbox.status === "applying" && sandbox.revision === preview.revision) {
		return {
			status: "not-yet-validated",
			tone: "info",
			sqlRevision: preview.revision,
			draftRevision: state.revision,
			reason: "rebuilding",
		};
	}

	if (
		sandbox.status === "applied" &&
		sandbox.revision === preview.revision &&
		state.revision === preview.revision
	) {
		return {
			status: "accepted",
			tone: "success",
			revision: preview.revision,
		};
	}

	return {
		status: "not-yet-validated",
		tone: "info",
		sqlRevision: preview.revision,
		draftRevision: state.revision,
		reason: "not-started",
	};
}

export type CreateProjectAction = { name: string };
export type OpenProjectAction = { projectId: string };
/** Creates a database design in the open Project and opens it. */
export type CreateDesignAction = { name: string };
/** Makes another database design of the open Project the active one. */
export type OpenDesignAction = { designId: string };
export type RenameDesignAction = { designId: string; name: string };
export type AddTableAction = { name: string; position?: CanvasPoint; designId: string };
export type UpdateIndexesAction = { tableId: string; indexes: DesignIndex[]; designId: string };
export type UpdateUniqueConstraintsAction = { tableId: string; uniqueConstraints: DesignUniqueConstraint[]; designId: string };
export type UpdatePoliciesAction = {
	tableId: string;
	rowLevelSecurity: boolean;
	policies: DesignPolicy[];
	designId: string;
};
export type UpdateEnumTypesAction = { enumTypes: DesignEnumType[]; designId: string };
export type RenameTableAction = { tableId: string; name: string; designId: string };
/** Removing a table that relationships depend on requires explicit confirmation. */
export type RemoveTableAction = { tableId: string; confirmed?: boolean; designId: string };
export type MoveTableAction = { tableId: string; position: CanvasPoint; designId: string };
export type SetViewportAction = CanvasViewport & { designId: string };

export type AddColumnAction = {
	tableId: string;
	name?: string;
	type?: ColumnType;
	designId: string;
};

/** Editable column properties. Omitted properties stay as they are. */
export type ColumnChanges = Partial<
	Pick<
		DesignColumn,
		"name" | "type" | "typeParameters" | "enumTypeId" | "nullable" | "primaryKey" | "unique" | "notes" | "identity" | "default"
	>
>;

export type UpdateColumnAction = {
	tableId: string;
	columnId: string;
	changes: ColumnChanges;
	designId: string;
};

export type RemoveColumnAction = {
	tableId: string;
	columnId: string;
	confirmed?: boolean;
	designId: string;
};

/**
 * Relates two tables: the referencing side receives the foreign key and, for a
 * one-to-one association, its uniqueness. An omitted cardinality means
 * one-to-many.
 */
export type AddRelationshipAction = {
	referencingTableId: string;
	referencedTableId: string;
	cardinality?: RelationshipCreationCardinality;
	/** Canvas placement for the visible junction created by many-to-many. */
	junctionPosition?: CanvasPoint;
	designId: string;
};
/** An omitted property keeps its current value. */
export type UpdateRelationshipAction = {
	relationshipId: string;
	required?: boolean;
	cardinality?: RelationshipCardinality;
	onDelete?: ReferentialAction;
	onUpdate?: ReferentialAction;
	designId: string;
};

/** Constraints a relationship owns and a destructive edit would remove. */
export type RelationshipConstraint = "foreign-key" | "unique" | "pair-unique";

export type RemoveRelationshipAction = { relationshipId: string; designId: string };


export type RemovalTarget = (
	| { kind: "table"; tableId: string }
	| { kind: "column"; tableId: string; columnId: string }
	| { kind: "function"; functionId: string }
) & { designId: string };

/** A relationship or association a pending removal would also delete. */
export type AffectedRelationship = {
	relationshipId: string;
	cardinality: AffectedRelationshipCardinality;
	referencingTable: string;
	referencingColumn: string;
	referencedTable: string;
	referencedColumn: string | null;
	/** Present for a many-to-many association. */
	junctionTable?: string;
	/** The relationship-owned constraints, never independent column settings. */
	constraints: RelationshipConstraint[];
};
export type AffectedTrigger = { triggerId: string; name: string; table: string };


/**
 * What a destructive edit would remove, so the designer can inspect it before
 * confirming. Cancelling leaves the design exactly as it was.
 */
export type RemovalPlan = {
	target: string;
	relationships: AffectedRelationship[];
	indexes: AffectedIndex[];
	uniqueConstraints: AffectedUniqueConstraint[];
	triggers: AffectedTrigger[];
};

/** An index key or INCLUDE entry removed with the referenced column. */
export type AffectedIndex = {
	table: string;
	indexId: string;
	name: string;
	removedKeys: number;
	removedIncludes: number;
};

/** A composite unique constraint that references a removed column. */
export type AffectedUniqueConstraint = { table: string; constraintId: string; name: string };
