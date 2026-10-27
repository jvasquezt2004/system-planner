import type { ElectrobunRPCSchema } from "electrobun/rpc";
import type {
	AssistantConnectionStatus,
	AssistantConversation,
	AssistantConversationRecord,
	AssistantModel,
	AssistantThinkingLevel,
} from "./assistant";
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
	Scenario,
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
} from "./design";
import type { SchemaCodeSnapshot } from "./schema-code";
import type {
	AddSystemComponentAction,
	AddSystemConnectionAction,
	AddSystemServiceAction,
	MoveSystemComponentAction,
	MoveSystemServiceAction,
	RemoveSystemComponentAction,
	RemoveSystemConnectionAction,
	RemoveSystemServiceAction,
	ResizeSystemServiceAction,
	SetActiveViewAction,
	SetSystemViewportAction,
	SystemComponentRemovalPlan,
	SystemServiceRemovalPlan,
	UpdateSystemComponentAction,
	UpdateSystemConnectionAction,
	UpdateSystemServiceAction,
} from "./system-design";
import type {
	AddWalkthroughStepAction,
	CreateWalkthroughAction,
	MoveWalkthroughAction,
	MoveWalkthroughStepAction,
	RemoveWalkthroughAction,
	RemoveWalkthroughStepAction,
	RenameWalkthroughAction,
	RepairWalkthroughStepAction,
	UpdateWalkthroughStepAction,
} from "./walkthrough";
export type SqlPreviewExportRequest = Readonly<{
	preview: DisplayedSqlPreview;
	fileName: string;
}>;
export type SchemaCodeExportRequest = Readonly<{
	snapshot: SchemaCodeSnapshot;
	fileName: string;
}>;

/**
 * Typed Electrobun communication between the Bun main process and the React
 * view. The design workspace interface is the only application seam the view
 * talks to.
 */
