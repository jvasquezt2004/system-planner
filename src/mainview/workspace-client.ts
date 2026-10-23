import { defineElectrobunRPC } from "electrobun/rpc";
import { Electroview } from "electrobun/view";
import type {
	CanvasPoint,
	CanvasViewport,
	ColumnChanges,
	ColumnType,
	DisplayedSqlPreview,
	RelationshipCardinality,
	RelationshipCreationCardinality,
	RemovalPlan,
	RemovalTarget,
	SqlPreviewCopyResult,
	SqlPreviewExportResult,
	ScenarioRun,
	WorkspaceState,
	DesignIndex,
	ReferentialAction,
	DesignEnumType,
	DesignFunction,
	DesignPolicy,
	DesignUniqueConstraint,
	SandboxApiRequest,
} from "../shared/design";
import type {
	AppRPCSchema,
	SchemaCodeExportRequest,
	SqlPreviewExportRequest,
} from "../shared/rpc";
import type { SchemaCodeSnapshot } from "../shared/schema-code";
import { errorMessage } from "../shared/error-message";

const listeners = new Set<(state: WorkspaceState) => void>();
let latestState: WorkspaceState | null = null;

const pendingSqlExports = new Map<
	string,
	(result: SqlPreviewExportResult) => void
>();

const rpc = defineElectrobunRPC<AppRPCSchema, "webview">("webview", {
	// Autosave plus sandbox validation can take longer than the 1s default.
	maxRequestTime: 60_000,
	handlers: {
		messages: {
			workspaceState(state) {
				latestState = state;
				for (const listener of listeners) listener(state);
			},
			sqlPreviewExportCompleted({ requestId, result }) {
				const resolve = pendingSqlExports.get(requestId);
				if (!resolve) return;
				pendingSqlExports.delete(requestId);
				resolve(result);
			},
		},
	},
});

export const electroview = new Electroview({ rpc });

/**
 * The view's only path to the application: typed Electrobun requests and state
 * messages backed by the design workspace interface.
 */
