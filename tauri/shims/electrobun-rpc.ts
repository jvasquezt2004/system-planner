import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Stand-in for `electrobun/rpc` in the webview. It keeps the call shape the
 * view already uses, `rpc.request.<name>(params)` and `rpc.send.<name>(params)`,
 * and carries it over Tauri commands. Backend pushes arrive as the
 * `rpc-message` event and are routed to the view's registered handlers.
 */
/** The shape of an Electrobun RPC schema, which the view's `AppRPCSchema` extends. */
export type ElectrobunRPCSchema = {
	bun: { requests: Record<string, { params: any; response: any }>; messages: Record<string, any> };
	webview: { requests: Record<string, { params: any; response: any }>; messages: Record<string, any> };
};

type Arguments<P> = [P] extends [void] | [undefined] ? [params?: P] : [params: P];

export type TauriRpc<S extends ElectrobunRPCSchema = ElectrobunRPCSchema> = {
	request: { [K in keyof S["bun"]["requests"]]: (...params: Arguments<S["bun"]["requests"][K]["params"]>) => Promise<S["bun"]["requests"][K]["response"]> };
	send: { [K in keyof S["bun"]["messages"]]: (...payload: Arguments<S["bun"]["messages"][K]>) => Promise<void> };
	/** Used by the Electroview shim to start listening for backend pushes. */
	__listen(): Promise<void>;
};

type Handlers<S extends ElectrobunRPCSchema> = {
	requests?: Record<string, (params: any) => unknown>;
	messages?: { [K in keyof S["webview"]["messages"]]?: (payload: S["webview"]["messages"][K]) => void };
};

type RpcConfig<S extends ElectrobunRPCSchema> = { maxRequestTime?: number; handlers?: Handlers<S> };

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : JSON.stringify(cause));
}

export function defineElectrobunRPC<S extends ElectrobunRPCSchema = ElectrobunRPCSchema, _Side extends string = string>(
	_side: _Side,
	config: RpcConfig<S> = {},
): TauriRpc<S> {
	const messages = (config.handlers?.messages ?? {}) as Record<string, ((payload: unknown) => void) | undefined>;
	const request = new Proxy({} as TauriRpc<S>["request"], {
		get: (_target, method: string) => async (params: unknown = {}) => {
			try {
				return await invoke("rpc_request", { method, params });
			} catch (cause) {
				throw errorFrom(cause);
			}
		},
	});
	const send = new Proxy({} as TauriRpc<S>["send"], {
		get: (_target, method: string) => async (params: unknown = {}) => {
			try {
				await invoke("rpc_message", { method, params });
			} catch (cause) {
				throw errorFrom(cause);
			}
		},
	});
	const rpc: TauriRpc<S> = {
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
