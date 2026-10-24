import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import { findRuntimeImport } from "./scenario-runtime";

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage(message: unknown): void };
const pending = new Map<string, (response: { status: number; headers: Record<string, string>; body: unknown }) => void>();
let sequence = 0;
const supportedImports = new Set([
	"jsr:@supabase/supabase-js@2", "npm:@supabase/supabase-js@2", "https://esm.sh/@supabase/supabase-js@2", "@supabase/supabase-js",
]);
const realtimeWebSocket = globalThis.WebSocket;

const tokenForRole = (role: "anon" | "service_role") => {
	const payload = btoa(JSON.stringify({ role })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.`;
};
const roleAuthorization = {
	anon: tokenForRole("anon"),
	serviceRole: tokenForRole("service_role"),
};
scope.onmessage = async ({ data }) => {
	if (data.type === "response") {
		pending.get(data.requestId)?.(data.response);
		pending.delete(data.requestId);
		return;
	}
	const { runId, invocationId, source, request } = data;
	const send = (message: object) => scope.postMessage({ ...message, runId, invocationId });
	const logs: string[] = [];
	let restoreRuntime: (() => void) | undefined;
	try {
		const importError = findRuntimeImport(source, (specifier) => supportedImports.has(specifier));
		if (importError) throw new Error(importError);
		const importPattern = /\bimport\s*\{\s*createClient\s*\}\s*from\s*["']([^"']+)["']\s*;?/g;
		const rewritten = source.replace(importPattern, (_statement: string, specifier: string) => {
			if (!supportedImports.has(specifier)) throw new Error(`Runtime import is not supported: ${specifier}.`);
			return "";
		});
		const compiled = ts.transpileModule(rewritten, {
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
		}).outputText;
		let nestedInvocationAttempted = false;
		const apiFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.pathname.startsWith("/functions/v1/")) {
				nestedInvocationAttempted = true;
				throw new Error("Nested Edge function invocation is not supported.");
			}
			const requestId = String(++sequence);
			const { promise, resolve } = Promise.withResolvers<{ status: number; headers: Record<string, string>; body: unknown }>();
			pending.set(requestId, resolve);
			const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
			if (headers.authorization === "Bearer scenario-service-role-key") {
				headers.authorization = roleAuthorization.serviceRole;
			} else if (headers.authorization === "Bearer scenario-anon-key") {
				headers.authorization = roleAuthorization.anon;
			}
			send({ type: "request", requestId, request: {
				method: init?.method ?? (input instanceof Request ? input.method : "GET"), path: url.pathname, query: url.search.slice(1),
				headers, body: typeof init?.body === "string" ? init.body : null, invocationRef: invocationId,
			} });
			const result = await promise;
			return new Response(JSON.stringify(result.body), { status: result.status, headers: result.headers });
		};
		const oldFetch = globalThis.fetch;
		const oldWebSocket = globalThis.WebSocket;
		const oldXhr = globalThis.XMLHttpRequest;
		const oldImportScripts = Reflect.get(globalThis, "importScripts");
		const capturedConsole = Object.fromEntries(["log", "info", "warn", "error"].map((level) => [level, (...values: unknown[]) => logs.push(values.map(String).join(" "))]));
		Object.assign(globalThis, { fetch: undefined, XMLHttpRequest: undefined, WebSocket: undefined, importScripts: undefined, console: capturedConsole });
		restoreRuntime = () => Object.assign(globalThis, { fetch: oldFetch, XMLHttpRequest: oldXhr, WebSocket: oldWebSocket, importScripts: oldImportScripts });
		const edgeCreateClient = (...args: Parameters<typeof createClient>) => {
			if (realtimeWebSocket) Reflect.set(globalThis, "WebSocket", realtimeWebSocket);
			try {
				const [url, key, options] = args;
				return createClient(url, key, { ...options, global: { ...options?.global, fetch: apiFetch as typeof fetch } });
			} finally {
				Reflect.set(globalThis, "WebSocket", undefined);
			}
		};
		const serving: { handler: ((req: Request) => Response | Promise<Response>) | null } = { handler: null };
		const Deno = {
			serve(callback: (req: Request) => Response | Promise<Response>) { serving.handler = callback; },
			env: { get(name: string) { return ({ SUPABASE_URL: "http://scenario.local", SUPABASE_ANON_KEY: "scenario-anon-key", SUPABASE_SERVICE_ROLE_KEY: "scenario-service-role-key" } as Record<string, string>)[name]; } },
		};
		new Function("Deno", "createClient", "console", `"use strict"; ${compiled}`)(Deno, edgeCreateClient, capturedConsole);
		const handler = serving.handler;
		if (!handler) throw new Error("Edge function did not call Deno.serve().");
		const result = await handler(new Request(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
		}));
		if (nestedInvocationAttempted) throw new Error("Nested Edge function invocation is not supported.");
		send({ type: "finished", status: result.status, headers: Object.fromEntries(result.headers), body: await result.text(), logs });
		restoreRuntime();
	} catch (error) {
		restoreRuntime?.();
		send({ type: "finished", status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }), logs });
	}
};
