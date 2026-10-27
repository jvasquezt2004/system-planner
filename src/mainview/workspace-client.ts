import { defineElectrobunRPC } from "electrobun/rpc";
import { Electroview } from "electrobun/view";
import type { AssistantThinkingLevel } from "../shared/assistant";
import type {
	AddSystemComponentAction,
	SystemComponentChanges,
	SystemComponentRemovalPlan,
	SystemConnectionChanges,
	SystemViewName,
} from "../shared/system-design";
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
const assistantScenarioRunListeners = new Set<(request: { requestId: string; projectId: string; designId: string; scenario: Scenario }) => void>();
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
	createDesign(name: string): Promise<WorkspaceState> {
		return rpc.request.createDesign({ name });
	},
	openDesign(designId: string): Promise<WorkspaceState> {
		return rpc.request.openDesign({ designId });
	},
	renameDesign(designId: string, name: string): Promise<WorkspaceState> {
		return rpc.request.renameDesign({ designId, name });
	},
	createScenario(request: { name: string; designId: string }): Promise<WorkspaceState> {
		return rpc.request.createScenario(request);
	},
	renameScenario(request: { scenarioId: string; name: string; designId: string }): Promise<WorkspaceState> {
		return rpc.request.renameScenario(request);
	},
	removeScenario(request: { scenarioId: string; designId: string }): Promise<WorkspaceState> {
		return rpc.request.removeScenario(request);
	},
	updateScenarioSource(request: { scenarioId: string; source: string; designId: string }): Promise<WorkspaceState> {
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
	beginScenarioRun(action: { scenarioId: string; designId: string }) {
		return rpc.request.beginScenarioRun(action);
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
	undo(designId: string): Promise<WorkspaceState> {
		return rpc.request.undo({ designId });
	},
	redo(designId: string): Promise<WorkspaceState> {
		return rpc.request.redo({ designId });
	},
	addTable(designId: string, name: string, position?: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.addTable({ designId, name, position });
	},
	renameTable(designId: string, tableId: string, name: string): Promise<WorkspaceState> {
		return rpc.request.renameTable({ designId, tableId, name });
	},
	removeTable(designId: string, tableId: string, confirmed?: boolean): Promise<WorkspaceState> {
		return rpc.request.removeTable({ designId, tableId, confirmed });
	},
	moveTable(designId: string, tableId: string, position: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.moveTable({ designId, tableId, position });
	},
	addColumn(designId: string, tableId: string, name?: string, type?: ColumnType): Promise<WorkspaceState> {
		return rpc.request.addColumn({ designId, tableId, name, type });
	},
	updateColumn(designId: string, tableId: string, columnId: string, changes: ColumnChanges): Promise<WorkspaceState> {
		return rpc.request.updateColumn({ designId, tableId, columnId, changes });
	},
	updateIndexes(designId: string, tableId: string, indexes: DesignIndex[]): Promise<WorkspaceState> {
		return rpc.request.updateIndexes({ designId, tableId, indexes });
	},
	updateEnumTypes(designId: string, enumTypes: DesignEnumType[]): Promise<WorkspaceState> {
		return rpc.request.updateEnumTypes({ designId, enumTypes });
	},
	updateFunctions(designId: string, functions: DesignFunction[]): Promise<WorkspaceState> {
		return rpc.request.updateFunctions({ designId, functions });
	},
	updateTriggers(designId: string, triggers: DesignTrigger[]): Promise<WorkspaceState> {
		return rpc.request.updateTriggers({ designId, triggers });
	},
	removeFunction(action: RemoveFunctionAction): Promise<WorkspaceState> {
		return rpc.request.removeFunction(action);
	},
	updateUniqueConstraints(designId: string, tableId: string, uniqueConstraints: DesignUniqueConstraint[]): Promise<WorkspaceState> {
		return rpc.request.updateUniqueConstraints({ designId, tableId, uniqueConstraints });
	},
	updatePolicies(designId: string, tableId: string, rowLevelSecurity: boolean, policies: DesignPolicy[]): Promise<WorkspaceState> {
		return rpc.request.updatePolicies({ designId, tableId, rowLevelSecurity, policies });
	},
	removeColumn(designId: string, tableId: string, columnId: string, confirmed?: boolean): Promise<WorkspaceState> {
		return rpc.request.removeColumn({ designId, tableId, columnId, confirmed });
	},
	addRelationship(
		designId: string,
		referencingTableId: string,
		referencedTableId: string,
		cardinality?: RelationshipCreationCardinality,
		junctionPosition?: CanvasPoint,
	): Promise<WorkspaceState> {
		return rpc.request.addRelationship({
			designId,
			referencingTableId,
			referencedTableId,
			cardinality,
			junctionPosition,
		});
	},
	updateRelationship(
		designId: string,
		relationshipId: string,
		changes: { required?: boolean; cardinality?: RelationshipCardinality; onDelete?: ReferentialAction; onUpdate?: ReferentialAction },
	): Promise<WorkspaceState> {
		return rpc.request.updateRelationship({ designId, relationshipId, ...changes });
	},
	removeRelationship(designId: string, relationshipId: string): Promise<WorkspaceState> {
		return rpc.request.removeRelationship({ designId, relationshipId });
	},
	describeRemoval(target: RemovalTarget): Promise<RemovalPlan> {
		return rpc.request.describeRemoval(target);
	},
	setViewport(designId: string, viewport: CanvasViewport): Promise<WorkspaceState> {
		return rpc.request.setViewport({ ...viewport, designId });
	},
	addSystemComponent(component: AddSystemComponentAction): Promise<WorkspaceState> {
		return rpc.request.addSystemComponent(component);
	},
	updateSystemComponent(componentId: string, changes: SystemComponentChanges): Promise<WorkspaceState> {
		return rpc.request.updateSystemComponent({ componentId, changes });
	},
	moveSystemComponent(componentId: string, point: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.moveSystemComponent({ componentId, x: point.x, y: point.y });
	},
	removeSystemComponent(componentId: string): Promise<WorkspaceState> {
		return rpc.request.removeSystemComponent({ componentId });
	},
	describeSystemComponentRemoval(componentId: string): Promise<SystemComponentRemovalPlan> {
		return rpc.request.describeSystemComponentRemoval({ componentId });
	},
	addSystemConnection(connection: { id: string; sourceId: string; targetId: string; label?: string }): Promise<WorkspaceState> {
		return rpc.request.addSystemConnection(connection);
	},
	updateSystemConnection(connectionId: string, changes: SystemConnectionChanges): Promise<WorkspaceState> {
		return rpc.request.updateSystemConnection({ connectionId, changes });
	},
	removeSystemConnection(connectionId: string): Promise<WorkspaceState> {
		return rpc.request.removeSystemConnection({ connectionId });
	},
	setSystemViewport(viewport: CanvasViewport): Promise<WorkspaceState> {
		return rpc.request.setSystemViewport(viewport);
	},
	setActiveView(view: SystemViewName): Promise<WorkspaceState> {
		return rpc.request.setActiveView({ view });
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
	answerAssistantOAuthPrompt(promptId: string, value: string) {
		return rpc.request.answerAssistantOAuthPrompt({ promptId, value });
	},
	cancelAssistantOAuthLogin(providerId: string) {
		return rpc.request.cancelAssistantOAuthLogin({ providerId });
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
	subscribeAssistantScenarioRuns(listener: (request: { requestId: string; projectId: string; designId: string; scenario: Scenario }) => void) {
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
