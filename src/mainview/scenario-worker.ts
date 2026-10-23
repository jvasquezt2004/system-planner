import { createClient } from "@supabase/supabase-js";
import ts from "typescript";

const scope = self as unknown as {
	onmessage: ((event: MessageEvent) => void) | null;
	postMessage(message: unknown): void;
};
let requestSequence = 0;
const pending = new Map<string, (response: { status: number; headers: Record<string, string>; body: unknown }) => void>();
const output: string[] = [];

scope.onmessage = async (event: MessageEvent) => {
	const message = event.data as
		| { type: "start"; runId: string; source: string }
		| { type: "response"; requestId: string; response: { status: number; headers: Record<string, string>; body: unknown } };
	if (message.type === "response") {
		pending.get(message.requestId)?.(message.response);
		pending.delete(message.requestId);
		return;
	}
	const runId = message.runId;
	const report = (status: "passed" | "errored", reason?: "exception") =>
		scope.postMessage({ type: "finished", runId, status, reason, console: output });
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
		const supabase = createClient("http://scenario.local", "scenario-anon-key", {
			auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
			global: { fetch: requestFetch },
		});
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
		await new Function("supabase", "console", `return (async () => { ${source}\n })()`)(supabase, capturedConsole);
		report("passed");
	} catch (error) {
		output.push(error instanceof Error ? error.message : String(error));
		report("errored", "exception");
	}
};

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try { return JSON.stringify(value); } catch { return String(value); }
}
