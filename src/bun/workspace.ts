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
	type DesignIndex,
	type DesignIndexKey,
	type DesignEnumType,
	type DesignUniqueConstraint,
	type ReferentialAction,
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
	type UpdateIndexesAction,
	type UpdateEnumTypesAction,
	type UpdateUniqueConstraintsAction,
	type UpdateRelationshipAction,
	type CreateScenarioAction,
	type RenameScenarioAction,
	type RemoveScenarioAction,
	type UpdateScenarioSourceAction,
	type Scenario,
	type ScenarioRun,
	type SandboxAppliedTable,
	type SandboxApiRequest,
	type SandboxApiResponse,
	type WorkspaceState,
} from "../shared/design";
import type { ScenarioRunDatabase } from "./scenario-api";
import { captureScenarioResultGrids, createScenarioRunDatabase, handleSandboxApiRequest } from "./scenario-api";
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
	createScenario(action: CreateScenarioAction): Promise<WorkspaceState>;
	renameScenario(action: RenameScenarioAction): Promise<WorkspaceState>;
	removeScenario(action: RemoveScenarioAction): Promise<WorkspaceState>;
	updateScenarioSource(action: UpdateScenarioSourceAction): Promise<WorkspaceState>;
	beginScenarioRun(action: { scenarioId: string }): Promise<{ runId: string; state: WorkspaceState }>;
	handleSandboxApiRequest(action: { runId: string; request: SandboxApiRequest }): Promise<SandboxApiResponse>;
	finishScenarioRun(action: { runId: string; status: "passed" | "failed" | "errored"; console: string[]; expectations?: ScenarioRun["expectations"]; reason?: ScenarioRun["reason"] }): Promise<WorkspaceState>;
	undo(): Promise<WorkspaceState>;
	redo(): Promise<WorkspaceState>;
	addTable(action: AddTableAction): Promise<WorkspaceState>;
	renameTable(action: RenameTableAction): Promise<WorkspaceState>;
	removeTable(action: RemoveTableAction): Promise<WorkspaceState>;
	moveTable(action: MoveTableAction): Promise<WorkspaceState>;
	addColumn(action: AddColumnAction): Promise<WorkspaceState>;
	updateColumn(action: UpdateColumnAction): Promise<WorkspaceState>;
	updateIndexes(action: UpdateIndexesAction): Promise<WorkspaceState>;
	updateEnumTypes(action: UpdateEnumTypesAction): Promise<WorkspaceState>;
	updateUniqueConstraints(action: UpdateUniqueConstraintsAction): Promise<WorkspaceState>;
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
		scenarios: [],
		scenarioSave: { status: "idle" },
		scenarioRuns: {},
		undoRedo: { canUndo: false, canRedo: false },
	};
	let activeProjectId: string | null = null;
	/** Orders every stored document, including layout-only writes. */
	let documentRevision = 0;
	let scenarioRevision = 0;
	let lastGeneratableSql: { revision: number; sql: string } | null = null;
	const inFlight = new Set<Promise<unknown>>();
	let activeScenarioRun: {
		id: string;
		scenarioId: string;
		projectId: string;
		revision: number;
		database: ScenarioRunDatabase | null;
		tables: SandboxAppliedTable[];
	} | null = null;
	let previewRequestId = 0;
	let scheduledPreview: {
		requestId: number;
		cancel: () => void;
		resolve: () => void;
	} | null = null;

	function setState(next: WorkspaceState) {
		if (next.project?.id === state.project?.id) {
			next = {
				...next,
				scenarioRuns: Object.fromEntries(
					Object.entries(next.scenarioRuns).map(([scenarioId, run]) => [
						scenarioId,
						run ? { ...run, stale: run.revision < next.revision } : null,
					]),
				),
			};
		}
		state = next;
		for (const listener of listeners) listener(state);
	}
	async function disposeActiveScenarioRun() {
		const run = activeScenarioRun;
		activeScenarioRun = null;
		if (run?.database) await run.database.close();
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
	async function saveScenarios(
		projectId: string,
		scenarios: Scenario[],
		revision: number,
	) {
		const savedAt = now();
		try {
			await store.saveScenarios(projectId, scenarios, { revision, savedAt });
			if (activeProjectId === projectId && scenarioRevision === revision) {
				setState({ ...state, projects: store.listProjects(), scenarioSave: { status: "saved", revision, savedAt } });
			}
		} catch (error) {
			if (activeProjectId === projectId && scenarioRevision === revision) {
				setState({
					...state,
					scenarioSave: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
					},
				});
			}
		}
	}

	function updateScenarios(
		projectId: string,
		update: (scenarios: Scenario[]) => Scenario[],
	) {
		const scenarios = update(state.scenarios);
		const revision = scenarioRevision + 1;
		scenarioRevision = revision;
		setState({
			...state,
			scenarios,
			scenarioSave: { status: "saving", revision },
		});
		return saveScenarios(projectId, scenarios, revision);
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
				await disposeActiveScenarioRun();
				invalidatePreviewWork();
				activeProjectId = project.id;
				documentRevision = revision;
				scenarioRevision = 0;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project,
					design,
					revision,
					save: { status: "saved", revision, savedAt },
					sql: { status: "empty", draftRevision: revision, errors: [] },
					sandbox: { status: "idle" },
					scenarios: [],
					scenarioSave: { status: "idle" },
					scenarioRuns: {},
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
				const scenarioDocument = store.loadScenarios(record.project.id);

				await disposeActiveScenarioRun();
				invalidatePreviewWork();
				activeProjectId = record.project.id;
				documentRevision = record.documentRevision;
				scenarioRevision = scenarioDocument.revision;
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
					scenarios: scenarioDocument.scenarios,
					scenarioSave:
						scenarioDocument.savedAt === null
							? { status: "idle" }
							: {
									status: "saved",
									revision: scenarioDocument.revision,
									savedAt: scenarioDocument.savedAt,
								},
					scenarioRuns: {},
					undoRedo: getUndoRedoState(record.project.id),
				});
				if (design.tables.length > 0) {
					const requestId = ++previewRequestId;
					await generateAndApply(record.project.id, record.revision, design, requestId);
				}
				return state;
			});
		},
		createScenario(action) {
			return runTask(async () => {
				const { projectId } = requireOpenDesign();
				const name = action.name.trim();
				if (!name) throw new Error("Scenario name is required.");
				const scenario: Scenario = { id: createId(), name, source: "" };
				await updateScenarios(projectId, (scenarios) => [...scenarios, scenario]);
				return state;
			});
		},
		renameScenario(action) {
			return runTask(async () => {
				const { projectId } = requireOpenDesign();
				const name = action.name.trim();
				if (!name) throw new Error("Scenario name is required.");
				const scenario = state.scenarios.find((item) => item.id === action.scenarioId);
				if (!scenario) throw new Error("That scenario could not be found.");
				if (scenario.name === name) return state;
				await updateScenarios(projectId, (scenarios) =>
					scenarios.map((item) => item.id === action.scenarioId ? { ...item, name } : item),
				);
				return state;
			});
		},
		removeScenario(action) {
			return runTask(async () => {
				const { projectId } = requireOpenDesign();
				if (!state.scenarios.some((item) => item.id === action.scenarioId)) {
					throw new Error("That scenario could not be found.");
				}
				await updateScenarios(projectId, (scenarios) =>
					scenarios.filter((item) => item.id !== action.scenarioId),
				);
				return state;
			});
		},
		updateScenarioSource(action) {
			return runTask(async () => {
				const { projectId } = requireOpenDesign();
				const scenario = state.scenarios.find((item) => item.id === action.scenarioId);
				if (!scenario) throw new Error("That scenario could not be found.");
				if (scenario.source === action.source) return state;
				await updateScenarios(projectId, (scenarios) =>
					scenarios.map((item) =>
						item.id === action.scenarioId ? { ...item, source: action.source } : item,
					),
				);
				return state;
			});
		},
		beginScenarioRun(action) {
			return runTask(async () => {
				const { projectId } = requireOpenDesign();
				if (activeScenarioRun) throw new Error("Another Scenario run is already active.");
				const scenario = state.scenarios.find((candidate) => candidate.id === action.scenarioId);
				if (!scenario) throw new Error("That Scenario could not be found.");
				const snapshot = getLastAppliedSandbox(state.sandbox);
				if (!snapshot) throw new Error("Apply a valid design revision before running a Scenario.");
				const run = {
					id: createId(),
					scenarioId: scenario.id,
					projectId,
					revision: snapshot.revision,
					database: null as ScenarioRunDatabase | null,
					tables: snapshot.tables,
				};
				activeScenarioRun = run;
				setState({
					...state,
					scenarioRuns: {
						...state.scenarioRuns,
						[scenario.id]: {
							id: run.id,
							status: "running",
							revision: run.revision,
							stale: run.revision < state.revision,
							requests: [],
							console: [],
							grids: [],
							expectations: [],
						},
					},
				});
				try {
					const database = await createScenarioRunDatabase(snapshot.sql);
					if (activeScenarioRun !== run || activeProjectId !== projectId) {
						await database.close();
						throw new Error("The Scenario run was superseded.");
					}
					run.database = database;
				} catch (error) {
					if (activeScenarioRun === run) {
						activeScenarioRun = null;
						const current = state.scenarioRuns[scenario.id];
						if (activeProjectId === projectId && current?.id === run.id) {
							setState({
								...state,
								scenarioRuns: {
									...state.scenarioRuns,
									[scenario.id]: {
										...current,
										status: "errored",
										reason: "exception",
										console: [error instanceof Error ? error.message : String(error)],
									},
								},
							});
						}
					}
					throw error;
				}
				return { runId: run.id, state };
			});
		},
		handleSandboxApiRequest(action) {
			return runTask(async () => {
				const run = activeScenarioRun;
				if (!run || run.id !== action.runId || run.projectId !== activeProjectId || !run.database) {
					return {
						status: 410,
						headers: { "content-type": "application/json" },
						body: { code: "PGRST_SANDBOX_UNSUPPORTED", message: "not supported by the sandbox: expired Scenario run", details: null, hint: null },
					};
				}
				const { response, entry } = await handleSandboxApiRequest(run.database, run.tables, action.request);
				if (activeScenarioRun !== run || activeProjectId !== run.projectId) return response;
				const previous = state.scenarioRuns[run.scenarioId];
				if (!previous || previous.id !== run.id) return response;
				setState({
					...state,
					scenarioRuns: {
						...state.scenarioRuns,
						[run.scenarioId]: {
							...previous,
							requests: [...previous.requests, { ...entry, order: previous.requests.length + 1 }],
						},
					},
				});
				return response;
			});
		},
		finishScenarioRun(action) {
			return runTask(async () => {
				const run = activeScenarioRun;
				if (!run || run.id !== action.runId || run.projectId !== activeProjectId) return state;
				const previous = state.scenarioRuns[run.scenarioId];
				let grids = previous?.id === run.id ? previous.grids : [];
				let status = action.status;
				let reason = action.reason;
				let output = [...action.console];
				try {
					if (run.database) grids = await captureScenarioResultGrids(run.database, run.tables);
				} catch (error) {
					status = "errored";
					reason = "exception";
					output = [...output, error instanceof Error ? error.message : String(error)];
				} finally {
					activeScenarioRun = null;
					if (run.database) await run.database.close();
				}
				if (previous?.id === run.id) {
					setState({
						...state,
						scenarioRuns: {
							...state.scenarioRuns,
							[run.scenarioId]: {
								...previous,
								status,
								console: output,
								grids,
								expectations: action.expectations ?? [],
								...(reason ? { reason } : {}),
							},
						},
					});
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
		updateIndexes(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const indexes = normalizeIndexes(action.indexes, table);
				if (JSON.stringify(indexes) === JSON.stringify(table.indexes ?? [])) return state;
				return applyStructuralChange(projectId, replaceTable(design, { ...table, indexes }));
			});
		},
		updateEnumTypes(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const enumTypes = normalizeEnumTypes(action.enumTypes);
				const removed = (design.enumTypes ?? []).filter((previous) =>
					!enumTypes.some((candidate) => candidate.id === previous.id),
				);
				for (const enumType of removed) {
					const columns = design.tables.flatMap((table) =>
						table.columns
							.filter((column) => column.type === "enum" && column.enumTypeId === enumType.id)
							.map((column) => `${table.name}.${column.name}`),
					);
					if (columns.length > 0) {
						throw new Error(`Enum type "${enumType.name}" is used by ${columns.join(", ")}.`);
					}
				}
				if (JSON.stringify(enumTypes) === JSON.stringify(design.enumTypes ?? [])) return state;
				return applyStructuralChange(projectId, { ...design, enumTypes });
			});
		},
		updateUniqueConstraints(action) {
			return runTask(async () => {
				const { projectId, design } = requireOpenDesign();
				const table = requireTable(design, action.tableId);
				const constraints = normalizeUniqueConstraints(action.uniqueConstraints, table);
				if (JSON.stringify(constraints) === JSON.stringify(table.uniqueConstraints ?? [])) return state;
				return applyStructuralChange(projectId, replaceTable(design, { ...table, uniqueConstraints: constraints }));
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
				const onDelete = action.onDelete === undefined ? relationship.onDelete ?? "NO ACTION" : requireReferentialAction(action.onDelete);
				const onUpdate = action.onUpdate === undefined ? relationship.onUpdate ?? "NO ACTION" : requireReferentialAction(action.onUpdate);
			if (
				required === undefined &&
				cardinality === relationship.cardinality &&
				onDelete === (relationship.onDelete ?? "NO ACTION") &&
				onUpdate === (relationship.onUpdate ?? "NO ACTION")
			) {
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
							? { ...candidate, cardinality, onDelete, onUpdate }
							: candidate,
					),
				};

				if (
					cardinality === relationship.cardinality &&
					onDelete === (relationship.onDelete ?? "NO ACTION") &&
					onUpdate === (relationship.onUpdate ?? "NO ACTION") &&
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
			await disposeActiveScenarioRun();
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
		...(design.enumTypes ? { enumTypes: design.enumTypes.map((enumType) => ({ ...enumType, labels: [...enumType.labels] })) } : {}),
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
	if (
		plan.relationships.length === 0 &&
		plan.indexes.length === 0 &&
		plan.uniqueConstraints.length === 0
	) return;
	const label = target.kind === "table" ? `table "${plan.target}"` : `column "${plan.target}"`;
	const count = plan.relationships.length;
	const summary = [
		...plan.relationships.map(describeAffectedRelationship),
		...plan.indexes.map((index) => `index ${index.name}`),
		...plan.uniqueConstraints.map((constraint) => `unique constraint ${constraint.name}`),
	].join(", ");
	throw new Error(
		`Removing ${label} also affects ` +
			`${count + plan.indexes.length + plan.uniqueConstraints.length} schema item(s) ` +
			`(${summary}). Confirm the removal to continue.`,
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
						indexes: (candidate.indexes ?? []).flatMap((index) => {
							const keys = index.keys.filter((key) => key.columnId !== column.id);
							if (keys.length === 0) return [];
							return [{
								...index,
								keys,
								includeColumnIds: (index.includeColumnIds ?? []).filter((id) => id !== column.id),
							}];
						}),
						uniqueConstraints: (candidate.uniqueConstraints ?? []).filter(
							(constraint) => !constraint.columnIds.includes(column.id),
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

/** Validates and copies index action data before it enters the design history. */
function normalizeIndexes(values: unknown, table: DesignTable): DesignIndex[] {
	if (!Array.isArray(values)) throw new Error("Indexes must be a list.");
	const methods = [
		"btree",
		"hash",
		"gin",
		"gist",
		"spgist",
		"brin",
		"hnsw",
		"ivfflat",
	];
	const ids = new Set<string>();
	return values.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Each index must be a structured value.");
		}
		const index = value as DesignIndex;
		if (typeof index.id !== "string" || !index.id.trim() || ids.has(index.id)) {
			throw new Error("Index ids must be non-empty and unique.");
		}
		ids.add(index.id);
		if (!methods.includes(index.method)) {
			throw new Error("That index access method is not supported.");
		}
		if (!Array.isArray(index.keys)) {
			throw new Error("Index keys must be a list.");
		}
		const keys: DesignIndexKey[] = index.keys.map((key) => {
			if (!key || typeof key !== "object" || typeof key.columnId !== "string") {
				throw new Error("Each index key needs a column id.");
			}
			requireColumn(table, key.columnId);
			if (key.order !== undefined && key.order !== "asc" && key.order !== "desc") {
				throw new Error("That index key ordering is not supported.");
			}
			if (key.nulls !== undefined && key.nulls !== "first" && key.nulls !== "last") {
				throw new Error("That index NULL ordering is not supported.");
			}
			if (key.operatorClass !== undefined && typeof key.operatorClass !== "string") {
				throw new Error("Index operator classes must be text.");
			}
			return { ...key };
		});
		const name = index.name === undefined ? undefined : requireName(index.name, "Index name");
		if (index.unique !== undefined && typeof index.unique !== "boolean") {
			throw new Error("Index uniqueness must be true or false.");
		}
		if (index.nullsNotDistinct !== undefined && typeof index.nullsNotDistinct !== "boolean") {
			throw new Error("Index NULL treatment must be true or false.");
		}
		const includeColumnIds = index.includeColumnIds ?? [];
		if (!Array.isArray(includeColumnIds)) {
			throw new Error("Index INCLUDE columns must be a list.");
		}
		includeColumnIds.forEach((id) => requireColumn(table, id));
		const storageOptions = normalizeIndexOptions(index.with);
		return {
			...index,
			...(name ? { name } : {}),
			keys,
			...(index.includeColumnIds ? { includeColumnIds: [...includeColumnIds] } : {}),
			...(storageOptions ? { with: storageOptions } : {}),
		};
	});
}

/** Validates the supported types of structured index storage options. */
function normalizeIndexOptions(value: unknown): DesignIndex["with"] {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Index storage options must be structured values.");
	}
	const options: NonNullable<DesignIndex["with"]> = {};
	for (const [key, option] of Object.entries(value)) {
		if (![
			"fillfactor",
			"fastupdate",
			"pagesPerRange",
			"lists",
			"m",
			"efConstruction",
		].includes(key)) {
			throw new Error(`Index storage option ${key} is not supported.`);
		}
		if (key === "fastupdate") {
			if (typeof option !== "boolean") {
				throw new Error("Index fastupdate must be true or false.");
			}
			options.fastupdate = option;
			continue;
		}
		if (option !== undefined && (typeof option !== "number" || !Number.isFinite(option) || !Number.isInteger(option))) {
			throw new Error(`Index storage option ${key} must be an integer.`);
		}
		if (key === "fillfactor") options.fillfactor = option as number | undefined;
		if (key === "pagesPerRange") options.pagesPerRange = option as number | undefined;
		if (key === "lists") options.lists = option as number | undefined;
		if (key === "m") options.m = option as number | undefined;
		if (key === "efConstruction") options.efConstruction = option as number | undefined;
	}
	return options;
}

/** Validates and copies enum definitions and their ordered labels. */
function normalizeEnumTypes(values: unknown): DesignEnumType[] {
	if (!Array.isArray(values)) throw new Error("Enum types must be a list.");
	const ids = new Set<string>();
	return values.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Each enum type must be a structured value.");
		}
		const enumType = value as DesignEnumType;
		if (typeof enumType.id !== "string" || !enumType.id.trim() || ids.has(enumType.id)) {
			throw new Error("Enum type ids must be non-empty and unique.");
		}
		ids.add(enumType.id);
		const name = requireName(enumType.name, "Enum type name");
		if (
			!Array.isArray(enumType.labels) ||
			enumType.labels.length === 0 ||
			enumType.labels.some((label) => typeof label !== "string" || !label.trim())
		) {
			throw new Error("Enum labels must be a non-empty list of text values.");
		}
		return { id: enumType.id, name, labels: [...enumType.labels] };
	});
}

