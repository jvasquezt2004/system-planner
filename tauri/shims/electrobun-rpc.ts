import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Stand-in for `electrobun/rpc` in the webview. It keeps the call shape the
 * view already uses, `rpc.request.<name>(params)` and `rpc.send.<name>(params)`,
 * and carries it over Tauri commands. Backend pushes arrive as the
 * `rpc-message` event and are routed to the view's registered handlers.
 */
type Handlers = {
	requests?: Record<string, (params: unknown) => unknown>;
	messages?: Record<string, (payload: unknown) => void>;
};

type RpcConfig = { maxRequestTime?: number; handlers?: Handlers };

export type TauriRpc = {
	request: Record<string, (params?: unknown) => Promise<unknown>>;
	send: Record<string, (params?: unknown) => Promise<void>>;
	/** Used by the Electroview shim to start listening for backend pushes. */
	__listen(): Promise<void>;
};

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : JSON.stringify(cause));
}

export function defineElectrobunRPC<_Schema = unknown, _Side extends string = string>(
	_side: _Side,
	config: RpcConfig = {},
): any {
	const messages = config.handlers?.messages ?? {};
	const request = new Proxy({} as TauriRpc["request"], {
		get: (_target, method: string) => async (params: unknown = {}) => {
			try {
				return await invoke("rpc_request", { method, params });
			} catch (cause) {
				throw errorFrom(cause);
			}
		},
	});
	const send = new Proxy({} as TauriRpc["send"], {
		get: (_target, method: string) => async (params: unknown = {}) => {
			try {
				await invoke("rpc_message", { method, params });
			} catch (cause) {
				throw errorFrom(cause);
			}
		},
	});
	const rpc: TauriRpc = {
		request,
		send,
		async __listen() {
			await listen<{ method: string; payload: unknown }>("rpc-message", ({ payload }) => {
				messages[payload.method]?.(payload.payload);
			});
		},
	};
	return rpc;
}
