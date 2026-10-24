import type { ElectrobunRPCSchema } from "electrobun/rpc";
import type {
	AssistantConnectionStatus,
	AssistantConversation,
	AssistantConversationRecord,
	AssistantModel,
	AssistantThinkingLevel,
} from "./assistant";
import type {
	AddRelationshipAction,
	CanvasPoint,
	CanvasViewport,
	ColumnChanges,
	ColumnType,
	RemovalPlan,
	RemovalTarget,
	RemoveRelationshipAction,
	UpdateRelationshipAction,
	UpdateIndexesAction,
	UpdateEnumTypesAction,
	UpdatePoliciesAction,
	UpdateFunctionsAction,
	UpdateUniqueConstraintsAction,
	RemoveFunctionAction,
	UpdateTriggersAction,
	CreateScenarioAction,
	RenameScenarioAction,
	RemoveScenarioAction,
	UpdateScenarioSourceAction,
	CreateEdgeFunctionAction,
	RenameEdgeFunctionAction,
	RemoveEdgeFunctionAction,
	UpdateEdgeFunctionSourceAction,
	DisplayedSqlPreview,
	SqlPreviewCopyResult,
	SqlPreviewExportResult,
	SandboxApiRequest,
	SandboxApiResponse,
	ScenarioRun,
	WorkspaceState,
} from "./design";
import type { SchemaCodeSnapshot } from "./schema-code";
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
			createScenario: { params: CreateScenarioAction; response: WorkspaceState };
			renameScenario: { params: RenameScenarioAction; response: WorkspaceState };
			removeScenario: { params: RemoveScenarioAction; response: WorkspaceState };
			updateScenarioSource: { params: UpdateScenarioSourceAction; response: WorkspaceState };
			createEdgeFunction: { params: CreateEdgeFunctionAction; response: WorkspaceState };
			renameEdgeFunction: { params: RenameEdgeFunctionAction; response: WorkspaceState };
			removeEdgeFunction: { params: RemoveEdgeFunctionAction; response: WorkspaceState };
			updateEdgeFunctionSource: { params: UpdateEdgeFunctionSourceAction; response: WorkspaceState };
			beginScenarioRun: { params: { scenarioId: string }; response: { runId: string; state: WorkspaceState } };
			handleSandboxApiRequest: { params: { runId: string; request: SandboxApiRequest }; response: SandboxApiResponse };
			finishScenarioRun: { params: { runId: string; status: "passed" | "failed" | "errored"; console: string[]; expectations?: ScenarioRun["expectations"]; reason?: "exception" | "stopped" | "timed out" }; response: WorkspaceState };
			undo: {
				params: Record<string, never>;
				response: WorkspaceState;
			};
			redo: {
				params: Record<string, never>;
				response: WorkspaceState;
			};
			addTable: {
				params: { name: string; position?: CanvasPoint };
				response: WorkspaceState;
			};
			renameTable: {
				params: { tableId: string; name: string };
				response: WorkspaceState;
			};
			removeTable: {
				params: { tableId: string; confirmed?: boolean };
				response: WorkspaceState;
			};
			moveTable: {
				params: { tableId: string; position: CanvasPoint };
				response: WorkspaceState;
			};
			addColumn: {
				params: { tableId: string; name?: string; type?: ColumnType };
				response: WorkspaceState;
			};
			updateColumn: {
				params: { tableId: string; columnId: string; changes: ColumnChanges };
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
				params: { tableId: string; columnId: string; confirmed?: boolean };
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
				params: CanvasViewport;
				response: WorkspaceState;
			};
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
			getAnthropicConnectionStatus: { params: Record<string, never>; response: { connected: boolean; error: string | null } };
			setAnthropicApiKey: { params: { apiKey: string }; response: void };
			removeAnthropicApiKey: { params: Record<string, never>; response: void };
			setAssistantApiKey: { params: { providerId: string; apiKey: string }; response: void };
			removeAssistantConnection: { params: { connectionId: string }; response: void };
			startAssistantOAuthLogin: { params: { providerId: string }; response: { success: boolean; error?: string } };
			getClaudeOptIn: { params: Record<string, never>; response: boolean };
			setClaudeOptIn: { params: { enabled: boolean }; response: void };
			sendAssistantMessage: { params: { conversationId: string; text: string; modelId: string; thinkingLevel: AssistantThinkingLevel }; response: unknown };
			stopAssistantTurn: { params: { conversationId: string }; response: void };
			continueAssistantTurn: { params: { conversationId: string }; response: unknown };
			getAssistantTurnStatus: { params: { conversationId: string }; response: { paused: boolean; confirmationRequired: boolean } };
			updateAssistantConversationSelection: { params: { conversationId: string; modelId: string; thinkingLevel: AssistantThinkingLevel }; response: void };
			confirmAssistantDdlDrop: { params: { conversationId: string; toolCallId: string }; response: AssistantConversationRecord | null };
			rejectAssistantDdlDrop: { params: { conversationId: string; toolCallId: string }; response: AssistantConversationRecord | null };
		};
		messages: {
			chooseSqlPreviewExportDirectory: { requestId: string };
			assistantEvent: { conversationId: string; event: unknown };
			assistantOAuthEvent: { providerId: string; event: unknown };
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			workspaceState: WorkspaceState;
			sqlPreviewExportCompleted: { requestId: string; result: SqlPreviewExportResult };
			assistantEvent: { conversationId: string; event: unknown };
			assistantOAuthEvent: { providerId: string; event: unknown };
		};
	};
}
