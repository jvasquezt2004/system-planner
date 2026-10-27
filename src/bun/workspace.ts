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
	type DesignFunction,
	type DesignTrigger,
	type DesignPolicy,
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
	type UpdatePoliciesAction,
	type RemoveFunctionAction,
	type UpdateUniqueConstraintsAction,
	type UpdateFunctionsAction,
	type UpdateTriggersAction,
	type UpdateRelationshipAction,
	type CreateScenarioAction,
	type RenameScenarioAction,
	type RemoveScenarioAction,
	type UpdateScenarioSourceAction,
	type Scenario,
	type EdgeFunction,
	type CreateEdgeFunctionAction,
	type RenameEdgeFunctionAction,
	type RemoveEdgeFunctionAction,
	type UpdateEdgeFunctionSourceAction,
	type ScenarioRun,
	type SandboxAppliedTable,
	type SandboxApiRequest,
	type SandboxApiResponse,
	type SandboxSnapshot,
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
 * removing columns; and updating row-level security policies) advance the
 * schema revision and refresh the SQL preview and sandbox. Layout actions
 * (moving a table card, panning or zooming the canvas) and column-note edits
 * only save the design document.
 */
export interface DesignWorkspace {
	getState(): WorkspaceState;
	subscribe(listener: WorkspaceListener): () => void;
	listProjects(): ProjectSummary[];
	addTable(action: AddTableAction): Promise<WorkspaceState>;
	createProject(action: CreateProjectAction): Promise<WorkspaceState>;
	openProject(action: OpenProjectAction): Promise<WorkspaceState>;
	createScenario(action: CreateScenarioAction): Promise<WorkspaceState>;
	renameScenario(action: RenameScenarioAction): Promise<WorkspaceState>;
	removeScenario(action: RemoveScenarioAction): Promise<WorkspaceState>;
	updateScenarioSource(action: UpdateScenarioSourceAction): Promise<WorkspaceState>;
	createEdgeFunction(action: CreateEdgeFunctionAction): Promise<WorkspaceState>;
	renameEdgeFunction(action: RenameEdgeFunctionAction): Promise<WorkspaceState>;
	removeEdgeFunction(action: RemoveEdgeFunctionAction): Promise<WorkspaceState>;
	updateEdgeFunctionSource(action: UpdateEdgeFunctionSourceAction): Promise<WorkspaceState>;
	beginScenarioRun(action: { scenarioId: string; designId?: string }): Promise<{ runId: string; state: WorkspaceState }>;
	handleSandboxApiRequest(action: { runId: string; request: SandboxApiRequest }): Promise<SandboxApiResponse>;
	finishScenarioRun(action: { runId: string; status: "passed" | "failed" | "errored"; console: string[]; expectations?: ScenarioRun["expectations"]; reason?: ScenarioRun["reason"] }): Promise<WorkspaceState>;
	undo(): Promise<WorkspaceState>;
	redo(): Promise<WorkspaceState>;
	applyAssistantDesign(design: Design, assistantTurnId?: string, designId?: string): Promise<WorkspaceState>;
	restoreAssistantProjectSnapshot(input: {
		projectId: string;
		design: Design;
		scenarios: Scenario[];
		edgeFunctions: EdgeFunction[];
		expectedSnapshot: { design: Design; scenarios: Scenario[]; edgeFunctions: EdgeFunction[] };
	}): Promise<WorkspaceState>;
	renameTable(action: RenameTableAction): Promise<WorkspaceState>;
	removeTable(action: RemoveTableAction): Promise<WorkspaceState>;
	moveTable(action: MoveTableAction): Promise<WorkspaceState>;
	addColumn(action: AddColumnAction): Promise<WorkspaceState>;
	updateColumn(action: UpdateColumnAction): Promise<WorkspaceState>;
	updateIndexes(action: UpdateIndexesAction): Promise<WorkspaceState>;
	updatePolicies(action: UpdatePoliciesAction): Promise<WorkspaceState>;
	updateEnumTypes(action: UpdateEnumTypesAction): Promise<WorkspaceState>;
	updateFunctions(action: UpdateFunctionsAction): Promise<WorkspaceState>;
	removeFunction(action: RemoveFunctionAction): Promise<WorkspaceState>;
	updateTriggers(action: UpdateTriggersAction): Promise<WorkspaceState>;
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
	assistantTurnId?: string;
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

