import { defineElectrobunRPC } from "electrobun/rpc";
import { Electroview } from "electrobun/view";
import type { CanvasPoint, CanvasViewport, WorkspaceState } from "../shared/design";
import type { AppRPCSchema } from "../shared/rpc";

const listeners = new Set<(state: WorkspaceState) => void>();
let latestState: WorkspaceState | null = null;

const rpc = defineElectrobunRPC<AppRPCSchema, "webview">("webview", {
	// Autosave plus sandbox validation can take longer than the 1s default.
	maxRequestTime: 60_000,
	handlers: {
		messages: {
			workspaceState(state) {
				latestState = state;
				for (const listener of listeners) listener(state);
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
	openProject(projectId: string): Promise<WorkspaceState> {
		return rpc.request.openProject({ projectId });
	},
	addTable(name: string, position?: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.addTable({ name, position });
	},
	renameTable(tableId: string, name: string): Promise<WorkspaceState> {
		return rpc.request.renameTable({ tableId, name });
	},
	removeTable(tableId: string): Promise<WorkspaceState> {
		return rpc.request.removeTable({ tableId });
	},
	moveTable(tableId: string, position: CanvasPoint): Promise<WorkspaceState> {
		return rpc.request.moveTable({ tableId, position });
	},
	setViewport(viewport: CanvasViewport): Promise<WorkspaceState> {
		return rpc.request.setViewport(viewport);
	},
	subscribe(listener: (state: WorkspaceState) => void): () => void {
		listeners.add(listener);
		if (latestState) listener(latestState);
		return () => listeners.delete(listener);
	},
};
