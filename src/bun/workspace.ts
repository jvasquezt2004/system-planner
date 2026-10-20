import {
	isColumnDefault,
	noColumnDefault,
	normalizeColumnDefault,
	sameColumnDefault,
} from "../shared/column-defaults";
import { columnTypeInfo, isSupportedColumnType } from "../shared/column-types";
import {
	CANVAS_MAX_ZOOM,
	CANVAS_MIN_ZOOM,
	type AddColumnAction,
	type AddRelationshipAction,
	type AddTableAction,
	type AffectedRelationship,
	CanvasPoint,
	CanvasViewport,
	type ColumnChanges,
	CreateProjectAction,
	Design,
	type DesignColumn,
	type DesignRelationship,
	DesignTable,
	MoveTableAction,
	OpenProjectAction,
	ProjectSummary,
	type RemovalPlan,
	type RemovalTarget,
	RemoveColumnAction,
	RemoveRelationshipAction,
	type RemoveTableAction,
	RenameTableAction,
	type SetViewportAction,
	type UpdateColumnAction,
	type UpdateRelationshipAction,
	type WorkspaceState,
} from "../shared/design";
import {
	foreignKeyColumnName,
	primaryKeyColumn,
	removalPlan,
	resolveRelationship,
} from "../shared/relationships";
import { createPGliteSandbox, type SchemaSandbox } from "./sandbox";
import { generateDesignSql } from "./sql";
import { openDesignStore, type DesignStore } from "./store";

export type DesignWorkspaceOptions = {
	databasePath: string;
	/** Narrowly controlled test overrides for storage timing and failures. */
	openStore?: (databasePath: string) => DesignStore;
	/** Narrowly controlled test override for sandbox I/O failures. */
	createSandbox?: () => SchemaSandbox;
	now?: () => number;
	createId?: () => string;
};

export type WorkspaceListener = (state: WorkspaceState) => void;

/**
 * The public design workspace interface. The React view and behavioral tests
 * use these actions and observable state instead of reaching into storage, SQL
 * generation, or sandbox orchestration.
 *
 * Structural actions (adding, renaming, removing tables; adding, editing, and
 * removing columns) advance the schema revision and refresh the SQL preview and
 * sandbox. Layout actions (moving a table card, panning or zooming the canvas)
 * and column-note edits only save the design document.
 */
export interface DesignWorkspace {
	getState(): WorkspaceState;
	subscribe(listener: WorkspaceListener): () => void;
	listProjects(): ProjectSummary[];
	createProject(action: CreateProjectAction): Promise<WorkspaceState>;
	openProject(action: OpenProjectAction): Promise<WorkspaceState>;
	addTable(action: AddTableAction): Promise<WorkspaceState>;
	renameTable(action: RenameTableAction): Promise<WorkspaceState>;
	removeTable(action: RemoveTableAction): Promise<WorkspaceState>;
	moveTable(action: MoveTableAction): Promise<WorkspaceState>;
	addColumn(action: AddColumnAction): Promise<WorkspaceState>;
	updateColumn(action: UpdateColumnAction): Promise<WorkspaceState>;
	removeColumn(action: RemoveColumnAction): Promise<WorkspaceState>;
	/** Creates the relationship and the foreign-key column it owns. */
	addRelationship(action: AddRelationshipAction): Promise<WorkspaceState>;
	updateRelationship(action: UpdateRelationshipAction): Promise<WorkspaceState>;
	/** Removes the relationship-owned constraint while keeping its columns. */
	removeRelationship(action: RemoveRelationshipAction): Promise<WorkspaceState>;
	/** Lists what a removal would also delete, before anything is removed. */
	describeRemoval(target: RemovalTarget): RemovalPlan;
	setViewport(action: SetViewportAction): Promise<WorkspaceState>;
	close(): Promise<void>;
}

