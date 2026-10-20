/**
 * Domain vocabulary shared by the Bun main process and the React view.
 * See GLOSSARY.md: Project, Design, Sandbox, Table card, SQL preview.
 */

export type ProjectSummary = {
	id: string;
	name: string;
};

export type ColumnType =
	| "bigint"
	| "integer"
	| "smallint"
	| "text"
	| "uuid"
	| "boolean"
	| "numeric"
	| "date"
	| "timestamptz"
	| "jsonb";

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

export type DesignColumn = {
	id: string;
	name: string;
	type: ColumnType;
	nullable: boolean;
	primaryKey: boolean;
	identity: boolean;
};

export type DesignTable = {
	id: string;
	name: string;
	position: CanvasPoint;
	columns: DesignColumn[];
};

export type Design = {
	tables: DesignTable[];
	viewport: CanvasViewport;
};

export type SaveState =
	| { status: "idle" }
	| { status: "saving"; revision: number }
	| { status: "saved"; revision: number; savedAt: number }
	| { status: "failed"; revision: number; error: string };

export type SqlState =
	| { status: "empty"; errors: string[] }
	| { status: "current"; revision: number; sql: string }
	| { status: "stale"; revision: number; sql: string; errors: string[] };

export type SandboxAppliedColumn = {
	name: string;
	dataType: string;
	isIdentity: boolean;
	nullable: boolean;
};

export type SandboxAppliedTable = {
	name: string;
	columns: SandboxAppliedColumn[];
};

export type SandboxState =
	| { status: "idle" }
	| { status: "applying"; revision: number }
	| {
			status: "applied";
			revision: number;
			tables: SandboxAppliedTable[];
			sql: string;
	  }
	| {
			status: "failed";
			revision: number;
			attemptedSql: string;
			error: string;
	  };

/**
 * Observable state of the design workspace. It distinguishes the current
 * project/design revision, save outcome, SQL availability, and sandbox outcome
 * so that unfinished, stale, failed, and applied states never blur together.
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
export type RemoveTableAction = { tableId: string };
export type MoveTableAction = { tableId: string; position: CanvasPoint };
export type SetViewportAction = CanvasViewport;
