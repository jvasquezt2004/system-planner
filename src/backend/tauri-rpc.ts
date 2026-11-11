import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { RpcSchema } from "../shared/rpc";

/**
 * The view's connection to the Rust backend: `rpc.request.<name>(params)` is a request that
 * answers, `rpc.send.<name>(params)` is a message that does not. Both travel as Tauri commands
 * (`rpc_request`, `rpc_message`); the backend's pushes arrive as the `rpc-message` event and are
 * routed to the handlers registered here.
 */

type Arguments<P> = [P] extends [void] | [undefined] ? [params?: P] : [params: P];

export type TauriRpc<S extends RpcSchema = RpcSchema> = {
	request: { [K in keyof S["backend"]["requests"]]: (...params: Arguments<S["backend"]["requests"][K]["params"]>) => Promise<S["backend"]["requests"][K]["response"]> };
	send: { [K in keyof S["backend"]["messages"]]: (...payload: Arguments<S["backend"]["messages"][K]>) => Promise<void> };
	/** Starts listening for the backend's pushes. */
	listen(): Promise<void>;
};

type Handlers<S extends RpcSchema> = {
	requests?: Record<string, (params: any) => unknown>;
	messages?: { [K in keyof S["webview"]["messages"]]?: (payload: S["webview"]["messages"][K]) => void };
};

type RpcConfig<S extends RpcSchema> = { handlers?: Handlers<S> };

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(typeof cause === "string" ? cause : JSON.stringify(cause));
}

export function defineRpc<S extends RpcSchema = RpcSchema>(config: RpcConfig<S> = {}): TauriRpc<S> {
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
		async listen() {
			await listen<{ method: string; payload: unknown }>("rpc-message", ({ payload }) => {
				messages[payload.method]?.(payload.payload);
			});
		},
	};
	return rpc;
}
