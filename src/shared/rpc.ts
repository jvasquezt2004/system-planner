import type { ElectrobunRPCSchema } from "electrobun/rpc";
import type { CanvasPoint, CanvasViewport, WorkspaceState } from "./design";

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
