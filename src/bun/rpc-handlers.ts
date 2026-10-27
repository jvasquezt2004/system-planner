import type { AssistantConversationRecord, AssistantModel, AssistantThinkingLevel, AssistantConnectionStatus, AssistantConversation } from "../shared/assistant";
import type {
	AddColumnAction,
	AddRelationshipAction,
	AddTableAction,
	CreateDesignAction,
	CreateEdgeFunctionAction,
	CreateScenarioAction,
	DisplayedSqlPreview,
	MoveTableAction,
	OpenDesignAction,
	RemovalPlan,
	RemovalTarget,
	RemoveColumnAction,
	RemoveEdgeFunctionAction,
	RemoveFunctionAction,
	RemoveRelationshipAction,
	RemoveScenarioAction,
	RemoveTableAction,
	RenameDesignAction,
	RenameEdgeFunctionAction,
	RenameScenarioAction,
	RenameTableAction,
	SandboxApiRequest,
	SandboxApiResponse,
	ScenarioRun,
	SetViewportAction,
	SqlPreviewCopyResult,
	SqlPreviewExportResult,
	UpdateColumnAction,
	UpdateEdgeFunctionSourceAction,
	UpdateEnumTypesAction,
	UpdateFunctionsAction,
	UpdateIndexesAction,
	UpdatePoliciesAction,
	UpdateRelationshipAction,
	UpdateScenarioSourceAction,
	UpdateTriggersAction,
	UpdateUniqueConstraintsAction,
	WorkspaceState,
} from "../shared/design";
import type { SchemaCodeSnapshot } from "../shared/schema-code";
import type {
	AddSystemComponentAction,
	AddSystemConnectionAction,
	AddSystemGroupAction,
	AddSystemServiceAction,
	CreateSystemDatabaseDesignAction,
	LinkSystemDatabaseAction,
	MoveSystemComponentAction,
	MoveSystemGroupAction,
	MoveSystemServiceAction,
	RemoveSystemComponentAction,
	RemoveSystemConnectionAction,
	RemoveSystemGroupAction,
	RemoveSystemServiceAction,
	SetSystemServiceCollapsedAction,
	ResizeSystemGroupAction,
	ResizeSystemServiceAction,
	UpdateSystemGroupAction,
	SetActiveViewAction,
	SetSystemViewportAction,
	SystemComponentRemovalPlan,
	SystemConnectionRemovalPlan,
	SystemServiceRemovalPlan,
	UpdateSystemComponentAction,
	UpdateSystemConnectionAction,
	UpdateSystemServiceAction,
} from "../shared/system-design";
import type {
	AddWalkthroughStepAction,
	CreateWalkthroughAction,
	MoveWalkthroughAction,
	MoveWalkthroughStepAction,
	RemoveWalkthroughAction,
	RemoveWalkthroughStepAction,
	RenameWalkthroughAction,
	AcceptWalkthroughStepRedirectionAction,
	RepairWalkthroughStepAction,
	WalkthroughRemovalImpact,
	UpdateWalkthroughStepAction,
} from "../shared/walkthrough";
import type { SqlPreviewActions } from "./sql-preview";
import type { DesignWorkspace } from "./workspace";
import type { AssistantRuntime } from "./assistant-runtime";

export type RpcHandlerDependencies = {
	workspace: Promise<DesignWorkspace> | DesignWorkspace;
	assistant: Promise<AssistantRuntime> | AssistantRuntime;
	sqlPreviewActions: SqlPreviewActions;
	pendingSqlExports: Map<string, () => Promise<SqlPreviewExportResult>>;
};

