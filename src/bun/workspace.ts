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
	type CreateDesignAction,
	type DatabaseDesignSummary,
	type OpenDesignAction,
	type RenameDesignAction,
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
import {
	createProjectHistory,
	describeProjectHistory,
	recordProjectChange,
	stepProjectHistory,
	type ProjectHistory,
} from "./project-history";
import {
	applySystemLayout,
	type SystemLayoutAction,
} from "../shared/system-layout";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	describeSystemComponentRemoval,
	describeSystemConnectionRemoval,
	describeSystemServiceRemoval,
	findSystemComponent,
	findSystemConnection,
	findSystemGroup,
	findSystemService,
	hasSystemConnectionRouteChange,
	moveSystemComponent,
	moveSystemGroup,
	moveSystemService,
	normalizeSystemDesign,
	removeSystemComponent,
	removeSystemConnection,
	removeSystemGroup,
	removeSystemService,
	resizeSystemGroup,
	resizeSystemService,
	setSystemFocus,
	setSystemServiceCollapsed,
	systemDesignContent,
	withSystemPresentation,
	type SystemComponent,
	type SystemContent,
	updateSystemComponent,
	updateSystemConnection,
	updateSystemGroup,
	updateSystemService,
	type AddSystemComponentAction,
	type AddSystemConnectionAction,
	type AddSystemGroupAction,
	type AddSystemServiceAction,
	type CreateSystemDatabaseDesignAction,
	type LinkSystemDatabaseAction,
	type MoveSystemComponentAction,
	type MoveSystemGroupAction,
	type MoveSystemServiceAction,
	type RemoveSystemComponentAction,
	type RemoveSystemConnectionAction,
	type RemoveSystemGroupAction,
	type RemoveSystemServiceAction,
	type ResizeSystemGroupAction,
	type ResizeSystemServiceAction,
	type SetSystemFocusAction,
	type SetSystemServiceCollapsedAction,
	type UpdateSystemGroupAction,
	type SetActiveViewAction,
	type SetSystemViewportAction,
	type SystemAttribution,
	type SystemComponentRemovalPlan,
	type SystemConnectionRemovalPlan,
	type SystemDesign,
	type SystemGroup,
	type SystemServiceRemovalPlan,
	type UpdateSystemComponentAction,
	type UpdateSystemConnectionAction,
	type UpdateSystemServiceAction,
} from "../shared/system-design";
import {
	createProjectExportDocument,
	prepareProjectImport,
	type ProjectExportDocument,
} from "../shared/project-portability";
import {
	acceptWalkthroughStepRedirection,
	addWalkthrough,
	addWalkthroughBlock,
	addWalkthroughParallelBranch,
	addWalkthroughStep,
	findWalkthrough,
	findWalkthroughBlock,
	findWalkthroughStep,
	moveWalkthrough,
	moveWalkthroughBlock,
	moveWalkthroughStep,
	removeWalkthroughBlock,
	updateWalkthroughRepeat,
	type AddWalkthroughBlockAction,
	type AddWalkthroughParallelBranchAction,
	type MoveWalkthroughBlockAction,
	type RemoveWalkthroughBlockAction,
	type UpdateWalkthroughRepeatAction,
	normalizeWalkthroughs,
	removeWalkthrough,
	removeWalkthroughStep,
	renameWalkthrough,
	repairWalkthroughStep,
	type AcceptWalkthroughStepRedirectionAction,
	updateWalkthroughStep,
	type AddWalkthroughStepAction,
	type CreateWalkthroughAction,
	type MoveWalkthroughAction,
	type MoveWalkthroughStepAction,
	type RemoveWalkthroughAction,
	type RemoveWalkthroughStepAction,
	type RenameWalkthroughAction,
	type RepairWalkthroughStepAction,
	type UpdateWalkthroughStepAction,
	type Walkthrough,
	type WalkthroughRemovalImpact,
	walkthroughStepsOnConnections,
} from "../shared/walkthrough";

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
	/**
	 * The portable document for the open Project, built from its saved content.
	 * Provider credentials and Assistant conversations are never included.
	 */
	exportProject(): Promise<ProjectExportDocument>;
	/**
	 * Validates a portable document, creates a new Project from it in one
	 * transaction, and opens that Project. A malformed document is refused with
	 * an error naming the problem, and nothing is written.
	 */
	importProject(document: unknown): Promise<WorkspaceState>;
	/** Adds an independent database design to the open Project and opens it. */
	createDesign(action: CreateDesignAction): Promise<WorkspaceState>;
	/** Makes another design of the open Project the active one. */
	openDesign(action: OpenDesignAction): Promise<WorkspaceState>;
	renameDesign(action: RenameDesignAction): Promise<WorkspaceState>;
	createScenario(action: CreateScenarioAction): Promise<WorkspaceState>;
	renameScenario(action: RenameScenarioAction): Promise<WorkspaceState>;
	removeScenario(action: RemoveScenarioAction): Promise<WorkspaceState>;
	updateScenarioSource(action: UpdateScenarioSourceAction): Promise<WorkspaceState>;
	createEdgeFunction(action: CreateEdgeFunctionAction): Promise<WorkspaceState>;
	renameEdgeFunction(action: RenameEdgeFunctionAction): Promise<WorkspaceState>;
	removeEdgeFunction(action: RemoveEdgeFunctionAction): Promise<WorkspaceState>;
	updateEdgeFunctionSource(action: UpdateEdgeFunctionSourceAction): Promise<WorkspaceState>;
	beginScenarioRun(action: { scenarioId: string; designId: string }): Promise<{ runId: string; state: WorkspaceState }>;
	handleSandboxApiRequest(action: { runId: string; request: SandboxApiRequest }): Promise<SandboxApiResponse>;
	finishScenarioRun(action: { runId: string; status: "passed" | "failed" | "errored"; console: string[]; expectations?: ScenarioRun["expectations"]; reason?: ScenarioRun["reason"] }): Promise<WorkspaceState>;
	undo(action: { designId: string }): Promise<WorkspaceState>;
	redo(action: { designId: string }): Promise<WorkspaceState>;
	applyAssistantDesign(design: Design, designId: string, assistantTurnId?: string): Promise<WorkspaceState>;
	onAssistantDesignMutation?(listener: (turnId: string, before: Design, after: Design) => void): () => void;
	restoreAssistantProjectSnapshot(input: {
		projectId: string;
		/** The design the Assistant turn changed; restoring any other design is refused. */
		designId: string;
		design?: Design;
		scenarios?: Scenario[];
		edgeFunctions?: EdgeFunction[];
		expectedSnapshot?: { design: Design; scenarios: Scenario[]; edgeFunctions: EdgeFunction[] };
		validateAndRestore?: (currentState: WorkspaceState) => {
			ok: true;
			design: Design;
			scenarios: Scenario[];
			edgeFunctions: EdgeFunction[];
			/** Present when the turn changed the System design; restores all of its items together. */
			systemDesign?: SystemContent;
		} | {
			ok: false;
			conflicts: string[];
		};
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
	/** Throws unless `designId` names the open project's active Design. */
	requireActiveDesign(designId: string | undefined): void;
	setViewport(action: SetViewportAction): Promise<WorkspaceState>;
	/** System design edits. Each one is a single Project-history action. */
	addSystemService(action: AddSystemServiceAction): Promise<WorkspaceState>;
	updateSystemService(action: UpdateSystemServiceAction): Promise<WorkspaceState>;
	/** Moves the boundary and the Components it owns together. */
	moveSystemService(action: MoveSystemServiceAction): Promise<WorkspaceState>;
	resizeSystemService(action: ResizeSystemServiceAction): Promise<WorkspaceState>;
	/** Releases owned Components to system scope and deletes Connections that end at the Service. */
	removeSystemService(action: RemoveSystemServiceAction): Promise<WorkspaceState>;
	/**
	 * Shows a Service collapsed or expanded. This is view presentation saved with the System design, so it
	 * never enters Project history and Undo does not reverse it.
	 */
	setSystemServiceCollapsed(action: SetSystemServiceCollapsedAction): Promise<WorkspaceState>;
	/**
	 * Opens a Service's focused view with its last camera, or returns to the overview when serviceId is null.
	 * Focus is presentation saved with the System design, so it never enters Project history.
	 */
	setSystemFocus(action: SetSystemFocusAction): Promise<WorkspaceState>;
	/** Lists what removing the Service releases, deletes, and which Walkthrough steps it leaves dangling, before anything changes. */
	describeSystemServiceRemoval(serviceId: string): SystemServiceRemovalPlan & WalkthroughRemovalImpact;
	/** Groups organize Components, Services, and child Groups. Each edit is one Project-history action. */
	addSystemGroup(action: AddSystemGroupAction): Promise<WorkspaceState>;
	/** Renames a Group or replaces its members; a nesting cycle is refused and changes nothing. */
	updateSystemGroup(action: UpdateSystemGroupAction): Promise<WorkspaceState>;
	/** Moves the frame and every member it resolves to, each once. Membership is unchanged. */
	moveSystemGroup(action: MoveSystemGroupAction): Promise<WorkspaceState>;
	resizeSystemGroup(action: ResizeSystemGroupAction): Promise<WorkspaceState>;
	/** Removes the frame only; its members and their Connections stay. */
	removeSystemGroup(action: RemoveSystemGroupAction): Promise<WorkspaceState>;
	addSystemComponent(action: AddSystemComponentAction): Promise<WorkspaceState>;
	updateSystemComponent(action: UpdateSystemComponentAction): Promise<WorkspaceState>;
	moveSystemComponent(action: MoveSystemComponentAction): Promise<WorkspaceState>;
	/** Applies one explicit layout arrangement as a single Project-history action. */
	arrangeSystemLayout(action: SystemLayoutAction): Promise<WorkspaceState>;
	removeSystemComponent(action: RemoveSystemComponentAction): Promise<WorkspaceState>;
	/** Lists the Connections and Walkthrough steps that removing the Component would affect, before anything changes. */
	describeSystemComponentRemoval(componentId: string): SystemComponentRemovalPlan & WalkthroughRemovalImpact;
	addSystemConnection(action: AddSystemConnectionAction): Promise<WorkspaceState>;
	updateSystemConnection(action: UpdateSystemConnectionAction): Promise<WorkspaceState>;
	removeSystemConnection(action: RemoveSystemConnectionAction): Promise<WorkspaceState>;
	/** Lists the Walkthrough steps that removing the Connection would leave dangling, before anything changes. */
	describeSystemConnectionRemoval(connectionId: string): SystemConnectionRemovalPlan & WalkthroughRemovalImpact;
	/** Saves the overview's pan and zoom. Navigation stays outside Project history. */
	setSystemViewport(action: SetSystemViewportAction): Promise<WorkspaceState>;
	/** Records the view to reopen for this Project. Navigation stays outside Project history. */
	setActiveView(action: SetActiveViewAction): Promise<WorkspaceState>;
	/**
	 * Links a Database component to a Design of the Project, or unlinks it with
	 * `null`. Several Database components may name one Design: a Shared schema.
	 * The Design itself, its Scenarios, and its Edge functions are never changed.
	 */
	linkSystemDatabase(action: LinkSystemDatabaseAction): Promise<WorkspaceState>;
	/**
	 * Creates a database Design in the Project for a conceptual Database component
	 * and links it. The new Design becomes the active one; the overview stays open.
	 */
	createSystemDatabaseDesign(action: CreateSystemDatabaseDesignAction): Promise<WorkspaceState>;
	/** Walkthrough edits. Each one is a single Project-history action; steps are never deleted by topology changes. */
	createWalkthrough(action: CreateWalkthroughAction): Promise<WorkspaceState>;
	renameWalkthrough(action: RenameWalkthroughAction): Promise<WorkspaceState>;
	removeWalkthrough(action: RemoveWalkthroughAction): Promise<WorkspaceState>;
	moveWalkthrough(action: MoveWalkthroughAction): Promise<WorkspaceState>;
	addWalkthroughStep(action: AddWalkthroughStepAction): Promise<WorkspaceState>;
	updateWalkthroughStep(action: UpdateWalkthroughStepAction): Promise<WorkspaceState>;
	moveWalkthroughStep(action: MoveWalkthroughStepAction): Promise<WorkspaceState>;
	removeWalkthroughStep(action: RemoveWalkthroughStepAction): Promise<WorkspaceState>;
	addWalkthroughBlock(action: AddWalkthroughBlockAction): Promise<WorkspaceState>;
	addWalkthroughParallelBranch(action: AddWalkthroughParallelBranchAction): Promise<WorkspaceState>;
	updateWalkthroughRepeat(action: UpdateWalkthroughRepeatAction): Promise<WorkspaceState>;
	moveWalkthroughBlock(action: MoveWalkthroughBlockAction): Promise<WorkspaceState>;
	removeWalkthroughBlock(action: RemoveWalkthroughBlockAction): Promise<WorkspaceState>;
	/** Points a step at a Connection and accepts that Connection's current endpoints. */
	repairWalkthroughStep(action: RepairWalkthroughStepAction): Promise<WorkspaceState>;
	/** Accepts the changed route of a redirected step. Only that step's recorded endpoints change. */
	acceptWalkthroughStepRedirection(action: AcceptWalkthroughStepRedirectionAction): Promise<WorkspaceState>;
	close(): Promise<void>;
}

const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

/**
 * Content that Undo, Redo, and Assistant Revert move together. Snapshots hold
 * a placeholder viewport because navigation is outside content history.
 * Later System design and Walkthrough content extends this type.
 */
type ProjectContent = {
	design: Design;
	scenarios: Scenario[];
	edgeFunctions: EdgeFunction[];
	/** Components and Connections only; the overview viewport is navigation. */
	systemDesign: SystemContent;
	walkthroughs: Walkthrough[];
};

/** How one content change is named, grouped, and attributed in the history. */
type HistoryAction = {
	name: string;
	coalesceKey?: string;
	assistantTurnId?: string;
};

const ASSISTANT_TURN_ACTION_NAME = "Assistant turn";
const REVERT_ASSISTANT_TURN_ACTION_NAME = "Revert Assistant turn";

export async function createDesignWorkspace(
	options: DesignWorkspaceOptions,
): Promise<DesignWorkspace> {
	const store =
		options.openStore?.(options.databasePath) ?? openDesignStore(options.databasePath);
	const createSandbox = options.createSandbox ?? createPGliteSandbox;
	const now = options.now ?? (() => Date.now());
	const createId = options.createId ?? (() => crypto.randomUUID());

	const listeners = new Set<WorkspaceListener>();
	/**
	 * One content history per database design. Each design's Undo and Redo
	 * move only its own content, so switching designs never changes what
	 * another design's Undo would reverse. Histories last for the session.
	 */
	const histories = new Map<string, ProjectHistory<ProjectContent>>();

	const assistantMutationListeners = new Set<(turnId: string, before: Design, after: Design) => void>();

	function projectContent(
		design: Design,
		scenarios: Scenario[],
		edgeFunctions: EdgeFunction[],
		systemDesign: SystemDesign | null = state.systemDesign ?? null,
		walkthroughs: Walkthrough[] = state.walkthroughs ?? [],
	): ProjectContent {
		const system = systemDesign ? systemDesignContent(systemDesign) : { services: [], groups: [], components: [], connections: [] };
		return structuredClone({
			design: { ...design, viewport: DEFAULT_VIEWPORT },
			scenarios,
			edgeFunctions,
			systemDesign: system,
			walkthroughs,
		});
	}

	/** The single entry point for recording content changes into the open Project's history. */
	function recordContentChange(
		action: HistoryAction,
		before: ProjectContent,
		after: ProjectContent,
		structural: boolean,
	) {
		if (activeDesignId === null) return;
		let history = histories.get(activeDesignId);
		if (!history) {
			history = createProjectHistory();
			histories.set(activeDesignId, history);
		}
		recordProjectChange(history, {
			name: action.name,
			before,
			after,
			structural,
			...(action.coalesceKey !== undefined ? { coalesceKey: action.coalesceKey } : {}),
			...(action.assistantTurnId !== undefined ? { assistantTurnId: action.assistantTurnId } : {}),
		}, now());
	}

	let state: WorkspaceState = {
		projects: store.listProjects(),
		project: null,
		design: null,
		activeDesignId: null,
		designs: [],
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
		systemDesign: null,
		systemSave: { status: "idle" },
		activeView: "system",
		walkthroughs: [],
		walkthroughSave: { status: "idle" },
	};
	let activeProjectId: string | null = null;
	let activeDesignId: string | null = null;
	/** Orders every stored document, including layout-only writes. */
	let documentRevision = 0;
	let scenarioRevision = 0;
	let edgeFunctionRevision = 0;
	/** Orders System design document writes; separate from the database Design's document revision. */
	let systemDocumentRevision = 0;
	/** Orders Walkthrough document writes, including those made by Undo and Redo. */
	let walkthroughDocumentRevision = 0;
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
		const history = next.project && activeDesignId !== null ? histories.get(activeDesignId) : undefined;
		const { canUndo, canRedo, undoActionName, redoActionName } = describeProjectHistory(history);
		next = {
			...next,
			undoRedo: { canUndo, canRedo },
			undoActionName,
			redoActionName,
		};
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
		designId: string,
	) {
		return (
			activeProjectId === projectId &&
			activeDesignId === designId &&
			state.revision === revision &&
			documentRevision === documentRevisionToSave
		);
	}
	function isCurrentPreview(projectId: string, revision: number, requestId: number, designId: string) {
		return (
			previewRequestId === requestId &&
			activeProjectId === projectId &&
			activeDesignId === designId &&
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

	function schedulePreview(projectId: string, revision: number, design: Design, designId: string) {
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
		designId: string,
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
		designId: string,
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
		designId: string,
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

	async function saveEdgeFunctions(projectId: string, edgeFunctions: EdgeFunction[], revision: number, projectGeneration: number, designId: string) {
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

	async function updateEdgeFunctions(
		projectId: string,
		update: (items: EdgeFunction[]) => EdgeFunction[],
		designId: string,
		action: HistoryAction,
	) {
		const open = requireOpenDesign(designId);
		const targetDesignId = open.designId;
		const edgeFunctions = update(state.edgeFunctions);
		recordContentChange(
			action,
			projectContent(open.design, state.scenarios, state.edgeFunctions),
			projectContent(open.design, state.scenarios, edgeFunctions),
			false,
		);
		const revision = edgeFunctionRevision + 1;
		edgeFunctionRevision = revision;
		setState({ ...state, edgeFunctions, edgeFunctionSave: { status: "saving", revision, designId: targetDesignId } });
		const committedState = state;
		await saveEdgeFunctions(projectId, edgeFunctions, revision, edgeFunctionProjectGeneration, targetDesignId);
		return activeProjectId === projectId && activeDesignId === targetDesignId ? state : committedState;
	}

	async function updateScenarios(
		projectId: string,
		update: (scenarios: Scenario[]) => Scenario[],
		designId: string,
		action: HistoryAction,
	) {
		const open = requireOpenDesign(designId);
		const targetDesignId = open.designId;
		const scenarios = update(state.scenarios);
		recordContentChange(
			action,
			projectContent(open.design, state.scenarios, state.edgeFunctions),
			projectContent(open.design, scenarios, state.edgeFunctions),
			false,
		);
		const revision = scenarioRevision + 1;
		scenarioRevision = revision;
		setState({
			...state,
			scenarios,
			scenarioSave: { status: "saving", revision, designId: targetDesignId },
		});
		const committedState = state;
		await saveScenarios(projectId, scenarios, revision, targetDesignId);
		return activeProjectId === projectId && activeDesignId === targetDesignId ? state : committedState;
	}
	/** Saves the draft immediately and debounces its disposable preview rebuild. */
	async function applyStructuralChange(
		projectId: string,
		design: Design,
		action: HistoryAction | null,
		designId: string,
	) {
		const targetDesignId = requireOpenDesign(designId).designId;
		const before = state.design;
		if (!before) throw new Error("Open a project before editing its design.");
		if (action) {
			recordContentChange(
				action,
				projectContent(before, state.scenarios, state.edgeFunctions),
				projectContent(design, state.scenarios, state.edgeFunctions),
				true,
			);
		}
		const revision = state.revision + 1;
		const nextDocumentRevision = documentRevision + 1;
		documentRevision = nextDocumentRevision;
		const lastApplied = getLastAppliedSandbox(state.sandbox);
		setState({
			...state,
			design,
			revision,
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
		action: HistoryAction | null,
		designId: string,
	) {
		const targetDesignId = requireOpenDesign(designId).designId;
		const before = state.design;
		if (!before) throw new Error("Open a project before editing its design.");
		if (action) {
			recordContentChange(
				action,
				projectContent(before, state.scenarios, state.edgeFunctions),
				projectContent(design, state.scenarios, state.edgeFunctions),
				false,
			);
		}
		const revision = state.revision;
		const nextDocumentRevision = documentRevision + 1;
		documentRevision = nextDocumentRevision;
		setState({
			...state,
			design,
			save: { status: "saving", revision, designId: targetDesignId },
		});
		await saveDocument(projectId, revision, nextDocumentRevision, design, targetDesignId);
		return state;
	}

	/**
	 * Moves the Project history one step and restores that side's content. The
	 * cursor only moves when the restored content is saved, so a failed Undo or
	 * Redo leaves both the Project and the history unchanged.
	 */
	async function applyHistoryChange(direction: "undo" | "redo", targetDesignId: string) {
		const { projectId, designId } = requireOpenDesign(targetDesignId);
		const history = histories.get(designId);
		if (!history) return state;

		const previousCursor = history.cursor;
		const entry = stepProjectHistory(history, direction);
		if (!entry) return state;
		try {
			const target = direction === "undo" ? entry.before : entry.after;
			return await applyProjectContent(projectId, designId, target, entry.structural);
		} catch (error) {
			history.cursor = previousCursor;
			setState({ ...state });
			throw error;
		}
	}

	/**
	 * Replaces the design, Scenarios, and Edge functions with a history snapshot
	 * in one atomic save. Only the parts that differ are written and revised.
	 */
	async function applyProjectContent(
		projectId: string,
		designId: string,
		target: ProjectContent,
		structural: boolean,
	) {
		const current = state;
		if (!current.design) throw new Error("Open a project before editing its design.");
		const design: Design = { ...structuredClone(target.design), viewport: current.design.viewport };
		const designChanged = JSON.stringify({ ...current.design, viewport: DEFAULT_VIEWPORT })
			!== JSON.stringify({ ...design, viewport: DEFAULT_VIEWPORT });
		const scenariosChanged = JSON.stringify(current.scenarios) !== JSON.stringify(target.scenarios);
		const edgeFunctionsChanged = JSON.stringify(current.edgeFunctions) !== JSON.stringify(target.edgeFunctions);
		const currentSystem = current.systemDesign ? systemDesignContent(current.systemDesign) : null;
		const systemChanged = currentSystem !== null && JSON.stringify(currentSystem) !== JSON.stringify(target.systemDesign);
		const walkthroughsChanged = JSON.stringify(current.walkthroughs ?? []) !== JSON.stringify(target.walkthroughs);
		if (!designChanged && !scenariosChanged && !edgeFunctionsChanged && !systemChanged && !walkthroughsChanged) return current;
		const nextSystemDesign: SystemDesign | null = systemChanged && current.systemDesign
			? withSystemPresentation(structuredClone(target.systemDesign), current.systemDesign)
			: current.systemDesign ?? null;

		const schemaChanged = designChanged && structural;
		const previousRevisions = {
			documentRevision,
			scenarioRevision,
			edgeFunctionRevision,
			systemDocumentRevision,
			walkthroughDocumentRevision,
		};
		const nextSystemDocumentRevision = systemChanged ? ++systemDocumentRevision : systemDocumentRevision;
		const nextWalkthroughDocumentRevision = walkthroughsChanged ? ++walkthroughDocumentRevision : walkthroughDocumentRevision;
		const savedAt = now();
		const nextRevision = schemaChanged ? current.revision + 1 : current.revision;
		const nextDocumentRevision = designChanged ? ++documentRevision : documentRevision;
		const nextScenarioRevision = scenariosChanged ? ++scenarioRevision : scenarioRevision;
		const nextEdgeFunctionRevision = edgeFunctionsChanged ? ++edgeFunctionRevision : edgeFunctionRevision;
		const lastApplied = getLastAppliedSandbox(current.sandbox);
		setState({
			...current,
			design: designChanged ? design : current.design,
			revision: nextRevision,
			scenarios: scenariosChanged ? structuredClone(target.scenarios) : current.scenarios,
			edgeFunctions: edgeFunctionsChanged ? structuredClone(target.edgeFunctions) : current.edgeFunctions,
			systemDesign: nextSystemDesign,
			systemSave: systemChanged && nextSystemDesign
				? { status: "saving", revision: nextSystemDocumentRevision, designId }
				: current.systemSave,
			walkthroughs: walkthroughsChanged ? structuredClone(target.walkthroughs) : current.walkthroughs,
			walkthroughSave: walkthroughsChanged
				? { status: "saving", revision: nextWalkthroughDocumentRevision, designId }
				: current.walkthroughSave,
			save: designChanged ? { status: "saving", revision: nextRevision, designId } : current.save,
			scenarioSave: scenariosChanged
				? { status: "saving", revision: nextScenarioRevision, designId }
				: current.scenarioSave,
			edgeFunctionSave: edgeFunctionsChanged
				? { status: "saving", revision: nextEdgeFunctionRevision, designId }
				: current.edgeFunctionSave,
			...(schemaChanged
				? {
						sql: {
							status: "checking",
							draftRevision: nextRevision,
							availableRevision: lastGeneratableSql?.revision ?? null,
							sql: lastGeneratableSql?.sql ?? null,
							designId,
						},
						sandbox: lastApplied === null
							? { status: "idle" }
							: { status: "applied", ...lastApplied, designId },
					}
				: {}),
		});
		try {
			await store.saveProjectArtifacts({
				projectId,
				designId,
				...(designChanged
					? { design: { design, save: { revision: nextRevision, documentRevision: nextDocumentRevision, savedAt } } }
					: {}),
				...(scenariosChanged
					? { scenarios: { scenarios: target.scenarios, save: { revision: nextScenarioRevision, savedAt } } }
					: {}),
				...(edgeFunctionsChanged
					? { edgeFunctions: { edgeFunctions: target.edgeFunctions, save: { revision: nextEdgeFunctionRevision, savedAt } } }
					: {}),
				...(systemChanged && nextSystemDesign
					? { systemDesign: { systemDesign: nextSystemDesign, save: { revision: nextSystemDocumentRevision, documentRevision: nextSystemDocumentRevision, savedAt } } }
					: {}),
				...(walkthroughsChanged
					? { walkthroughs: { walkthroughs: target.walkthroughs, save: { revision: nextWalkthroughDocumentRevision, savedAt } } }
					: {}),
			});
		} catch (error) {
			documentRevision = previousRevisions.documentRevision;
			scenarioRevision = previousRevisions.scenarioRevision;
			edgeFunctionRevision = previousRevisions.edgeFunctionRevision;
			systemDocumentRevision = previousRevisions.systemDocumentRevision;
			walkthroughDocumentRevision = previousRevisions.walkthroughDocumentRevision;
			if (activeDesignId === designId) setState(current);
			throw error;
		}
		const latest = documentRevision === nextDocumentRevision
			&& scenarioRevision === nextScenarioRevision
			&& edgeFunctionRevision === nextEdgeFunctionRevision
			&& systemDocumentRevision === nextSystemDocumentRevision
			&& walkthroughDocumentRevision === nextWalkthroughDocumentRevision;
		if (latest && state.project?.id === projectId && activeDesignId === designId) {
			setState({
				...state,
				projects: store.listProjects(),
				...(designChanged ? { save: { status: "saved", revision: nextRevision, savedAt, designId } } : {}),
				...(scenariosChanged ? { scenarioSave: { status: "saved", revision: nextScenarioRevision, savedAt, designId } } : {}),
				...(edgeFunctionsChanged ? { edgeFunctionSave: { status: "saved", revision: nextEdgeFunctionRevision, savedAt, designId } } : {}),
				...(systemChanged ? { systemSave: { status: "saved", revision: nextSystemDocumentRevision, savedAt, designId } } : {}),
				...(walkthroughsChanged ? { walkthroughSave: { status: "saved", revision: nextWalkthroughDocumentRevision, savedAt, designId } } : {}),
			});
		}
		if (schemaChanged) await schedulePreview(projectId, nextRevision, design, designId);
		return state;
	}

	/**
	 * Makes one stored design of a Project the active one. The previous design's
	 * saves keep their own design identity and finish in the background; only
	 * what the designer sees changes here.
	 */
	async function activateDesign(project: ProjectSummary, designId: string, options: { openingProject?: boolean } = {}) {
		const record = store.loadDesign(designId);
		if (!record || record.projectId !== project.id) {
			throw new Error("That design could not be found in this project.");
		}
		const design = normalizeDesign(record.design);
		const scenarioDocument = store.loadScenarios(project.id, designId);
		const edgeFunctionDocument = store.loadEdgeFunctions(project.id, designId);

		await disposeActiveScenarioRun();
		invalidatePreviewWork();
		activeProjectId = project.id;
		activeDesignId = designId;
		edgeFunctionProjectGeneration += 1;
		documentRevision = record.documentRevision;
		// Revisions only move forward within a session, so a save still in flight
		// for an earlier activation can never share a revision with a new one.
		edgeFunctionRevision = Math.max(edgeFunctionRevision, edgeFunctionDocument.revision);
		scenarioRevision = scenarioDocument.revision;
		// The System design and Walkthroughs belong to the Project, so they load only when the Project opens.
		// Switching designs keeps what is already loaded, along with the view.
		const systemRecord = options.openingProject ? store.loadSystemDesign(project.id) : null;
		if (options.openingProject) {
			systemDocumentRevision = systemRecord?.documentRevision ?? 0;
		}
		const walkthroughRecord = options.openingProject ? store.loadWalkthroughs(project.id) : null;
		if (options.openingProject) {
			walkthroughDocumentRevision = walkthroughRecord?.revision ?? 0;
		}
		lastGeneratableSql = null;
		setState({
			projects: store.listProjects(),
			project,
			designs: store.listDesigns(project.id),
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
			undoRedo: { canUndo: false, canRedo: false },
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
			// The workspace state is replaced, not merged, so project-level fields are carried over explicitly.
			...(options.openingProject
				? {
						systemDesign: systemRecord ? normalizeSystemDesign(systemRecord.document) : createEmptySystemDesign(),
						systemSave: systemRecord
							? { status: "saved" as const, revision: systemRecord.revision, savedAt: systemRecord.savedAt, designId }
							: { status: "idle" as const },
						activeView: systemRecord?.lastView ?? "system",
						walkthroughs: walkthroughRecord ? normalizeWalkthroughs(walkthroughRecord.document) : [],
						walkthroughSave: walkthroughRecord
							? { status: "saved" as const, revision: walkthroughRecord.revision, savedAt: walkthroughRecord.savedAt, designId }
							: { status: "idle" as const },
					}
				: {
						systemDesign: state.systemDesign,
						systemSave: state.systemSave,
						activeView: state.activeView,
						walkthroughs: state.walkthroughs,
						walkthroughSave: state.walkthroughSave,
					}),
		});
		if (design.tables.length > 0) {
			const requestId = ++previewRequestId;
			await generateAndApply(project.id, record.revision, design, requestId, designId);
		}
		return state;
	}

	/** A design name is trimmed, non-empty, and unique within its Project, ignoring case. */
	function requireDesignName(value: string, others: DatabaseDesignSummary[]): string {
		const name = value.trim();
		if (name.length === 0) throw new Error("Design name is required.");
		if (others.some((design) => design.name.trim().toLowerCase() === name.toLowerCase())) {
			throw new Error(`A design named “${name}” already exists in this project.`);
		}
		return name;
	}

	function requireDesignOwner(designId: string): { project: ProjectSummary; design: DatabaseDesignSummary; designs: DatabaseDesignSummary[] } {
		const project = state.project;
		if (!project || activeProjectId === null) throw new Error("Open a project before managing its designs.");
		const designs = store.listDesigns(project.id);
		const design = designs.find((candidate) => candidate.id === designId);
		if (!design) throw new Error("That design could not be found in this project.");
		return { project, design, designs };
	}

	function requireOpenDesign(targetDesignId: string): { projectId: string; design: Design; designId: string } {
		if (!state.project || !state.design || activeProjectId === null || activeDesignId === null) {
			throw new Error("Open a project before editing its design.");
		}
		if (typeof targetDesignId !== "string" || targetDesignId.length === 0) {
			throw new Error("A database design ID is required.");
		}
		if (targetDesignId !== activeDesignId) {
			throw new Error(`Target database design '${targetDesignId}' is not the active design.`);
		}
		return { projectId: activeProjectId, design: state.design, designId: activeDesignId };
	}

	/** System design edits need an open Project, not a particular database Design. */
	function requireOpenProject(): { projectId: string; designId: string } {
		if (!state.project || !state.systemDesign || activeProjectId === null || activeDesignId === null) {
			throw new Error("Open a project before editing its System design.");
		}
		return { projectId: activeProjectId, designId: activeDesignId };
	}

	/**
	 * Applies one System design change: validate it, record it as one history
	 * action, then save the whole document. A failed save keeps the draft and
	 * shows the error; the next successful save writes the whole document.
	 */
	async function applySystemDesignChange(
		mutate: (design: SystemDesign) => { next: SystemDesign; action: HistoryAction },
	): Promise<WorkspaceState> {
		const { projectId, designId } = requireOpenProject();
		const current = state.systemDesign!;
		const { next, action } = mutate(current);
		if (JSON.stringify(systemDesignContent(next)) === JSON.stringify(systemDesignContent(current))) return state;
		recordContentChange(
			action,
			projectContent(state.design!, state.scenarios, state.edgeFunctions, current),
			projectContent(state.design!, state.scenarios, state.edgeFunctions, next),
			false,
		);
		return persistSystemDesign(projectId, designId, next);
	}

	function persistSystemDesign(projectId: string, designId: string, next: SystemDesign): WorkspaceState {
		const revision = ++systemDocumentRevision;
		const savedAt = now();
		setState({ ...state, systemDesign: next, systemSave: { status: "saving", revision, designId } });
		try {
			store.saveSystemDesign(projectId, next, { revision, documentRevision: revision, savedAt });
			if (activeProjectId === projectId && systemDocumentRevision === revision) {
				setState({ ...state, systemSave: { status: "saved", revision, savedAt, designId } });
			}
		} catch (error) {
			if (activeProjectId === projectId && systemDocumentRevision === revision) {
				setState({
					...state,
					systemSave: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
						designId,
					},
				});
			}
		}
		return state;
	}

	/** The Walkthrough steps that removing these Connections leaves dangling, across the open Project's Walkthroughs. */
	function walkthroughRemovalImpact(connections: readonly { id: string }[]): WalkthroughRemovalImpact {
		return { walkthroughSteps: walkthroughStepsOnConnections(state.walkthroughs ?? [], connections.map((connection) => connection.id)) };
	}

	/**
	 * Applies one Walkthrough change: record it as one history action, then save
	 * the whole Walkthrough document. As with the System design, a failed save
	 * keeps the draft visible and the next successful save writes all of it.
	 */
	async function applyWalkthroughChange(
		mutate: (walkthroughs: Walkthrough[]) => { next: Walkthrough[]; action: HistoryAction },
	): Promise<WorkspaceState> {
		const { projectId, designId } = requireOpenProject();
		const current = state.walkthroughs ?? [];
		const { next, action } = mutate(current);
		if (JSON.stringify(next) === JSON.stringify(current)) return state;
		recordContentChange(
			action,
			projectContent(state.design!, state.scenarios, state.edgeFunctions, state.systemDesign ?? null, current),
			projectContent(state.design!, state.scenarios, state.edgeFunctions, state.systemDesign ?? null, next),
			false,
		);
		return persistWalkthroughs(projectId, designId, next);
	}

	function persistWalkthroughs(projectId: string, designId: string, next: Walkthrough[]): WorkspaceState {
		const revision = ++walkthroughDocumentRevision;
		const savedAt = now();
		setState({ ...state, walkthroughs: next, walkthroughSave: { status: "saving", revision, designId } });
		try {
			store.saveWalkthroughs(projectId, next, { revision, savedAt });
			if (activeProjectId === projectId && walkthroughDocumentRevision === revision) {
				setState({ ...state, walkthroughSave: { status: "saved", revision, savedAt, designId } });
			}
		} catch (error) {
			if (activeProjectId === projectId && walkthroughDocumentRevision === revision) {
				setState({
					...state,
					walkthroughSave: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
						designId,
					},
				});
			}
		}
		return state;
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
				systemDocumentRevision = revision;
				walkthroughDocumentRevision = 0;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project,
					designs: store.listDesigns(project.id),
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
					undoRedo: { canUndo: false, canRedo: false },
					systemDesign: createEmptySystemDesign(),
					systemSave: { status: "saved", revision, savedAt, designId },
					activeView: "system",
					walkthroughs: [],
					walkthroughSave: { status: "idle" },
				});
				return state;
			});
		},
		openProject(action) {
			return runTask(async () => {
				const record = store.loadProject(action.projectId);
				if (!record) throw new Error("That project could not be found.");
				return activateDesign(record.project, record.designId, { openingProject: true });
			});
		},
		exportProject() {
			return runTask(async () => {
				const project = state.project;
				if (!project || activeProjectId === null) throw new Error("Open a project before exporting it.");
				const projectId = project.id;
				const systemRecord = store.loadSystemDesign(projectId);
				const walkthroughRecord = store.loadWalkthroughs(projectId);
				const designs = store.listDesigns(projectId).map((summary) => {
					const record = store.loadDesign(summary.id);
					if (!record) throw new Error(`Design "${summary.name || summary.id}" could not be read.`);
					return {
						id: summary.id,
						name: summary.name,
						design: record.design,
						scenarios: store.loadScenarios(projectId, summary.id).scenarios,
						edgeFunctions: store.loadEdgeFunctions(projectId, summary.id).edgeFunctions,
					};
				});
				return createProjectExportDocument({
					projectName: project.name,
					activeDesignId: activeDesignId!,
					activeView: systemRecord?.lastView ?? "system",
					systemDesign: systemRecord ? normalizeSystemDesign(systemRecord.document) : createEmptySystemDesign(),
					walkthroughs: walkthroughRecord ? normalizeWalkthroughs(walkthroughRecord.document) : [],
					designs,
				});
			});
		},
		importProject(document) {
			return runTask(async () => {
				// Everything is validated and given fresh identities before the first write.
				const prepared = prepareProjectImport(document, { createId, normalizeDesign: normalizeImportedDesign });
				store.importProject(prepared, now());
				setState({ ...state, projects: store.listProjects() });
				return activateDesign({ id: prepared.project.id, name: prepared.project.name }, prepared.activeDesignId, {
					openingProject: true,
				});
			});
		},
		createDesign(action) {
			return runTask(async () => {
				const project = state.project;
				if (!project || activeProjectId === null) throw new Error("Open a project before adding a design.");
				const existing = store.listDesigns(project.id);
				const name = action.name.trim().length > 0
					? requireDesignName(action.name, existing)
					: nextDefaultDesignName(existing);
				const designId = createId();
				const savedAt = now();
				await store.createDesign(project.id, designId, name, createEmptyDesign(), {
					revision: 1,
					documentRevision: 1,
					savedAt,
				});
				return activateDesign(project, designId);
			});
		},
		openDesign(action) {
			return runTask(async () => {
				const project = state.project;
				if (!project || activeProjectId === null) throw new Error("Open a project before choosing a design.");
				requireDesignOwner(action.designId);
				if (action.designId === activeDesignId) return state;
				return activateDesign(project, action.designId);
			});
		},
		renameDesign(action) {
			return runTask(async () => {
				const { project, design, designs } = requireDesignOwner(action.designId);
				const name = requireDesignName(action.name, designs.filter((candidate) => candidate.id !== design.id));
				await store.renameDesign(project.id, design.id, name, now());
				setState({
					...state,
					projects: store.listProjects(),
					designs: store.listDesigns(project.id),
				});
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
				return await updateEdgeFunctions(projectId, (items) => [...items, edgeFunction], designId, {
					name: `Add Edge function “${name}”`,
					assistantTurnId: action.assistantTurnId,
				});
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
				return await updateEdgeFunctions(projectId, (items) =>
					items.map((item) => item.id === current.id ? { ...item, name } : item),
				designId, {
					name: `Rename Edge function to “${name}”`,
					assistantTurnId: action.assistantTurnId,
				});
			});
		},
		removeEdgeFunction(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				if (!state.edgeFunctions.some((item) => item.id === action.edgeFunctionId)) {
					throw new Error("That Edge function could not be found.");
				}
				const removed = state.edgeFunctions.find((item) => item.id === action.edgeFunctionId)!;
				return await updateEdgeFunctions(projectId, (items) => items.filter((item) => item.id !== action.edgeFunctionId), designId, {
					name: `Remove Edge function “${removed.name}”`,
					assistantTurnId: action.assistantTurnId,
				});
			});
		},
		updateEdgeFunctionSource(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const edgeFunction = state.edgeFunctions.find((item) => item.id === action.edgeFunctionId);
				if (!edgeFunction) throw new Error("That Edge function could not be found.");
				if (edgeFunction.source === action.source) return state;
				return await updateEdgeFunctions(projectId, (items) =>
					items.map((item) => item.id === edgeFunction.id ? { ...item, source: action.source } : item),
					designId, {
						name: `Edit “${edgeFunction.name}” handler`,
						coalesceKey: `edge-function-source:${edgeFunction.id}`,
						assistantTurnId: action.assistantTurnId,
					});
			});
		},
		createScenario(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const name = action.name.trim();
				if (!name) throw new Error("Scenario name is required.");
				const scenario: Scenario = { id: createId(), name, source: "", designId };
				return await updateScenarios(projectId, (scenarios) => [...scenarios, scenario], designId, {
					name: `Add scenario “${name}”`,
					assistantTurnId: action.assistantTurnId,
				});
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
				return await updateScenarios(projectId, (scenarios) =>
					scenarios.map((item) => item.id === action.scenarioId ? { ...item, name } : item),
					designId, {
						name: `Rename scenario to “${name}”`,
						coalesceKey: `scenario-name:${scenario.id}`,
						assistantTurnId: action.assistantTurnId,
					});
			});
		},
		removeScenario(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				if (!state.scenarios.some((item) => item.id === action.scenarioId)) {
					throw new Error("That scenario could not be found.");
				}
				const removed = state.scenarios.find((item) => item.id === action.scenarioId)!;
				return await updateScenarios(projectId, (scenarios) =>
					scenarios.filter((item) => item.id !== action.scenarioId),
					designId, {
						name: `Remove scenario “${removed.name}”`,
						assistantTurnId: action.assistantTurnId,
					});
			});
		},
		updateScenarioSource(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenDesign(action.designId);
				const scenario = state.scenarios.find((item) => item.id === action.scenarioId);
				if (!scenario) throw new Error("That scenario could not be found.");
				if (scenario.source === action.source) return state;
				return await updateScenarios(projectId, (scenarios) =>
					scenarios.map((item) =>
						item.id === action.scenarioId ? { ...item, source: action.source } : item,
					),
					designId, {
						name: `Edit “${scenario.name}” source`,
						coalesceKey: `scenario-source:${scenario.id}`,
						assistantTurnId: action.assistantTurnId,
					});
			});
		},
		beginScenarioRun(action: { scenarioId: string; designId: string }) {
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
		undo(action) {
			return runTask(() => applyHistoryChange("undo", action.designId));
		},
		redo(action) {
			return runTask(() => applyHistoryChange("redo", action.designId));
		},
		applyAssistantDesign(design, targetDesignId, assistantTurnId) {
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
				if (assistantTurnId) {
					for (const listener of assistantMutationListeners) {
						listener(assistantTurnId, currentDesign, validated);
					}
				}
				return applyStructuralChange(projectId, validated, { name: assistantTurnId ? ASSISTANT_TURN_ACTION_NAME : "Assistant design change", assistantTurnId }, designId);
			});
		},
		restoreAssistantProjectSnapshot(input) {
			return runTask(async () => {
				const current = state;
				if (current.project?.id !== input.projectId || !current.design) throw new Error("The Assistant turn belongs to a different open project.");
				if (activeDesignId !== input.designId) throw new Error("The Assistant turn belongs to a different design. Open that design to revert it.");
				const designId = input.designId;
				let targetDesign = input.design;
				let targetScenarios = input.scenarios;
				let targetEdgeFunctions = input.edgeFunctions;
				let targetSystem: SystemContent | undefined;

				if (input.validateAndRestore) {
					const result = input.validateAndRestore(current);
					if (result.ok === false) {
						throw new Error(`Cannot revert Assistant turn due to conflicting items: ${result.conflicts.join("; ")}`);
					}
					targetDesign = result.design;
					targetScenarios = result.scenarios;
					targetEdgeFunctions = result.edgeFunctions;
					targetSystem = result.systemDesign;
				}

				if (!targetDesign || !targetScenarios || !targetEdgeFunctions) {
					throw new Error("Missing restoration payload.");
				}

				if (input.expectedSnapshot) {
					const currentContent = { design: { ...current.design, viewport: null }, scenarios: current.scenarios, edgeFunctions: current.edgeFunctions };
					const expectedContent = { design: { ...input.expectedSnapshot.design, viewport: null }, scenarios: input.expectedSnapshot.scenarios, edgeFunctions: input.expectedSnapshot.edgeFunctions };
					if (JSON.stringify(currentContent) !== JSON.stringify(expectedContent)) throw new Error("The project changed after this Assistant turn; it can no longer be reverted.");
				}
				const restored = normalizeDesign({ ...targetDesign, viewport: current.design.viewport });
				const systemChanged = current.systemDesign !== null && current.systemDesign !== undefined
					&& targetSystem !== undefined
					&& JSON.stringify(systemDesignContent(current.systemDesign)) !== JSON.stringify(targetSystem);
				const nextSystem: SystemDesign | null = systemChanged && current.systemDesign
					? withSystemPresentation(structuredClone(targetSystem!), current.systemDesign)
					: current.systemDesign ?? null;
				const nextRevision = state.revision + 1;
				const nextDocumentRevision = ++documentRevision;
				const nextScenarioRevision = ++scenarioRevision;
				const nextEdgeFunctionRevision = ++edgeFunctionRevision;
				const nextSystemDocumentRevision = systemChanged ? ++systemDocumentRevision : systemDocumentRevision;
				const savedAt = now();
				const history = histories.get(designId);
				const originalHistory = history ? structuredClone(history) : undefined;
				recordContentChange(
					{ name: REVERT_ASSISTANT_TURN_ACTION_NAME },
					projectContent(current.design, current.scenarios, current.edgeFunctions),
					projectContent(restored, targetScenarios, targetEdgeFunctions, nextSystem),
					true,
				);
				const lastApplied = getLastAppliedSandbox(state.sandbox);
				setState({
					...state,
					design: restored,
					revision: nextRevision,
					scenarios: targetScenarios,
					edgeFunctions: targetEdgeFunctions,
					systemDesign: nextSystem,
					...(systemChanged ? { systemSave: { status: "saving" as const, revision: nextSystemDocumentRevision, designId } } : {}),
					save: { status: "saving", revision: nextRevision, designId },
					scenarioSave: { status: "saving", revision: nextScenarioRevision, designId },
					edgeFunctionSave: { status: "saving", revision: nextEdgeFunctionRevision, designId },
					sql: {
						status: "checking",
						draftRevision: nextRevision,
						availableRevision: lastGeneratableSql?.revision ?? null,
						sql: lastGeneratableSql?.sql ?? null,
					},
					sandbox: lastApplied === null ? { status: "idle" } : { status: "applied", ...lastApplied },
				});
				const initialSave = {
					projectId: input.projectId,
					designId,
					design: { design: restored, save: { revision: nextRevision, documentRevision: nextDocumentRevision, savedAt } },
					scenarios: { scenarios: targetScenarios, save: { revision: nextScenarioRevision, savedAt } },
					edgeFunctions: { edgeFunctions: targetEdgeFunctions, save: { revision: nextEdgeFunctionRevision, savedAt } },
					...(systemChanged && nextSystem
						? { systemDesign: { systemDesign: nextSystem, save: { revision: nextSystemDocumentRevision, documentRevision: nextSystemDocumentRevision, savedAt } } }
						: {}),
				};
				try {
					await store.saveProjectArtifacts(initialSave);
				} catch (error) {
					const concurrentEdit = state.revision !== nextRevision || documentRevision !== nextDocumentRevision
						|| scenarioRevision !== nextScenarioRevision || edgeFunctionRevision !== nextEdgeFunctionRevision
						|| systemDocumentRevision !== nextSystemDocumentRevision;
					if (!concurrentEdit) {
						documentRevision = nextDocumentRevision - 1;
						scenarioRevision = nextScenarioRevision - 1;
						edgeFunctionRevision = nextEdgeFunctionRevision - 1;
						if (systemChanged) systemDocumentRevision = nextSystemDocumentRevision - 1;
						if (originalHistory) histories.set(designId, originalHistory);
						else histories.delete(designId);
						setState(current);
					} else {
						const currentState = state;
						const correctiveDocumentRevision = ++documentRevision;
						await store.saveProjectArtifacts({
							projectId: input.projectId,
							designId,
							design: { design: currentState.design!, save: { revision: currentState.revision, documentRevision: correctiveDocumentRevision, savedAt: now() } },
							scenarios: { scenarios: currentState.scenarios, save: { revision: ++scenarioRevision, savedAt: now() } },
							edgeFunctions: { edgeFunctions: currentState.edgeFunctions, save: { revision: ++edgeFunctionRevision, savedAt: now() } },
							...(currentState.systemDesign
								? { systemDesign: { systemDesign: currentState.systemDesign, save: { revision: ++systemDocumentRevision, documentRevision: systemDocumentRevision, savedAt: now() } } }
								: {}),
						});
					}
					throw error;
				}
				if (state.revision === nextRevision && documentRevision === nextDocumentRevision
					&& scenarioRevision === nextScenarioRevision && edgeFunctionRevision === nextEdgeFunctionRevision
					&& systemDocumentRevision === nextSystemDocumentRevision) {
					setState({
						...state,
						projects: store.listProjects(),
						save: { status: "saved", revision: nextRevision, savedAt, designId },
						scenarioSave: { status: "saved", revision: nextScenarioRevision, savedAt, designId },
						edgeFunctionSave: { status: "saved", revision: nextEdgeFunctionRevision, savedAt, designId },
						...(systemChanged ? { systemSave: { status: "saved" as const, revision: nextSystemDocumentRevision, savedAt, designId } } : {}),
					});
					schedulePreview(input.projectId, nextRevision, restored, designId);
				} else {
					const latest = state;
					const correctiveDocumentRevision = ++documentRevision;
					const correctiveScenarioRevision = ++scenarioRevision;
					const correctiveEdgeFunctionRevision = ++edgeFunctionRevision;
					const correctiveSystemRevision = latest.systemDesign ? ++systemDocumentRevision : systemDocumentRevision;
					await store.saveProjectArtifacts({
						projectId: input.projectId,
						designId,
						design: { design: latest.design!, save: { revision: latest.revision, documentRevision: correctiveDocumentRevision, savedAt: now() } },
						scenarios: { scenarios: latest.scenarios, save: { revision: correctiveScenarioRevision, savedAt: now() } },
						edgeFunctions: { edgeFunctions: latest.edgeFunctions, save: { revision: correctiveEdgeFunctionRevision, savedAt: now() } },
						...(latest.systemDesign
							? { systemDesign: { systemDesign: latest.systemDesign, save: { revision: correctiveSystemRevision, documentRevision: correctiveSystemRevision, savedAt: now() } } }
							: {}),
					});
				}
				return state;
			});
		},
		onAssistantDesignMutation(listener) {
			assistantMutationListeners.add(listener);
			return () => assistantMutationListeners.delete(listener);
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
				return applyStructuralChange(projectId, nextDesign, { name: `Add table “${name}”` }, designId);
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
				return applyStructuralChange(projectId, nextDesign, { name: `Rename table to “${name}”`, coalesceKey: `table-name:${table.id}` }, designId);
			});
		},
		removeTable(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const target: RemovalTarget = { kind: "table", tableId: table.id, designId };
				requireConfirmedRemoval(design, target, action.confirmed);

				return applyStructuralChange(
					projectId,
					removeTableAndItsRelationships(design, table, designId),
					{ name: `Remove table “${table.name}”` },
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
				return applyNonSchemaChange(projectId, nextDesign, { name: `Move table “${table.name}”` }, designId);
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
				return applyStructuralChange(projectId, nextDesign, { name: `Add column “${name}”` }, designId);
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
					? applyStructuralChange(projectId, nextDesign, { name: `Edit column “${updated.name}”` }, designId)
					: applyNonSchemaChange(projectId, nextDesign, { name: `Edit notes on “${updated.name}”`, coalesceKey: `column-notes:${column.id}` }, designId);
			});
		},
		updateIndexes(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const indexes = normalizeIndexes(action.indexes, table);
				if (JSON.stringify(indexes) === JSON.stringify(table.indexes ?? [])) return state;
				return applyStructuralChange(projectId, replaceTable(design, { ...table, indexes }), { name: `Update indexes on “${table.name}”` }, designId);
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
				return applyStructuralChange(projectId, { ...design, enumTypes }, { name: "Update enum types" }, designId);
			});
		},
		updateFunctions(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const functions = normalizeFunctions(action.functions, design);
				if (JSON.stringify(functions) === JSON.stringify(design.functions ?? [])) return state;
				return applyStructuralChange(projectId, { ...design, functions }, functionsHistoryAction(design.functions ?? [], functions), designId);
			});
		},
		removeFunction(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const target: RemovalTarget = { kind: "function", functionId: action.functionId, designId };
				requireRemovalTarget(design, target);
				requireConfirmedRemoval(design, target, action.confirmed);
				return applyStructuralChange(projectId, {
					...design,
					functions: (design.functions ?? []).filter((fn) => fn.id !== action.functionId),
					triggers: (design.triggers ?? []).filter((trigger) => trigger.functionId !== action.functionId),
				}, { name: `Remove function “${design.functions?.find((fn) => fn.id === action.functionId)?.name}”` }, designId);
			});
		},
		updateTriggers(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const triggers = normalizeTriggers(action.triggers, design);
				if (JSON.stringify(triggers) === JSON.stringify(design.triggers ?? [])) return state;
				return applyStructuralChange(projectId, { ...design, triggers }, { name: "Update triggers" }, designId);
			});
		},

		updateUniqueConstraints(action) {
			return runTask(async () => {
				const { projectId, design, designId } = requireOpenDesign(action.designId);
				const table = requireTable(design, action.tableId);
				const constraints = normalizeUniqueConstraints(action.uniqueConstraints, table);
				if (JSON.stringify(constraints) === JSON.stringify(table.uniqueConstraints ?? [])) return state;
				return applyStructuralChange(projectId, replaceTable(design, { ...table, uniqueConstraints: constraints }), { name: `Update unique constraints on “${table.name}”` }, designId);
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
					{ name: `Update policies on “${table.name}”` },
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
					designId,
				};
				requireConfirmedRemoval(design, target, action.confirmed);

				const nextDesign = removeColumnAndItsRelationships(design, table, column, designId);
				return applyStructuralChange(projectId, nextDesign, { name: `Remove column “${column.name}”` }, designId);
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
					return applyStructuralChange(projectId, nextDesign, { name: "Add many-to-many relationship" }, designId);
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
				return applyStructuralChange(projectId, nextDesign, { name: "Add relationship" }, designId);
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
				return applyStructuralChange(projectId, nextDesign, { name: "Update relationship" }, designId);
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
				return applyStructuralChange(projectId, nextDesign, { name: "Remove relationship" }, designId);
			});
		},
		describeRemoval(target) {
			const { design } = requireOpenDesign(target.designId);
			requireRemovalTarget(design, target);
			return removalPlan(design, target);
		},
		requireActiveDesign(designId) {
			if (typeof designId !== "string" || designId.length === 0) {
				throw new Error("A database design ID is required.");
			}
			requireOpenDesign(designId);
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
					null,
					designId,
				);
			});
		},
		addSystemComponent(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applySystemDesignChange(
					(design) => {
						const next = addSystemComponent(design, { ...action, id, position: { x: action.x, y: action.y } });
						const added = findSystemComponent(next, id)!;
						return { next, action: attributed(action, { name: `Add component “${added.name}”` }) };
					},
				);
			});
		},
		updateSystemComponent(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const before = findSystemComponent(design, action.componentId);
					const next = updateSystemComponent(design, action.componentId, action.changes);
					const after = findSystemComponent(next, action.componentId);
					if (!after || !before) throw new Error("That Component could not be found.");
					if (after.serviceId !== before.serviceId) {
						const owner = after.serviceId === null ? null : findSystemService(next, after.serviceId);
						return {
							next,
							action: attributed(action, owner
								? { name: `Assign “${after.name}” to “${owner.name}”` }
								: { name: `Release “${after.name}” to system scope` }),
						};
					}
					const renamed = after.name !== before.name;
					return {
						next,
						action: attributed(action, renamed
							? { name: `Rename component to “${after.name}”` }
							: { name: `Edit component “${after.name}”`, coalesceKey: `system-component:${action.componentId}` }),
					};
				});
			});
		},
		addSystemService(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applySystemDesignChange((design) => {
					const next = addSystemService(design, { id, name: action.name, position: { x: action.x, y: action.y } });
					const added = findSystemService(next, id)!;
					return { next, action: attributed(action, { name: `Add service “${added.name}”` }) };
				});
			});
		},
		updateSystemService(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = updateSystemService(design, action.serviceId, action.changes);
					const after = findSystemService(next, action.serviceId);
					if (!after) throw new Error("That Service could not be found.");
					return { next, action: attributed(action, { name: `Rename service to “${after.name}”` }) };
				});
			});
		},
		moveSystemService(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = moveSystemService(design, action.serviceId, { x: action.x, y: action.y });
					const moved = findSystemService(next, action.serviceId);
					if (!moved) throw new Error("That Service could not be found.");
					return { next, action: attributed(action, { name: `Move service “${moved.name}”` }) };
				});
			});
		},
		resizeSystemService(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = resizeSystemService(design, action.serviceId, { width: action.width, height: action.height });
					const resized = findSystemService(next, action.serviceId);
					if (!resized) throw new Error("That Service could not be found.");
					return { next, action: attributed(action, { name: `Resize service “${resized.name}”` }) };
				});
			});
		},
		removeSystemService(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const removed = findSystemService(design, action.serviceId);
					if (!removed) throw new Error("That Service could not be found.");
					return {
						next: removeSystemService(design, action.serviceId),
						action: attributed(action, { name: `Remove service “${removed.name}”` }),
					};
				});
			});
		},
		setSystemServiceCollapsed(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenProject();
				const current = state.systemDesign!;
				const next = setSystemServiceCollapsed(current, action.serviceId, action.collapsed);
				if (next === current) return state;
				return persistSystemDesign(projectId, designId, next);
			});
		},
		setSystemFocus(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenProject();
				const current = state.systemDesign!;
				const viewport = action.viewport && {
					x: requireNumber(action.viewport.x, "Canvas position"),
					y: requireNumber(action.viewport.y, "Canvas position"),
					zoom: clamp(requireNumber(action.viewport.zoom, "Canvas zoom"), CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM),
				};
				const next = setSystemFocus(current, action.serviceId, viewport);
				if (next === current) return state;
				return persistSystemDesign(projectId, designId, next);
			});
		},
		describeSystemServiceRemoval(serviceId) {
			requireOpenProject();
			const plan = describeSystemServiceRemoval(state.systemDesign!, serviceId);
			return { ...plan, ...walkthroughRemovalImpact(plan.connections) };
		},
		addSystemGroup(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applySystemDesignChange((design) => {
					const next = addSystemGroup(design, {
						id,
						name: action.name,
						position: { x: action.x, y: action.y },
						size: action.width !== undefined && action.height !== undefined
							? { width: action.width, height: action.height }
							: undefined,
						memberIds: action.memberIds,
					});
					const added = findSystemGroup(next, id)!;
					return { next, action: attributed(action, { name: `Add group “${added.name}”` }) };
				});
			});
		},
		updateSystemGroup(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const before = findSystemGroup(design, action.groupId);
					const next = updateSystemGroup(design, action.groupId, action.changes);
					const after = findSystemGroup(next, action.groupId);
					if (!before || !after) throw new Error("That Group could not be found.");
					return { next, action: attributed(action, groupEditHistoryAction(design, before, after)) };
				});
			});
		},
		moveSystemGroup(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = moveSystemGroup(design, action.groupId, { x: action.x, y: action.y });
					const moved = findSystemGroup(next, action.groupId);
					if (!moved) throw new Error("That Group could not be found.");
					return { next, action: attributed(action, { name: `Move group “${moved.name}”` }) };
				});
			});
		},
		resizeSystemGroup(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = resizeSystemGroup(design, action.groupId, { width: action.width, height: action.height });
					const resized = findSystemGroup(next, action.groupId);
					if (!resized) throw new Error("That Group could not be found.");
					return { next, action: attributed(action, { name: `Resize group “${resized.name}”` }) };
				});
			});
		},
		removeSystemGroup(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const removed = findSystemGroup(design, action.groupId);
					if (!removed) throw new Error("That Group could not be found.");
					return {
						next: removeSystemGroup(design, action.groupId),
						action: attributed(action, { name: `Remove group “${removed.name}”` }),
					};
				});
			});
		},
		arrangeSystemLayout(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = applySystemLayout(design, action.placement);
					return { next, action: attributed(action, { name: "Arrange layout" }) };
				});
			});
		},
		moveSystemComponent(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = moveSystemComponent(design, action.componentId, { x: action.x, y: action.y });
					const moved = findSystemComponent(next, action.componentId);
					if (!moved) throw new Error("That Component could not be found.");
					return { next, action: attributed(action, { name: `Move “${moved.name}”` }) };
				});
			});
		},
		removeSystemComponent(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const removed = findSystemComponent(design, action.componentId);
					if (!removed) throw new Error("That Component could not be found.");
					return {
						next: removeSystemComponent(design, action.componentId),
						action: attributed(action, { name: `Remove component “${removed.name}”` }),
					};
				});
			});
		},
		describeSystemComponentRemoval(componentId) {
			requireOpenProject();
			const plan = describeSystemComponentRemoval(state.systemDesign!, componentId);
			return { ...plan, ...walkthroughRemovalImpact(plan.connections) };
		},
		describeSystemConnectionRemoval(connectionId) {
			requireOpenProject();
			const plan = describeSystemConnectionRemoval(state.systemDesign!, connectionId);
			return { ...plan, ...walkthroughRemovalImpact([{ id: connectionId }]) };
		},
		addSystemConnection(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applySystemDesignChange((design) => {
					const next = addSystemConnection(design, { ...action, id });
					const added = findSystemConnection(next, id)!;
					return { next, action: attributed(action, { name: `Add connection “${added.label}”` }) };
				});
			});
		},
		updateSystemConnection(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const next = updateSystemConnection(design, action.connectionId, action.changes);
					const after = findSystemConnection(next, action.connectionId);
					if (!after) throw new Error("That Connection could not be found.");
					// A route edit is one completed gesture, so it is never merged with a later edit to the same Connection.
					if (hasSystemConnectionRouteChange(action.changes)) {
						return { next, action: attributed(action, { name: `Reroute connection “${after.label}”` }) };
					}
					return {
						next,
						action: attributed(action, { name: `Edit connection “${after.label}”`, coalesceKey: `system-connection:${action.connectionId}` }),
					};
				});
			});
		},
		removeSystemConnection(action) {
			return runTask(async () => {
				return applySystemDesignChange((design) => {
					const removed = findSystemConnection(design, action.connectionId);
					if (!removed) throw new Error("That Connection could not be found.");
					return {
						next: removeSystemConnection(design, action.connectionId),
						action: attributed(action, { name: `Remove connection “${removed.label}”` }),
					};
				});
			});
		},
		setSystemViewport(action) {
			return runTask(async () => {
				const { projectId, designId } = requireOpenProject();
				const current = state.systemDesign!;
				const viewport = {
					x: requireNumber(action.x, "Canvas position"),
					y: requireNumber(action.y, "Canvas position"),
					zoom: clamp(requireNumber(action.zoom, "Canvas zoom"), CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM),
				};
				if (sameViewport(current.viewport, viewport)) return state;
				return persistSystemDesign(projectId, designId, { ...current, viewport });
			});
		},
		setActiveView(action) {
			return runTask(async () => {
				const { projectId } = requireOpenProject();
				if (state.activeView === action.view) return state;
				store.saveLastView(projectId, action.view);
				setState({ ...state, activeView: action.view });
				return state;
			});
		},
		linkSystemDatabase(action) {
			return runTask(async () => {
				const { projectId } = requireOpenProject();
				const designs = store.listDesigns(projectId);
				const target = action.designId === null ? null : designs.find((design) => design.id === action.designId);
				if (action.designId !== null && !target) throw new Error("That design could not be found in this project.");
				return applySystemDesignChange((design) => {
					const component = requireDatabaseComponent(design, action.componentId);
					const next = updateSystemComponent(design, component.id, { designId: action.designId ?? undefined });
					return {
						next,
						action: {
							name: target
								? `Link “${component.name}” to “${target.name}”`
								: `Unlink “${component.name}” from its design`,
						},
					};
				});
			});
		},
		createWalkthrough(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applyWalkthroughChange((walkthroughs) => {
					const next = addWalkthrough(walkthroughs, { id, name: action.name });
					const added = findWalkthrough(next, id)!;
					return { next, action: { name: `Add walkthrough “${added.name}”` } };
				});
			});
		},
		renameWalkthrough(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const next = renameWalkthrough(walkthroughs, action.walkthroughId, action.name);
					const renamed = findWalkthrough(next, action.walkthroughId)!;
					return { next, action: { name: `Rename walkthrough to “${renamed.name}”` } };
				});
			});
		},
		removeWalkthrough(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const removed = findWalkthrough(walkthroughs, action.walkthroughId);
					if (!removed) throw new Error("That Walkthrough could not be found.");
					return {
						next: removeWalkthrough(walkthroughs, action.walkthroughId),
						action: { name: `Remove walkthrough “${removed.name}”` },
					};
				});
			});
		},
		createSystemDatabaseDesign(action) {
			return runTask(async () => {
				const { projectId } = requireOpenProject();
				const project = state.project!;
				const component = requireDatabaseComponent(state.systemDesign!, action.componentId);
				if (component.designId !== undefined) {
					throw new Error("This database component is already linked to a design. Unlink it first.");
				}
				const existing = store.listDesigns(projectId);
				const name = action.name !== undefined && action.name.trim().length > 0
					? requireDesignName(action.name, existing)
					: nextDefaultDesignName(existing);
				const designId = createId();
				await store.createDesign(projectId, designId, name, createEmptyDesign(), {
					revision: 1,
					documentRevision: 1,
					savedAt: now(),
				});
				await activateDesign(project, designId);
				return applySystemDesignChange((design) => {
					const next = updateSystemComponent(design, component.id, { designId });
					return { next, action: { name: `Link “${component.name}” to “${name}”` } };
				});
			});
		},
		moveWalkthrough(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const next = moveWalkthrough(walkthroughs, action.walkthroughId, action.toIndex);
					const moved = findWalkthrough(next, action.walkthroughId)!;
					return { next, action: { name: `Move walkthrough “${moved.name}”` } };
				});
			});
		},
		addWalkthroughStep(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applyWalkthroughChange((walkthroughs) => {
					const next = addWalkthroughStep(walkthroughs, action.walkthroughId, { ...action, id }, state.systemDesign!);
					const added = findWalkthroughStep(next, action.walkthroughId, id)!;
					return { next, action: { name: `Add step “${added.title}”` } };
				});
			});
		},
		updateWalkthroughStep(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const before = findWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId);
					const next = updateWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId, action.changes);
					const after = findWalkthroughStep(next, action.walkthroughId, action.stepId);
					if (!before || !after) throw new Error("That step could not be found.");
					const retitled = after.title !== before.title;
					return {
						next,
						action: retitled
							? { name: `Rename step to “${after.title}”` }
							: { name: `Edit step “${after.title}”`, coalesceKey: `walkthrough-step:${action.stepId}` },
					};
				});
			});
		},
		moveWalkthroughStep(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const next = moveWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId, action.toIndex);
					const moved = findWalkthroughStep(next, action.walkthroughId, action.stepId)!;
					return { next, action: { name: `Move step “${moved.title}”` } };
				});
			});
		},
		removeWalkthroughStep(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const removed = findWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId);
					if (!removed) throw new Error("That step could not be found.");
					return {
						next: removeWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId),
						action: { name: `Remove step “${removed.title}”` },
					};
				});
			});
		},
		addWalkthroughBlock(action) {
			return runTask(async () => {
				const id = action.id ?? createId();
				return applyWalkthroughChange((walkthroughs) => {
					const next = addWalkthroughBlock(walkthroughs, action.walkthroughId, { ...action, id });
					const added = findWalkthroughBlock(next, action.walkthroughId, id)!;
					const name = added.kind === "parallel" ? "Add parallel block" : "Add repeated block";
					return { next, action: { name } };
				});
			});
		},
		addWalkthroughParallelBranch(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const next = addWalkthroughParallelBranch(walkthroughs, action.walkthroughId, action.blockId);
					return { next, action: { name: "Add parallel branch" } };
				});
			});
		},
		updateWalkthroughRepeat(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const next = updateWalkthroughRepeat(walkthroughs, action.walkthroughId, action.blockId, action.count);
					return { next, action: { name: `Repeat ${action.count} ${action.count === 1 ? "time" : "times"}` } };
				});
			});
		},
		moveWalkthroughBlock(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const next = moveWalkthroughBlock(walkthroughs, action.walkthroughId, action.blockId, action.toIndex);
					return { next, action: { name: "Move block" } };
				});
			});
		},
		removeWalkthroughBlock(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const removed = findWalkthroughBlock(walkthroughs, action.walkthroughId, action.blockId);
					if (!removed) throw new Error("That block could not be found.");
					const name = removed.kind === "parallel" ? "Remove parallel block" : "Remove repeated block";
					return { next: removeWalkthroughBlock(walkthroughs, action.walkthroughId, action.blockId), action: { name } };
				});
			});
		},
		repairWalkthroughStep(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const before = findWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId);
					if (!before) throw new Error("That step could not be found.");
					const next = repairWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId, action.connectionId, state.systemDesign!);
					const repaired = findWalkthroughStep(next, action.walkthroughId, action.stepId)!;
					const relinked = repaired.connectionId !== before.connectionId;
					return {
						next,
						action: { name: relinked ? `Relink step “${repaired.title}”` : `Accept route for step “${repaired.title}”` },
					};
				});
			});
		},
		acceptWalkthroughStepRedirection(action) {
			return runTask(async () => {
				return applyWalkthroughChange((walkthroughs) => {
					const before = findWalkthroughStep(walkthroughs, action.walkthroughId, action.stepId);
					if (!before) throw new Error("That step could not be found.");
					const next = acceptWalkthroughStepRedirection(walkthroughs, action.walkthroughId, action.stepId, state.systemDesign!);
					const accepted = findWalkthroughStep(next, action.walkthroughId, action.stepId)!;
					return { next, action: { name: `Accept route for step “${accepted.title}”` } };
				});
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

/** A Component that can link to a database design: it must be a Database component. */
function requireDatabaseComponent(design: SystemDesign, componentId: string): SystemComponent {
	const component = findSystemComponent(design, componentId);
	if (!component) throw new Error("That Component could not be found.");
	if (component.kind !== "database") throw new Error("Only a Database component can link to a database design.");
	return component;
}

/** A design with no content yet, placed like a new Project's first design. */
function createEmptyDesign(): Design {
	return {
		tables: [],
		relationships: [],
		manyToManyRelationships: [],
		viewport: { ...DEFAULT_VIEWPORT },
	};
}

/** "Design 2", "Design 3", ... — the first such name not already in use. */
function nextDefaultDesignName(existing: DatabaseDesignSummary[]): string {
	const taken = new Set(existing.map((design) => design.name.trim().toLowerCase()));
	for (let number = existing.length + 1; ; number += 1) {
		const name = `Design ${number}`;
		if (!taken.has(name.toLowerCase())) return name;
	}
}

/**
 * Names a Group edit by what changed: a rename, one member added or removed, or
 * a broader change to the member list.
 */
function groupEditHistoryAction(design: SystemDesign, before: SystemGroup, after: SystemGroup): HistoryAction {
	if (after.name !== before.name) return { name: `Rename group to “${after.name}”` };
	const added = after.memberIds.filter((id) => !before.memberIds.includes(id));
	const removed = before.memberIds.filter((id) => !after.memberIds.includes(id));
	const label = (id: string) => findSystemComponent(design, id)?.name ?? findSystemService(design, id)?.name ?? findSystemGroup(design, id)?.name ?? id;
	if (added.length === 1 && removed.length === 0) return { name: `Add “${label(added[0]!)}” to “${after.name}”` };
	if (removed.length === 1 && added.length === 0) return { name: `Remove “${label(removed[0]!)}” from “${after.name}”` };
	return { name: `Edit members of “${after.name}”` };
}

/**
 * Names a System design change. An Assistant-attributed change joins its turn's
 * single history action, which carries the Assistant turn name.
 */
function attributed(attribution: SystemAttribution, action: HistoryAction): HistoryAction {
	if (attribution.assistantTurnId === undefined) return action;
	return { name: ASSISTANT_TURN_ACTION_NAME, assistantTurnId: attribution.assistantTurnId };
}

/** Names a Function edit for the Project history, with typing in one body grouped. */
function functionsHistoryAction(before: DesignFunction[], after: DesignFunction[]): HistoryAction {
	const added = after.find((fn) => !before.some((candidate) => candidate.id === fn.id));
	if (added) return { name: `Add function “${added.name}”` };
	const removed = before.find((fn) => !after.some((candidate) => candidate.id === fn.id));
	if (removed) return { name: `Remove function “${removed.name}”` };
	const edited = after.find((fn) =>
		JSON.stringify(fn) !== JSON.stringify(before.find((candidate) => candidate.id === fn.id)),
	);
	if (edited) return { name: `Edit function “${edited.name}”`, coalesceKey: `function:${edited.id}` };
	return { name: "Update functions" };
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

/**
 * An imported design gets the checks a designer's own edits get: the stored
 * shape, then its Functions and triggers, which must reference what they name.
 */
function normalizeImportedDesign(value: unknown): Design {
	const design = normalizeDesign(value as Design);
	const withFunctions = design.functions ? { ...design, functions: normalizeFunctions(design.functions, design) } : design;
	return withFunctions.triggers
		? { ...withFunctions, triggers: normalizeTriggers(withFunctions.triggers, withFunctions) }
		: withFunctions;
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
function removeTableAndItsRelationships(design: Design, table: DesignTable, designId: string): Design {
	const affected = affectedRelationshipIds(design, { kind: "table", tableId: table.id, designId });
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
	designId: string,
): Design {
	const affected = affectedRelationshipIds(design, {
		kind: "column",
		tableId: table.id,
		columnId: column.id,
		designId,
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