const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export async function createDesignWorkspace(
	options: DesignWorkspaceOptions,
): Promise<DesignWorkspace> {
	const store =
		options.openStore?.(options.databasePath) ?? openDesignStore(options.databasePath);
	const createSandbox = options.createSandbox ?? createPGliteSandbox;
	const now = options.now ?? (() => Date.now());
	const createId = options.createId ?? (() => crypto.randomUUID());

	const listeners = new Set<WorkspaceListener>();
	let state: WorkspaceState = {
		projects: store.listProjects(),
		project: null,
		design: null,
		revision: 0,
		save: { status: "idle" },
		sql: { status: "empty", errors: [] },
		sandbox: { status: "idle" },
	};
	let activeProjectId: string | null = null;
	/** Orders every stored document, including layout-only writes. */
	let documentRevision = 0;
	let lastGeneratableSql: { revision: number; sql: string } | null = null;
	const inFlight = new Set<Promise<unknown>>();

	function setState(next: WorkspaceState) {
		state = next;
		for (const listener of listeners) listener(state);
	}

	/**
	 * Tracks work so close() can wait for saves that were still writing. The
	 * call itself is not queued: each edit applies to the draft immediately and
	 * its save completes independently.
	 */
	function runTask<T>(task: () => Promise<T>): Promise<T> {
		const promise = task();
		inFlight.add(promise);
		const done = () => inFlight.delete(promise);
		promise.then(done, done);
		return promise;
	}

	async function settle() {
		while (inFlight.size > 0) {
			await Promise.allSettled([...inFlight]);
		}
	}

	function isCurrent(projectId: string, revision: number) {
		return activeProjectId === projectId && state.revision === revision;
	}

	async function generateAndApply(projectId: string, revision: number, design: Design) {
		if (!isCurrent(projectId, revision)) return;

		const generation = generateDesignSql(design);
		if (!generation.ok) {
			setState({
				...state,
				sql:
					lastGeneratableSql === null
						? { status: "empty", errors: generation.errors }
						: {
								status: "stale",
								revision,
								sql: lastGeneratableSql.sql,
								errors: generation.errors,
							},
			});
			return;
		}

		lastGeneratableSql = { revision, sql: generation.sql };
		setState({
			...state,
			sql: { status: "current", revision, sql: generation.sql },
			sandbox: { status: "applying", revision },
		});

		const sandbox = createSandbox();
		try {
			const result = await sandbox.apply(generation.sql);
			if (!isCurrent(projectId, revision)) return;
			setState({
				...state,
				sandbox: result.ok
					? {
							status: "applied",
							revision,
							tables: result.tables,
							relationships: result.relationships,
							sql: generation.sql,
						}
					: {
							status: "failed",
							revision,
							attemptedSql: generation.sql,
							error: result.error,
						},
			});
		} catch (error) {
			if (!isCurrent(projectId, revision)) return;
			setState({
				...state,
				sandbox: {
					status: "failed",
					revision,
					attemptedSql: generation.sql,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		} finally {
			try {
				await sandbox.dispose();
			} catch (error) {
				console.error("[sandbox] failed to dispose preview", error);
			}
		}
	}

	async function saveDocument(
		projectId: string,
		revision: number,
		documentRevisionToSave: number,
		design: Design,
	) {
		const savedAt = now();
		try {
			await store.saveDesign(projectId, design, {
				revision,
				documentRevision: documentRevisionToSave,
				savedAt,
			});
			if (isCurrent(projectId, revision)) {
				setState({
					...state,
					projects: store.listProjects(),
					save: { status: "saved", revision, savedAt },
				});
			}
		} catch (error) {
			if (isCurrent(projectId, revision)) {
				setState({
					...state,
					save: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
					},
				});
			}
		}
	}

	/** Applies a schema edit: bump the revision, save, then refresh SQL and sandbox. */
	async function applyStructuralChange(projectId: string, design: Design) {
		const revision = state.revision + 1;
		const nextDocumentRevision = documentRevision + 1;
		documentRevision = nextDocumentRevision;
		setState({
			...state,
			design,
			revision,
			save: { status: "saving", revision },
		});
		await saveDocument(projectId, revision, nextDocumentRevision, design);
		await generateAndApply(projectId, revision, design);
		return state;
	}

	/**
	 * Applies a design edit that does not change the schema: card layout, canvas
	 * viewport, and column notes. The schema revision, SQL preview, and applied
	 * sandbox stay exactly as they were; only the stored document changes.
	 */
	async function applyNonSchemaChange(projectId: string, design: Design) {
		const revision = state.revision;
		const nextDocumentRevision = documentRevision + 1;
		documentRevision = nextDocumentRevision;
		setState({
			...state,
			design,
			save: { status: "saving", revision },
		});
		await saveDocument(projectId, revision, nextDocumentRevision, design);
		return state;
	}

	function requireOpenDesign(): { projectId: string; design: Design } {
		if (!state.project || !state.design || activeProjectId === null) {
			throw new Error("Open a project before editing its design.");
		}
		return { projectId: activeProjectId, design: state.design };
	}

	const workspace: DesignWorkspace = {
		getState() {
			return state;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listProjects() {
			return store.listProjects();
		},
		createProject(action) {
			return runTask(async () => {
				const name = action.name.trim();
				if (name.length === 0) throw new Error("Project name is required.");

				const project: ProjectSummary = { id: createId(), name };
				const design: Design = {
					tables: [],
					relationships: [],
					viewport: { ...DEFAULT_VIEWPORT },
				};
				const revision = 1;
				const savedAt = now();

				await store.createProject(project, design, {
					revision,
					documentRevision: revision,
					savedAt,
				});
				activeProjectId = project.id;
				documentRevision = revision;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project,
					design,
					revision,
					save: { status: "saved", revision, savedAt },
					sql: { status: "empty", errors: [] },
					sandbox: { status: "idle" },
				});
				await generateAndApply(project.id, revision, design);
				return state;
			});
		},
		openProject(action) {
			return runTask(async () => {
				const record = store.loadProject(action.projectId);
				if (!record) throw new Error("That project could not be found.");
				const design = normalizeDesign(record.design);

				activeProjectId = record.project.id;
				documentRevision = record.documentRevision;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project: record.project,
					design,
					revision: record.revision,
					save: { status: "saved", revision: record.revision, savedAt: record.savedAt },
					sql: { status: "empty", errors: [] },
					sandbox: { status: "idle" },
				});
				await generateAndApply(record.project.id, record.revision, design);
				return state;
			});
		},
		addTable(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const name = action.name.trim();
				if (name.length === 0) throw new Error("Table name is required.");
				const position = action.position
					? requirePoint(action.position, "Table position")
					: defaultTablePosition(design);

				const table = createDefaultTable(name, position, createId);
				const nextDesign: Design = {
					...design,
					tables: [...design.tables, table],
				};
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		renameTable(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const name = action.name.trim();
				if (name.length === 0) throw new Error("Table name is required.");
				const table = requireTable(design, action.tableId);
				if (table.name === name) return state;

				const nextDesign: Design = {
					...design,
					tables: design.tables.map((candidate) =>
						candidate.id === table.id ? { ...candidate, name } : candidate,
					),
				};
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		removeTable(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const target: RemovalTarget = { kind: "table", tableId: table.id };
				requireConfirmedRemoval(design, target, action.confirmed);

				return applyStructuralChange(
					projectId,
					removeTableAndItsRelationships(design, table),
				);
			});
		},
		moveTable(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const position = requirePoint(action.position, "Table position");
				if (samePoint(table.position, position)) return state;

				const nextDesign: Design = {
					...design,
					tables: design.tables.map((candidate) =>
						candidate.id === table.id ? { ...candidate, position } : candidate,
					),
				};
				return applyNonSchemaChange(projectId, nextDesign);
			});
		},
		addColumn(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const name =
					action.name === undefined
						? nextColumnName(table)
						: requireName(action.name, "Column name");
				const type = action.type === undefined ? "text" : requireColumnType(action.type);
				const column: DesignColumn = {
					id: createId(),
					name,
					type,
					nullable: true,
					primaryKey: false,
					unique: false,
					identity: false,
					default: noColumnDefault(),
					notes: "",
				};
				const nextDesign = replaceTable(design, {
					...table,
					columns: [...table.columns, column],
				});
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		updateColumn(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const column = requireColumn(table, action.columnId);
				const changes = normalizeColumnChanges(action.changes);

				let updated: DesignColumn = { ...column, ...changes };
				// Identity generation only exists for integer types, so changing the
				// type to another family drops it in the same visible edit.
				if (
					changes.type !== undefined &&
					changes.type !== column.type &&
					column.identity &&
					!columnTypeInfo(changes.type).identity
				) {
					updated = { ...updated, identity: false };
				}

				const columns = table.columns.map((candidate) => {
					if (candidate.id === column.id) return updated;
					// A table has a single-column key, so choosing a new key column
					// demotes the previous one in the same edit.
					if (updated.primaryKey && candidate.primaryKey) {
						return { ...candidate, primaryKey: false };
					}
					return candidate;
				});

				if (
					columns.length === table.columns.length &&
					columns.every((candidate, index) =>
						sameColumn(candidate, table.columns[index]),
					)
				) {
					return state;
				}

				const nextDesign = replaceTable(design, { ...table, columns });
				const schemaChanged = Object.keys(changes).some((key) => key !== "notes");
				return schemaChanged
					? applyStructuralChange(projectId, nextDesign)
					: applyNonSchemaChange(projectId, nextDesign);
			});
		},
		removeColumn(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const column = requireColumn(table, action.columnId);
				const target: RemovalTarget = {
					kind: "column",
					tableId: table.id,
					columnId: column.id,
				};
				requireConfirmedRemoval(design, target, action.confirmed);

				const nextDesign = removeColumnAndItsRelationships(design, table, column);
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		addRelationship(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const referencingTable = requireTable(design, action.referencingTableId);
				const referencedTable = requireTable(design, action.referencedTableId);
				const referencedColumn = primaryKeyColumn(referencedTable);
				if (!referencedColumn) {
					throw new Error(
						`Table "${referencedTable.name}" needs exactly one primary key column before another table can reference it.`,
					);
				}

				const column: DesignColumn = {
					id: createId(),
					name: foreignKeyColumnName(referencingTable, referencedTable, referencedColumn),
					// Only the key's type transfers; identity and defaults stay behind.
					type: referencedColumn.type,
					nullable: false,
					primaryKey: false,
					unique: false,
					identity: false,
					default: noColumnDefault(),
					notes: "",
				};
				const relationship: DesignRelationship = {
					id: createId(),
					referencingTableId: referencingTable.id,
					referencingColumnId: column.id,
					referencedTableId: referencedTable.id,
				};

				const nextDesign: Design = {
					...design,
					tables: design.tables.map((candidate) =>
						candidate.id === referencingTable.id
							? { ...candidate, columns: [...candidate.columns, column] }
							: candidate,
					),
					relationships: [...design.relationships, relationship],
				};
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		updateRelationship(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const relationship = requireRelationship(design, action.relationshipId);
				if (action.required === undefined) return state;
				if (typeof action.required !== "boolean") {
					throw new Error("Relationship required must be true or false.");
				}

				const view = resolveRelationship(design, relationship);
				if (!view) throw new Error("That relationship could not be found.");
				if (view.required === action.required) return state;

				// Required and the foreign-key column's nullability are one setting.
				const columns = view.referencingTable.columns.map((candidate) =>
					candidate.id === view.referencingColumn.id
						? { ...candidate, nullable: !action.required }
						: candidate,
				);
				const nextDesign = replaceTable(design, {
					...view.referencingTable,
					columns,
				});
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		removeRelationship(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const relationship = requireRelationship(design, action.relationshipId);

				// Only the constraint goes; the columns it participated in stay.
				const nextDesign: Design = {
					...design,
					relationships: design.relationships.filter(
						(candidate) => candidate.id !== relationship.id,
					),
				};
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		describeRemoval(target) {
			const { design } = requireOpenDesign();
			requireRemovalTarget(design, target);
			return removalPlan(design, target);
		},
		setViewport(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const viewport: CanvasViewport = {
					x: requireNumber(action.x, "Canvas position"),
					y: requireNumber(action.y, "Canvas position"),
					zoom: clamp(
						requireNumber(action.zoom, "Canvas zoom"),
						CANVAS_MIN_ZOOM,
						CANVAS_MAX_ZOOM,
					),
				};
				if (sameViewport(design.viewport, viewport)) return state;

				return applyNonSchemaChange(projectId, { ...design, viewport });
			});
		},
		async close() {
			await settle();
			listeners.clear();
			store.close();
		},
	};

	const mostRecent = state.projects[0];
	if (mostRecent) {
		await workspace.openProject({ projectId: mostRecent.id });
	}

	return workspace;
}

