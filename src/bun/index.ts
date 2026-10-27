import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { BrowserWindow, Updater, Utils } from "electrobun/main";
import { defineElectrobunRPC } from "electrobun/rpc";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ScenarioRun, SqlPreviewExportResult } from "../shared/design";
import type { AppRPCSchema } from "../shared/rpc";
import { createSqlPreviewActions } from "./sql-preview";
import { createDesignWorkspace } from "./workspace";
import { createAssistantRuntime } from "./assistant-runtime";
import { createRpcRequestHandlers } from "./rpc-handlers";

// pi-ai loads OAuth sign-in flows through a variable import() the bundle cannot
// follow; register them statically so account sign-in works in the built app.
registerBunOAuthFlows();

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// Check if Vite dev server is running for HMR
async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'hutch run dev:hmr' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

const databasePath =
	process.env.DB_PLANNER_DATABASE_PATH ??
	join(Utils.paths.userData, "schema-designer.sqlite");

// Keep the authoritative design and the disposable sandbox behind one public
// workspace interface. The view only sees this interface through typed RPC.
type PendingAssistantScenarioRun = {
	resolve: (run: ScenarioRun | null) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
};
const pendingAssistantScenarioRuns = new Map<string, PendingAssistantScenarioRun>();
function rejectPendingAssistantScenarioRun(requestId: string, error: Error) {
	const pending = pendingAssistantScenarioRuns.get(requestId);
	if (!pending) return;
	pendingAssistantScenarioRuns.delete(requestId);
	pending.cleanup();
	pending.reject(error);
}
function completePendingAssistantScenarioRun(requestId: string, run: ScenarioRun | null, error?: string) {
	const pending = pendingAssistantScenarioRuns.get(requestId);
	if (!pending) return;
	pendingAssistantScenarioRuns.delete(requestId);
	pending.cleanup();
	if (error) pending.reject(new Error(error));
	else pending.resolve(run);
}
const workspacePromise = createDesignWorkspace({ databasePath });
const assistantPromise = workspacePromise.then((workspace) =>
	createAssistantRuntime({
		databasePath,
		workspace,
		openExternal: (url) => Utils.openExternal(url),
		runScenario: (projectId, designId, scenario, signal, timeoutMs) => {
			if (!designId) throw new Error("The Assistant Scenario run has no target Design.");
			const { promise, resolve, reject } = Promise.withResolvers<ScenarioRun | null>();
			const requestId = crypto.randomUUID();
			const onAbort = () => {
				const error = new Error("The Assistant turn stopped the Scenario run.");
				error.name = "AbortError";
				void rpc.send.assistantScenarioRunCancel({ requestId });
				rejectPendingAssistantScenarioRun(requestId, error);
			};
			const timer = setTimeout(() => {
				void rpc.send.assistantScenarioRunCancel({ requestId });
				rejectPendingAssistantScenarioRun(
					requestId,
					new Error("The view did not report the Scenario run result in time."),
				);
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			pendingAssistantScenarioRuns.set(requestId, { resolve, reject, cleanup });
			if (signal?.aborted) onAbort();
			else {
				signal?.addEventListener("abort", onAbort, { once: true });
				void Promise.resolve(rpc.send.assistantScenarioRunRequest({ requestId, projectId, designId, scenario })).catch((cause: unknown) => {
					rejectPendingAssistantScenarioRun(
						requestId,
						cause instanceof Error ? cause : new Error(String(cause)),
					);
				});
			}
			return promise;
		},
	}),
);

/** Exports waiting for the view to start the folder picker, by request id. */
const pendingSqlExports = new Map<string, () => Promise<SqlPreviewExportResult>>();
const sqlPreviewActions = createSqlPreviewActions({
	writeClipboardText: Utils.clipboardWriteText,
	// Electrobun has a native folder picker but no native save dialog.
	chooseExportDirectory: async () => {
		const [directory] = await Utils.openFileDialog({
			startingFolder: Utils.paths.documents,
			allowedFileTypes: "*",
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
		return directory ?? null;
	},
});

const rpc = defineElectrobunRPC<AppRPCSchema, "bun">("bun", {
	maxRequestTime: 60_000,
	handlers: {
		requests: createRpcRequestHandlers({
			workspace: workspacePromise,
			assistant: assistantPromise,
			sqlPreviewActions,
			pendingSqlExports,
		}),
		messages: {
			// Start the native picker from a message, not an awaited RPC request.
			chooseSqlPreviewExportDirectory: ({ requestId }) => {
				const runExport = pendingSqlExports.get(requestId);
				if (!runExport) return;
				pendingSqlExports.delete(requestId);
				void runExport().then((result) => {
					rpc.send.sqlPreviewExportCompleted({ requestId, result });
				});
			},
			assistantScenarioRunCompleted: ({ requestId, run, error }) =>
				completePendingAssistantScenarioRun(requestId, run, error),
		},
	},
});
void assistantPromise.then((assistant) => {
	assistant.subscribe((conversationId, event) => {
		rpc.send.assistantEvent({ conversationId, event });
	});
	assistant.subscribeOAuth((providerId, event) => {
		rpc.send.assistantOAuthEvent({ providerId, event });
	});
});
const proofReportPath = process.env.SCHEMA_DESIGNER_PROOF_REPORT_PATH;
let proofServer: ReturnType<typeof Bun.serve> | undefined;
let proofReportUrl: string | undefined;
if (proofReportPath) {
	proofServer = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const headers = {
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "POST, OPTIONS",
				"access-control-allow-headers": "content-type",
			};
			if (request.method === "OPTIONS") return new Response(null, { headers });
			if (request.method !== "POST" || new URL(request.url).pathname !== "/report") {
				return new Response("Not found", { status: 404, headers });
			}
			try {
				const report = await request.json() as { allPassed?: boolean };
				mkdirSync(dirname(proofReportPath), { recursive: true });
				writeFileSync(proofReportPath, `${JSON.stringify(report, null, 2)}\n`);
				const passed = report.allPassed === true;
				setTimeout(() => {
					proofServer?.stop();
					process.exit(passed ? 0 : 1);
				}, 100);
				return Response.json({ accepted: true, allPassed: passed }, { headers });
			} catch (error) {
				console.error("[webview-proof] failed to save report", error);
				return new Response(String(error), { status: 500, headers });
			}
		},
	});
	proofReportUrl = `http://127.0.0.1:${proofServer.port}/report`;
}

const url = await getMainViewUrl();
const windowUrl = proofReportUrl
	? `${url}${url.includes("?") ? "&" : "?"}proofReportUrl=${encodeURIComponent(proofReportUrl)}`
	: url;

const mainWindow = new BrowserWindow({
	title: "Schema Designer",
	url: windowUrl,
	frame: {
		width: 1280,
		height: 800,
		x: 160,
		y: 120,
	},
	rpc,
});

void workspacePromise
	.then((workspace) => {
		const state = workspace.getState();
		console.log(
			`[workspace] database=${databasePath} project=${state.project?.name ?? "none"} sql=${state.sql.status} sandbox=${state.sandbox.status}`,
		);
		workspace.subscribe((next) => {
			rpc.send.workspaceState(next);
		});
	})
	.catch((error: unknown) => {
		console.error("[workspace] failed to initialize", error);
	});

console.log("Schema Designer started!", mainWindow.id);