/** Validates composite unique constraint references and copies their ids. */
function normalizeUniqueConstraints(
	values: unknown,
	table: DesignTable,
): DesignUniqueConstraint[] {
	if (!Array.isArray(values)) throw new Error("Unique constraints must be a list.");
	const ids = new Set<string>();
	return values.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Each unique constraint must be a structured value.");
		}
		const constraint = value as DesignUniqueConstraint;
		if (
			typeof constraint.id !== "string" ||
			!constraint.id.trim() ||
			ids.has(constraint.id)
		) {
			throw new Error("Unique constraint ids must be non-empty and unique.");
		}
		ids.add(constraint.id);
		if (!Array.isArray(constraint.columnIds)) {
			throw new Error("Unique constraint column ids must be a list.");
		}
		constraint.columnIds.forEach((id) => requireColumn(table, id));
		const name = constraint.name === undefined ? undefined : requireName(constraint.name, "Unique constraint name");
		if (
			constraint.nullsNotDistinct !== undefined &&
			typeof constraint.nullsNotDistinct !== "boolean"
		) {
			throw new Error("Unique constraint NULL treatment must be true or false.");
		}
		return { ...constraint, ...(name ? { name } : {}), columnIds: [...constraint.columnIds] };
	});
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

function isReferentialAction(value: unknown): value is ReferentialAction {
	return value === "NO ACTION" || value === "RESTRICT" || value === "CASCADE" || value === "SET NULL" || value === "SET DEFAULT";
}