/** Documents saved before the canvas existed have no viewport yet. */
function normalizeDesign(design: Design): Design {
	return {
		tables: design.tables.map((table) => ({
			...table,
			columns: table.columns.map((column) => ({
				...column,
				unique: column.unique ?? false,
				default: isColumnDefault(column.default)
					? normalizeColumnDefault(column.default)
					: noColumnDefault(),
				notes: column.notes ?? "",
			})),
		})),
		// Documents saved before relationships existed have none yet.
		relationships: (design.relationships ?? []).map((relationship) => ({ ...relationship })),
		viewport: design.viewport ?? { ...DEFAULT_VIEWPORT },
	};
}

function createDefaultTable(
	name: string,
	position: CanvasPoint,
	createId: () => string,
): DesignTable {
	return {
		id: createId(),
		name,
		position,
		columns: [
			{
				id: createId(),
				name: "id",
				type: "bigint",
				nullable: false,
				primaryKey: true,
				unique: false,
				identity: true,
				default: noColumnDefault(),
				notes: "",
			},
		],
	};
}

function defaultTablePosition(design: Design): CanvasPoint {
	const index = design.tables.length;
	return {
		x: 40 + (index % 3) * 300,
		y: 40 + Math.floor(index / 3) * 240,
	};
}

function requireTable(design: Design, tableId: string): DesignTable {
	const table = design.tables.find((candidate) => candidate.id === tableId);
	if (!table) throw new Error("That table could not be found.");
	return table;
}