export function createRpcRequestHandlers(deps: RpcHandlerDependencies) {
	return {
		getWorkspaceState: async (): Promise<WorkspaceState> => (await deps.workspace).getState(),
		createProject: async (action: { name: string }): Promise<WorkspaceState> => (await deps.workspace).createProject(action),
		openProject: async (action: { projectId: string }): Promise<WorkspaceState> => (await deps.workspace).openProject(action),
		createDesign: async (action: CreateDesignAction): Promise<WorkspaceState> => (await deps.workspace).createDesign(action),
		openDesign: async (action: OpenDesignAction): Promise<WorkspaceState> => (await deps.workspace).openDesign(action),
		renameDesign: async (action: RenameDesignAction): Promise<WorkspaceState> => (await deps.workspace).renameDesign(action),
		createScenario: async (action: CreateScenarioAction): Promise<WorkspaceState> => (await deps.workspace).createScenario(action),
		renameScenario: async (action: RenameScenarioAction): Promise<WorkspaceState> => (await deps.workspace).renameScenario(action),
		removeScenario: async (action: RemoveScenarioAction): Promise<WorkspaceState> => (await deps.workspace).removeScenario(action),
		updateScenarioSource: async (action: UpdateScenarioSourceAction): Promise<WorkspaceState> => (await deps.workspace).updateScenarioSource(action),
		createEdgeFunction: async (action: CreateEdgeFunctionAction): Promise<WorkspaceState> => (await deps.workspace).createEdgeFunction(action),
		renameEdgeFunction: async (action: RenameEdgeFunctionAction): Promise<WorkspaceState> => (await deps.workspace).renameEdgeFunction(action),
		removeEdgeFunction: async (action: RemoveEdgeFunctionAction): Promise<WorkspaceState> => (await deps.workspace).removeEdgeFunction(action),
		updateEdgeFunctionSource: async (action: UpdateEdgeFunctionSourceAction): Promise<WorkspaceState> => (await deps.workspace).updateEdgeFunctionSource(action),
		beginScenarioRun: async (action: { scenarioId: string; designId: string }): Promise<{ runId: string; state: WorkspaceState }> =>
			(await deps.workspace).beginScenarioRun(action),
		handleSandboxApiRequest: async (action: { runId: string; request: SandboxApiRequest }): Promise<SandboxApiResponse> =>
			(await deps.workspace).handleSandboxApiRequest(action),
		finishScenarioRun: async (action: {
			runId: string;
			status: "passed" | "failed" | "errored";
			console: string[];
			expectations?: ScenarioRun["expectations"];
			reason?: "exception" | "stopped" | "timed out";
		}): Promise<WorkspaceState> => (await deps.workspace).finishScenarioRun(action),
		undo: async (action: { designId: string }): Promise<WorkspaceState> => (await deps.workspace).undo(action),
		redo: async (action: { designId: string }): Promise<WorkspaceState> => (await deps.workspace).redo(action),
		addTable: async (action: AddTableAction): Promise<WorkspaceState> =>
			(await deps.workspace).addTable(action),
		renameTable: async (action: RenameTableAction): Promise<WorkspaceState> =>
			(await deps.workspace).renameTable(action),
		removeTable: async (action: RemoveTableAction): Promise<WorkspaceState> =>
			(await deps.workspace).removeTable(action),
		moveTable: async (action: MoveTableAction): Promise<WorkspaceState> =>
			(await deps.workspace).moveTable(action),
		addColumn: async (action: AddColumnAction): Promise<WorkspaceState> =>
			(await deps.workspace).addColumn(action),
		updateColumn: async (action: UpdateColumnAction): Promise<WorkspaceState> =>
			(await deps.workspace).updateColumn(action),
		updateIndexes: async (action: UpdateIndexesAction): Promise<WorkspaceState> => (await deps.workspace).updateIndexes(action),
		updateEnumTypes: async (action: UpdateEnumTypesAction): Promise<WorkspaceState> => (await deps.workspace).updateEnumTypes(action),
		updateUniqueConstraints: async (action: UpdateUniqueConstraintsAction): Promise<WorkspaceState> => (await deps.workspace).updateUniqueConstraints(action),
		updateFunctions: async (action: UpdateFunctionsAction): Promise<WorkspaceState> => (await deps.workspace).updateFunctions(action),
		updateTriggers: async (action: UpdateTriggersAction): Promise<WorkspaceState> => (await deps.workspace).updateTriggers(action),
		removeFunction: async (action: RemoveFunctionAction): Promise<WorkspaceState> => (await deps.workspace).removeFunction(action),
		updatePolicies: async (action: UpdatePoliciesAction): Promise<WorkspaceState> => (await deps.workspace).updatePolicies(action),
		removeColumn: async (action: RemoveColumnAction): Promise<WorkspaceState> =>
			(await deps.workspace).removeColumn(action),
		addRelationship: async (action: AddRelationshipAction): Promise<WorkspaceState> => (await deps.workspace).addRelationship(action),
		updateRelationship: async (action: UpdateRelationshipAction): Promise<WorkspaceState> => (await deps.workspace).updateRelationship(action),
		removeRelationship: async (action: RemoveRelationshipAction): Promise<WorkspaceState> => (await deps.workspace).removeRelationship(action),
		describeRemoval: async (target: RemovalTarget): Promise<RemovalPlan> => (await deps.workspace).describeRemoval(target),
		setViewport: async (action: SetViewportAction): Promise<WorkspaceState> => (await deps.workspace).setViewport(action),
		addSystemService: async (action: AddSystemServiceAction): Promise<WorkspaceState> => (await deps.workspace).addSystemService(action),
		updateSystemService: async (action: UpdateSystemServiceAction): Promise<WorkspaceState> => (await deps.workspace).updateSystemService(action),
		moveSystemService: async (action: MoveSystemServiceAction): Promise<WorkspaceState> => (await deps.workspace).moveSystemService(action),
		resizeSystemService: async (action: ResizeSystemServiceAction): Promise<WorkspaceState> => (await deps.workspace).resizeSystemService(action),
		removeSystemService: async (action: RemoveSystemServiceAction): Promise<WorkspaceState> => (await deps.workspace).removeSystemService(action),
		setSystemServiceCollapsed: async (action: SetSystemServiceCollapsedAction): Promise<WorkspaceState> =>
			(await deps.workspace).setSystemServiceCollapsed(action),
		describeSystemServiceRemoval: async ({ serviceId }: { serviceId: string }): Promise<SystemServiceRemovalPlan & WalkthroughRemovalImpact> =>
			(await deps.workspace).describeSystemServiceRemoval(serviceId),
		addSystemGroup: async (action: AddSystemGroupAction): Promise<WorkspaceState> => (await deps.workspace).addSystemGroup(action),
		updateSystemGroup: async (action: UpdateSystemGroupAction): Promise<WorkspaceState> => (await deps.workspace).updateSystemGroup(action),
		moveSystemGroup: async (action: MoveSystemGroupAction): Promise<WorkspaceState> => (await deps.workspace).moveSystemGroup(action),
		resizeSystemGroup: async (action: ResizeSystemGroupAction): Promise<WorkspaceState> => (await deps.workspace).resizeSystemGroup(action),
		removeSystemGroup: async (action: RemoveSystemGroupAction): Promise<WorkspaceState> => (await deps.workspace).removeSystemGroup(action),
		addSystemComponent: async (action: AddSystemComponentAction): Promise<WorkspaceState> => (await deps.workspace).addSystemComponent(action),
		updateSystemComponent: async (action: UpdateSystemComponentAction): Promise<WorkspaceState> => (await deps.workspace).updateSystemComponent(action),
		moveSystemComponent: async (action: MoveSystemComponentAction): Promise<WorkspaceState> => (await deps.workspace).moveSystemComponent(action),
		removeSystemComponent: async (action: RemoveSystemComponentAction): Promise<WorkspaceState> => (await deps.workspace).removeSystemComponent(action),
		describeSystemComponentRemoval: async ({ componentId }: { componentId: string }): Promise<SystemComponentRemovalPlan & WalkthroughRemovalImpact> =>
			(await deps.workspace).describeSystemComponentRemoval(componentId),
		describeSystemConnectionRemoval: async ({ connectionId }: { connectionId: string }): Promise<SystemConnectionRemovalPlan & WalkthroughRemovalImpact> =>
			(await deps.workspace).describeSystemConnectionRemoval(connectionId),
		addSystemConnection: async (action: AddSystemConnectionAction): Promise<WorkspaceState> => (await deps.workspace).addSystemConnection(action),
		updateSystemConnection: async (action: UpdateSystemConnectionAction): Promise<WorkspaceState> => (await deps.workspace).updateSystemConnection(action),
		removeSystemConnection: async (action: RemoveSystemConnectionAction): Promise<WorkspaceState> => (await deps.workspace).removeSystemConnection(action),
		setSystemViewport: async (action: SetSystemViewportAction): Promise<WorkspaceState> => (await deps.workspace).setSystemViewport(action),
		setActiveView: async (action: SetActiveViewAction): Promise<WorkspaceState> => (await deps.workspace).setActiveView(action),
		linkSystemDatabase: async (action: LinkSystemDatabaseAction): Promise<WorkspaceState> => (await deps.workspace).linkSystemDatabase(action),
		createSystemDatabaseDesign: async (action: CreateSystemDatabaseDesignAction): Promise<WorkspaceState> =>
			(await deps.workspace).createSystemDatabaseDesign(action),
		createWalkthrough: async (action: CreateWalkthroughAction): Promise<WorkspaceState> => (await deps.workspace).createWalkthrough(action),
		renameWalkthrough: async (action: RenameWalkthroughAction): Promise<WorkspaceState> => (await deps.workspace).renameWalkthrough(action),
		removeWalkthrough: async (action: RemoveWalkthroughAction): Promise<WorkspaceState> => (await deps.workspace).removeWalkthrough(action),
		moveWalkthrough: async (action: MoveWalkthroughAction): Promise<WorkspaceState> => (await deps.workspace).moveWalkthrough(action),
		addWalkthroughStep: async (action: AddWalkthroughStepAction): Promise<WorkspaceState> => (await deps.workspace).addWalkthroughStep(action),
		updateWalkthroughStep: async (action: UpdateWalkthroughStepAction): Promise<WorkspaceState> => (await deps.workspace).updateWalkthroughStep(action),
		moveWalkthroughStep: async (action: MoveWalkthroughStepAction): Promise<WorkspaceState> => (await deps.workspace).moveWalkthroughStep(action),
		removeWalkthroughStep: async (action: RemoveWalkthroughStepAction): Promise<WorkspaceState> => (await deps.workspace).removeWalkthroughStep(action),
		repairWalkthroughStep: async (action: RepairWalkthroughStepAction): Promise<WorkspaceState> => (await deps.workspace).repairWalkthroughStep(action),
		acceptWalkthroughStepRedirection: async (action: AcceptWalkthroughStepRedirectionAction): Promise<WorkspaceState> =>
			(await deps.workspace).acceptWalkthroughStepRedirection(action),
		copySqlPreview: async ({ preview }: { preview: DisplayedSqlPreview }): Promise<SqlPreviewCopyResult> => {
			(await deps.workspace).requireActiveDesign(preview.designId);
			return deps.sqlPreviewActions.copy(preview);
		},
		beginSqlPreviewExport: async ({ preview, fileName }: { preview: DisplayedSqlPreview; fileName: string }): Promise<{ requestId: string }> => {
			(await deps.workspace).requireActiveDesign(preview.designId);
			const requestId = crypto.randomUUID();
			deps.pendingSqlExports.set(requestId, () => deps.sqlPreviewActions.export(preview, fileName));
			return { requestId };
		},
		copySchemaCode: async ({ snapshot }: { snapshot: SchemaCodeSnapshot }): Promise<SqlPreviewCopyResult> => {
			(await deps.workspace).requireActiveDesign(snapshot.designId);
			return deps.sqlPreviewActions.copyCode(snapshot);
		},
		beginSchemaCodeExport: async ({ snapshot, fileName }: { snapshot: SchemaCodeSnapshot; fileName: string }): Promise<{ requestId: string }> => {
			(await deps.workspace).requireActiveDesign(snapshot.designId);
			const requestId = crypto.randomUUID();
			deps.pendingSqlExports.set(requestId, () => deps.sqlPreviewActions.exportCode(snapshot, fileName));
			return { requestId };
		},
		listAssistantConversations: async ({ projectId }: { projectId: string }): Promise<AssistantConversation[]> =>
			(await deps.assistant).listConversations(projectId),
		getAssistantConversation: async ({ conversationId }: { conversationId: string }): Promise<AssistantConversationRecord | null> =>
			(await deps.assistant).loadConversation(conversationId),
		createAssistantConversation: async ({ projectId }: { projectId: string }): Promise<AssistantConversation> =>
			(await deps.assistant).createConversation(projectId),
		renameAssistantConversation: async ({ conversationId, title }: { conversationId: string; title: string }): Promise<boolean> =>
			(await deps.assistant).renameConversation(conversationId, title),
		deleteAssistantConversation: async ({ conversationId }: { conversationId: string }): Promise<boolean> =>
			(await deps.assistant).deleteConversation(conversationId),
		listAssistantModels: async (): Promise<AssistantModel[]> => (await deps.assistant).listModels(),
		listAssistantConnections: async (): Promise<AssistantConnectionStatus[]> => (await deps.assistant).listConnections(),
		setAssistantApiKey: async ({ providerId, apiKey }: { providerId: string; apiKey: string }): Promise<void> => {
			await (await deps.assistant).setAssistantApiKey(providerId, apiKey);
		},
		removeAssistantConnection: async ({ connectionId }: { connectionId: string }): Promise<void> =>
			(await deps.assistant).removeAssistantConnection(connectionId),
		startAssistantOAuthLogin: async ({ providerId }: { providerId: string }): Promise<{ started: boolean }> => {
			void (await deps.assistant).startOAuthLogin(providerId);
			return { started: true };
		},
		answerAssistantOAuthPrompt: async ({ promptId, value }: { promptId: string; value: string }): Promise<boolean> =>
			(await deps.assistant).answerOAuthPrompt(promptId, value),
		cancelAssistantOAuthLogin: async ({ providerId }: { providerId: string }): Promise<void> =>
			(await deps.assistant).cancelOAuthLogin(providerId),
		getClaudeOptIn: async (): Promise<boolean> => (await deps.assistant).getClaudeOptIn(),
		setClaudeOptIn: async ({ enabled }: { enabled: boolean }): Promise<void> => (await deps.assistant).setClaudeOptIn(enabled),
		getAssistantRequestCap: async (): Promise<number> => (await deps.assistant).getMaxRequestsPerTurn(),
		setAssistantRequestCap: async ({ limit }: { limit: number }): Promise<void> => (await deps.assistant).setMaxRequestsPerTurn(limit),
		sendAssistantMessage: async ({ conversationId, text, modelId, thinkingLevel, connectionId }: {
			conversationId: string;
			text: string;
			modelId: string;
			thinkingLevel: AssistantThinkingLevel;
			connectionId?: string;
		}): Promise<{ started: boolean }> => {
			const assistant = await deps.assistant;
			const result = await assistant.sendMessage(conversationId, text, modelId, thinkingLevel, connectionId, { waitForCompletion: false });
			return (result && typeof result === "object" && "started" in result) ? (result as { started: boolean }) : { started: true };
		},
		stopAssistantTurn: async ({ conversationId }: { conversationId: string }): Promise<void> =>
			(await deps.assistant).stop(conversationId),
		continueAssistantTurn: async ({ conversationId }: { conversationId: string }): Promise<{ started: boolean }> => {
			const assistant = await deps.assistant;
			const result = await assistant.continueTurn(conversationId, { waitForCompletion: false });
			return (result && typeof result === "object" && "started" in result) ? (result as { started: boolean }) : { started: true };
		},
		getAssistantTurnStatus: async ({ conversationId }: { conversationId: string }): Promise<{ paused: boolean; confirmationRequired: boolean; revertAvailable: boolean; running: boolean }> => {
			const assistant = await deps.assistant;
			return {
				paused: assistant.isTurnPaused(conversationId),
				confirmationRequired: assistant.isConfirmationPending(conversationId),
				revertAvailable: assistant.canRevertTurn(conversationId),
				running: assistant.isTurnRunning ? assistant.isTurnRunning(conversationId) : false,
			};
		},
		revertAssistantTurn: async ({ conversationId }: { conversationId: string }): Promise<AssistantConversationRecord | null> =>
			(await deps.assistant).revertTurn(conversationId),
		updateAssistantConversationSelection: async ({ conversationId, connectionId, modelId, thinkingLevel }: {
			conversationId: string;
			connectionId: string | null;
			modelId: string;
			thinkingLevel: AssistantThinkingLevel;
		}): Promise<void> => (await deps.assistant).updateConversationSelection(conversationId, connectionId, modelId, thinkingLevel),
		confirmAssistantDdlDrop: async ({ conversationId, toolCallId }: { conversationId: string; toolCallId: string }): Promise<{ started: boolean }> => {
			const assistant = await deps.assistant;
			const result = await assistant.confirmDdlDrop(conversationId, toolCallId, { waitForCompletion: false });
			return (result && typeof result === "object" && "started" in result) ? (result as { started: boolean }) : { started: true };
		},
		rejectAssistantDdlDrop: async ({ conversationId, toolCallId }: { conversationId: string; toolCallId: string }): Promise<{ started: boolean }> => {
			const assistant = await deps.assistant;
			const result = await assistant.rejectDdlDrop(conversationId, toolCallId, { waitForCompletion: false });
			return (result && typeof result === "object" && "started" in result) ? (result as { started: boolean }) : { started: true };
		},
	};
}