export interface AppRPCSchema extends ElectrobunRPCSchema {
	bun: {
		requests: {
			getWorkspaceState: {
				params: Record<string, never>;
				response: WorkspaceState;
			};
			createProject: {
				params: { name: string };
				response: WorkspaceState;
			};
			openProject: {
				params: { projectId: string };
				response: WorkspaceState;
			};
			createDesign: { params: CreateDesignAction; response: WorkspaceState };
			openDesign: { params: OpenDesignAction; response: WorkspaceState };
			renameDesign: { params: RenameDesignAction; response: WorkspaceState };
			createScenario: { params: CreateScenarioAction; response: WorkspaceState };
			renameScenario: { params: RenameScenarioAction; response: WorkspaceState };
			removeScenario: { params: RemoveScenarioAction; response: WorkspaceState };
			updateScenarioSource: { params: UpdateScenarioSourceAction; response: WorkspaceState };
			createEdgeFunction: { params: CreateEdgeFunctionAction; response: WorkspaceState };
			renameEdgeFunction: { params: RenameEdgeFunctionAction; response: WorkspaceState };
			removeEdgeFunction: { params: RemoveEdgeFunctionAction; response: WorkspaceState };
			updateEdgeFunctionSource: { params: UpdateEdgeFunctionSourceAction; response: WorkspaceState };
			beginScenarioRun: { params: { scenarioId: string; designId: string }; response: { runId: string; state: WorkspaceState } };
			handleSandboxApiRequest: { params: { runId: string; request: SandboxApiRequest }; response: SandboxApiResponse };
			finishScenarioRun: { params: { runId: string; status: "passed" | "failed" | "errored"; console: string[]; expectations?: ScenarioRun["expectations"]; reason?: "exception" | "stopped" | "timed out" }; response: WorkspaceState };
			undo: {
				params: { designId: string };
				response: WorkspaceState;
			};
			redo: {
				params: { designId: string };
				response: WorkspaceState;
			};
			addTable: {
				params: AddTableAction;
				response: WorkspaceState;
			};
			renameTable: {
				params: RenameTableAction;
				response: WorkspaceState;
			};
			removeTable: {
				params: RemoveTableAction;
				response: WorkspaceState;
			};
			moveTable: {
				params: MoveTableAction;
				response: WorkspaceState;
			};
			addColumn: {
				params: AddColumnAction;
				response: WorkspaceState;
			};
			updateColumn: {
				params: UpdateColumnAction;
				response: WorkspaceState;
			};
			updateIndexes: { params: UpdateIndexesAction; response: WorkspaceState };
			updateEnumTypes: { params: UpdateEnumTypesAction; response: WorkspaceState };
			updateUniqueConstraints: { params: UpdateUniqueConstraintsAction; response: WorkspaceState };
			updateFunctions: { params: UpdateFunctionsAction; response: WorkspaceState };
			updateTriggers: { params: UpdateTriggersAction; response: WorkspaceState };
			removeFunction: { params: RemoveFunctionAction; response: WorkspaceState };
			updatePolicies: { params: UpdatePoliciesAction; response: WorkspaceState };
			removeColumn: {
				params: RemoveColumnAction;
				response: WorkspaceState;
			};
			addRelationship: {
				params: AddRelationshipAction;
				response: WorkspaceState;
			};
			updateRelationship: {
				params: UpdateRelationshipAction;
				response: WorkspaceState;
			};
			removeRelationship: {
				params: RemoveRelationshipAction;
				response: WorkspaceState;
			};
			describeRemoval: {
				params: RemovalTarget;
				response: RemovalPlan;
			};
			setViewport: {
				params: SetViewportAction;
				response: WorkspaceState;
			};
			addSystemService: { params: AddSystemServiceAction; response: WorkspaceState };
			updateSystemService: { params: UpdateSystemServiceAction; response: WorkspaceState };
			moveSystemService: { params: MoveSystemServiceAction; response: WorkspaceState };
			resizeSystemService: { params: ResizeSystemServiceAction; response: WorkspaceState };
			removeSystemService: { params: RemoveSystemServiceAction; response: WorkspaceState };
			describeSystemServiceRemoval: { params: { serviceId: string }; response: SystemServiceRemovalPlan };
			addSystemComponent: { params: AddSystemComponentAction; response: WorkspaceState };
			updateSystemComponent: { params: UpdateSystemComponentAction; response: WorkspaceState };
			moveSystemComponent: { params: MoveSystemComponentAction; response: WorkspaceState };
			removeSystemComponent: { params: RemoveSystemComponentAction; response: WorkspaceState };
			describeSystemComponentRemoval: { params: { componentId: string }; response: SystemComponentRemovalPlan };
			addSystemConnection: { params: AddSystemConnectionAction; response: WorkspaceState };
			updateSystemConnection: { params: UpdateSystemConnectionAction; response: WorkspaceState };
			removeSystemConnection: { params: RemoveSystemConnectionAction; response: WorkspaceState };
			setSystemViewport: { params: SetSystemViewportAction; response: WorkspaceState };
			setActiveView: { params: SetActiveViewAction; response: WorkspaceState };
			createWalkthrough: { params: CreateWalkthroughAction; response: WorkspaceState };
			renameWalkthrough: { params: RenameWalkthroughAction; response: WorkspaceState };
			removeWalkthrough: { params: RemoveWalkthroughAction; response: WorkspaceState };
			moveWalkthrough: { params: MoveWalkthroughAction; response: WorkspaceState };
			addWalkthroughStep: { params: AddWalkthroughStepAction; response: WorkspaceState };
			updateWalkthroughStep: { params: UpdateWalkthroughStepAction; response: WorkspaceState };
			moveWalkthroughStep: { params: MoveWalkthroughStepAction; response: WorkspaceState };
			removeWalkthroughStep: { params: RemoveWalkthroughStepAction; response: WorkspaceState };
			repairWalkthroughStep: { params: RepairWalkthroughStepAction; response: WorkspaceState };
			copySqlPreview: {
				params: { preview: DisplayedSqlPreview };
				response: SqlPreviewCopyResult;
			};
			beginSqlPreviewExport: {
				params: SqlPreviewExportRequest;
				response: { requestId: string };
			};
			copySchemaCode: {
				params: { snapshot: SchemaCodeSnapshot };
				response: SqlPreviewCopyResult;
			};
			/** ORM exports share the SQL export's folder picker and completion message. */
			beginSchemaCodeExport: {
				params: SchemaCodeExportRequest;
				response: { requestId: string };
			};
			listAssistantConversations: { params: { projectId: string }; response: AssistantConversation[] };
			getAssistantConversation: { params: { conversationId: string }; response: AssistantConversationRecord | null };
			createAssistantConversation: { params: { projectId: string }; response: AssistantConversation };
			renameAssistantConversation: { params: { conversationId: string; title: string }; response: boolean };
			deleteAssistantConversation: { params: { conversationId: string }; response: boolean };
			listAssistantModels: { params: Record<string, never>; response: AssistantModel[] };
			listAssistantConnections: { params: Record<string, never>; response: AssistantConnectionStatus[] };
			setAssistantApiKey: { params: { providerId: string; apiKey: string }; response: void };
			removeAssistantConnection: { params: { connectionId: string }; response: void };
			/** Starts sign-in and returns at once; the outcome arrives as an assistantOAuthEvent "login_finished". */
			startAssistantOAuthLogin: { params: { providerId: string }; response: { started: boolean } };
			answerAssistantOAuthPrompt: { params: { promptId: string; value: string }; response: boolean };
			cancelAssistantOAuthLogin: { params: { providerId: string }; response: void };
			getClaudeOptIn: { params: Record<string, never>; response: boolean };
			setClaudeOptIn: { params: { enabled: boolean }; response: void };
			getAssistantRequestCap: { params: Record<string, never>; response: number };
			setAssistantRequestCap: { params: { limit: number }; response: void };
			sendAssistantMessage: { params: { conversationId: string; text: string; modelId: string; thinkingLevel: AssistantThinkingLevel; connectionId?: string }; response: { started: boolean } };
			stopAssistantTurn: { params: { conversationId: string }; response: void };
			continueAssistantTurn: { params: { conversationId: string }; response: { started: boolean } };
			getAssistantTurnStatus: { params: { conversationId: string }; response: { paused: boolean; confirmationRequired: boolean; revertAvailable: boolean; running?: boolean } };
			revertAssistantTurn: { params: { conversationId: string }; response: AssistantConversationRecord | null };
			updateAssistantConversationSelection: { params: { conversationId: string; connectionId: string | null; modelId: string; thinkingLevel: AssistantThinkingLevel }; response: void };
			confirmAssistantDdlDrop: { params: { conversationId: string; toolCallId: string }; response: { started: boolean } };
			rejectAssistantDdlDrop: { params: { conversationId: string; toolCallId: string }; response: { started: boolean } };
		};
		messages: {
			chooseSqlPreviewExportDirectory: { requestId: string };
			assistantScenarioRunCompleted: { requestId: string; designId?: string; run: ScenarioRun | null; error?: string };
			assistantEvent: { conversationId: string; event: unknown };
			assistantOAuthEvent: { providerId: string; event: unknown };
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			workspaceState: WorkspaceState;
			sqlPreviewExportCompleted: { requestId: string; result: SqlPreviewExportResult };
			assistantScenarioRunRequest: { requestId: string; projectId: string; designId: string; scenario: Scenario };
			assistantScenarioRunCancel: { requestId: string };
			assistantEvent: { conversationId: string; event: unknown };
			assistantOAuthEvent: { providerId: string; event: unknown };
		};
	};
}
