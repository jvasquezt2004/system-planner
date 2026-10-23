import { createClient } from "@supabase/supabase-js";
import ts from "typescript";

const scope = self as unknown as {
	onmessage: ((event: MessageEvent) => void) | null;
	postMessage(message: unknown): void;
};
const realtimeWebSocket = globalThis.WebSocket;
let requestSequence = 0;
const pending = new Map<string, (response: { status: number; headers: Record<string, string>; body: unknown }) => void>();
const output: string[] = [];
type ExpectationResult = { description: string; passed: boolean; message: string };
const expectations: ExpectationResult[] = [];

scope.onmessage = async (event: MessageEvent) => {
	const message = event.data as
		| { type: "start"; runId: string; source: string }
		| { type: "response"; requestId: string; response: { status: number; headers: Record<string, string>; body: unknown } };
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
		const file = ts.createSourceFile("scenario.ts", message.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
		const hasRuntimeImport = (node: ts.Node): boolean => {
			if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) return true;
			if (ts.isExportDeclaration(node) && Boolean(node.moduleSpecifier) && !node.isTypeOnly) return true;
			if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) return true;
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
			return ts.forEachChild(node, hasRuntimeImport) ?? false;
		};
		if (hasRuntimeImport(file)) throw new Error("Scenarios may only import types; runtime imports are not supported.");
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
			scope.postMessage({
				type: "request",
				runId,
				requestId,
				request: { method: init?.method ?? (input instanceof Request ? input.method : "GET"), path: parsed.pathname, query: parsed.search.slice(1), headers, body },
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
		const expectResult = (value: unknown) => {
			const pending = value !== null && typeof value === "object" && "then" in value && typeof value.then === "function";
			const valid = isScenarioRequestResult(value);
			const invalidReason = pending
				? "expect() received a pending request; await it first"
				: valid ? null : "expect() requires an awaited request result";
			const result: ScenarioRequestResult = valid ? value : {};
			const recordInvalidInput = (description: string): boolean => {
				if (!invalidReason) return false;
				recordExpectation(description, false, invalidReason);
				return true;
			};
			return {
				succeeds() {
					if (recordInvalidInput("request succeeds")) return;
					const passed = !result.error;
					recordExpectation("request succeeds", passed, passed ? "Request succeeded." : `Request failed: ${result.error?.message ?? result.error?.code ?? "unknown error"}`);
				},
				fails(code?: string) {
					if (recordInvalidInput(code ? `request fails with ${code}` : "request fails")) return;
					const matchesFailure = Boolean(result.error) && (!code || result.error?.code === code);
					recordExpectation(
						code ? `request fails with ${code}` : "request fails",
						matchesFailure,
						matchesFailure ? `Request failed${code ? ` with ${code}` : ""}.` : result.error ? `Expected error ${code}, received ${result.error.code ?? "unknown error"}.` : "Expected request to fail, but it succeeded.",
					);
				},
				returnsDataEqual(expected: unknown) {
					if (recordInvalidInput("request returns expected data")) return;
					const passed = deepEqual(result.data, expected);
					recordExpectation("request returns expected data", passed, passed ? "Returned data matched." : `Expected ${stringify(expected)}, received ${stringify(result.data)}.`);
				},
			};
		};
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
function deepEqual(actual: unknown, expected: unknown): boolean {
	if (Object.is(actual, expected)) return true;
	if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) return false;
	if (Array.isArray(actual) !== Array.isArray(expected)) return false;
	const actualKeys = Object.keys(actual);
	const expectedKeys = Object.keys(expected);
	return actualKeys.length === expectedKeys.length
		&& expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(actual, key) && deepEqual((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
}

type ScenarioRequestResult = { data?: unknown; error?: { code?: string; message?: string } | null };

function isScenarioRequestResult(value: unknown): value is ScenarioRequestResult {
	return typeof value === "object"
		&& value !== null
		&& !("then" in value && typeof value.then === "function")
		&& ("data" in value || "error" in value);
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}