function requireColumn(table: DesignTable, columnId: string): DesignColumn {
	const column = table.columns.find((candidate) => candidate.id === columnId);
	if (!column) throw new Error("That column could not be found.");
	return column;
}

function requireRelationship(design: Design, relationshipId: string): DesignRelationship {
	const relationship = design.relationships.find(
		(candidate) => candidate.id === relationshipId,
	);
	if (!relationship) throw new Error("That relationship could not be found.");
	return relationship;
}

function requireRemovalTarget(design: Design, target: RemovalTarget) {
	const table = requireTable(design, target.tableId);
	if (target.kind === "column") requireColumn(table, target.columnId);
}

/** A destructive edit that affects relationships needs explicit confirmation. */
function requireConfirmedRemoval(
	design: Design,
	target: RemovalTarget,
	confirmed: boolean | undefined,
) {
	if (confirmed) return;
	const plan = removalPlan(design, target);
	if (plan.relationships.length === 0) return;
	const label = target.kind === "table" ? `table "${plan.target}"` : `column "${plan.target}"`;
	const count = plan.relationships.length;
	const summary = plan.relationships.map(describeAffectedRelationship).join(", ");
	throw new Error(
		`Removing ${label} also removes ${count} ${count === 1 ? "relationship" : "relationships"} (${summary}). Confirm the removal to continue.`,
	);
}