function requireReferentialAction(value: unknown): ReferentialAction {
	if (!isReferentialAction(value)) throw new Error("That foreign-key referential action is not supported.");
	return value;
}

function normalizeColumnChanges(changes: ColumnChanges): ColumnChanges {
	if (!changes || typeof changes !== "object") {
		throw new Error("Column changes are required.");
	}
	const normalized: ColumnChanges = {};
	if (changes.name !== undefined) normalized.name = requireName(changes.name, "Column name");
	if (changes.type !== undefined) normalized.type = requireColumnType(changes.type);
	if (changes.enumTypeId !== undefined) {
		if (typeof changes.enumTypeId !== "string" || !changes.enumTypeId.trim()) {
			throw new Error("Enum type references need an enum type id.");
		}
		normalized.enumTypeId = changes.enumTypeId;
	}
	if (changes.typeParameters !== undefined) {
		if (!changes.typeParameters || typeof changes.typeParameters !== "object") {
			throw new Error("Column type parameters must be structured values.");
		}
		for (const [key, value] of Object.entries(changes.typeParameters)) {
			if (!["length", "precision", "scale", "dimensions", "array"].includes(key)) {
				throw new Error("Column type parameters include an unsupported field.");
			}
			const invalidNumber =
				typeof value !== "number" ||
				!Number.isInteger(value) ||
				(key === "scale" ? value < -1000 || value > 1000 : value < 0);
			if (key !== "array" && value !== undefined && invalidNumber) {
				throw new Error("Column type parameters must be valid integers.");
			}
		}
		if (
			changes.typeParameters.array !== undefined &&
			typeof changes.typeParameters.array !== "boolean"
		) {
			throw new Error("Array type must be true or false.");
		}
		normalized.typeParameters = { ...changes.typeParameters };
	}
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
		a.enumTypeId === b.enumTypeId &&
		JSON.stringify(a.typeParameters ?? {}) === JSON.stringify(b.typeParameters ?? {}) &&
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
