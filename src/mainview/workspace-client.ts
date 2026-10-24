import { defineElectrobunRPC } from "electrobun/rpc";
import { Electroview } from "electrobun/view";
import type { AssistantThinkingLevel } from "../shared/assistant";
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
	DesignTrigger,
	DesignUniqueConstraint,
	RemoveFunctionAction,
	SandboxApiRequest,
	CreateEdgeFunctionAction,
	RenameEdgeFunctionAction,
	RemoveEdgeFunctionAction,
	UpdateEdgeFunctionSourceAction,
} from "../shared/design";
import type {
	AppRPCSchema,
	SchemaCodeExportRequest,
	SqlPreviewExportRequest,
} from "../shared/rpc";
import type { SchemaCodeSnapshot } from "../shared/schema-code";
import { errorMessage } from "../shared/error-message";
import type { Scenario } from "../shared/design";

const listeners = new Set<(state: WorkspaceState) => void>();
const assistantListeners = new Set<(event: { conversationId: string; event: unknown }) => void>();
const assistantOAuthListeners = new Set<(event: { providerId: string; event: unknown }) => void>();
const assistantScenarioRunListeners = new Set<(request: { requestId: string; projectId: string; scenario: Scenario }) => void>();
const assistantScenarioRunCancelListeners = new Set<(requestId: string) => void>();
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
			assistantEvent({ conversationId, event }) {
				for (const listener of assistantListeners) listener({ conversationId, event });
			},
			assistantOAuthEvent({ providerId, event }) {
				for (const listener of assistantOAuthListeners) listener({ providerId, event });
			},
			assistantScenarioRunRequest(request) {
				for (const listener of assistantScenarioRunListeners) listener(request);
			},
			assistantScenarioRunCancel({ requestId }) {
				for (const listener of assistantScenarioRunCancelListeners) listener(requestId);
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
	createEdgeFunction(action: CreateEdgeFunctionAction): Promise<WorkspaceState> {
		return rpc.request.createEdgeFunction(action);
	},
	renameEdgeFunction(action: RenameEdgeFunctionAction): Promise<WorkspaceState> {
		return rpc.request.renameEdgeFunction(action);
	},
	removeEdgeFunction(action: RemoveEdgeFunctionAction): Promise<WorkspaceState> {
		return rpc.request.removeEdgeFunction(action);
	},
	updateEdgeFunctionSource(action: UpdateEdgeFunctionSourceAction): Promise<WorkspaceState> {
		return rpc.request.updateEdgeFunctionSource(action);
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
	updateTriggers(triggers: DesignTrigger[]): Promise<WorkspaceState> {
		return rpc.request.updateTriggers({ triggers });
	},
	removeFunction(action: RemoveFunctionAction): Promise<WorkspaceState> {
		return rpc.request.removeFunction(action);
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
	listAssistantConversations(projectId: string) {
		return rpc.request.listAssistantConversations({ projectId });
	},
	getAssistantConversation(conversationId: string) {
		return rpc.request.getAssistantConversation({ conversationId });
	},
	createAssistantConversation(projectId: string) {
		return rpc.request.createAssistantConversation({ projectId });
	},
	renameAssistantConversation(conversationId: string, title: string) {
		return rpc.request.renameAssistantConversation({ conversationId, title });
	},
	deleteAssistantConversation(conversationId: string) {
		return rpc.request.deleteAssistantConversation({ conversationId });
	},
	listAssistantModels() {
		return rpc.request.listAssistantModels({});
	},
	sendAssistantMessage(conversationId: string, text: string, modelId: string, thinkingLevel: AssistantThinkingLevel, connectionId?: string) {
		return rpc.request.sendAssistantMessage({ conversationId, text, modelId, thinkingLevel, connectionId });
	},
	stopAssistantTurn(conversationId: string) {
		return rpc.request.stopAssistantTurn({ conversationId });
	},
	listAssistantConnections() {
		return rpc.request.listAssistantConnections({});
	},
	setAssistantApiKey(providerId: string, apiKey: string) {
		return rpc.request.setAssistantApiKey({ providerId, apiKey });
	},
	removeAssistantConnection(connectionId: string) {
		return rpc.request.removeAssistantConnection({ connectionId });
	},
	startAssistantOAuthLogin(providerId: string) {
		return rpc.request.startAssistantOAuthLogin({ providerId });
	},
	getClaudeOptIn() {
		return rpc.request.getClaudeOptIn({});
	},
	setClaudeOptIn(enabled: boolean) {
		return rpc.request.setClaudeOptIn({ enabled });
	},
	getAssistantRequestCap() {
		return rpc.request.getAssistantRequestCap({});
	},
	setAssistantRequestCap(limit: number) {
		return rpc.request.setAssistantRequestCap({ limit });
	},
	subscribeAssistantOAuthEvents(listener: (event: { providerId: string; event: unknown }) => void) {
		assistantOAuthListeners.add(listener);
		return () => { assistantOAuthListeners.delete(listener); };
	},
	continueAssistantTurn(conversationId: string) {
		return rpc.request.continueAssistantTurn({ conversationId });
	},
	getAssistantTurnStatus(conversationId: string) {
		return rpc.request.getAssistantTurnStatus({ conversationId });
	},
	revertAssistantTurn(conversationId: string) {
		return rpc.request.revertAssistantTurn({ conversationId });
	},
	updateAssistantConversationSelection(conversationId: string, connectionId: string | null, modelId: string, thinkingLevel: AssistantThinkingLevel) {
		return rpc.request.updateAssistantConversationSelection({ conversationId, connectionId, modelId, thinkingLevel });
	},
	confirmAssistantDdlDrop(conversationId: string, toolCallId: string) {
		return rpc.request.confirmAssistantDdlDrop({ conversationId, toolCallId });
	},
	rejectAssistantDdlDrop(conversationId: string, toolCallId: string) {
		return rpc.request.rejectAssistantDdlDrop({ conversationId, toolCallId });
	},
	subscribeAssistantEvents(listener: (event: { conversationId: string; event: unknown }) => void) {
		assistantListeners.add(listener);
		return () => { assistantListeners.delete(listener); };
	},
	subscribeAssistantScenarioRuns(listener: (request: { requestId: string; projectId: string; scenario: Scenario }) => void) {
		assistantScenarioRunListeners.add(listener);
		return () => { assistantScenarioRunListeners.delete(listener); };
	},
	subscribeAssistantScenarioRunCancels(listener: (requestId: string) => void) {
		assistantScenarioRunCancelListeners.add(listener);
		return () => { assistantScenarioRunCancelListeners.delete(listener); };
	},
	completeAssistantScenarioRun(requestId: string, run: ScenarioRun | null, error?: string) {
		return rpc.send.assistantScenarioRunCompleted({ requestId, run, error });
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