function describeAffectedRelationship(affected: AffectedRelationship): string {
	return `${affected.referencingTable}.${affected.referencingColumn} → ${affected.referencedTable}.${affected.referencedColumn ?? "(no primary key)"}`;
}

/** Removes the table together with the relationships that participate in it. */
function removeTableAndItsRelationships(design: Design, table: DesignTable): Design {
	const affected = affectedRelationshipIds(design, { kind: "table", tableId: table.id });
	return {
		...design,
		tables: design.tables.filter((candidate) => candidate.id !== table.id),
		relationships: design.relationships.filter(
			(relationship) => !affected.has(relationship.id),
		),
	};
}

/** Removes the column together with the relationships that participate in it. */
function removeColumnAndItsRelationships(
	design: Design,
	table: DesignTable,
	column: DesignColumn,
): Design {
	const affected = affectedRelationshipIds(design, {
		kind: "column",
		tableId: table.id,
		columnId: column.id,
	});
	return {
		...design,
		tables: design.tables.map((candidate) =>
			candidate.id === table.id
				? {
						...candidate,
						columns: candidate.columns.filter(
							(columnCandidate) => columnCandidate.id !== column.id,
						),
					}
				: candidate,
		),
		relationships: design.relationships.filter(
			(relationship) => !affected.has(relationship.id),
		),
	};
}

