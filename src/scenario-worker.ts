import { createClient } from "@supabase/supabase-js";
import ts from "typescript";
import { findRuntimeImport, createScenarioExpect, stringify, type ScenarioExpectationResult } from "./scenario-runtime";

const scope = self as unknown as {
	onmessage: ((event: MessageEvent) => void) | null;
	postMessage(message: unknown): void;
};
const realtimeWebSocket = globalThis.WebSocket;
let requestSequence = 0;
const pending = new Map<string, (response: { status: number; headers: Record<string, string>; body: unknown }) => void>();
const output: string[] = [];
type ExpectationResult = ScenarioExpectationResult;
const expectations: ExpectationResult[] = [];

scope.onmessage = async (event: MessageEvent) => {
	const message = event.data as
		| { type: "start"; runId: string; source: string; edgeFunctions: { id: string; name: string; source: string }[] }
		| { type: "response"; requestId: string; response: { status: number; headers: Record<string, string>; body: unknown } }
		| { type: "console"; lines: string[] };
	if (message.type === "console") {
		output.push(...message.lines);
		return;
	}
	if (message.type === "response") {
		pending.get(message.requestId)?.(message.response);
		pending.delete(message.requestId);
		return;
	}
	expectations.length = 0;
	output.length = 0;
	const runId = message.runId;
	const report = (status: "passed" | "failed" | "errored", reason?: "exception") =>
		scope.postMessage({ type: "finished", runId, status: status === "passed" && expectations.some((item) => !item.passed) ? "failed" : status, reason, console: output, expectations: [...expectations] });
	try {
		const importError = findRuntimeImport(message.source, () => false);
		if (importError) throw new Error("Scenarios may only import types; runtime imports are not supported.");
		const source = ts.transpileModule(message.source, {
			reportDiagnostics: true,
			compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove },
		}).outputText.replace(/^export \{\};?\s*$/gm, "");
		const requestFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = input instanceof Request ? input.url : String(input);
			const parsed = new URL(url);
			const requestId = String(++requestSequence);
			const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
			const body = init?.body ? String(init.body) : null;
			const { promise, resolve } = Promise.withResolvers<{ status: number; headers: Record<string, string>; body: unknown }>();
			pending.set(requestId, resolve);
			const functionRoute = parsed.pathname.startsWith("/functions/v1/");
			scope.postMessage({
				type: functionRoute ? "invoke" : "request",
				runId,
				requestId,
				functionName: functionRoute ? decodeURIComponent(parsed.pathname.slice("/functions/v1/".length)) : undefined,
				request: functionRoute
					? { url, method: init?.method ?? (input instanceof Request ? input.method : "GET"), headers, body }
					: { method: init?.method ?? (input instanceof Request ? input.method : "GET"), path: parsed.pathname, query: parsed.search.slice(1), headers, body },
			});
			const response = await promise;
			return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
		}) as typeof fetch;
		const createIdentityClient = (role: "anon" | "authenticated" | "service_role", claims: Record<string, unknown>) => {
			const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ ...claims, role }))))
				.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
			const token = `eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.${payload}.`;
			const previousWebSocket = globalThis.WebSocket;
			if (realtimeWebSocket) globalThis.WebSocket = realtimeWebSocket;
			try {
				return createClient("http://scenario.local", "scenario-anon-key", {
					auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
					global: { fetch: requestFetch, headers: { Authorization: `Bearer ${token}` } },
				});
			} finally {
				globalThis.WebSocket = previousWebSocket;
			}
		};
		const supabase = createIdentityClient("anon", {});
		const asUser = (userId: string, claims: Record<string, unknown> = {}) =>
			createIdentityClient("authenticated", { ...claims, sub: userId, user_id: userId });
		const asServiceRole = () => createIdentityClient("service_role", {});
		const recordExpectation = (description: string, passed: boolean, message: string) => {
			expectations.push({ description, passed, message });
		};
		const expectResult = createScenarioExpect(recordExpectation);
		const capturedConsole = {
			log: (...values: unknown[]) => output.push(values.map(stringify).join(" ")),
			info: (...values: unknown[]) => output.push(values.map(stringify).join(" ")),
			warn: (...values: unknown[]) => output.push(values.map(stringify).join(" ")),
			error: (...values: unknown[]) => output.push(values.map(stringify).join(" ")),
		};
		Object.assign(globalThis, {
			fetch: undefined,
			XMLHttpRequest: undefined,
			WebSocket: undefined,
			importScripts: undefined,
			console: capturedConsole,
		});
		await new Function("supabase", "asUser", "asServiceRole", "console", "expect", `return (async () => { ${source}\n })()`)(supabase, asUser, asServiceRole, capturedConsole, expectResult);
		report("passed");
	} catch (error) {
		output.push(error instanceof Error ? error.message : String(error));
		report("errored", "exception");
	}
};
