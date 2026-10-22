import type { ElectrobunRPCSchema } from "electrobun/rpc";
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
	UpdateUniqueConstraintsAction,
	DisplayedSqlPreview,
	SqlPreviewCopyResult,
	SqlPreviewExportResult,
	WorkspaceState,
} from "./design";
export type SqlPreviewExportRequest = Readonly<{
	preview: DisplayedSqlPreview;
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
		};
		messages: {
			chooseSqlPreviewExportDirectory: { requestId: string };
		};
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			workspaceState: WorkspaceState;
			sqlPreviewExportCompleted: {
				requestId: string;
				result: SqlPreviewExportResult;
			};
		};
	};
}
