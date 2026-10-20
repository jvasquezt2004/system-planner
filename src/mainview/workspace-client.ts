import { defineElectrobunRPC } from "electrobun/rpc";
import { Electroview } from "electrobun/view";
import type { WorkspaceState } from "../shared/design";
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
	addTable(name: string): Promise<WorkspaceState> {
		return rpc.request.addTable({ name });
	},
	subscribe(listener: (state: WorkspaceState) => void): () => void {
		listeners.add(listener);
		if (latestState) listener(latestState);
		return () => listeners.delete(listener);
	},
};
