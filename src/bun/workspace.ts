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
	getLastAppliedSandbox,
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
	type RelationshipCreationCardinality,
	type UpdateColumnAction,
	type UpdateRelationshipAction,
	type WorkspaceState,
} from "../shared/design";
import { uniquePostgresIdentifier } from "../shared/postgres-identifiers";
import {
	foreignKeyColumnName,
	isRelationshipCardinality,
	manyToManyAssociationForRelationship,
	primaryKeyColumn,
	removalPlan,
	resolveRelationship,
} from "../shared/relationships";
import { createPGliteSandbox, type SchemaSandbox } from "./sandbox";
import { generateDesignSql, postgresSchemaRelationNames } from "./sql";
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
	undo(): Promise<WorkspaceState>;
	redo(): Promise<WorkspaceState>;
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

type DesignHistoryEntry = {
	before: Design;
	after: Design;
	structural: boolean;
};

type ProjectDesignHistory = {
	entries: DesignHistoryEntry[];
	cursor: number;
};

export async function createDesignWorkspace(
	options: DesignWorkspaceOptions,
): Promise<DesignWorkspace> {
	const store =
		options.openStore?.(options.databasePath) ?? openDesignStore(options.databasePath);
	const createSandbox = options.createSandbox ?? createPGliteSandbox;
	const now = options.now ?? (() => Date.now());
	const createId = options.createId ?? (() => crypto.randomUUID());

	const listeners = new Set<WorkspaceListener>();
	const histories = new Map<string, ProjectDesignHistory>();

	function getUndoRedoState(projectId: string | null): WorkspaceState["undoRedo"] {
		const history = projectId ? histories.get(projectId) : undefined;
		return {
			canUndo: history !== undefined && history.cursor > 0,
			canRedo: history !== undefined && history.cursor < history.entries.length,
		};
	}

	function recordDesignChange(
		projectId: string,
		before: Design,
		after: Design,
		structural: boolean,
	): WorkspaceState["undoRedo"] {
		let history = histories.get(projectId);
		if (!history) {
			history = { entries: [], cursor: 0 };
			histories.set(projectId, history);
		}
		history.entries.length = history.cursor;
		history.entries.push({ before, after, structural });
		history.cursor = history.entries.length;
		return getUndoRedoState(projectId);
	}
	let state: WorkspaceState = {
		projects: store.listProjects(),
		project: null,
		design: null,
		revision: 0,
		save: { status: "idle" },
		sql: { status: "empty", draftRevision: 0, errors: [] },
		sandbox: { status: "idle" },
		undoRedo: { canUndo: false, canRedo: false },
	};
	let activeProjectId: string | null = null;
	/** Orders every stored document, including layout-only writes. */
	let documentRevision = 0;
	let lastGeneratableSql: { revision: number; sql: string } | null = null;
	const inFlight = new Set<Promise<unknown>>();
	let previewRequestId = 0;
	let scheduledPreview: {
		requestId: number;
		cancel: () => void;
		resolve: () => void;
	} | null = null;

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

	function isCurrentSave(
		projectId: string,
		revision: number,
		documentRevisionToSave: number,
	) {
		return (
			activeProjectId === projectId &&
			state.revision === revision &&
			documentRevision === documentRevisionToSave
		);
	}
	function isCurrentPreview(projectId: string, revision: number, requestId: number) {
		return (
			previewRequestId === requestId &&
			activeProjectId === projectId &&
			state.revision === revision
		);
	}


	function cancelScheduledPreview() {
		if (!scheduledPreview) return;
		const pending = scheduledPreview;
		scheduledPreview = null;
		pending.cancel();
		pending.resolve();
	}

	function invalidatePreviewWork() {
		previewRequestId += 1;
		cancelScheduledPreview();
	}

	function schedulePreview(projectId: string, revision: number, design: Design) {
		cancelScheduledPreview();
		const requestId = ++previewRequestId;

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			if (scheduledPreview?.requestId === requestId) scheduledPreview = null;
			const task = runTask(() =>
				generateAndApply(projectId, revision, design, requestId),
			);
			void task.then(resolve, reject);
		}, 180);

		scheduledPreview = {
			requestId,
			cancel: () => clearTimeout(timer),
			resolve,
		};
		return promise;
	}

	async function generateAndApply(
		projectId: string,
		revision: number,
		design: Design,
		requestId: number,
	) {
		if (!isCurrentPreview(projectId, revision, requestId)) return;

		const generation = generateDesignSql(design);
		if (!generation.ok) {
			const available = lastGeneratableSql;
			const lastApplied = getLastAppliedSandbox(state.sandbox);
			setState({
				...state,
				sql:
					available === null
						? { status: "empty", draftRevision: revision, errors: generation.errors }
						: {
								status: "stale",
								revision: available.revision,
								draftRevision: revision,
								sql: available.sql,
								errors: generation.errors,
							},
				sandbox:
					lastApplied === null
						? { status: "idle" }
						: { status: "applied", ...lastApplied },
			});
			return;
		}

		lastGeneratableSql = { revision, sql: generation.sql };
		const lastApplied = getLastAppliedSandbox(state.sandbox);
		setState({
			...state,
			sql: { status: "current", revision, sql: generation.sql },
			sandbox: {
				status: "applying",
				revision,
				attemptedSql: generation.sql,
				lastApplied,
			},
		});

		let sandbox: SchemaSandbox | null = null;
		try {
			sandbox = createSandbox();
			const result = await sandbox.apply(generation.sql);
			if (!isCurrentPreview(projectId, revision, requestId)) return;
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
					: result.failure === "sql-rejected"
						? {
								status: "failed",
								failure: "sql-rejected",
								revision,
								attemptedSql: generation.sql,
								error: result.error,
								lastApplied,
							}
						: {
								status: "failed",
								failure: "sandbox-error",
								revision,
								error: result.error,
								lastApplied,
							},
			});
		} catch (error) {
			if (!isCurrentPreview(projectId, revision, requestId)) return;
			setState({
				...state,
				sandbox: {
					status: "failed",
					failure: "sandbox-error",
					revision,
					error: error instanceof Error ? error.message : String(error),
					lastApplied,
				},
			});
		} finally {
			if (sandbox) {
				try {
					await sandbox.dispose();
				} catch (error) {
					console.error("[sandbox] failed to dispose preview", error);
				}
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
			if (isCurrentSave(projectId, revision, documentRevisionToSave)) {
				setState({
					...state,
					projects: store.listProjects(),
					save: { status: "saved", revision, savedAt },
				});
			}
		} catch (error) {
			if (isCurrentSave(projectId, revision, documentRevisionToSave)) {
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
	/** Saves the draft immediately and debounces its disposable preview rebuild. */
	async function applyStructuralChange(
		projectId: string,
		design: Design,
		recordHistory = true,
	) {
		const before = state.design;
		if (!before) throw new Error("Open a project before editing its design.");
		const undoRedo = recordHistory
			? recordDesignChange(projectId, before, design, true)
			: getUndoRedoState(projectId);
		const revision = state.revision + 1;
		const nextDocumentRevision = documentRevision + 1;
		documentRevision = nextDocumentRevision;
		const lastApplied = getLastAppliedSandbox(state.sandbox);
		setState({
			...state,
			design,
			revision,
			undoRedo,
			save: { status: "saving", revision },
			sql: {
				status: "checking",
				draftRevision: revision,
				availableRevision: lastGeneratableSql?.revision ?? null,
				sql: lastGeneratableSql?.sql ?? null,
			},
			sandbox:
				lastApplied === null
					? { status: "idle" }
					: { status: "applied", ...lastApplied },
		});
		const preview = schedulePreview(projectId, revision, design);
		await saveDocument(projectId, revision, nextDocumentRevision, design);
		await preview;
		return state;
	}

	/**
	 * Applies a design edit that does not change the schema: card layout, canvas
	 * viewport, and column notes. The schema revision, SQL preview, and applied
	 * sandbox stay exactly as they were; only the stored document changes.
	 */
	async function applyNonSchemaChange(
		projectId: string,
		design: Design,
		recordHistory = true,
	) {
		const before = state.design;
		if (!before) throw new Error("Open a project before editing its design.");
		const undoRedo = recordHistory
			? recordDesignChange(projectId, before, design, false)
			: getUndoRedoState(projectId);
		const revision = state.revision;
		const nextDocumentRevision = documentRevision + 1;
		documentRevision = nextDocumentRevision;
		setState({
			...state,
			design,
			undoRedo,
			save: { status: "saving", revision },
		});
		await saveDocument(projectId, revision, nextDocumentRevision, design);
		return state;
	}

	async function applyHistoryChange(direction: "undo" | "redo") {
		const { projectId, design: currentDesign } = requireOpenDesign();
		const history = histories.get(projectId);
		if (!history) return state;

		const undoing = direction === "undo";
		const entry = history.entries[undoing ? history.cursor - 1 : history.cursor];
		if (!entry) return state;

		history.cursor += undoing ? -1 : 1;
		try {
			const snapshot = undoing ? entry.before : entry.after;
			const design = { ...snapshot, viewport: currentDesign.viewport };
			return entry.structural
				? await applyStructuralChange(projectId, design, false)
				: await applyNonSchemaChange(projectId, design, false);
		} catch (error) {
			history.cursor += undoing ? 1 : -1;
			if (activeProjectId === projectId) {
				setState({ ...state, undoRedo: getUndoRedoState(projectId) });
			}
			throw error;
		}
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
					manyToManyRelationships: [],
					viewport: { ...DEFAULT_VIEWPORT },
				};
				const revision = 1;
				const savedAt = now();

				await store.createProject(project, design, {
					revision,
					documentRevision: revision,
					savedAt,
				});
				invalidatePreviewWork();
				activeProjectId = project.id;
				documentRevision = revision;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project,
					design,
					revision,
					save: { status: "saved", revision, savedAt },
					sql: { status: "empty", draftRevision: revision, errors: [] },
					sandbox: { status: "idle" },
					undoRedo: getUndoRedoState(project.id),
				});
				return state;
			});
		},
		openProject(action) {
			return runTask(async () => {
				const record = store.loadProject(action.projectId);
				if (!record) throw new Error("That project could not be found.");
				const design = normalizeDesign(record.design);

				invalidatePreviewWork();
				activeProjectId = record.project.id;
				documentRevision = record.documentRevision;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project: record.project,
					design,
					revision: record.revision,
					save: { status: "saved", revision: record.revision, savedAt: record.savedAt },
					sql: {
						status: "empty",
						draftRevision: record.revision,
						errors: [],
					},
					sandbox: { status: "idle" },
					undoRedo: getUndoRedoState(record.project.id),
				});
				if (design.tables.length > 0) {
					const requestId = ++previewRequestId;
					await generateAndApply(record.project.id, record.revision, design, requestId);
				}
				return state;
			});
		},
		undo() {
			return runTask(() => applyHistoryChange("undo"));
		},
		redo() {
			return runTask(() => applyHistoryChange("redo"));
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
				if (
					isManyToManyReferenceColumn(design, table.id, column.id) &&
					(changes.nullable === true ||
						changes.primaryKey === true ||
						changes.unique === true ||
						changes.identity === true ||
						(changes.default !== undefined && changes.default.kind !== "none"))
				) {
					throw new Error(
						"Many-to-many junction references must remain required and cannot own individual defaults, keys, or uniqueness.",
					);
				}

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
				const creationCardinality = requireRelationshipCreationCardinality(
					action.cardinality,
				);

				if (creationCardinality === "many-to-many") {
					const leftKey = primaryKeyColumn(referencingTable);
					const rightKey = primaryKeyColumn(referencedTable);
					if (!leftKey) {
						throw new Error(
							`Table "${referencingTable.name}" needs exactly one primary key column before it can participate in a many-to-many relationship.`,
						);
					}
					if (!rightKey) {
						throw new Error(
							`Table "${referencedTable.name}" needs exactly one primary key column before it can participate in a many-to-many relationship.`,
						);
					}

					const junction = createDefaultTable(
						nextTableName(design, `${referencingTable.name}${referencedTable.name}`),
						action.junctionPosition !== undefined
							? requirePoint(action.junctionPosition, "Junction table position")
							: defaultTablePosition(design),
						createId,
					);
					const leftColumn = createRelationshipColumn(
						junction,
						referencingTable,
						leftKey,
						createId,
					);
					const withLeftColumn = {
						...junction,
						columns: [...junction.columns, leftColumn],
					};
					const rightColumn = createRelationshipColumn(
						withLeftColumn,
						referencedTable,
						rightKey,
						createId,
					);
					const junctionTable = {
						...withLeftColumn,
						columns: [...withLeftColumn.columns, rightColumn],
					};
					const leftRelationship: DesignRelationship = {
						id: createId(),
						cardinality: "one-to-many",
						referencingTableId: junction.id,
						referencingColumnId: leftColumn.id,
						referencedTableId: referencingTable.id,
					};
					const rightRelationship: DesignRelationship = {
						id: createId(),
						cardinality: "one-to-many",
						referencingTableId: junction.id,
						referencingColumnId: rightColumn.id,
						referencedTableId: referencedTable.id,
					};
					const association = {
						id: createId(),
						leftTableId: referencingTable.id,
						rightTableId: referencedTable.id,
						junctionTableId: junction.id,
						leftRelationshipId: leftRelationship.id,
						rightRelationshipId: rightRelationship.id,
					};
					const nextDesign: Design = {
						...design,
						tables: [...design.tables, junctionTable],
						relationships: [
							...design.relationships,
							leftRelationship,
							rightRelationship,
						],
						manyToManyRelationships: [
							...design.manyToManyRelationships,
							association,
						],
					};
					return applyStructuralChange(projectId, nextDesign);
				}

				const cardinality = requireCardinality(creationCardinality);
				const referencedColumn = primaryKeyColumn(referencedTable);
				if (!referencedColumn) {
					throw new Error(
						`Table "${referencedTable.name}" needs exactly one primary key column before another table can reference it.`,
					);
				}

				const column = createRelationshipColumn(
					referencingTable,
					referencedTable,
					referencedColumn,
					createId,
				);
				const relationship: DesignRelationship = {
					id: createId(),
					cardinality,
					referencingTableId: referencingTable.id,
					referencingColumnId: column.id,
					referencedTableId: referencedTable.id,
				};

				const nextDesign: Design = {
					...replaceTable(design, {
						...referencingTable,
						columns: [...referencingTable.columns, column],
					}),
					relationships: [...design.relationships, relationship],
				};
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		updateRelationship(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const relationship = requireRelationship(design, action.relationshipId);
				const required = action.required;
				if (required !== undefined && typeof required !== "boolean") {
					throw new Error("Relationship required must be true or false.");
				}
				const association = manyToManyAssociationForRelationship(
					design,
					relationship.id,
				);
				if (association && required === false) {
					throw new Error("Many-to-many junction references must remain required.");
				}
				if (
					association &&
					action.cardinality !== undefined &&
					action.cardinality !== "one-to-many"
				) {
					throw new Error("Many-to-many junction reference cardinality cannot be changed.");
				}
				const cardinality =
					action.cardinality === undefined
						? relationship.cardinality
						: requireCardinality(action.cardinality);
				if (required === undefined && cardinality === relationship.cardinality) {
					return state;
				}

				const view = resolveRelationship(design, relationship);
				if (!view) throw new Error("That relationship could not be found.");
				// Required and the foreign-key column's nullability are one setting.
				const nextRequired = required ?? view.required;
				const columns = view.referencingTable.columns.map((candidate) =>
					candidate.id === view.referencingColumn.id
						? { ...candidate, nullable: !nextRequired }
						: candidate,
				);
				const nextDesign: Design = {
					...replaceTable(design, { ...view.referencingTable, columns }),
					relationships: design.relationships.map((candidate) =>
						candidate.id === relationship.id
							? { ...candidate, cardinality }
							: candidate,
					),
				};

				if (
					cardinality === relationship.cardinality &&
					nextRequired === view.required
				) {
					return state;
				}
				return applyStructuralChange(projectId, nextDesign);
			});
		},
		removeRelationship(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const relationship = requireRelationship(design, action.relationshipId);
				const association = manyToManyAssociationForRelationship(
					design,
					relationship.id,
				);
				const relationshipIds = association
					? new Set([
							association.leftRelationshipId,
							association.rightRelationshipId,
						])
					: new Set([relationship.id]);

				// Remove relationship-owned constraints, never the junction or its columns.
				const nextDesign: Design = {
					...design,
					relationships: design.relationships.filter(
						(candidate) => !relationshipIds.has(candidate.id),
					),
					manyToManyRelationships: association
						? design.manyToManyRelationships.filter(
								(candidate) => candidate.id !== association.id,
							)
						: design.manyToManyRelationships,
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

				return applyNonSchemaChange(
					projectId,
					{ ...design, viewport },
					false,
				);
			});
		},
		async close() {
			invalidatePreviewWork();
			await settle();
			listeners.clear();
			store.close();
			histories.clear();
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
		relationships: (design.relationships ?? []).map((relationship) => ({
			...relationship,
			// Documents saved before one-to-one existed mean one-to-many.
			cardinality: isRelationshipCardinality(relationship.cardinality)
				? relationship.cardinality
				: "one-to-many",
		})),
		manyToManyRelationships: design.manyToManyRelationships ?? [],
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

function createRelationshipColumn(
	referencingTable: DesignTable,
	referencedTable: DesignTable,
	referencedColumn: DesignColumn,
	createId: () => string,
): DesignColumn {
	return {
		id: createId(),
		name: foreignKeyColumnName(referencingTable, referencedTable, referencedColumn),
		type: referencedColumn.type,
		nullable: false,
		primaryKey: false,
		unique: false,
		identity: false,
		default: noColumnDefault(),
		notes: "",
	};
}

function defaultTablePosition(design: Design): CanvasPoint {
	const index = design.tables.length;
	return {
		x: 40 + (index % 3) * 300,
		y: 40 + Math.floor(index / 3) * 240,
	};
}

function nextTableName(design: Design, base: string): string {
	const names = postgresSchemaRelationNames(design);
	return uniquePostgresIdentifier(base, names);
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

function isManyToManyReferenceColumn(
	design: Design,
	tableId: string,
	columnId: string,
): boolean {
	return design.relationships.some(
		(relationship) =>
			relationship.referencingTableId === tableId &&
			relationship.referencingColumnId === columnId &&
			manyToManyAssociationForRelationship(design, relationship.id) !== null,
	);
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
	if (affected.cardinality === "many-to-many") {
		return `many-to-many ${affected.referencingTable} ↔ ${affected.referencedTable} via ${affected.junctionTable ?? "(missing junction)"}`;
	}
	return `${affected.referencingTable}.${affected.referencingColumn} → ${affected.referencedTable}.${affected.referencedColumn ?? "(no primary key)"}`;
}

/** Removes the table together with the relationships that participate in it. */
function removeTableAndItsRelationships(design: Design, table: DesignTable): Design {
	const affected = affectedRelationshipIds(design, { kind: "table", tableId: table.id });
	return {
		...design,
		tables: design.tables.filter((candidate) => candidate.id !== table.id),
		relationships: design.relationships.filter(
			(relationship) => !affected.relationshipIds.has(relationship.id),
		),
		manyToManyRelationships: design.manyToManyRelationships.filter(
			(association) => !affected.associationIds.has(association.id),
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
			(relationship) => !affected.relationshipIds.has(relationship.id),
		),
		manyToManyRelationships: design.manyToManyRelationships.filter(
			(association) => !affected.associationIds.has(association.id),
		),
	};
}

/** The cascade set is exactly what the confirmation listed, never a second rule. */
function affectedRelationshipIds(
	design: Design,
	target: RemovalTarget,
): { relationshipIds: Set<string>; associationIds: Set<string> } {
	const relationshipIds = new Set<string>();
	const associationIds = new Set<string>();
	for (const affected of removalPlan(design, target).relationships) {
		if (affected.cardinality !== "many-to-many") {
			relationshipIds.add(affected.relationshipId);
			continue;
		}
		associationIds.add(affected.relationshipId);
		const association = design.manyToManyRelationships.find(
			(candidate) => candidate.id === affected.relationshipId,
		);
		if (association) {
			relationshipIds.add(association.leftRelationshipId);
			relationshipIds.add(association.rightRelationshipId);
		}
	}
	return { relationshipIds, associationIds };
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

/** An omitted cardinality means the ordinary required one-to-many reference. */
function requireCardinality(value: unknown) {
	if (value === undefined) return "one-to-many" as const;
	if (!isRelationshipCardinality(value)) {
		throw new Error("That relationship cardinality is not supported.");
	}
	return value;
}

function requireRelationshipCreationCardinality(
	value: unknown,
): RelationshipCreationCardinality {
	if (value === undefined) return "one-to-many";
	if (value === "many-to-many" || isRelationshipCardinality(value)) return value;
	throw new Error("That relationship cardinality is not supported.");
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