export const workspaceClient = {
	async load(): Promise<WorkspaceState> {
		const state = await rpc.request.getWorkspaceState({});
		latestState = state;
		return state;
	},
	createProject(name: string): Promise<WorkspaceState> {
		return rpc.request.createProject({ name });
	},
	createScenario(request: { name: string }): Promise<WorkspaceState> {
		return rpc.request.createScenario(request);
	},
	renameScenario(request: { scenarioId: string; name: string }): Promise<WorkspaceState> {
		return rpc.request.renameScenario(request);
	},
	removeScenario(request: { scenarioId: string }): Promise<WorkspaceState> {
		return rpc.request.removeScenario(request);
	},
	updateScenarioSource(request: { scenarioId: string; source: string }): Promise<WorkspaceState> {
		return rpc.request.updateScenarioSource(request);
	},
	beginScenarioRun(scenarioId: string) {
		return rpc.request.beginScenarioRun({ scenarioId });
	},
	handleSandboxApiRequest(runId: string, request: SandboxApiRequest) {
		return rpc.request.handleSandboxApiRequest({ runId, request });
	},
	finishScenarioRun(input: { runId: string; status: "passed" | "failed" | "errored"; console: string[]; expectations?: ScenarioRun["expectations"]; reason?: "exception" | "stopped" | "timed out" }) {
		return rpc.request.finishScenarioRun(input);
	},
	openProject(projectId: string): Promise<WorkspaceState> {
		return rpc.request.openProject({ projectId });
	},
	undo(): Promise<WorkspaceState> {
		return rpc.request.undo({});
	},
	redo(): Promise<WorkspaceState> {
		return rpc.request.redo({});
	},
	addTable(name: string, position?: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.addTable({ name, position });
	},
	renameTable(tableId: string, name: string): Promise<WorkspaceState> {
		return rpc.request.renameTable({ tableId, name });
	},
	removeTable(tableId: string, confirmed?: boolean): Promise<WorkspaceState> {
		return rpc.request.removeTable({ tableId, confirmed });
	},
	moveTable(tableId: string, position: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.moveTable({ tableId, position });
	},
	addColumn(
		tableId: string,
		name?: string,
		type?: ColumnType,
	): Promise<WorkspaceState> {
		return rpc.request.addColumn({ tableId, name, type });
	},
	updateColumn(
		tableId: string,
		columnId: string,
		changes: ColumnChanges,
	): Promise<WorkspaceState> {
		return rpc.request.updateColumn({ tableId, columnId, changes });
	},
	updateIndexes(tableId: string, indexes: DesignIndex[]): Promise<WorkspaceState> {
		return rpc.request.updateIndexes({ tableId, indexes });
	},
	updateEnumTypes(enumTypes: DesignEnumType[]): Promise<WorkspaceState> {
		return rpc.request.updateEnumTypes({ enumTypes });
	},
	updateFunctions(functions: DesignFunction[]): Promise<WorkspaceState> {
		return rpc.request.updateFunctions({ functions });
	},
	updateUniqueConstraints(tableId: string, uniqueConstraints: DesignUniqueConstraint[]): Promise<WorkspaceState> {
		return rpc.request.updateUniqueConstraints({ tableId, uniqueConstraints });
	},
	updatePolicies(tableId: string, rowLevelSecurity: boolean, policies: DesignPolicy[]): Promise<WorkspaceState> {
		return rpc.request.updatePolicies({ tableId, rowLevelSecurity, policies });
	},
	removeColumn(
		tableId: string,
		columnId: string,
		confirmed?: boolean,
	): Promise<WorkspaceState> {
		return rpc.request.removeColumn({ tableId, columnId, confirmed });
	},
	addRelationship(
		referencingTableId: string,
		referencedTableId: string,
		cardinality?: RelationshipCreationCardinality,
		junctionPosition?: CanvasPoint,
	): Promise<WorkspaceState> {
		return rpc.request.addRelationship({
			referencingTableId,
			referencedTableId,
			cardinality,
			junctionPosition,
		});
	},
	updateRelationship(
		relationshipId: string,
		changes: { required?: boolean; cardinality?: RelationshipCardinality; onDelete?: ReferentialAction; onUpdate?: ReferentialAction },
	): Promise<WorkspaceState> {
		return rpc.request.updateRelationship({ relationshipId, ...changes });
	},
	removeRelationship(relationshipId: string): Promise<WorkspaceState> {
		return rpc.request.removeRelationship({ relationshipId });
	},
	describeRemoval(target: RemovalTarget): Promise<RemovalPlan> {
		return rpc.request.describeRemoval(target);
	},
	setViewport(viewport: CanvasViewport): Promise<WorkspaceState> {
		return rpc.request.setViewport(viewport);
	},
	copySqlPreview(preview: DisplayedSqlPreview): Promise<SqlPreviewCopyResult> {
		return rpc.request.copySqlPreview({ preview });
	},
	async exportSqlPreview(request: SqlPreviewExportRequest): Promise<SqlPreviewExportResult> {
		const { requestId } =
			await rpc.request.beginSqlPreviewExport(request);
		return chooseExportDirectory(requestId, request.preview.revision);
	},
	copySchemaCode(snapshot: SchemaCodeSnapshot): Promise<SqlPreviewCopyResult> {
		return rpc.request.copySchemaCode({ snapshot });
	},
	async exportSchemaCode(request: SchemaCodeExportRequest): Promise<SqlPreviewExportResult> {
		const { requestId } = await rpc.request.beginSchemaCodeExport(request);
		return chooseExportDirectory(requestId, request.snapshot.revision);
	},
	subscribe(listener: (state: WorkspaceState) => void): () => void {
		listeners.add(listener);
		if (latestState) listener(latestState);
		return () => listeners.delete(listener);
	},
};

/** Starts the native folder picker for a begun export and awaits its result. */
async function chooseExportDirectory(
	requestId: string,
	revision: number,
): Promise<SqlPreviewExportResult> {
	const { promise, resolve } = Promise.withResolvers<SqlPreviewExportResult>();
	pendingSqlExports.set(requestId, resolve);
	try {
		await rpc.send.chooseSqlPreviewExportDirectory({ requestId });
	} catch (cause) {
		pendingSqlExports.delete(requestId);
		return { status: "failed", revision, error: errorMessage(cause) };
	}
	return promise;
}