	function applyManualDelta(target: unknown, manualBefore: unknown, manualAfter: unknown): unknown {
		if (JSON.stringify(manualBefore) === JSON.stringify(manualAfter)) return structuredClone(target);
		if (Array.isArray(manualBefore) && Array.isArray(manualAfter)) {
			const keyed = [...manualBefore, ...manualAfter].every((item) =>
				item !== null && typeof item === "object" && "id" in item && typeof item.id === "string",
			);
			if (keyed && Array.isArray(target)) {
				const beforeById = new Map(manualBefore.map((item) => [(item as { id: string }).id, item]));
				const afterById = new Map(manualAfter.map((item) => [(item as { id: string }).id, item]));
				const targetById = new Map(target.map((item) => [(item as { id: string }).id, item]));
				const result = target.map((item) => structuredClone(item));
				const resultById = new Map(result.map((item) => [(item as { id: string }).id, item]));
				for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
					const before = beforeById.get(id);
					const after = afterById.get(id);
					if (before === undefined && after !== undefined) {
						if (!resultById.has(id)) {
							const added = structuredClone(after);
							result.push(added);
							resultById.set(id, added);
						}
					} else if (before !== undefined && after === undefined) {
						const index = result.findIndex((item) => (item as { id: string }).id === id);
						if (index >= 0) result.splice(index, 1);
						resultById.delete(id);
					} else if (before !== undefined && after !== undefined && resultById.has(id)) {
						const next = applyManualDelta(targetById.get(id), before, after);
						const index = result.findIndex((item) => (item as { id: string }).id === id);
						if (index >= 0) result[index] = next;
						resultById.set(id, next);
					}
				}
				return result;
			}
			if (Array.isArray(target) && manualBefore.length === manualAfter.length && target.length === manualBefore.length) {
				return manualBefore.map((item, index) =>
					applyManualDelta(target[index], item, manualAfter[index]),
				);
			}
			return structuredClone(manualAfter);
		}
		if (manualBefore && manualAfter && target
			&& typeof manualBefore === "object" && typeof manualAfter === "object" && typeof target === "object"
			&& !Array.isArray(manualBefore) && !Array.isArray(manualAfter) && !Array.isArray(target)) {
			const before = manualBefore as Record<string, unknown>;
			const after = manualAfter as Record<string, unknown>;
			const result = structuredClone(target) as Record<string, unknown>;
			for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
				if (!(key in after)) delete result[key];
				else if (!(key in before)) result[key] = structuredClone(after[key]);
				else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
					if (before[key] && after[key] && typeof before[key] === "object" && typeof after[key] === "object"
						&& key in result) {
						result[key] = applyManualDelta(result[key], before[key], after[key]);
					} else result[key] = structuredClone(after[key]);
				}
			}
			return result;
		}
		return structuredClone(manualAfter);
	}
	function rebaseManualEdits(manualBefore: unknown, manualAfter: unknown, base: unknown): unknown {
		return applyManualDelta(base, manualBefore, manualAfter);
	}
	function recordDesignChange(
		projectId: string,
		before: Design,
		after: Design,
		structural: boolean,
		assistantTurnId?: string,
	): WorkspaceState["undoRedo"] {
		let history = histories.get(projectId);
		if (!history) {
			history = { entries: [], cursor: 0 };
			histories.set(projectId, history);
		}
		history.entries.length = history.cursor;
		if (assistantTurnId) {
			let firstTurnEntry = history.cursor - 1;
			while (firstTurnEntry >= 0 && history.entries[firstTurnEntry].assistantTurnId === undefined) firstTurnEntry -= 1;
			const previous = history.entries[firstTurnEntry];
			if (previous?.assistantTurnId === assistantTurnId) {
				let rebased = previous.before;
				const manualEntries: DesignHistoryEntry[] = [];
				for (let index = firstTurnEntry + 1; index < history.cursor; index += 1) {
					const entry = history.entries[index];
					if (entry.assistantTurnId) continue;
					const next = rebaseManualEdits(entry.before, entry.after, rebased) as Design;
					if (JSON.stringify(rebased) !== JSON.stringify(next)) {
						manualEntries.push({ before: rebased, after: next, structural: entry.structural });
						rebased = next;
					}
				}
				let rebasedAfter: Design = structuredClone(after);
				for (let index = firstTurnEntry + 1; index < history.cursor; index += 1) {
					const entry = history.entries[index];
					if (entry.assistantTurnId) continue;
					rebasedAfter = rebaseManualEdits(entry.before, entry.after, rebasedAfter) as Design;
				}
				const assistantEntry: DesignHistoryEntry = {
					before: rebased,
					after: rebasedAfter,
					structural: previous.structural || structural,
					assistantTurnId,
				};
				history.entries.splice(firstTurnEntry, history.cursor - firstTurnEntry, ...manualEntries, assistantEntry);
				history.cursor = firstTurnEntry + manualEntries.length + 1;
				return getUndoRedoState(projectId);
			}
		}
		history.entries.push({ before, after, structural, ...(assistantTurnId ? { assistantTurnId } : {}) });
		history.cursor = history.entries.length;
		return getUndoRedoState(projectId);
	}
	let state: WorkspaceState = {
		projects: store.listProjects(),
		project: null,
		design: null,
		activeDesignId: null,
		revision: 0,
		save: { status: "idle" },
		sql: { status: "empty", draftRevision: 0, errors: [] },
		sandbox: { status: "idle" },
		scenarios: [],
		scenarioSave: { status: "idle" },
		edgeFunctions: [],
		edgeFunctionSave: { status: "idle" },
		scenarioRuns: {},
		undoRedo: { canUndo: false, canRedo: false },
	};
	let activeProjectId: string | null = null;
	let activeDesignId: string | null = null;
	/** Orders every stored document, including layout-only writes. */
	let documentRevision = 0;
	let scenarioRevision = 0;
	let edgeFunctionRevision = 0;
	let edgeFunctionProjectGeneration = 0;
	let lastGeneratableSql: { revision: number; sql: string } | null = null;
	const inFlight = new Set<Promise<unknown>>();
	let activeScenarioRun: {
		id: string;
		scenarioId: string;
		projectId: string;
		designId: string;
		revision: number;
		scenarioRevision: number;
		edgeFunctionRevision: number;
		database: ScenarioRunDatabase | null;
		tables: SandboxAppliedTable[];
		relationships: SandboxSnapshot["relationships"];
		functions: DesignFunction[];
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
						run ? {
							...run,
							stale: run.revision < next.revision ||
								run.scenarioRevision < scenarioRevision ||
								run.edgeFunctionRevision < edgeFunctionRevision,
						} : null,
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
		designId?: string,
	) {
		return (
			activeProjectId === projectId &&
			(designId === undefined || activeDesignId === designId) &&
			state.revision === revision &&
			documentRevision === documentRevisionToSave
		);
	}
	function isCurrentPreview(projectId: string, revision: number, requestId: number, designId?: string) {
		return (
			previewRequestId === requestId &&
			activeProjectId === projectId &&
			(designId === undefined || activeDesignId === designId) &&
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

	function schedulePreview(projectId: string, revision: number, design: Design, designId?: string) {
		cancelScheduledPreview();
		const requestId = ++previewRequestId;

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(() => {
			if (scheduledPreview?.requestId === requestId) scheduledPreview = null;
			const task = runTask(() =>
				generateAndApply(projectId, revision, design, requestId, designId),
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
		designId?: string,
	) {
		if (!isCurrentPreview(projectId, revision, requestId, designId)) return;

		const generation = generateDesignSql(design);
		if (!generation.ok) {
			const available = lastGeneratableSql;
			const lastApplied = getLastAppliedSandbox(state.sandbox);
			setState({
				...state,
				sql:
					available === null
						? { status: "empty", draftRevision: revision, errors: generation.errors, designId }
						: {
								status: "stale",
								revision: available.revision,
								draftRevision: revision,
								sql: available.sql,
								errors: generation.errors,
								designId,
							},
				sandbox:
					lastApplied === null
						? { status: "idle" }
						: { status: "applied", ...lastApplied, designId },
			});
			return;
		}

		lastGeneratableSql = { revision, sql: generation.sql };
		const lastApplied = getLastAppliedSandbox(state.sandbox);
		setState({
			...state,
			sql: { status: "current", revision, sql: generation.sql, designId },
			sandbox: {
				status: "applying",
				revision,
				attemptedSql: generation.sql,
				lastApplied,
				designId,
			},
		});

		let sandbox: SchemaSandbox | null = null;
		try {
			sandbox = createSandbox();
			const result = await sandbox.apply(generation.sql);
			if (!isCurrentPreview(projectId, revision, requestId, designId)) return;
			setState({
				...state,
				sandbox: result.ok
					? {
							status: "applied",
							designId,
							revision,
							tables: result.tables.map((table) => ({
								...table,
								columns: table.columns.map((column) => {
									const designTable = design.tables.find((candidate) => candidate.name === table.name);
									const designColumn = designTable?.columns.find((candidate) => candidate.name === column.name);
									const enumType = design.enumTypes?.find((candidate) => candidate.id === designColumn?.enumTypeId);
									return enumType ? { ...column, enumTypeName: enumType.name } : column;
								}),
							})),
							relationships: result.relationships,
							sql: generation.sql,
							...(design.enumTypes ? { enumTypes: design.enumTypes.map((enumType) => ({ ...enumType, labels: [...enumType.labels] })) } : {}),
							...(design.functions ? { functions: structuredClone(design.functions) } : {}),
						}
					: result.failure === "sql-rejected"
						? {
								status: "failed",
								failure: "sql-rejected",
								revision,
								attemptedSql: generation.sql,
								error: result.error,
								lastApplied,
								designId,
							}
						: {
								status: "failed",
								failure: "sandbox-error",
								revision,
								error: result.error,
								lastApplied,
								designId,
							},
			});
		} catch (error) {
			if (!isCurrentPreview(projectId, revision, requestId, designId)) return;
			setState({
				...state,
				sandbox: {
					status: "failed",
					failure: "sandbox-error",
					revision,
					error: error instanceof Error ? error.message : String(error),
					lastApplied,
					designId,
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
		designId?: string,
	) {
		const savedAt = now();
		try {
			await store.saveDesign(projectId, design, {
				revision,
				documentRevision: documentRevisionToSave,
				savedAt,
			}, designId);
			if (isCurrentSave(projectId, revision, documentRevisionToSave, designId)) {
				setState({
					...state,
					projects: store.listProjects(),
					save: { status: "saved", revision, savedAt, designId },
				});
			}
		} catch (error) {
			if (isCurrentSave(projectId, revision, documentRevisionToSave, designId)) {
				setState({
					...state,
					save: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
						designId,
					},
				});
			}
		}
	}
	async function saveScenarios(
		projectId: string,
		scenarios: Scenario[],
		revision: number,
		designId?: string,
	) {
		const savedAt = now();
		const isCurrentScenarioSave = () =>
			activeProjectId === projectId &&
			activeDesignId === designId &&
			scenarioRevision === revision;
		try {
			await store.saveScenarios(projectId, scenarios, { revision, savedAt }, designId);
			if (isCurrentScenarioSave()) {
				setState({ ...state, projects: store.listProjects(), scenarioSave: { status: "saved", revision, savedAt, designId } });
			}
		} catch (error) {
			if (isCurrentScenarioSave()) {
				setState({
					...state,
					scenarioSave: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
						designId,
					},
				});
			}
		}
	}

	async function saveEdgeFunctions(projectId: string, edgeFunctions: EdgeFunction[], revision: number, projectGeneration: number, designId?: string) {
		const savedAt = now();
		const isCurrentEdgeFunctionSave = () =>
			activeProjectId === projectId &&
			activeDesignId === designId &&
			edgeFunctionProjectGeneration === projectGeneration &&
			edgeFunctionRevision === revision;
		try {
			await store.saveEdgeFunctions(projectId, edgeFunctions, { revision, savedAt }, designId);
			if (isCurrentEdgeFunctionSave()) {
				setState({ ...state, projects: store.listProjects(), edgeFunctionSave: { status: "saved", revision, savedAt, designId } });
			}
		} catch (error) {
			if (isCurrentEdgeFunctionSave()) {
				setState({
					...state,
					edgeFunctionSave: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
						designId,
					},
				});
			}
		}
	}

	function updateEdgeFunctions(projectId: string, update: (items: EdgeFunction[]) => EdgeFunction[], designId?: string) {
		const targetDesignId = designId ?? activeDesignId ?? undefined;
		const edgeFunctions = update(state.edgeFunctions);
		const revision = edgeFunctionRevision + 1;
		edgeFunctionRevision = revision;
		setState({ ...state, edgeFunctions, edgeFunctionSave: { status: "saving", revision, designId: targetDesignId } });
		return saveEdgeFunctions(projectId, edgeFunctions, revision, edgeFunctionProjectGeneration, targetDesignId);
	}

	function updateScenarios(
		projectId: string,
		update: (scenarios: Scenario[]) => Scenario[],
		designId?: string,
	) {
		const targetDesignId = designId ?? activeDesignId ?? undefined;
		const scenarios = update(state.scenarios);
		const revision = scenarioRevision + 1;
		scenarioRevision = revision;
		setState({
			...state,
			scenarios,
			scenarioSave: { status: "saving", revision, designId: targetDesignId },
		});
		return saveScenarios(projectId, scenarios, revision, targetDesignId);
	}
	/** Saves the draft immediately and debounces its disposable preview rebuild. */
	async function applyStructuralChange(
		projectId: string,
		design: Design,
		recordHistory = true,
		assistantTurnId?: string,
		designId?: string,
	) {
		const targetDesignId = designId ?? activeDesignId ?? undefined;
		const before = state.design;
		if (!before) throw new Error("Open a project before editing its design.");
		const undoRedo = recordHistory
			? recordDesignChange(projectId, before, design, true, assistantTurnId)
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
			save: { status: "saving", revision, designId: targetDesignId },
			sql: {
				status: "checking",
				draftRevision: revision,
				availableRevision: lastGeneratableSql?.revision ?? null,
				sql: lastGeneratableSql?.sql ?? null,
				designId: targetDesignId,
			},
			sandbox:
				lastApplied === null
					? { status: "idle" }
					: { status: "applied", ...lastApplied, designId: targetDesignId },
		});
		const committedState = state;
		const preview = schedulePreview(projectId, revision, design, targetDesignId);
		await saveDocument(projectId, revision, nextDocumentRevision, design, targetDesignId);
		await preview;
		return state.project?.id === projectId ? state : committedState;
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
		designId?: string,
	) {
		const targetDesignId = designId ?? activeDesignId ?? undefined;
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
			save: { status: "saving", revision, designId: targetDesignId },
		});
		await saveDocument(projectId, revision, nextDocumentRevision, design, targetDesignId);
		return state;
	}

	async function applyHistoryChange(direction: "undo" | "redo") {
		const { projectId, design: currentDesign, designId } = requireOpenDesign();
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
				? await applyStructuralChange(projectId, design, false, undefined, designId)
				: await applyNonSchemaChange(projectId, design, false, designId);
		} catch (error) {
			history.cursor += undoing ? 1 : -1;
			if (activeProjectId === projectId) {
				setState({ ...state, undoRedo: getUndoRedoState(projectId) });
			}
			throw error;
		}
	}

	function requireOpenDesign(targetDesignId?: string): { projectId: string; design: Design; designId: string } {
		if (!state.project || !state.design || activeProjectId === null || activeDesignId === null) {
			throw new Error("Open a project before editing its design.");
		}
		if (targetDesignId !== undefined && targetDesignId !== activeDesignId) {
			throw new Error(`Target database design '${targetDesignId}' is not the active design.`);
		}
		return { projectId: activeProjectId, design: state.design, designId: activeDesignId };
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
				const designId = createId();

				await store.createProject(project, design, {
					revision,
					documentRevision: revision,
					savedAt,
				}, designId);
				await disposeActiveScenarioRun();
				invalidatePreviewWork();
				activeProjectId = project.id;
				activeDesignId = designId;
				edgeFunctionProjectGeneration += 1;
				documentRevision = revision;
				scenarioRevision = 0;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project,
					design,
					activeDesignId: designId,
					revision,
					save: { status: "saved", revision, savedAt, designId },
					sql: { status: "empty", draftRevision: revision, errors: [], designId },
					sandbox: { status: "idle" },
					scenarios: [],
					scenarioSave: { status: "idle" },
					edgeFunctions: [],
					edgeFunctionSave: { status: "idle" },
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
				const designId = record.designId;
				const scenarioDocument = store.loadScenarios(record.project.id, designId);

				await disposeActiveScenarioRun();
				invalidatePreviewWork();
				activeProjectId = record.project.id;
				activeDesignId = designId;
				edgeFunctionProjectGeneration += 1;
				documentRevision = record.documentRevision;
				const edgeFunctionDocument = store.loadEdgeFunctions(record.project.id, designId);
				edgeFunctionRevision = Math.max(edgeFunctionRevision, edgeFunctionDocument.revision);
				scenarioRevision = scenarioDocument.revision;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project: record.project,
					design,
					activeDesignId: designId,
					revision: record.revision,
					save: { status: "saved", revision: record.revision, savedAt: record.savedAt, designId },
					sql: {
						status: "empty",
						draftRevision: record.revision,
						errors: [],
						designId,
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
									designId,
								},
					scenarioRuns: {},
					edgeFunctions: edgeFunctionDocument.edgeFunctions,
					edgeFunctionSave:
						edgeFunctionDocument.savedAt === null
							? { status: "idle" }
							: {
									status: "saved",
									revision: edgeFunctionDocument.revision,
									savedAt: edgeFunctionDocument.savedAt,
									designId,
								},
					undoRedo: getUndoRedoState(record.project.id),
				});
				if (design.tables.length > 0) {
					const requestId = ++previewRequestId;
					await generateAndApply(record.project.id, record.revision, design, requestId, designId);
				}
				return state;
			});
		},
		createEdgeFunction(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const name = requireEdgeFunctionName(action.name);
				if (state.edgeFunctions.some((item) => item.name === name)) throw new Error(`Edge function “${name}” already exists in this project.`);
				const edgeFunction: EdgeFunction = {
					id: createId(),
					name,
					source: 'Deno.serve(async (_request) => new Response("OK"));',
					designId,
				};
				await updateEdgeFunctions(projectId, (items) => [...items, edgeFunction], designId);
				return state;
			});
		},
		renameEdgeFunction(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const name = requireEdgeFunctionName(action.name);
				const current = state.edgeFunctions.find((item) => item.id === action.edgeFunctionId);
				if (!current) throw new Error("That Edge function could not be found.");
				if (state.edgeFunctions.some((item) => item.id !== current.id && item.name === name)) {
					throw new Error(`Edge function “${name}” already exists in this project.`);
				}
				if (current.name === name) return state;
				await updateEdgeFunctions(projectId, (items) =>
					items.map((item) => item.id === current.id ? { ...item, name } : item),
				designId);
				return state;
			});
		},
		removeEdgeFunction(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				if (!state.edgeFunctions.some((item) => item.id === action.edgeFunctionId)) {
					throw new Error("That Edge function could not be found.");
				}
				await updateEdgeFunctions(projectId, (items) => items.filter((item) => item.id !== action.edgeFunctionId), designId);
				return state;
			});
		},
		updateEdgeFunctionSource(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const edgeFunction = state.edgeFunctions.find((item) => item.id === action.edgeFunctionId);
				if (!edgeFunction) throw new Error("That Edge function could not be found.");
				if (edgeFunction.source === action.source) return state;
				await updateEdgeFunctions(projectId, (items) =>
					items.map((item) => item.id === edgeFunction.id ? { ...item, source: action.source } : item),
				designId);
				return state;
			});
		},
		createScenario(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const name = action.name.trim();
				if (!name) throw new Error("Scenario name is required.");
				const scenario: Scenario = { id: createId(), name, source: "", designId };
				await updateScenarios(projectId, (scenarios) => [...scenarios, scenario], designId);
				return state;
			});
		},
		renameScenario(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const name = action.name.trim();
				if (!name) throw new Error("Scenario name is required.");
				const scenario = state.scenarios.find((item) => item.id === action.scenarioId);
				if (!scenario) throw new Error("That scenario could not be found.");
				if (scenario.name === name) return state;
				await updateScenarios(projectId, (scenarios) =>
					scenarios.map((item) => item.id === action.scenarioId ? { ...item, name } : item),
				designId);
				return state;
			});
		},
		removeScenario(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				if (!state.scenarios.some((item) => item.id === action.scenarioId)) {
					throw new Error("That scenario could not be found.");
				}
				await updateScenarios(projectId, (scenarios) =>
					scenarios.filter((item) => item.id !== action.scenarioId),
				designId);
				return state;
			});
		},
		updateScenarioSource(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const scenario = state.scenarios.find((item) => item.id === action.scenarioId);
				if (!scenario) throw new Error("That scenario could not be found.");
				if (scenario.source === action.source) return state;
				await updateScenarios(projectId, (scenarios) =>
					scenarios.map((item) =>
						item.id === action.scenarioId ? { ...item, source: action.source } : item,
					),
				designId);
				return state;
			});
		},
		beginScenarioRun(action: { scenarioId: string; designId?: string }) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				if (activeScenarioRun) throw new Error("Another Scenario run is already active.");
				const scenario = state.scenarios.find((candidate) => candidate.id === action.scenarioId);
				if (!scenario || (scenario.designId !== undefined && scenario.designId !== designId)) {
					throw new Error("That Scenario could not be found in the target database Design.");
				}
				const snapshot = getLastAppliedSandbox(state.sandbox);
				if (!snapshot || snapshot.designId !== designId) throw new Error("Apply a valid design revision before running a Scenario.");
				const run = {
					id: createId(),
					scenarioId: scenario.id,
					projectId,
					designId,
					revision: snapshot.revision,
					scenarioRevision,
					edgeFunctionRevision,
					database: null as ScenarioRunDatabase | null,
					tables: snapshot.tables,
					relationships: snapshot.relationships,
					functions: snapshot.functions ?? [],
				};
				activeScenarioRun = run;
				setState({
					...state,
					scenarioRuns: {
						...state.scenarioRuns,
						[scenario.id]: {
							id: run.id,
							designId,
							scenarioId: scenario.id,
							status: "running",
							revision: run.revision,
							scenarioRevision: run.scenarioRevision,
							edgeFunctionRevision: run.edgeFunctionRevision,
							stale: run.revision < state.revision || run.scenarioRevision < scenarioRevision ||
								run.edgeFunctionRevision < edgeFunctionRevision,
							requests: [],
							console: [],
							grids: [],
							expectations: [],
						},
					},
				});
				try {
					const database = await createScenarioRunDatabase(snapshot.sql);
					if (activeScenarioRun !== run || activeProjectId !== projectId || activeDesignId !== designId) {
						await database.close();
						throw new Error("The Scenario run was superseded.");
					}
					run.database = database;
				} catch (error) {
					if (activeScenarioRun === run) {
						activeScenarioRun = null;
						const current = state.scenarioRuns[scenario.id];
						if (activeProjectId === projectId && activeDesignId === designId && current?.id === run.id) {
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
				if (!run || run.id !== action.runId || run.projectId !== activeProjectId || run.designId !== activeDesignId || !run.database) {
					return {
						status: 410,
						headers: { "content-type": "application/json" },
						body: { code: "PGRST_SANDBOX_UNSUPPORTED", message: "not supported by the sandbox: expired Scenario run", details: null, hint: null },
					};
				}
				const { response, entry } = await handleSandboxApiRequest(run.database, run.tables, action.request, run.relationships, run.functions);
				if (activeScenarioRun !== run || activeProjectId !== run.projectId || activeDesignId !== run.designId) return response;
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
				if (!run || run.id !== action.runId || run.projectId !== activeProjectId || run.designId !== activeDesignId) return state;
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
								id: run.id,
								designId: run.designId,
								scenarioId: run.scenarioId,
								status,
								console: output,
								grids,
								expectations: action.expectations ?? [],
								scenarioRevision: run.scenarioRevision,
								stale: run.revision < state.revision || run.scenarioRevision < scenarioRevision ||
									run.edgeFunctionRevision < edgeFunctionRevision,
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
		applyAssistantDesign(design, assistantTurnId, targetDesignId) {
			return runTask(async () => {
				const { projectId, design: currentDesign, designId } = requireOpenDesign(targetDesignId);
				const normalized = normalizeDesign(design);
				const currentTables = new Map(currentDesign.tables.map((table) => [table.id, table]));
				for (const table of normalized.tables) {
					const currentTable = currentTables.get(table.id);
					const position = requirePoint(table.position, "Table position");
					if (currentTable && !samePoint(position, currentTable.position)) {
						throw new Error("Assistant design changes cannot move existing tables.");
					}
				}
				if (!sameViewport(normalized.viewport, currentDesign.viewport)) {
					throw new Error("Assistant design changes cannot change the canvas viewport.");
				}
				const validated: Design = {
					...normalized,
					tables: normalized.tables.map((table) => ({
						...table,
						position: requirePoint(table.position, "Table position"),
						policies: normalizePolicies(table.policies ?? []),
						...(table.indexes !== undefined
							? { indexes: normalizeIndexes(table.indexes, table) }
							: {}),
						...(table.uniqueConstraints !== undefined
							? { uniqueConstraints: normalizeUniqueConstraints(table.uniqueConstraints, table) }
							: {}),
					})),
					...(normalized.enumTypes !== undefined
						? { enumTypes: normalizeEnumTypes(normalized.enumTypes) }
						: {}),
					...(normalized.functions !== undefined
						? { functions: normalizeFunctions(normalized.functions, normalized) }
						: {}),
					...(normalized.triggers !== undefined
						? { triggers: normalizeTriggers(normalized.triggers, normalized) }
						: {}),
				};
				if (JSON.stringify(validated) === JSON.stringify(currentDesign)) return state;
				return applyStructuralChange(projectId, validated, true, assistantTurnId, designId);
			});
		},
		restoreAssistantProjectSnapshot(input) {
			return runTask(async () => {
				const current = state;
				if (current.project?.id !== input.projectId || !current.design) throw new Error("The Assistant turn belongs to a different open project.");
				const currentContent = { design: { ...current.design, viewport: null }, scenarios: current.scenarios, edgeFunctions: current.edgeFunctions };
				const expectedContent = { design: { ...input.expectedSnapshot.design, viewport: null }, scenarios: input.expectedSnapshot.scenarios, edgeFunctions: input.expectedSnapshot.edgeFunctions };
				if (JSON.stringify(currentContent) !== JSON.stringify(expectedContent)) throw new Error("The project changed after this Assistant turn; it can no longer be reverted.");
				const restored = normalizeDesign({ ...input.design, viewport: current.design.viewport });
				if (JSON.stringify({ ...restored, viewport: null }) !== JSON.stringify({ ...current.design, viewport: null })) {
					await applyStructuralChange(input.projectId, restored, true, undefined, activeDesignId ?? undefined);
				}
				if (state.project?.id !== input.projectId) throw new Error("The open project changed while reverting the Assistant turn.");
				await updateScenarios(input.projectId, () => structuredClone(input.scenarios), activeDesignId ?? undefined);
				if (state.project?.id !== input.projectId) throw new Error("The open project changed while reverting the Assistant turn.");
				await updateEdgeFunctions(input.projectId, () => structuredClone(input.edgeFunctions), activeDesignId ?? undefined);
				return state;
			});
		},
		addTable(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		renameTable(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		removeTable(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const target: RemovalTarget = { kind: "table", tableId: table.id };
				requireConfirmedRemoval(design, target, action.confirmed);

				return applyStructuralChange(
					projectId,
					removeTableAndItsRelationships(design, table),
					true,
					undefined,
					designId,
				);
			});
		},
		moveTable(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const position = requirePoint(action.position, "Table position");
				if (samePoint(table.position, position)) return state;

				const nextDesign: Design = {
					...design,
					tables: design.tables.map((candidate) =>
						candidate.id === table.id ? { ...candidate, position } : candidate,
					),
				};
				return applyNonSchemaChange(projectId, nextDesign, true, designId);
			});
		},
		addColumn(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		updateColumn(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
					? applyStructuralChange(projectId, nextDesign, true, undefined, designId)
					: applyNonSchemaChange(projectId, nextDesign, true, designId);
			});
		},
		updateIndexes(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const indexes = normalizeIndexes(action.indexes, table);
				if (JSON.stringify(indexes) === JSON.stringify(table.indexes ?? [])) return state;
				return applyStructuralChange(projectId, replaceTable(design, { ...table, indexes }), true, undefined, designId);
			});
		},
		updateEnumTypes(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
				return applyStructuralChange(projectId, { ...design, enumTypes }, true, undefined, designId);
			});
		},
		updateFunctions(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const functions = normalizeFunctions(action.functions, design);
				if (JSON.stringify(functions) === JSON.stringify(design.functions ?? [])) return state;
				return applyStructuralChange(projectId, { ...design, functions }, true, undefined, designId);
			});
		},
		removeFunction(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const target: RemovalTarget = { kind: "function", functionId: action.functionId };
				requireRemovalTarget(design, target);
				requireConfirmedRemoval(design, target, action.confirmed);
				return applyStructuralChange(projectId, {
					...design,
					functions: (design.functions ?? []).filter((fn) => fn.id !== action.functionId),
					triggers: (design.triggers ?? []).filter((trigger) => trigger.functionId !== action.functionId),
				}, true, undefined, designId);
			});
		},
		updateTriggers(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const triggers = normalizeTriggers(action.triggers, design);
				if (JSON.stringify(triggers) === JSON.stringify(design.triggers ?? [])) return state;
				return applyStructuralChange(projectId, { ...design, triggers }, true, undefined, designId);
			});
		},

		updateUniqueConstraints(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const constraints = normalizeUniqueConstraints(action.uniqueConstraints, table);
				if (JSON.stringify(constraints) === JSON.stringify(table.uniqueConstraints ?? [])) return state;
				return applyStructuralChange(projectId, replaceTable(design, { ...table, uniqueConstraints: constraints }), true, undefined, designId);
			});
		},
		updatePolicies(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const rowLevelSecurity = action.rowLevelSecurity === true;
				const policies = normalizePolicies(action.policies);
				if (
					rowLevelSecurity === (table.rowLevelSecurity ?? false) &&
					JSON.stringify(policies) === JSON.stringify(table.policies ?? [])
				) return state;
				return applyStructuralChange(
					projectId,
					replaceTable(design, { ...table, rowLevelSecurity, policies }),
					true,
					undefined,
					designId,
				);
			});
		},
		removeColumn(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const column = requireColumn(table, action.columnId);
				const target: RemovalTarget = {
					kind: "column",
					tableId: table.id,
					columnId: column.id,
				};
				requireConfirmedRemoval(design, target, action.confirmed);

				const nextDesign = removeColumnAndItsRelationships(design, table, column);
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		addRelationship(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
					return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
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
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		updateRelationship(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		removeRelationship(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
				return applyStructuralChange(projectId, nextDesign, true, undefined, designId);
			});
		},
		describeRemoval(target) {
			const { design } = requireOpenDesign(target.designId);
			requireRemovalTarget(design, target);
			return removalPlan(design, target);
		},
		setViewport(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
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
					designId,
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

/** Validates policy names and roles before preserving handwritten conditions. */
function normalizePolicies(policies: DesignPolicy[]): DesignPolicy[] {
	const names = new Set<string>();
	const ids = new Set<string>();
	return policies.map((policy) => {
		const id = requireName(policy.id, "Policy id");
		const name = requireName(policy.name, "Policy name");
		if (ids.has(id)) throw new Error(`Policy id "${id}" is duplicated.`);
		if (names.has(name)) throw new Error(`Policy name "${name}" is duplicated.`);
		ids.add(id);
		names.add(name);
		if (!["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].includes(policy.command)) {
			throw new Error(`Policy "${name}" has an unsupported command.`);
		}
		if (!["permissive", "restrictive"].includes(policy.mode)) {
			throw new Error(`Policy "${name}" has an unsupported mode.`);
		}
		return {
			...policy,
			id,
			name,
			roles: [...new Set(policy.roles.map((role) => requireName(role, "Policy role")))],
		};
	});
}
/** Validates function metadata and tracks referenced project tables. */
function normalizeFunctions(values: unknown, design: Design): DesignFunction[] {
	if (!Array.isArray(values)) throw new Error("Functions must be a list.");
	const ids = new Set<string>();
	const names = new Set<string>();
	return values.map((value: unknown) => {
		if (!value || typeof value !== "object") throw new Error("Function definition is invalid.");
		const fn = value as DesignFunction;
		const id = requireName(fn.id, "Function id");
		const name = requireName(fn.name, "Function name");
		if (ids.has(id)) throw new Error(`Function id "${id}" is duplicated.`);
		if (names.has(name)) throw new Error(`Function name "${name}" is duplicated.`);
		ids.add(id);
		names.add(name);
		if (!Array.isArray(fn.arguments)) throw new Error(`Function "${name}" arguments must be a list.`);
		const argumentNames = new Set<string>();
		const args = fn.arguments.map((argument) => {
			const argumentName = requireName(argument.name, "Function argument name");
			if (argumentNames.has(argumentName)) throw new Error(`Function "${name}" has duplicate argument "${argumentName}".`);
			argumentNames.add(argumentName);
			return { name: argumentName, type: requireName(argument.type, "Function argument type") };
		});
		if (!["sql", "plpgsql"].includes(fn.language)) throw new Error(`Function "${name}" has an unsupported language.`);
		if (!["volatile", "stable", "immutable"].includes(fn.volatility)) throw new Error(`Function "${name}" has unsupported volatility.`);
		if (!["invoker", "definer"].includes(fn.security)) throw new Error(`Function "${name}" has unsupported security mode.`);
		if (typeof fn.returnsSet !== "boolean" || typeof fn.body !== "string") throw new Error(`Function "${name}" definition is incomplete.`);
		const returnType = requireName(fn.returnType, "Function return type");
		if (returnType.toLowerCase() === "trigger" && fn.language !== "plpgsql") throw new Error(`Function "${name}" returning trigger must use PL/pgSQL.`);
		const previous = design.functions?.find((candidate) => candidate.id === id);
		const unchangedReferences = previous?.body === fn.body
			&& previous.returnType === returnType
			&& JSON.stringify(previous.arguments) === JSON.stringify(args);
		const tableDependencies = unchangedReferences && previous.tableDependencies
			? [...previous.tableDependencies]
			: functionTableDependencies(fn.body, design.tables, [returnType, ...args.map((argument) => argument.type)]);
		return {
			id, name, arguments: args, returnType,
			returnsSet: returnType.toLowerCase() === "trigger" ? false : fn.returnsSet || /^TABLE\s*\(/i.test(returnType),
			language: fn.language, volatility: fn.volatility, security: fn.security,
			body: fn.body, tableDependencies,
		};
	});
}
function normalizeTriggers(values: unknown, design: Design): DesignTrigger[] {
	if (!Array.isArray(values)) throw new Error("Triggers must be a list.");
	const ids = new Set<string>();
	const names = new Set<string>();
	return values.map((value: unknown) => {
		if (!value || typeof value !== "object") throw new Error("Trigger definition is invalid.");
		const trigger = value as DesignTrigger;
		const id = requireName(trigger.id, "Trigger id");
		const name = requireName(trigger.name, "Trigger name");
		const scopedName = `${trigger.tableId}:${name}`;
		if (ids.has(id) || names.has(scopedName)) throw new Error(`Trigger "${name}" is duplicated on this table.`);
		ids.add(id);
		names.add(scopedName);
		if (!design.tables.some((table) => table.id === trigger.tableId)) throw new Error(`Trigger "${name}" needs an existing table.`);
		if (!design.functions?.some((fn) => fn.id === trigger.functionId && fn.returnType.trim().toLowerCase() === "trigger" && fn.language === "plpgsql" && fn.arguments.length === 0)) {
			throw new Error(`Trigger "${name}" needs a no-argument PL/pgSQL Function returning trigger.`);
		}
		if (!["BEFORE", "AFTER", "INSTEAD OF"].includes(trigger.timing)) throw new Error(`Trigger "${name}" has invalid timing.`);
		if (!["ROW", "STATEMENT"].includes(trigger.level)) throw new Error(`Trigger "${name}" has invalid level.`);
		if (!Array.isArray(trigger.events) || trigger.events.length === 0) throw new Error(`Trigger "${name}" needs at least one event.`);
		const table = design.tables.find((candidate) => candidate.id === trigger.tableId)!;
		const events = trigger.events.map((event) => {
			if (!["INSERT", "UPDATE", "DELETE", "TRUNCATE"].includes(event.event)) throw new Error(`Trigger "${name}" has an invalid event.`);
			const columnIds = [...new Set(event.columnIds ?? [])];
			if (event.event !== "UPDATE" && columnIds.length) throw new Error(`Only UPDATE events can select columns.`);
			if (columnIds.some((columnId) => !table.columns.some((column) => column.id === columnId))) throw new Error(`Trigger "${name}" references a missing column.`);
			if (columnIds.length && trigger.level !== "ROW") throw new Error(`UPDATE OF columns requires a row-level trigger.`);
			return columnIds.length ? { event: event.event, columnIds } : { event: event.event };
		});
		if (new Set(events.map((event) => event.event)).size !== events.length) throw new Error(`Trigger "${name}" has duplicate events.`);
		return { ...trigger, id, name, events, when: typeof trigger.when === "string" ? trigger.when.trim() : "" };
	});
}

function functionTableDependencies(body: string, tables: DesignTable[], types: string[]): string[] {
	return tables.filter((table) => {
		if (types.some((type) => type.trim().replace(/\[\]$/, "") === table.name)) return true;
		const escapedName = table.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const relation = `(?:"${escapedName}"|${escapedName})`;
		return new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\\s+(?:public\\s*\\.\\s*)?${relation}(?![\\w$])`, "i").test(body);
	}).map((table) => table.id);
}

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
			rowLevelSecurity: table.rowLevelSecurity ?? false,
			policies: table.policies ?? [],
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
		...(design.functions ? { functions: structuredClone(design.functions) } : {}),
		...(design.triggers ? { triggers: structuredClone(design.triggers) } : {}),
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
		rowLevelSecurity: false,
		policies: [],
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
	if (target.kind === "function") {
		if (!design.functions?.some((fn) => fn.id === target.functionId)) throw new Error("Function does not exist.");
		return;
	}
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
		plan.uniqueConstraints.length === 0 &&
		plan.triggers.length === 0
	) return;
	const label = target.kind === "table" ? `table "${plan.target}"` : target.kind === "function" ? `Function "${plan.target}"` : `column "${plan.target}"`;
	const count = plan.relationships.length + plan.indexes.length + plan.uniqueConstraints.length + plan.triggers.length;
	const summary = [
		...plan.relationships.map(describeAffectedRelationship),
		...plan.indexes.map((index) => `index ${index.name}`),
		...plan.uniqueConstraints.map((constraint) => `unique constraint ${constraint.name}`),
		...plan.triggers.map((trigger) => `trigger ${trigger.name} on ${trigger.table}`),
	].join(", ");
	throw new Error(
		`Removing ${label} also affects ${count} schema item(s) (${summary}). Confirm the removal to continue.`,
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
		triggers: (design.triggers ?? []).filter((trigger) => trigger.tableId !== table.id),
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
		// Removing the last UPDATE OF column removes the filter, so the trigger fires on any UPDATE.
		triggers: (design.triggers ?? []).map((trigger) => ({
			...trigger,
			events: trigger.events.map((event) => {
				if (event.event !== "UPDATE" || !event.columnIds?.includes(column.id)) return event;
				const columnIds = event.columnIds.filter((id) => id !== column.id);
				return columnIds.length ? { ...event, columnIds } : { event: "UPDATE" as const };
			}),
		})),
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

function requireEdgeFunctionName(value: string): string {
	const name = value.trim();
	if (!/^[a-z0-9_-]+$/.test(name)) {
		throw new Error("Edge function names must use lowercase letters, digits, hyphens, or underscores.");
	}
	return name;
}
