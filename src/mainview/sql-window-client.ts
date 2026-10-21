import { defineElectrobunRPC } from "electrobun/rpc";
import { Electroview } from "electrobun/view";
import type { WorkspaceState } from "../shared/design";
import type { SqlWindowRPCSchema } from "../shared/rpc";

const listeners = new Set<(state: WorkspaceState) => void>();
let latestState: WorkspaceState | null = null;

const rpc = defineElectrobunRPC<SqlWindowRPCSchema, "webview">("webview", {
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

export const sqlWindowClient = {
	async load(): Promise<WorkspaceState> {
		const state = await rpc.request.getWorkspaceState({});
		latestState = state;
		return state;
	},
	copyText(text: string): Promise<void> {
		return rpc.request.copyText({ text });
	},
	subscribe(listener: (state: WorkspaceState) => void): () => void {
		listeners.add(listener);
		if (latestState) listener(latestState);
		return () => listeners.delete(listener);
	},
};
