import { Agent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { Type, createModels, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import type {
	AssistantConnectionStatus,
	AssistantConversation,
	AssistantConversationRecord,
	AssistantModel,
	AssistantProviderConnection,
} from "../shared/assistant";
import { BunSecretCredentialStore, createConnectionScopedStore } from "./assistant-credentials";
import { applyAssistantDdl } from "./assistant-ddl";
import type { AssistantStore } from "./assistant-store";
import { getAssistantCodeDiagnostics } from "./assistant-code-diagnostics";
import { openAssistantStore } from "./assistant-store";
import { generateDesignSql, quoteIdentifier } from "./sql";
import { getLastAppliedSandbox, type WorkspaceState } from "../shared/design";
import type { DesignWorkspace } from "./workspace";

function deterministicDdlIdFactory(toolCallId: string) {
	let counter = 0;
	return () => {
		const hex = createHash("sha256").update(`${toolCallId}:${counter++}`).digest("hex").slice(0, 32);
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${(Number.parseInt(hex[16]!, 16) & 3 | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	};
}

function assistantColumnNotesSql(state: ReturnType<DesignWorkspace["getState"]>): string {
	const notes = state.design?.tables.flatMap((table) => table.columns
		.filter((column) => column.notes.trim())
		.map((column) => `-- ${quoteIdentifier(table.name)}.${quoteIdentifier(column.name)}: ${column.notes.replace(/[\r\n]+/g, " ")}`)) ?? [];
	return notes.length ? `\n-- Column notes\n${notes.join("\n")}` : "";
}
const SANDBOX_API_PROMPT = `Sandbox API subset (unsupported features must be treated as errors):

Scenarios use the Supabase client against a fresh Sandbox. Reads support select=* or comma-separated columns, nested foreign-key embeds (including !inner and !relationship hints), eq/neq/gt/gte/lt/lte/like/ilike/is/in/not/or filters, ordering, non-negative limit/offset, inclusive Range, exact count and head requests, single() and maybeSingle(). Writes support insert, update (PATCH), delete, upsert with merge/ignore duplicates and optional on_conflict, minimal or representation returns, and exact counts. PostgreSQL constraint errors retain SQLSTATE; each request is transactional.

Row-level security applies to anon, authenticated, and service_role requests. auth.uid(), auth.role(), and auth.jwt() expose request claims. Scenario clients can invoke design Functions by POST /rpc/<name>; GET is only for stable or immutable Functions. Set-returning and named table-row results support the documented projections; other query operations on function results are unsupported.

supabase.functions.invoke(name, { body }) invokes a saved Edge function. Edge handlers support Deno.serve, Deno.env.get for SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY, and Supabase imports from jsr:@supabase/supabase-js@2, npm:@supabase/supabase-js@2, https://esm.sh/@supabase/supabase-js@2, or @supabase/supabase-js. Network, WebSocket, XMLHttpRequest, script imports, other runtime imports, and nested Edge function invocations are unavailable.`;

const SYSTEM_PROMPT = `You are the Assistant for Schema Designer. The current project is the only project in scope; the Design is authoritative. Read the current project before making changes and use only its project tools. Apply schema changes only through the apply_ddl tool. The accepted DDL subset is CREATE/ALTER/DROP TABLE; ADD/RENAME/ALTER TYPE/DROP COLUMN; NOT NULL, UNIQUE, single-column PRIMARY KEY; structured defaults (typed literals, now(), gen_random_uuid(), identity); REFERENCES with referential actions; CREATE INDEX; CREATE TYPE AS ENUM; CREATE OR REPLACE FUNCTION; CREATE TRIGGER; CREATE POLICY; ENABLE ROW LEVEL SECURITY; COMMENT ON COLUMN. Composite primary keys, CHECK constraints, views and arbitrary defaults are unsupported and must be rejected, never approximated. A destructive drop with dependents requires user confirmation. Keep existing card positions and viewport unchanged. ${SANDBOX_API_PROMPT} Report tool errors without claiming changes that were not applied.`;


export type AssistantRuntimeOptions = {
	databasePath: string;
	workspace: DesignWorkspace;
	models?: MutableModels;
	getApiKey?: () => Promise<string | undefined>;
	streamFn?: ConstructorParameters<typeof Agent>[0]["streamFn"];
	maxRequestsPerTurn?: number;
	openExternal?: (url: string) => unknown;
};

export interface AssistantRuntime {
	listConversations: (projectId: string) => AssistantConversation[];
	getLatestConversation: (projectId: string) => AssistantConversation | null;
	loadConversation: (conversationId: string) => AssistantConversationRecord | null;
	createConversation: (projectId: string) => AssistantConversation;
	renameConversation: (conversationId: string, title: string) => boolean;
	deleteConversation: (conversationId: string) => boolean;
	listConnections: () => Promise<AssistantConnectionStatus[]>;
	getConnectionStatus: (connectionId: string) => Promise<AssistantConnectionStatus>;
	setAssistantApiKey: (providerId: string, apiKey: string) => Promise<AssistantProviderConnection>;
	removeAssistantConnection: (connectionId: string) => Promise<void>;
	startOAuthLogin: (providerId: string) => Promise<{ success: boolean; connection?: AssistantProviderConnection; error?: string }>;
	getClaudeOptIn: () => boolean;
	setClaudeOptIn: (enabled: boolean) => void;
	subscribeOAuth: (subscriber: (providerId: string, event: unknown) => void) => () => void;
	listModels: () => Promise<AssistantModel[]>;
	updateConversationSelection: (conversationId: string, connectionIdOrModel: string | null, modelOrThinking: string, maybeThinking?: ThinkingLevel) => void;
	subscribe: (subscriber: (conversationId: string, event: unknown) => void) => () => void;
	isTurnPaused: (conversationId: string) => boolean;
	isConfirmationPending: (conversationId: string) => boolean;
	continueTurn: (conversationId: string) => Promise<AssistantConversationRecord | null>;
	stop: (conversationId: string) => void;
	confirmDdlDrop: (conversationId: string, toolCallId: string) => Promise<AssistantConversationRecord | null>;
	rejectDdlDrop: (conversationId: string, toolCallId: string) => Promise<AssistantConversationRecord | null>;
	sendMessage: (conversationId: string, text: string, modelId: string, thinkingLevel?: ThinkingLevel, connectionId?: string) => Promise<AssistantConversationRecord | null>;
	close: () => void;
}

/** Main-process Assistant entry point; credentials remain outside application SQLite. */
export function createAssistantRuntime({ databasePath, workspace, models: suppliedModels, streamFn, getApiKey, maxRequestsPerTurn = 40, openExternal }: AssistantRuntimeOptions): AssistantRuntime {
	const store: AssistantStore = openAssistantStore(databasePath);
	const credentials = new BunSecretCredentialStore(databasePath);
	const connectionModelsMap = new Map<string, MutableModels>();
	function getOrInitConnectionModels(conn: AssistantProviderConnection): MutableModels {
		let connModels = connectionModelsMap.get(conn.id);
		if (!connModels) {
			const scopedStore = createConnectionScopedStore(credentials, conn.id, conn.provider_id);
			connModels = createModels({ credentials: scopedStore });
			const customProvider = suppliedModels?.getProvider(conn.provider_id);
			if (customProvider) {
				connModels.setProvider(customProvider);
			} else if (conn.provider_id === "anthropic") {
				connModels.setProvider(anthropicProvider());
			} else if (conn.provider_id === "openai") {
				connModels.setProvider(openaiProvider());
			} else if (conn.provider_id === "google") {
				connModels.setProvider(googleProvider());
			}
			connectionModelsMap.set(conn.id, connModels);
		}
		return connModels;
	}
	const oAuthSubscribers = new Set<(providerId: string, event: unknown) => void>();
	function publishOAuthEvent(providerId: string, event: unknown) {
		for (const subscriber of oAuthSubscribers) subscriber(providerId, event);
	}
	function getProviderDisplayName(providerId: string, authMethod?: string): string {
		if (providerId === "anthropic") {
			return authMethod === "oauth" ? "Claude (Account sign-in)" : "Anthropic (API key)";
		}
		if (providerId === "openai") {
			return authMethod === "oauth" ? "ChatGPT (Account sign-in)" : "OpenAI (API key)";
		}
		if (providerId === "google") {
			return "Google Gemini (API key)";
		}
		return providerId;
	}
	let migrationPromise: Promise<void> | null = null;
	function ensureLegacyCredentialsMigrated(): Promise<void> {
		if (!migrationPromise) {
			migrationPromise = (async () => {
				for (const conn of store.listProviderConnections()) {
					if (conn.provider_id === "anthropic" && conn.auth_method === "api-key") {
						const existing = await credentials.read(`connection-${conn.id}`);
						if (!existing) {
							const legacy = await credentials.read("anthropic");
							if (legacy) {
								await credentials.modify(`connection-${conn.id}`, async () => legacy);
								await credentials.delete("anthropic");
								connectionModelsMap.delete(conn.id);
							}
						}
					}
				}
			})();
		}
		return migrationPromise;
	}
	void ensureLegacyCredentialsMigrated();

	async function getConnectionStatus(connectionIdOrProviderId: string): Promise<AssistantConnectionStatus> {
		await ensureLegacyCredentialsMigrated();
		let conn = store.getConnection(connectionIdOrProviderId);
		if (!conn) {
			const savedList = store.listProviderConnections();
			conn = savedList.find((c) => c.provider_id === connectionIdOrProviderId) ?? null;
		}
		if (!conn) {
			const name = getProviderDisplayName(connectionIdOrProviderId);
			return {
				id: connectionIdOrProviderId,
				providerId: connectionIdOrProviderId,
				name,
				authMethod: "api-key",
				connected: false,
				error: null,
				claudeOptIn: connectionIdOrProviderId === "anthropic" ? store.getClaudeOptIn() : undefined,
			};
		}
		const name = getProviderDisplayName(conn.provider_id, conn.auth_method);
		const connModels = getOrInitConnectionModels(conn);
		try {
			const auth = await connModels.getAuth(conn.provider_id);
			if (auth) {
				return {
					id: conn.id,
					providerId: conn.provider_id,
					name,
					authMethod: conn.auth_method as "api-key" | "oauth",
					connected: true,
					error: null,
					claudeOptIn: conn.provider_id === "anthropic" ? store.getClaudeOptIn() : undefined,
				};
			}
			return {
				id: conn.id,
				providerId: conn.provider_id,
				name,
				authMethod: conn.auth_method as "api-key" | "oauth",
				connected: false,
				error: `${name} credentials missing from credential store.`,
				claudeOptIn: conn.provider_id === "anthropic" ? store.getClaudeOptIn() : undefined,
			};
		} catch (error) {
			return {
				id: conn.id,
				providerId: conn.provider_id,
				name,
				authMethod: conn.auth_method as "api-key" | "oauth",
				connected: false,
				error: error instanceof Error ? error.message : String(error),
				claudeOptIn: conn.provider_id === "anthropic" ? store.getClaudeOptIn() : undefined,
			};
		}
	}
	const active = new Map<string, Agent>();
	const subscribers = new Set<(conversationId: string, event: unknown) => void>();
	const pausedTurns = new Set<string>();
	const requestsThisTurn = new Map<string, number>();
	const turnIds = new Map<string, string>();
	const pendingConfirmations = new Set<string>();
	const confirmingDrops = new Set<string>();
	const requestLimit = maxRequestsPerTurn;
	type BoundWorkspaceState = ReturnType<DesignWorkspace["getState"]> & {
		project: NonNullable<ReturnType<DesignWorkspace["getState"]>["project"]>;
		design: NonNullable<ReturnType<DesignWorkspace["getState"]>["design"]>;
	};


	function requireBoundState(conversationId: string) {
		const conversation = store.loadConversation(conversationId);
		if (!conversation) throw new Error("Conversation not found.");
		const state = workspace.getState();
		if (!state.project || !state.design || state.project.id !== conversation.project_id) {
			throw new Error("This conversation is bound to a different project. Reopen its project before using project tools.");
		}
		return { conversation, state: state as BoundWorkspaceState };
	}
	function projectSnapshot(state: ReturnType<DesignWorkspace["getState"]>): string {
		return JSON.stringify({ design: state.design, scenarios: state.scenarios, edgeFunctions: state.edgeFunctions });
	}
	function publish(conversationId: string, event: unknown) {
		for (const subscriber of subscribers) subscriber(conversationId, event);
	}
	function buildTools(conversationId: string): AgentTool[] {
		return [{
		name: "read_project",
		label: "Read project",
		description: "Read the current project design, generated SQL, sandbox status, Functions, Triggers, Policies, Scenarios, Edge functions, and Scenario run results. Always use this before proposing changes.",
		parameters: Type.Object({}),
		execute: async () => {
			const { state } = requireBoundState(conversationId);
			const generated = generateDesignSql(state.design);
			store.observeProjectSnapshot(conversationId, projectSnapshot(state), state.revision);
			return {
				content: [{ type: "text", text: JSON.stringify({
					project: state.project,
					revision: state.revision,
					design: state.design,
					generatedSql: generated.ok ? `${generated.sql}${assistantColumnNotesSql(state)}` : { errors: generated.errors },
					sandbox: state.sandbox,
					functions: state.design.functions,
					triggers: state.design.triggers,
					policies: state.design.tables.map(({ name, policies }) => ({ table: name, policies })),
					scenarios: state.scenarios,
					edgeFunctions: state.edgeFunctions,
					scenarioRuns: state.scenarioRuns,
				}) }],
				details: { projectId: state.project.id, revision: state.revision },
			};
		},
	},
	{
		name: "apply_ddl",
		label: "Apply PostgreSQL DDL",
		description: "Translate the documented accepted PostgreSQL DDL subset into one atomic design change. Unsupported statements fail without changing the project. A drop with dependents returns a confirmation plan; do not claim it was applied.",
		parameters: Type.Object({ sql: Type.String({ description: "PostgreSQL DDL to parse and apply" }) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const { conversation } = requireBoundState(conversationId);
			const { sql } = params as { sql: string };
			const before = workspace.getState().design;
			const result = await applyAssistantDdl(workspace, sql, {
				assistantTurnId: turnIds.get(conversationId),
				expectedProjectId: conversation.project_id,
				idFactory: deterministicDdlIdFactory(_toolCallId),
			});
			if (result.status === "confirmation-required") {
				pendingConfirmations.add(conversationId);
				publish(conversationId, { type: "assistant_confirmation_required" });
			}
			let affectedTables: { id: string; name: string; removed?: boolean }[] = [];
			if (result.status === "applied" && result.state.project?.id !== conversation.project_id) {
				const changedProject = { applied: true, note: "project switched; re-read on next turn" };
				return { content: [{ type: "text", text: JSON.stringify(changedProject) }], details: changedProject };
			}
			if (result.status === "applied") {
				const after = result.state;
				store.observeProjectSnapshot(conversationId, projectSnapshot(after), after.revision);
				const beforeById = new Map((before?.tables ?? []).map((table) => [table.id, table]));
				affectedTables = (after.design?.tables ?? [])
					.filter((table) => JSON.stringify(beforeById.get(table.id)) !== JSON.stringify(table))
					.map(({ id, name }) => ({ id, name }));
				const afterIds = new Set((after.design?.tables ?? []).map(({ id }) => id));
				for (const table of before?.tables ?? []) {
					if (!afterIds.has(table.id)) affectedTables.push({ id: table.id, name: table.name, removed: true });
				}
			}
			const confirmationDetails = result.status === "applied" ? { ...result, affectedTables } : result;
			return {
				content: [{ type: "text", text: JSON.stringify(confirmationDetails) }],
				details: confirmationDetails,
				...(result.status === "confirmation-required" ? { terminate: true } : {}),
			};
		},
	},
	{
		name: "manage_code",
		label: "Manage project code",
		description: "Create, rename, or remove a Scenario or Edge function; write or exact-string-edit a Scenario, Edge function, or design Function body. Every edit must match exactly once. Code writes use ordinary workspace saves; tool results include the complete source diff and TypeScript diagnostics from the same declarations as Monaco (Function bodies are SQL, not TypeScript).",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("create"),
				Type.Literal("rename"),
				Type.Literal("remove"),
				Type.Literal("write"),
				Type.Literal("edit"),
			]),
			kind: Type.Union([Type.Literal("scenario"), Type.Literal("edge-function"), Type.Literal("function-body")]),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
			source: Type.Optional(Type.String()),
			oldText: Type.Optional(Type.String()),
			newText: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const input = params as {
				action: "create" | "rename" | "remove" | "write" | "edit";
				kind: "scenario" | "edge-function" | "function-body";
				id?: string;
				name?: string;
				source?: string;
				oldText?: string;
				newText?: string;
			};
			const { conversation } = requireBoundState(conversationId);
			const kind = input.kind;
			if (input.action === "create") {
				if (kind === "function-body") throw new Error("Function bodies cannot be created; define a Function through apply_ddl.");
				if (!input.name) throw new Error("A name is required to create a code item.");
				const state = kind === "scenario"
					? await workspace.createScenario({ name: input.name })
					: await workspace.createEdgeFunction({ name: input.name });
				if (state.project?.id !== conversation.project_id) throw new Error("The open project changed before the code item was created.");
				const item = kind === "scenario"
					? state.scenarios.find((candidate) => candidate.name === input.name?.trim())
					: state.edgeFunctions.find((candidate) => candidate.name === input.name?.trim());
				if (!item) throw new Error("The created code item could not be found in the bound project.");
				return { content: [{ type: "text", text: JSON.stringify({ action: "created", kind, id: item.id, name: item.name }) }], details: { action: "created", kind, id: item.id, name: item.name } };
			}
			if (input.action === "rename" || input.action === "remove") {
				if (kind === "function-body") throw new Error("Function bodies cannot be renamed or removed through code tools.");
				if (!input.id) throw new Error("An item id is required to rename or remove a code item.");
				if (input.action === "rename" && !input.name) throw new Error("A new name is required to rename a code item.");
				const state = kind === "scenario"
					? input.action === "rename"
						? await workspace.renameScenario({ scenarioId: input.id, name: input.name! })
						: await workspace.removeScenario({ scenarioId: input.id })
					: input.action === "rename"
						? await workspace.renameEdgeFunction({ edgeFunctionId: input.id, name: input.name! })
						: await workspace.removeEdgeFunction({ edgeFunctionId: input.id });
				if (state.project?.id !== conversation.project_id) throw new Error("The open project changed before the code item was updated.");
				return { content: [{ type: "text", text: JSON.stringify({ action: input.action === "rename" ? "renamed" : "removed", kind, id: input.id, name: input.name }) }], details: { action: input.action === "rename" ? "renamed" : "removed", kind, id: input.id, name: input.name } };
			}

			const bound = requireBoundState(conversationId);
			if (!input.id) throw new Error("An item id is required to write code.");
			let itemName: string;
			let before: string;
			if (kind === "scenario") {
				const item = bound.state.scenarios.find(({ id }) => id === input.id);
				if (!item) throw new Error("That Scenario could not be found in the bound project.");
				itemName = item.name;
				before = item.source;
			} else if (kind === "edge-function") {
				const item = bound.state.edgeFunctions.find(({ id }) => id === input.id);
				if (!item) throw new Error("That Edge function could not be found in the bound project.");
				itemName = item.name;
				before = item.source;
			} else {
				const item = bound.state.design?.functions?.find(({ id }) => id === input.id);
				if (!item) throw new Error("That Function could not be found in the bound project.");
				itemName = item.name;
				before = item.body;
			}
			let after: string;
			if (input.action === "write") {
				if (input.source === undefined) throw new Error("A complete source string is required for a whole-file write.");
				after = input.source;
			} else {
				if (input.oldText === undefined || input.newText === undefined) throw new Error("Exact-string edit requires oldText and newText.");
				let matches = 0;
				for (let position = 0; input.oldText.length > 0 && (position = before.indexOf(input.oldText, position)) !== -1; position += 1) matches += 1;
				if (matches !== 1) throw new Error(`Exact-string edit expected exactly one match; found ${matches}.`);
				after = before.replace(input.oldText, input.newText);
			}
			let state: WorkspaceState;
			if (kind === "scenario") state = await workspace.updateScenarioSource({ scenarioId: input.id, source: after });
			else if (kind === "edge-function") state = await workspace.updateEdgeFunctionSource({ edgeFunctionId: input.id, source: after });
			else {
				const design = bound.state.design;
				if (!design) throw new Error("Open a project before writing a Function body.");
				const functions = (design.functions ?? []).map((fn) => fn.id === input.id ? { ...fn, body: after } : fn);
				state = await workspace.applyAssistantDesign(
					{ ...design, functions },
					turnIds.get(conversationId),
				);
			}
			if (state.project?.id !== conversation.project_id) throw new Error("The open project changed before the code write completed.");
			const appliedSource = kind === "scenario"
				? state.scenarios.find(({ id }) => id === input.id)?.source
				: kind === "edge-function"
					? state.edgeFunctions.find(({ id }) => id === input.id)?.source
					: state.design?.functions?.find(({ id }) => id === input.id)?.body;
			if (appliedSource !== after) throw new Error("The code write was not saved to the bound project.");
			const snapshot = getLastAppliedSandbox(state.sandbox);
			const diagnostics = kind === "function-body" ? [] : getAssistantCodeDiagnostics(
				kind,
				after,
				snapshot?.tables ?? [],
				snapshot?.enumTypes ?? [],
				snapshot?.functions ?? [],
			);
			const details = {
				action: input.action,
				kind,
				id: input.id,
				name: itemName,
				before,
				after,
				diagnostics,
				diagnosticsNote: kind === "function-body" ? "TypeScript diagnostics do not apply to SQL Function bodies." : undefined,
			};
			return { content: [{ type: "text", text: JSON.stringify({ ...details, before: undefined, after: undefined }) }], details };
		},
	},
];
	}

	return {
		listConversations: (projectId: string) => store.listConversations(projectId),
		getLatestConversation: (projectId: string) => store.getLatestConversation(projectId),
		loadConversation: (conversationId: string) => store.loadConversation(conversationId),
		createConversation(projectId: string) {
			const selection = store.getDefaultSelection();
			return store.createConversation(projectId, {
				role: "system",
				kind: "assistant-context",
				payload: { text: "Conversation initialized." },
			}, { connectionId: selection.connectionId, model: selection.model, thinking: selection.thinking });
		},
		renameConversation: (conversationId: string, title: string) => store.renameConversation(conversationId, title),
		deleteConversation(conversationId: string) {
			active.get(conversationId)?.abort();
			active.delete(conversationId);
			return store.deleteConversation(conversationId);
		},
		async listConnections(): Promise<AssistantConnectionStatus[]> {
			await ensureLegacyCredentialsMigrated();
			const saved = store.listProviderConnections();
			const statuses: AssistantConnectionStatus[] = [];
			for (const conn of saved) {
				statuses.push(await getConnectionStatus(conn.id));
			}
			return statuses;
		},
		async getConnectionStatus(connectionId: string): Promise<AssistantConnectionStatus> {
			return getConnectionStatus(connectionId);
		},
		async setAssistantApiKey(providerId: string, apiKey: string): Promise<AssistantProviderConnection> {
			const normalized = apiKey.trim();
			if (!normalized) throw new Error(`Enter an API key for ${providerId}.`);
			const conn = store.saveProviderConnection(providerId, "api-key");
			const scopedStore = createConnectionScopedStore(credentials, conn.id, conn.provider_id);
			await scopedStore.modify(conn.provider_id, async () => ({ type: "api_key", key: normalized }));
			connectionModelsMap.delete(conn.id);
			return conn;
		},
		async removeAssistantConnection(connectionId: string): Promise<void> {
			const conn = store.getConnection(connectionId);
			if (conn) {
				const scopedStore = createConnectionScopedStore(credentials, conn.id, conn.provider_id);
				await scopedStore.delete(conn.provider_id);
				connectionModelsMap.delete(conn.id);
				store.removeProviderConnection(conn.id);
			}
		},
		async startOAuthLogin(providerId: string) {
			if (providerId === "google") {
				throw new Error("Google account sign-in is explicitly not offered.");
			}
			if (providerId === "anthropic" && !store.getClaudeOptIn()) {
				throw new Error("Claude account sign-in requires enabling the opt-in setting.");
			}
			const conn = store.saveProviderConnection(providerId, "oauth");
			const connModels = getOrInitConnectionModels(conn);
			try {
				await connModels.login(providerId, "oauth", {
					prompt: async (prompt) => {
						publishOAuthEvent(providerId, { type: "prompt", prompt });
						if (prompt.type === "select" && prompt.options[0]) {
							return prompt.options[0].id;
						}
						return "";
					},
					notify: (event) => {
						if (event.type === "auth_url") {
							if (openExternal) {
								void openExternal(event.url);
							}
						}
						publishOAuthEvent(providerId, event);
					},
				});
				return { success: true, connection: conn };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				publishOAuthEvent(providerId, { type: "error", error: message });
				return { success: false, error: message };
			}
		},
		getClaudeOptIn: () => store.getClaudeOptIn(),
		setClaudeOptIn: (enabled: boolean) => { store.setClaudeOptIn(enabled); },
		subscribeOAuth(subscriber: (providerId: string, event: unknown) => void) {
			oAuthSubscribers.add(subscriber);
			return () => oAuthSubscribers.delete(subscriber);
		},
		async listModels(): Promise<AssistantModel[]> {
			await ensureLegacyCredentialsMigrated();
			const connections = store.listProviderConnections();
			const result: AssistantModel[] = [];
			for (const conn of connections) {
				const connModels = getOrInitConnectionModels(conn);
				const connName = getProviderDisplayName(conn.provider_id, conn.auth_method);
				const providerModels = connModels.getModels(conn.provider_id);
				for (const m of providerModels) {
					result.push({
						id: m.id,
						name: m.name,
						provider: conn.provider_id,
						connectionId: conn.id,
						connectionName: connName,
						reasoning: Boolean(m.reasoning),
						contextWindow: m.contextWindow ?? 0,
					});
				}
			}
			if (connections.length === 0) {
				const defaultProviders = suppliedModels
					? suppliedModels.getProviders().map((p) => p.id)
					: ["anthropic", "openai", "google"];
				for (const providerId of defaultProviders) {
					const fallbackModels = suppliedModels
						? suppliedModels.getModels(providerId)
						: (providerId === "anthropic" ? anthropicProvider().getModels() :
							providerId === "openai" ? openaiProvider().getModels() :
							providerId === "google" ? googleProvider().getModels() : []);
					for (const m of fallbackModels) {
						result.push({
							id: m.id,
							name: m.name,
							provider: providerId,
							connectionId: providerId,
							connectionName: getProviderDisplayName(providerId, "api-key"),
							reasoning: Boolean(m.reasoning),
							contextWindow: m.contextWindow ?? 0,
						});
					}
				}
			}
			return result;
		},
		updateConversationSelection(conversationId: string, connectionIdOrModel: string | null, modelOrThinking: string, maybeThinking?: ThinkingLevel) {
			const connectionId = maybeThinking !== undefined ? connectionIdOrModel : null;
			const model = maybeThinking !== undefined ? modelOrThinking : (connectionIdOrModel ?? "");
			const thinking = (maybeThinking !== undefined ? maybeThinking : modelOrThinking) as ThinkingLevel;
			store.updateConversationSelection(conversationId, connectionId, model, thinking);
			store.updateDefaultSelection(connectionId, model, thinking);
		},
		subscribe(subscriber: (conversationId: string, event: unknown) => void) {
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		isTurnPaused: (conversationId: string) => pausedTurns.has(conversationId) || pendingConfirmations.has(conversationId),
		isConfirmationPending: (conversationId: string) => pendingConfirmations.has(conversationId),
		async continueTurn(conversationId: string) {
			const agent = active.get(conversationId);
			if (!agent || pendingConfirmations.has(conversationId) || !pausedTurns.delete(conversationId)) throw new Error("This Assistant turn is not waiting to continue.");
			requestsThisTurn.set(conversationId, 0);
			const message = { role: "user" as const, content: "Continue the interrupted Assistant task.", timestamp: Date.now() };
			store.appendMessage(conversationId, { role: "user", kind: "assistant-continue", payload: message });
			agent.steer(message);
			await agent.continue();
			return store.loadConversation(conversationId);
		},
		stop(conversationId: string) {
			active.get(conversationId)?.abort();
		},
		async confirmDdlDrop(conversationId: string, toolCallId: string) {
			const { conversation } = requireBoundState(conversationId);
			if (confirmingDrops.has(toolCallId)) throw new Error("This DDL confirmation is already being processed.");
			if (conversation.messages.some((message) => {
				if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") return false;
				return "toolCallId" in message.payload && message.payload.toolCallId === toolCallId
					&& "status" in message.payload && (message.payload.status === "consumed" || message.payload.status === "rejected");
			})) throw new Error("This DDL confirmation has already been used.");
			if (!pendingConfirmations.has(conversationId)) throw new Error("This DDL confirmation is no longer available.");
			const confirmation = [...conversation.messages].reverse().find((message) => {
				const payload = message.payload;
				if (message.role !== "toolResult" || !payload || typeof payload !== "object" || !("toolCallId" in payload) || !("details" in payload)) return false;
				const details = payload.details;
				return payload.toolCallId === toolCallId && details !== null && typeof details === "object"
					&& "status" in details && details.status === "confirmation-required";
			});
			if (!confirmation) throw new Error("This DDL confirmation is no longer available.");
			const confirmationPayload = confirmation.payload;
			if (!confirmationPayload || typeof confirmationPayload !== "object" || !("details" in confirmationPayload)) throw new Error("The saved DDL confirmation is malformed.");
			const originalDetails = confirmationPayload.details;
			const latestUpdate = [...conversation.messages].reverse().find((message) => {
				if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") return false;
				return "toolCallId" in message.payload && message.payload.toolCallId === toolCallId
					&& "status" in message.payload && message.payload.status === "updated" && "details" in message.payload;
			});
			const updatedDetails = latestUpdate?.payload as { details?: unknown } | undefined;
			const savedPlan = (updatedDetails?.details ?? originalDetails) as {
				statement: string;
				projectId: string;
				revision: number;
				removal: unknown;
				targets: { targetId: string }[];
			};
			if (!originalDetails || typeof originalDetails !== "object" || !("statement" in originalDetails) || typeof savedPlan.statement !== "string"
				|| !Array.isArray(savedPlan.targets) || savedPlan.targets.some((target) => !target || typeof target.targetId !== "string")
				|| savedPlan.projectId !== conversation.project_id) {
				throw new Error("The saved DDL confirmation is malformed or belongs to another project.");
			}
			const statement = savedPlan.statement;
			confirmingDrops.add(toolCallId);
			try {
				const plan = await applyAssistantDdl(workspace, statement, {
					expectedProjectId: conversation.project_id,
					idFactory: deterministicDdlIdFactory(toolCallId),
					planOnly: true,
				});
				if (plan.status !== "confirmation-required") throw new Error("Could not refresh the destructive DDL plan.");
				if (plan.projectId !== savedPlan.projectId || plan.revision !== savedPlan.revision
					|| JSON.stringify(plan.removal) !== JSON.stringify(savedPlan.removal)
					|| JSON.stringify(plan.targets) !== JSON.stringify(savedPlan.targets)) {
					store.appendMessage(conversationId, {
						role: "system",
						kind: "assistant-drop-confirmation",
						payload: {
							toolCallId,
							status: "updated",
							details: plan,
							note: "The plan changed. Review the updated plan before confirming.",
						},
					});
					publish(conversationId, { type: "assistant_confirmation_plan_updated" });
					return store.loadConversation(conversationId);
				}
				const turnId = turnIds.get(conversationId) ?? `confirmed:${toolCallId}`;
				turnIds.set(conversationId, turnId);
				const result = await applyAssistantDdl(workspace, statement, {
					assistantTurnId: turnId,
					confirmedDrops: true,
					expectedProjectId: conversation.project_id,
					idFactory: deterministicDdlIdFactory(toolCallId),
					confirmation: {
						projectId: savedPlan.projectId,
						revision: savedPlan.revision,
						targetIds: savedPlan.targets.map(({ targetId }) => targetId),
					},
				});
				if (result.status !== "applied") throw new Error("The DDL change still requires confirmation.");
				store.appendMessage(conversationId, {
					role: "system",
					kind: "assistant-drop-confirmation",
					payload: { toolCallId, status: "consumed" },
				});
				pendingConfirmations.delete(conversationId);
				publish(conversationId, { type: "assistant_confirmation_resolved" });
				store.observeProjectSnapshot(conversationId, projectSnapshot(result.state), result.state.revision);
				const message = { role: "user" as const, content: "The user confirmed the destructive DDL change. Report its result.", timestamp: Date.now() };
				store.appendMessage(conversationId, { role: "user", kind: "assistant-drop-confirmation", payload: { ...message, toolCallId } });
				const agent = active.get(conversationId);
				if (agent) {
					agent.clearAllQueues();
					pausedTurns.delete(conversationId);
					if (agent.state.isStreaming) agent.steer(message);
					else await agent.prompt(message.content);
				}
				return store.loadConversation(conversationId);
			} finally {
				confirmingDrops.delete(toolCallId);
			}
		},
		async rejectDdlDrop(conversationId: string, toolCallId: string) {
			const { conversation } = requireBoundState(conversationId);
			if (!pendingConfirmations.has(conversationId)) throw new Error("This DDL confirmation is no longer available.");
			if (conversation.messages.some((message) => {
				if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") return false;
				return "toolCallId" in message.payload && message.payload.toolCallId === toolCallId
					&& "status" in message.payload && (message.payload.status === "consumed" || message.payload.status === "rejected");
			})) throw new Error("This DDL confirmation has already been used.");
			const exists = [...conversation.messages].reverse().some((message) => {
				const payload = message.payload;
				if (message.role !== "toolResult" || !payload || typeof payload !== "object" || !("toolCallId" in payload) || !("details" in payload)) return false;
				const details = payload.details;
				return payload.toolCallId === toolCallId && details !== null && typeof details === "object"
					&& "status" in details && details.status === "confirmation-required";
			});
			if (!exists) throw new Error("This DDL confirmation is no longer available.");
			store.appendMessage(conversationId, {
				role: "system",
				kind: "assistant-drop-confirmation",
				payload: { toolCallId, status: "rejected" },
			});
			const toolResult = {
				role: "toolResult" as const,
				toolCallId,
				content: [{ type: "text" as const, text: "the designer rejected this destructive change" }],
			};
			store.appendMessage(conversationId, { role: "toolResult", kind: "tool-result", payload: toolResult });
			pendingConfirmations.delete(conversationId);
			publish(conversationId, { type: "assistant_confirmation_resolved" });
			const agent = active.get(conversationId);
			if (agent) {
				agent.state.messages.push(toolResult as never);
				await agent.prompt("Continue after the rejected destructive change.");
			}
			return store.loadConversation(conversationId);
		},
		async sendMessage(conversationId: string, text: string, modelId: string, thinkingLevel: ThinkingLevel = "medium", connectionId?: string) {
			await ensureLegacyCredentialsMigrated();
			const conversation = requireBoundState(conversationId).conversation;
			if (pendingConfirmations.has(conversationId)) throw new Error("Confirm or reject the pending destructive DDL plan before sending another message.");
			const effectiveConnectionId = connectionId ?? conversation.connection_id;
			let targetConn = effectiveConnectionId ? store.getConnection(effectiveConnectionId) : null;
			if (effectiveConnectionId && !targetConn) {
				throw new Error("The provider connection for this conversation was removed. Select a connection and model to continue.");
			}
			if (!targetConn && store.listProviderConnections().length > 0) {
				for (const c of store.listProviderConnections()) {
					const cm = getOrInitConnectionModels(c);
					if (cm.getModels(c.provider_id).some((m) => m.id === modelId)) {
						targetConn = c;
						break;
					}
				}
			}
			let activeModels: MutableModels;
			let model: ReturnType<MutableModels["getModel"]> | undefined;
			if (targetConn) {
				activeModels = getOrInitConnectionModels(targetConn);
				model = activeModels.getModels(targetConn.provider_id).find((m) => m.id === modelId)
					?? (suppliedModels ? suppliedModels.getModel(targetConn.provider_id, modelId) : undefined);
				if (!model) throw new Error(`Unknown model: ${modelId} for connection ${targetConn.id}`);
				if (getApiKey) {
					const key = await getApiKey().catch(() => undefined);
					if (!key) throw new Error("Configure credentials before sending a message.");
				} else {
					let authResult: unknown;
					try {
						authResult = await activeModels.getAuth(model);
					} catch (err) {
						throw new Error(`Authentication failed for ${targetConn.provider_id}: ${err instanceof Error ? err.message : String(err)}`);
					}
					if (!authResult) {
						const name = getProviderDisplayName(targetConn.provider_id, targetConn.auth_method);
						throw new Error(`Configure credentials for ${name} before sending a message.`);
					}
				}
				store.updateConversationSelection(conversationId, targetConn.id, modelId, thinkingLevel);
				store.updateDefaultSelection(targetConn.id, modelId, thinkingLevel);
			} else if (suppliedModels) {
				activeModels = suppliedModels;
				model = suppliedModels.getModels().find((m) => m.id === modelId);
				if (!model) throw new Error(`Unknown model: ${modelId}`);
				if (getApiKey) {
					const key = await getApiKey().catch(() => undefined);
					if (!key) throw new Error("Configure credentials before sending a message.");
				}
				store.updateConversationSelection(conversationId, null, modelId, thinkingLevel);
				store.updateDefaultSelection(null, modelId, thinkingLevel);
			} else {
				throw new Error("No provider connection selected for this conversation. Choose a connection and model to continue.");
			}
			const currentState = requireBoundState(conversationId).state;
			let changeNote: { role: "user"; content: string; timestamp: number } | undefined;
			const currentSnapshot = projectSnapshot(currentState);
			const previousSnapshot = store.observeProjectSnapshot(conversationId, currentSnapshot, currentState.revision);
			if (previousSnapshot !== null && previousSnapshot.snapshot !== currentSnapshot) {
				const previous = JSON.parse(previousSnapshot.snapshot) as { design?: unknown; scenarios?: unknown; edgeFunctions?: unknown };
				const changed = [
					...(JSON.stringify(previous.design) !== JSON.stringify(currentState.design) ? ["schema design"] : []),
					...(JSON.stringify(previous.scenarios) !== JSON.stringify(currentState.scenarios) ? ["scenarios"] : []),
					...(JSON.stringify(previous.edgeFunctions) !== JSON.stringify(currentState.edgeFunctions) ? ["Edge functions"] : []),
				];
				changeNote = {
					role: "user",
					content: `Project changed since revision ${previousSnapshot.revision} (${changed.join(", ")}). These latest saved definitions are authoritative. Re-read the project before acting.`,
					timestamp: Date.now(),
				};
				store.appendMessage(conversationId, { role: "user", kind: "assistant-change-note", payload: changeNote });
			}
			const userMessage = { role: "user" as const, content: text, timestamp: Date.now() };
			if (!conversation.messages.some((message) => message.role === "user")) {
				store.renameConversation(conversationId, text.replace(/\s+/g, " ").trim().slice(0, 80) || "New conversation");
			}
			store.appendMessage(conversationId, { role: "user", payload: userMessage });
			let agent = active.get(conversationId);
			if (agent?.state.isStreaming) {
				if (changeNote) agent.steer(changeNote);
				agent.steer(userMessage);
				return store.loadConversation(conversationId);
			}
			const hadAgent = Boolean(agent);
			if (!agent) {
				const transcript = (store.loadConversation(conversationId)?.messages ?? [])
					.slice(0, -1)
					.map((message) => message.payload)
					.filter((message): message is Record<string, unknown> => Boolean(message && typeof message === "object" && "role" in message))
					.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
				agent = new Agent({
					initialState: {
						systemPrompt: SYSTEM_PROMPT,
						model,
						thinkingLevel,
						tools: buildTools(conversationId),
						messages: transcript as never[],
					},
					streamFn: streamFn ?? activeModels.streamSimple.bind(activeModels),
					getApiKey: async (provider) => {
						if (getApiKey) return getApiKey();
						const resolved = await activeModels.getAuth(provider);
						return resolved?.auth.apiKey;
					},
					sessionId: conversationId,
					identity: { attribution: { name: "Schema Designer", url: "https://github.com/jvasquezt2004/db-planner" } },
					beforeToolCall: async () => pendingConfirmations.has(conversationId)
						? { block: true, reason: "Waiting for destructive DDL confirmation.", terminate: true }
						: undefined,
				});
				agent.finishTurn = async ({ message }) => {
					if (message.stopReason === "error" || message.stopReason === "aborted") return;
					if (pendingConfirmations.has(conversationId)) return { action: "end" };
					const requests = (requestsThisTurn.get(conversationId) ?? 0) + 1;
					requestsThisTurn.set(conversationId, requests);
					if (requests < requestLimit) return;
					pausedTurns.add(conversationId);
					publish(conversationId, { type: "assistant_turn_paused", requestCount: requests });
					return { action: "end" };
				};
				agent.subscribe((event) => {
					publish(conversationId, event);
					if (event.type === "message_end" && event.message.role !== "user") {
						store.appendMessage(conversationId, { role: event.message.role, payload: event.message });
					}
					if (event.type === "agent_end" && !pausedTurns.has(conversationId) && !pendingConfirmations.has(conversationId)) turnIds.delete(conversationId);
				});
				active.set(conversationId, agent);
			}
			if (hadAgent && changeNote) agent.state.messages.push(changeNote);
			agent.state.model = model;
			agent.state.thinkingLevel = thinkingLevel;
			requestsThisTurn.set(conversationId, 0);
			pausedTurns.delete(conversationId);
			turnIds.set(conversationId, crypto.randomUUID());
			await agent.prompt(text);
			return store.loadConversation(conversationId);
		},
		close() {
			for (const agent of active.values()) agent.abort();
			active.clear();
			store.close();
		},
	};
}

