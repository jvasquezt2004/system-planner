import type { ElectrobunRPCSchema } from "electrobun/rpc";
import type {
	CanvasPoint,
	CanvasViewport,
	ColumnChanges,
	ColumnType,
	WorkspaceState,
} from "./design";

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
			addTable: {
				params: { name: string; position?: CanvasPoint };
				response: WorkspaceState;
			};
			renameTable: {
				params: { tableId: string; name: string };
				response: WorkspaceState;
			};
			removeTable: {
				params: { tableId: string };
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
			removeColumn: {
				params: { tableId: string; columnId: string };
				response: WorkspaceState;
			};
			setViewport: {
				params: CanvasViewport;
				response: WorkspaceState;
			};
		};
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			workspaceState: WorkspaceState;
		};
	};
}