/** The cascade set is exactly what the confirmation listed, never a second rule. */
function affectedRelationshipIds(design: Design, target: RemovalTarget): Set<string> {
	return new Set(
		removalPlan(design, target).relationships.map(
			(relationship) => relationship.relationshipId,
		),
	);
}

function replaceTable(design: Design, table: DesignTable): Design {
	return {
		...design,
		tables: design.tables.map((candidate) =>
			candidate.id === table.id ? table : candidate,
		),
	};
}

function nextColumnName(table: DesignTable): string {
	const names = new Set(table.columns.map((column) => column.name));
	if (!names.has("column")) return "column";
	let index = 2;
	while (names.has(`column_${index}`)) index += 1;
	return `column_${index}`;
}

function requireName(value: string, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} must be text.`);
	const name = value.trim();
	if (name.length === 0) throw new Error(`${label} is required.`);
	return name;
}

function requireColumnType(value: unknown) {
	if (!isSupportedColumnType(value)) throw new Error("That column type is not supported.");
	return value;
}

function normalizeColumnChanges(changes: ColumnChanges): ColumnChanges {
	if (!changes || typeof changes !== "object") {
		throw new Error("Column changes are required.");
	}
	const normalized: ColumnChanges = {};
	if (changes.name !== undefined) normalized.name = requireName(changes.name, "Column name");
	if (changes.type !== undefined) normalized.type = requireColumnType(changes.type);
	for (const key of ["nullable", "primaryKey", "unique"] as const) {
		const value = changes[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			throw new Error(`Column ${key} must be true or false.`);
		}
		normalized[key] = value;
	}
	if (changes.notes !== undefined) {
		if (typeof changes.notes !== "string") throw new Error("Column notes must be text.");
		normalized.notes = changes.notes.trim();
	}
	if (changes.identity !== undefined) {
		if (typeof changes.identity !== "boolean") {
			throw new Error("Column identity must be true or false.");
		}
		normalized.identity = changes.identity;
	}
	if (changes.default !== undefined) {
		if (!isColumnDefault(changes.default)) {
			throw new Error("That column default is not supported.");
		}
		normalized.default = normalizeColumnDefault(changes.default);
	}
	return normalized;
}

function sameColumn(a: DesignColumn, b: DesignColumn): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.type === b.type &&
		a.nullable === b.nullable &&
		a.primaryKey === b.primaryKey &&
		a.unique === b.unique &&
		a.identity === b.identity &&
		sameColumnDefault(a.default, b.default) &&
		a.notes === b.notes
	);
}

function requirePoint(point: CanvasPoint, label: string): CanvasPoint {
	return {
		x: round(requireNumber(point.x, label)),
		y: round(requireNumber(point.y, label)),
	};
}

function requireNumber(value: number, label: string): number {
	if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
	return value;
}

function round(value: number): number {
	return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function samePoint(a: CanvasPoint, b: CanvasPoint): boolean {
	return a.x === b.x && a.y === b.y;
}

function sameViewport(a: CanvasViewport, b: CanvasViewport): boolean {
	return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}
