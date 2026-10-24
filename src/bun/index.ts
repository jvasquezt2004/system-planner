import { BrowserWindow, Updater, Utils } from "electrobun/main";
import { defineElectrobunRPC } from "electrobun/rpc";
import { join } from "node:path";
import type { SqlPreviewExportResult } from "../shared/design";
import type { AppRPCSchema } from "../shared/rpc";
import { createSqlPreviewActions } from "./sql-preview";
import { createDesignWorkspace } from "./workspace";
import { createAssistantRuntime } from "./assistant-runtime";

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
const workspacePromise = createDesignWorkspace({ databasePath });
const assistantPromise = workspacePromise.then((workspace) =>
	createAssistantRuntime({ databasePath, workspace }),
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
		requests: {
			getWorkspaceState: async () => (await workspacePromise).getState(),
			listAssistantConversations: async ({ projectId }) =>
				(await assistantPromise).listConversations(projectId),
			getAssistantConversation: async ({ conversationId }) =>
				(await assistantPromise).loadConversation(conversationId),
			createAssistantConversation: async ({ projectId }) =>
				(await assistantPromise).createConversation(projectId),
			renameAssistantConversation: async ({ conversationId, title }) =>
				(await assistantPromise).renameConversation(conversationId, title),
			deleteAssistantConversation: async ({ conversationId }) =>
				(await assistantPromise).deleteConversation(conversationId),
			listAssistantModels: async () => (await assistantPromise).listModels(),
			getAnthropicConnectionStatus: async () => (await assistantPromise).getAnthropicConnectionStatus(),
			removeAnthropicApiKey: async () => (await assistantPromise).removeAnthropicApiKey(),
			setAnthropicApiKey: async ({ apiKey }) =>
				(await assistantPromise).setAnthropicApiKey(apiKey),
			sendAssistantMessage: async ({ conversationId, text, modelId, thinkingLevel }) =>
				(await assistantPromise).sendMessage(conversationId, text, modelId, thinkingLevel),
			stopAssistantTurn: async ({ conversationId }) =>
				(await assistantPromise).stop(conversationId),
			continueAssistantTurn: async ({ conversationId }) =>
				(await assistantPromise).continueTurn(conversationId),
			getAssistantTurnStatus: async ({ conversationId }) => ({
				paused: (await assistantPromise).isTurnPaused(conversationId),
				confirmationRequired: (await assistantPromise).isConfirmationPending(conversationId),
			}),
			updateAssistantConversationSelection: async ({ conversationId, modelId, thinkingLevel }) =>
				(await assistantPromise).updateConversationSelection(conversationId, modelId, thinkingLevel),
			confirmAssistantDdlDrop: async ({ conversationId, toolCallId }) =>
				(await assistantPromise).confirmDdlDrop(conversationId, toolCallId),
			rejectAssistantDdlDrop: async ({ conversationId, toolCallId }) =>
				(await assistantPromise).rejectDdlDrop(conversationId, toolCallId),
			createProject: async ({ name }) => (await workspacePromise).createProject({ name }),
			openProject: async ({ projectId }) =>
				(await workspacePromise).openProject({ projectId }),
			createScenario: async ({ name }) =>
				(await workspacePromise).createScenario({ name }),
			renameScenario: async ({ scenarioId, name }) =>
				(await workspacePromise).renameScenario({ scenarioId, name }),
			removeScenario: async ({ scenarioId }) =>
				(await workspacePromise).removeScenario({ scenarioId }),
			updateScenarioSource: async ({ scenarioId, source }) =>
				(await workspacePromise).updateScenarioSource({ scenarioId, source }),
			createEdgeFunction: async (action) => (await workspacePromise).createEdgeFunction(action),
			renameEdgeFunction: async (action) => (await workspacePromise).renameEdgeFunction(action),
			removeEdgeFunction: async (action) => (await workspacePromise).removeEdgeFunction(action),
			updateEdgeFunctionSource: async (action) => (await workspacePromise).updateEdgeFunctionSource(action),
			beginScenarioRun: async ({ scenarioId }) =>
				(await workspacePromise).beginScenarioRun({ scenarioId }),
			handleSandboxApiRequest: async ({ runId, request }) =>
				(await workspacePromise).handleSandboxApiRequest({ runId, request }),
			finishScenarioRun: async ({ runId, status, console: output, reason }) =>
				(await workspacePromise).finishScenarioRun({ runId, status, console: output, reason }),
			undo: async () => (await workspacePromise).undo(),
			redo: async () => (await workspacePromise).redo(),
			addTable: async ({ name, position }) =>
				(await workspacePromise).addTable({ name, position }),
			renameTable: async ({ tableId, name }) =>
				(await workspacePromise).renameTable({ tableId, name }),
			removeTable: async ({ tableId, confirmed }) =>
				(await workspacePromise).removeTable({ tableId, confirmed }),
			moveTable: async ({ tableId, position }) =>
				(await workspacePromise).moveTable({ tableId, position }),
			addColumn: async ({ tableId, name, type }) =>
				(await workspacePromise).addColumn({ tableId, name, type }),
			updateColumn: async ({ tableId, columnId, changes }) =>
				(await workspacePromise).updateColumn({ tableId, columnId, changes }),
			updateIndexes: async (action) => (await workspacePromise).updateIndexes(action),
			updateEnumTypes: async (action) => (await workspacePromise).updateEnumTypes(action),
			updateFunctions: async (action) => (await workspacePromise).updateFunctions(action),
			updateTriggers: async (action) => (await workspacePromise).updateTriggers(action),
			removeFunction: async (action) => (await workspacePromise).removeFunction(action),
			updatePolicies: async (action) => (await workspacePromise).updatePolicies(action),
			updateUniqueConstraints: async (action) => (await workspacePromise).updateUniqueConstraints(action),
			removeColumn: async ({ tableId, columnId, confirmed }) =>
				(await workspacePromise).removeColumn({ tableId, columnId, confirmed }),
			addRelationship: async ({
				referencingTableId,
				referencedTableId,
				cardinality,
				junctionPosition,
			}) =>
				(await workspacePromise).addRelationship({
					referencingTableId,
					referencedTableId,
					cardinality,
					junctionPosition,
				}),
			updateRelationship: async ({ relationshipId, required, cardinality }) =>
				(await workspacePromise).updateRelationship({
					relationshipId,
					required,
					cardinality,
				}),
			removeRelationship: async ({ relationshipId }) =>
				(await workspacePromise).removeRelationship({ relationshipId }),
			describeRemoval: async (target) =>
				(await workspacePromise).describeRemoval(target),
			setViewport: async (viewport) => (await workspacePromise).setViewport(viewport),
			copySqlPreview: ({ preview }) => sqlPreviewActions.copy(preview),
			beginSqlPreviewExport: ({ preview, fileName }) => {
				const requestId = crypto.randomUUID();
				pendingSqlExports.set(requestId, () =>
					sqlPreviewActions.export(preview, fileName),
				);
				return { requestId };
			},
			copySchemaCode: ({ snapshot }) => sqlPreviewActions.copyCode(snapshot),
			beginSchemaCodeExport: ({ snapshot, fileName }) => {
				const requestId = crypto.randomUUID();
				pendingSqlExports.set(requestId, () =>
					sqlPreviewActions.exportCode(snapshot, fileName),
				);
				return { requestId };
			},
		},
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
		},
	},
});
void assistantPromise.then((assistant) => {
	assistant.subscribe((conversationId, event) => {
		rpc.send.assistantEvent({ conversationId, event });
	});
});

const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
	title: "Schema Designer",
	url,
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
