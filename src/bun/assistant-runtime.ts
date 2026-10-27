import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import { Type, createModels, normalizeContext, type MutableModels, calculateCost, type AnyModel, type Model, type Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type {
	AssistantConnectionStatus,
	AssistantConversation,
	AssistantConversationRecord,
	AssistantModel,
	AssistantProviderConnection,
} from "../shared/assistant";
import { BunSecretCredentialStore, createConnectionScopedStore, type BunSecretCredentialStoreOptions } from "./assistant-credentials";
import { applyAssistantDdl } from "./assistant-ddl";
import type { AssistantStore } from "./assistant-store";
import { getAssistantCodeDiagnostics } from "./assistant-code-diagnostics";
import { openAssistantStore } from "./assistant-store";
import { generateDesignSql, quoteIdentifier } from "./sql";
import { getLastAppliedSandbox, type Design, type EdgeFunction, type SandboxState, type SqlState, type WorkspaceState } from "../shared/design";
import type { DesignWorkspace } from "./workspace";
import type { ScenarioRun } from "../shared/design";
import type { Scenario } from "../shared/design";
import { runAllScenarios, SCENARIO_RUN_TIMEOUT_MS } from "../shared/run-all";
import { TurnTracker, checkCodeRelevantContent } from "./assistant-turn-tracker";
import { SYSTEM_COMPONENT_KINDS, SYSTEM_CONNECTION_SIDES, systemDesignContent, type SystemContent } from "../shared/system-design";
import { WALKTHROUGH_ACTIONS, type Walkthrough } from "../shared/walkthrough";
import { CUSTOM_ICONS } from "../shared/component-catalog";
import {
	applySystemOperationPlan,
	checkSystemReadPreconditions,
	planSystemOperations,
	readSystemArchitecture,
	systemReadContent,
	type SystemOperation,
} from "./system-design-operations";
import {
	WALKTHROUGH_OPERATION_NAMES,
	checkWalkthroughReadPreconditions,
	planWalkthroughOperations,
	readWalkthroughs,
	walkthroughDiagnostics,
	walkthroughImpactOfRemovedConnections,
	type WalkthroughOperation,
} from "./walkthrough-operations";
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

Writing a Scenario: its source is top-level TypeScript run once against a fresh, empty Sandbox. Do not import or create a Supabase client, and do not use Deno.test or test frameworks. These globals are provided:
- supabase: an anon client; asUser(userId, claims?) returns an authenticated client; asServiceRole() returns a service_role client that bypasses row-level security.
- expect(result) checks a request result without throwing: .succeeds(), .fails(code?) where code is a PostgreSQL SQLSTATE or PostgREST code, and .returnsDataEqual(value).
Example:
const admin = asServiceRole();
const author = await admin.from("authors").insert({ name: "Ada" }).select("id").single();
expect(author).succeeds();
const duplicate = await admin.from("authors").insert({ name: "Ada" });
expect(duplicate).fails("23505");
A run passes when every expectation is met, fails when one is unmet, and errors on an uncaught exception. Edge functions are different: they are Deno.serve handlers, and Scenarios call them with supabase.functions.invoke(name, { body }).

Scenarios use the Supabase client against a fresh Sandbox. Reads support select=* or comma-separated columns, nested foreign-key embeds (including !inner and !relationship hints), eq/neq/gt/gte/lt/lte/like/ilike/is/in/not/or filters, ordering, non-negative limit/offset, inclusive Range, exact count and head requests, single() and maybeSingle(). Writes support insert, update (PATCH), delete, upsert with merge/ignore duplicates and optional on_conflict, minimal or representation returns, and exact counts. PostgreSQL constraint errors retain SQLSTATE; each request is transactional.

Row-level security applies to anon, authenticated, and service_role requests. auth.uid(), auth.role(), and auth.jwt() expose request claims. Scenario clients can invoke design Functions by POST /rpc/<name>; GET is only for stable or immutable Functions. Set-returning and named table-row results support the documented projections; other query operations on function results are unsupported.

supabase.functions.invoke(name, { body }) invokes a saved Edge function. Edge handlers support Deno.serve, Deno.env.get for SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY, and Supabase imports from jsr:@supabase/supabase-js@2, npm:@supabase/supabase-js@2, https://esm.sh/@supabase/supabase-js@2, or @supabase/supabase-js. Network, WebSocket, XMLHttpRequest, script imports, other runtime imports, and nested Edge function invocations are unavailable.`;

export const SYSTEM_PROMPT = `You are the Assistant for Schema Designer. The current project is the only project in scope; the Design is authoritative. Read the current project before making changes and use only its project tools. Apply schema changes only through the apply_ddl tool. The accepted DDL subset is CREATE/ALTER/DROP TABLE; ADD/RENAME/ALTER TYPE/DROP COLUMN; NOT NULL, UNIQUE, single-column PRIMARY KEY; structured defaults (typed literals, now(), gen_random_uuid(), identity); REFERENCES with referential actions; CREATE INDEX; CREATE TYPE AS ENUM; CREATE OR REPLACE FUNCTION; CREATE TRIGGER; CREATE POLICY; ENABLE ROW LEVEL SECURITY; COMMENT ON COLUMN. Identity columns must use GENERATED ALWAYS AS IDENTITY; GENERATED BY DEFAULT is unsupported. Composite primary keys, CHECK constraints, views and arbitrary defaults are unsupported and must be rejected, never approximated. When a requirement needs behaviour foreign keys cannot express (e.g. deleting a child also deletes its parent), implement it with a Function and a Trigger rather than proposing a simpler design. A destructive drop with dependents requires user confirmation; a confirmed destructive change is already applied and must not be re-run; if the designer rejects it, never retry it or an equivalent change, and ask what they want instead. Keep existing card positions and viewport unchanged. Describe architecture only through read_system_design and edit_system_design: read the System design first, give each new Service, Component, Group, and Connection a new stable id, and report the impacts a batch returns, such as Connections a removal deleted. Assign ownership with ownerServiceId (null releases it to system scope), and link a database component with linkedDesignId only to a design that read_system_design lists. Group membership never changes ownership. Set attachment sides, bend points, and label offsets only when the designer asks about routing. Move existing items, or call arrange_layout, only when the designer asks for a layout; otherwise keep existing positions. Describe Walkthroughs only through read_walkthroughs and edit_walkthroughs: read them first, play existing Connections by connectionId, and give new Walkthroughs, steps, and blocks a new stable id. Use parallel blocks for work that runs together and repeat blocks for a fixed number of attempts, with a failed attempt and its retry as ordinary steps; never add a runtime condition. A removed Connection leaves its steps dangling and a changed route leaves them redirected: the explanation is kept, and the diagnostics name each step to repair or accept. One request may change architecture, schema, and Walkthroughs together; the whole turn reverts as one. ${SANDBOX_API_PROMPT} Report tool errors without claiming changes that were not applied.`;

function estimateMessageTokens(msg: { content?: unknown }): number {
	if (typeof msg.content === "string") return Math.ceil(msg.content.length / 4);
	if (Array.isArray(msg.content)) {
		let chars = 0;
		for (const block of msg.content) {
			if (block && typeof block === "object") {
				if ("text" in block && typeof block.text === "string") chars += block.text.length;
				if ("arguments" in block && block.arguments) chars += JSON.stringify(block.arguments).length;
			}
		}
		return Math.ceil(chars / 4);
	}
	return 10;
}

function normalizeDdl(sql: string): string {
	return sql.trim().replace(/;\s*$/, "");
}

function computeUsageCost(model: Model<string> | undefined, usage: Usage | undefined, isApiKeyConnection: boolean): number | null {
	if (!isApiKeyConnection || !usage) return null;
	if (usage.cost && typeof usage.cost.total === "number" && usage.cost.total > 0) {
		return usage.cost.total;
	}
	if (model && model.cost && typeof model.cost === "object") {
		try {
			const calculated = calculateCost(model as AnyModel, usage);
			if (calculated && typeof calculated.total === "number") {
				return calculated.total;
			}
		} catch {
			return null;
		}
	}
	return null;
}


export type AssistantRuntimeOptions = {
	databasePath: string;
	workspace: DesignWorkspace;
	models?: MutableModels;
	credentialsOptions?: BunSecretCredentialStoreOptions;
	getApiKey?: () => Promise<string | undefined>;
	streamFn?: ConstructorParameters<typeof Agent>[0]["streamFn"];
	maxRequestsPerTurn?: number;
	openExternal?: (url: string) => unknown;
	scenarioRunTimeoutMs?: number;
	runScenario?: (projectId: string, designId: string, scenario: Scenario, signal: AbortSignal | undefined, timeoutMs: number) => Promise<ScenarioRun | null>;
};
function compactExpectationMessage(message: string) {
	const receivedAt = message.search(/,\s*received\b/i);
	const summary = receivedAt >= 0 ? `${message.slice(0, receivedAt)}, received row data omitted.` : message;
	return summary.slice(0, 500);
}

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
	getMaxRequestsPerTurn: () => number;
	setMaxRequestsPerTurn: (limit: number) => void;
	subscribeOAuth: (subscriber: (providerId: string, event: unknown) => void) => () => void;
	/** Answers a sign-in prompt the designer was shown, such as a pasted redirect URL. */
	answerOAuthPrompt: (promptId: string, value: string) => boolean;
	/** Cancels an in-progress sign-in for a provider. */
	cancelOAuthLogin: (providerId: string) => void;
	listModels: () => Promise<AssistantModel[]>;
	updateConversationSelection: (conversationId: string, connectionIdOrModel: string | null, modelOrThinking: string, maybeThinking?: ThinkingLevel) => void;
	subscribe: (subscriber: (conversationId: string, event: unknown) => void) => () => void;
	isTurnPaused: (conversationId: string) => boolean;
	isConfirmationPending: (conversationId: string) => boolean;
	isTurnRunning?: (conversationId: string) => boolean;
	continueTurn: <T extends { waitForCompletion?: boolean } = { waitForCompletion: true }>(
		conversationId: string,
		options?: T,
	) => Promise<T extends { waitForCompletion: false } ? { started: boolean } : AssistantConversationRecord | null>;
	stop: (conversationId: string) => void;
	canRevertTurn: (conversationId: string) => boolean;
	revertTurn: (conversationId: string) => Promise<AssistantConversationRecord | null>;
	confirmDdlDrop: <T extends { waitForCompletion?: boolean } = { waitForCompletion: true }>(
		conversationId: string,
		toolCallId: string,
		options?: T,
	) => Promise<T extends { waitForCompletion: false } ? { started: boolean } : AssistantConversationRecord | null>;
	rejectDdlDrop: <T extends { waitForCompletion?: boolean } = { waitForCompletion: true }>(
		conversationId: string,
		toolCallId: string,
		options?: T,
	) => Promise<T extends { waitForCompletion: false } ? { started: boolean } : AssistantConversationRecord | null>;
	sendMessage: <T extends { waitForCompletion?: boolean } = { waitForCompletion: true }>(
		conversationId: string,
		text: string,
		modelId: string,
		thinkingLevel?: ThinkingLevel,
		connectionId?: string,
		options?: T,
	) => Promise<T extends { waitForCompletion: false } ? { started: boolean } : AssistantConversationRecord | null>;
	close: () => void;
}

function compactScenarioRun(scenarioId: string, name: string, run: ScenarioRun) {
	const stopped = run.reason === "stopped";
	const requestCounts = new Map<string, number>();
	for (const request of run.requests) {
		const key = `${request.method} ${request.table} (${request.status})`;
		requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
	}
	return {
		scenario: name,
		scenarioId,
		runId: run.id,
		status: stopped ? "stopped" : run.status,
		revision: run.revision,
		stale: run.stale,
		reason: run.reason,
		failedExpectationCount: run.expectations.filter(({ passed }) => !passed).length,
		failedExpectations: run.expectations.filter(({ passed }) => !passed).slice(0, 20).map(({ description, message }) => ({
			description: description.slice(0, 300),
			message: compactExpectationMessage(message),
		})),
		console: run.console.slice(-20).map((line) => line.slice(0, 500)),
		requestCount: run.requests.length,
		requestLog: [...requestCounts].slice(0, 50).map(([request, count]) => ({ request, count })),
		omittedRequestKinds: Math.max(0, requestCounts.size - 50),
		grids: run.grids.slice(0, 10).map((grid) => ({
			table: grid.table,
			rowCount: grid.total,
			capturedRows: grid.rows.length,
			rows: grid.rows.slice(0, 3).map((row) => {
				const text = JSON.stringify(row);
				return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : row;
			}),
		})),
	};
}

function scenarioToolResult(details: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}
export function compactSandboxStatus(sandbox: SandboxState): "accepted" | "checking" | { rejected: string } {
	if (sandbox.status === "applied") return "accepted";
	if (sandbox.status === "failed") return { rejected: sandbox.error };
	return "checking";
}

export function compactSqlStatus(sql: SqlState): "current" | { errors: string[] } {
	if (sql.status === "current") return "current";
	const errors = "errors" in sql && Array.isArray(sql.errors) ? sql.errors : [];
	return { errors };
}


/** Main-process Assistant entry point; credentials remain outside application SQLite. */
export function createAssistantRuntime({ databasePath, workspace, models: suppliedModels, credentialsOptions, streamFn, getApiKey, maxRequestsPerTurn, openExternal, scenarioRunTimeoutMs = SCENARIO_RUN_TIMEOUT_MS + 15_000, runScenario }: AssistantRuntimeOptions): AssistantRuntime {
	const store: AssistantStore = openAssistantStore(databasePath);
	const credentials = new BunSecretCredentialStore(databasePath, credentialsOptions);
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
	// Prompts stay open until the designer answers, the flow aborts them (e.g. the
	// local callback server won the race), or the sign-in is cancelled.
	const pendingOAuthPrompts = new Map<string, { providerId: string; resolve: (value: string) => void; reject: (error: Error) => void }>();
	const oAuthLogins = new Map<string, AbortController>();
	/** Withdraws the login's leftover prompts, then reports its outcome last. */
	function finishOAuthLogin(providerId: string, loginAbort: AbortController, outcome: { type: "login_finished"; success: boolean; error?: string }) {
		if (oAuthLogins.get(providerId) === loginAbort) oAuthLogins.delete(providerId);
		for (const [promptId, pending] of pendingOAuthPrompts) {
			if (pending.providerId === providerId) closeOAuthPrompt(promptId)?.reject(new Error("Sign-in finished"));
		}
		publishOAuthEvent(providerId, outcome);
	}
	function closeOAuthPrompt(promptId: string) {
		const pending = pendingOAuthPrompts.get(promptId);
		if (!pending) return undefined;
		pendingOAuthPrompts.delete(promptId);
		publishOAuthEvent(pending.providerId, { type: "prompt_closed", promptId });
		return pending;
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
	const runningTurns = new Set<string>();
	const requestsThisTurn = new Map<string, number>();
	const turnIds = new Map<string, string>();
	const turnTrackers = new Map<string, TurnTracker>();
	const conversationReadStates = new Map<string, { revision: number; design: Design; scenarios: Scenario[]; edgeFunctions: EdgeFunction[]; systemDesign?: SystemContent; walkthroughs?: Walkthrough[] }>();
	const turnCheckpoints = new Map<string, { turnId: string; projectId: string; designId: string; before: { design: NonNullable<ReturnType<DesignWorkspace["getState"]>["design"]>; scenarios: Scenario[]; edgeFunctions: NonNullable<ReturnType<DesignWorkspace["getState"]>["edgeFunctions"]> }; after?: { design: NonNullable<ReturnType<DesignWorkspace["getState"]>["design"]>; scenarios: Scenario[]; edgeFunctions: NonNullable<ReturnType<DesignWorkspace["getState"]>["edgeFunctions"]> } }>();
	const latestTurnByProject = new Map<string, string>();
	workspace.onAssistantDesignMutation?.((turnId, before, after) => {
		const tracker = turnTrackers.get(turnId);
		if (tracker) {
			tracker.recordDesignMutation(before, after);
		}
	});
	const pendingConfirmations = new Set<string>();
	// Removal plans the designer rejected, per conversation, for the current turn only.
	const rejectedDrops = new Map<string, { turnId: string | undefined; plans: Set<string> }>();
	const confirmingDrops = new Set<string>();
	type ConfirmedDropGuard = {
		turnId: string | undefined;
		statement: string;
		statements: string[];
		affectedTables: Array<{ name: string; change: "added" | "changed" | "removed" }>;
		projectId: string;
		designId: string | undefined;
	};
	const lastConfirmedDrops = new Map<string, ConfirmedDropGuard>();
	type AssistantTarget = { projectId: string; designId: string };
	const pendingDdlTargets = new Map<string, AssistantTarget>();
	/** The Design each conversation's current turn was started on. Its tools never retarget. */
	const turnTargets = new Map<string, AssistantTarget>();
	const turnUsages = new Map<string, {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cost: number | null;
	}>();
	const lastPromptTokens = new Map<string, number>();
	function getConversationConnection(conversationId: string): AssistantProviderConnection | null {
		const conv = store.loadConversation(conversationId);
		if (conv?.connection_id) {
			const conn = store.getConnection(conv.connection_id);
			if (conn) return conn;
		}
		const connections = store.listProviderConnections();
		if (conv?.provider) {
			const byProvider = connections.find((c) => c.provider_id === conv.provider);
			if (byProvider) return byProvider;
		}
		return connections[0] ?? null;
	}

	const activeTurnIsApiKey = new Map<string, boolean>();
	function isConversationApiKeyConnection(conversationId: string): boolean {
		const turnOverride = activeTurnIsApiKey.get(conversationId);
		if (turnOverride !== undefined) return turnOverride;
		const conn = getConversationConnection(conversationId);
		if (conn) return conn.auth_method === "api-key";
		return Boolean(getApiKey);
	}

	// A "Sign in with ChatGPT" token reaches only the models of pi's Codex catalog; OpenAI
	// rejects the rest of the API catalog (e.g. gpt-4) with model_not_found. API-key
	// connections keep the full catalog.
	const chatGptSignInModelIds = new Set(openaiCodexProvider().getModels().map((model) => model.id));
	function isModelUsableWithConnection(conn: AssistantProviderConnection, model: { id: string }): boolean {
		if (conn.auth_method === "oauth" && conn.provider_id === "openai") return chatGptSignInModelIds.has(model.id);
		return true;
	}
	function getUsableModelsForConnection(conn: AssistantProviderConnection) {
		const connModels = getOrInitConnectionModels(conn);
		const providerObj = connModels.getProvider(conn.provider_id);
		let providerModels = connModels.getModels(conn.provider_id);
		if (conn.auth_method === "oauth" && providerObj?.filterModels) {
			providerModels = providerObj.filterModels(providerModels, { type: "oauth" } as never);
		}
		return providerModels.filter((m) => isModelUsableWithConnection(conn, m));
	}

	function getModelContext(conversationId: string, messages: AgentMessage[]): AgentMessage[] {
		const compaction = store.getCompaction(conversationId);
		if (!compaction || !compaction.firstKeptMessageId) return messages;

		const system = messages.length > 0 && messages[0]?.role === "system" ? messages[0] : null;
		const conversationMessages = system ? messages.slice(1) : messages;

		const cutIndex = (conversationMessages as Array<{ id?: string }>).findIndex((m) => m.id === compaction.firstKeptMessageId);
		if (cutIndex <= 0) return messages;

		const summaryMsg: AgentMessage & { id?: string } = {
			id: `compaction-summary:${compaction.createdAt}`,
			role: "user",
			content: `Summary of earlier conversation:\n${compaction.summary}`,
			timestamp: compaction.createdAt,
		};

		const kept = conversationMessages.slice(cutIndex);
		return system ? [system, summaryMsg, ...kept] : [summaryMsg, ...kept];
	}

	async function performCompaction(conversationId: string, agent: Agent) {
		const contextWindow = agent.state.model.contextWindow;
		if (contextWindow <= 0) return;

		const messages = agent.state.messages as Array<AgentMessage & { id?: string; kind?: string }>;
		const conversationMessages = messages.length > 0 && messages[0]?.role === "system" ? messages.slice(1) : messages;

		type TurnGroup = {
			userMessage: AgentMessage & { id?: string };
			messages: Array<AgentMessage & { id?: string }>;
		};
		const turns: TurnGroup[] = [];
		let currentTurn: TurnGroup | null = null;
		for (const msg of conversationMessages) {
			if (msg.role === "user" && msg.kind !== "assistant-change-note") {
				currentTurn = { userMessage: msg, messages: [msg] };
				turns.push(currentTurn);
			} else if (currentTurn) {
				currentTurn.messages.push(msg);
			}
		}

		if (turns.length < 2) return;

		const targetKeptTokens = Math.floor(contextWindow * 0.2);
		let firstKeptTurnIndex = turns.length - 1;
		let keptTokens = turns[firstKeptTurnIndex]!.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

		for (let i = turns.length - 2; i >= 1; i--) {
			const turnTokens = turns[i]!.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
			if (keptTokens + turnTokens <= targetKeptTokens) {
				firstKeptTurnIndex = i;
				keptTokens += turnTokens;
			} else {
				break;
			}
		}

		const firstKeptTurn = turns[firstKeptTurnIndex]!;
		const firstKeptMessageId = firstKeptTurn.userMessage.id;
		if (!firstKeptMessageId) return;

		const currentContext = getModelContext(conversationId, agent.state.messages);
		const summaryInstruction = {
			role: "user" as const,
			content: "Summarise the conversation so far for your own future reference: decisions, schema/code changes applied, open issues",
			timestamp: Date.now(),
		};
		const summaryMessages = [...currentContext, summaryInstruction];

		const conn = getConversationConnection(conversationId);
		const activeModels = conn ? getOrInitConnectionModels(conn) : (suppliedModels ?? createModels({ credentials }));
		const effectiveStreamFn = streamFn ?? activeModels.streamSimple.bind(activeModels);
		try {
			const resolvedAuth = await activeModels.getAuth(agent.state.model).catch(() => undefined);
			const apiKey = (getApiKey ? await getApiKey().catch(() => undefined) : undefined) ?? resolvedAuth?.auth.apiKey;
			const summaryStream = await effectiveStreamFn(agent.state.model, normalizeContext({ messages: summaryMessages }), {
				sessionId: conversationId,
				...(apiKey ? { apiKey } : {}),
			});
			const summaryResult = await summaryStream.result();
			if (summaryResult.stopReason === "error" || summaryResult.stopReason === "aborted") {
				return;
			}
			const summaryText = summaryResult.content
				.filter((c: unknown): c is { type: "text"; text: string } => Boolean(c && typeof c === "object" && "type" in c && c.type === "text"))
				.map((c) => c.text)
				.join("\n")
				.trim();
			if (!summaryText) {
				return;
			}

			if (summaryResult.usage) {
				const currentUsage = turnUsages.get(conversationId) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: null };
				currentUsage.inputTokens += summaryResult.usage.input || 0;
				currentUsage.outputTokens += summaryResult.usage.output || 0;
				currentUsage.cacheReadTokens += summaryResult.usage.cacheRead || 0;
				const isApiKey = isConversationApiKeyConnection(conversationId);
				const msgCost = computeUsageCost(agent.state.model, summaryResult.usage, isApiKey);
				if (msgCost !== null) {
					currentUsage.cost = (currentUsage.cost ?? 0) + msgCost;
				}
				turnUsages.set(conversationId, currentUsage);
			}

			store.saveCompaction(conversationId, summaryText, firstKeptMessageId);

			const announcement = {
				id: crypto.randomUUID(),
				role: "system",
				kind: "assistant-compaction",
				payload: {
					text: "Conversation context reached 80% of the model limit. Older turns have been summarised to preserve context space.",
					timestamp: Date.now(),
				},
			};
			store.appendMessage(conversationId, announcement);
			publish(conversationId, {
				type: "assistant_compaction_announced",
				message: announcement,
			});
		} catch {
			return;
		}
	}
	const requestLimit = () => maxRequestsPerTurn ?? store.getMaxRequestsPerTurn();
	type BoundWorkspaceState = ReturnType<DesignWorkspace["getState"]> & {
		project: NonNullable<ReturnType<DesignWorkspace["getState"]>["project"]>;
		design: NonNullable<ReturnType<DesignWorkspace["getState"]>["design"]>;
	};


	function stateMatchesTarget(state: ReturnType<DesignWorkspace["getState"]>, target: AssistantTarget) {
		return state.project?.id === target.projectId
			&& state.design !== null
			&& (state.activeDesignId ?? undefined) === target.designId;
	}
	function assertTargetState(state: ReturnType<DesignWorkspace["getState"]>, target: AssistantTarget, message: string) {
		if (!stateMatchesTarget(state, target)) throw new Error(message);
	}
	/** The Project and Design shown now, which is where a new turn starts. */
	function currentBoundState(conversationId: string) {
		const conversation = store.loadConversation(conversationId);
		if (!conversation) throw new Error("Conversation not found.");
		const state = workspace.getState();
		if (!state.project || !state.design || state.project.id !== conversation.project_id || !state.activeDesignId) {
			throw new Error("This conversation requires its project and an active Design to use project tools.");
		}
		return {
			conversation,
			state: state as BoundWorkspaceState,
			target: { projectId: conversation.project_id, designId: state.activeDesignId } satisfies AssistantTarget,
		};
	}
	/**
	 * Tools and confirmations act on the Design their turn started on, never on
	 * whichever Design is open. Opening a different Design makes them refuse.
	 */
	function requireBoundState(conversationId: string) {
		const current = currentBoundState(conversationId);
		const bound = turnTargets.get(conversationId);
		if (!bound) return current;
		if (bound.projectId !== current.target.projectId || bound.designId !== current.target.designId) {
			throw new Error("This Assistant turn works on another design. Open that design to continue it.");
		}
		return { ...current, target: bound };
	}
	function projectSnapshot(state: ReturnType<DesignWorkspace["getState"]>): string {
		return JSON.stringify({
			design: state.design,
			scenarios: state.scenarios,
			edgeFunctions: state.edgeFunctions,
			systemDesign: systemReadContent(state.systemDesign) ?? null,
			walkthroughs: state.walkthroughs ?? [],
		});
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
			const { state, target } = requireBoundState(conversationId);
			const generated = generateDesignSql(state.design);
			store.observeProjectSnapshot(conversationId, projectSnapshot(state), state.revision);
			conversationReadStates.set(conversationId, {
				revision: state.revision,
				design: structuredClone(state.design),
				scenarios: structuredClone(state.scenarios),
				edgeFunctions: structuredClone(state.edgeFunctions),
				systemDesign: structuredClone(systemReadContent(state.systemDesign)),
			});
			return {
				content: [{ type: "text", text: JSON.stringify({
					projectId: target.projectId,
					designId: target.designId,
					project: state.project,
					revision: state.revision,
					systemDesign: systemReadContent(state.systemDesign) ?? null,
					design: state.design,
					generatedSql: generated.ok ? `${generated.sql}${assistantColumnNotesSql(state)}` : { errors: generated.errors },
					sandbox: state.sandbox,
					functions: state.design.functions,
					triggers: state.design.triggers,
					policies: state.design.tables.map(({ name, policies }) => ({ table: name, policies })),
					scenarios: state.scenarios,
					edgeFunctions: state.edgeFunctions,
					scenarioRuns: Object.entries(state.scenarioRuns).flatMap(([scenarioId, run]) => run
						? [compactScenarioRun(scenarioId, state.scenarios.find(({ id }) => id === scenarioId)?.name ?? scenarioId, run)]
						: []),
				}) }],
				details: { projectId: target.projectId, designId: target.designId, revision: state.revision },
			};
		},
	},
	{
		name: "read_system_design",
		label: "Read System design",
		description: "Read the System design in focus: every Service, Group, Component, and Connection with its stable id and version, ownership (ownerServiceId), Group membership and nesting (memberIds, containedInGroupIds), database design links (linkedDesignId), Connection attachment sides, bend points, and label offsets, the database designs the Project offers for linking, and diagnostics. Read before editing; an item changed after your read is refused.",
		parameters: Type.Object({}),
		execute: async () => {
			const { state, target } = requireBoundState(conversationId);
			const design = state.systemDesign;
			if (!design) throw new Error("The System design is not loaded for this project.");
			const existing = conversationReadStates.get(conversationId);
			if (existing) existing.systemDesign = structuredClone(systemReadContent(design));
			return {
				content: [{ type: "text", text: JSON.stringify({
					projectId: target.projectId,
					designId: target.designId,
					revision: state.revision,
					...readSystemArchitecture(design, state.designs),
				}) }],
				details: { projectId: target.projectId, designId: target.designId, revision: state.revision },
			};
		},
	},
	{
		name: "edit_system_design",
		label: "Edit System design",
		description: "Edit the Project's System design in one batch: add, update, move, or remove Services, Components, Groups, and directed, labeled Connections; assign or release Component ownership; link or unlink database components to designs; set Connection attachment sides, bend points, and label offsets; or arrange the layout. Each batch applies in full or not at all. Give new items a new stable id and reuse it in later operations of the same batch. Read the System design before editing: an item changed since your read is refused until you read again. The result lists the impacts of the batch, such as Connections a removal deleted.",
		parameters: Type.Object({
			operations: Type.Array(Type.Object({
				op: Type.Union([
					Type.Literal("add_component"),
					Type.Literal("update_component"),
					Type.Literal("move_component"),
					Type.Literal("remove_component"),
					Type.Literal("add_service"),
					Type.Literal("update_service"),
					Type.Literal("move_service"),
					Type.Literal("remove_service"),
					Type.Literal("add_group"),
					Type.Literal("update_group"),
					Type.Literal("move_group"),
					Type.Literal("remove_group"),
					Type.Literal("add_connection"),
					Type.Literal("update_connection"),
					Type.Literal("remove_connection"),
					Type.Literal("arrange_layout"),
				]),
				id: Type.Optional(Type.String({ description: "New stable id for an add_ operation" })),
				componentId: Type.Optional(Type.String()),
				serviceId: Type.Optional(Type.String()),
				groupId: Type.Optional(Type.String()),
				connectionId: Type.Optional(Type.String()),
				sourceId: Type.Optional(Type.String({ description: "Existing Component or Service id where a Connection starts" })),
				targetId: Type.Optional(Type.String({ description: "Existing Component or Service id where a Connection arrives" })),
				componentIds: Type.Optional(Type.Array(Type.String(), { description: "arrange_layout only: the Components to arrange. Omit to arrange every Component." })),
				name: Type.Optional(Type.String()),
				kind: Type.Optional(Type.Union(SYSTEM_COMPONENT_KINDS.map((kind) => Type.Literal(kind)))),
				technology: Type.Optional(Type.String()),
				description: Type.Optional(Type.String()),
				properties: Type.Optional(Type.Array(Type.Object({ key: Type.String(), value: Type.String() }), { description: "Descriptive properties; replaces the Component's list" })),
				icon: Type.Optional(Type.Union(CUSTOM_ICONS.map((icon) => Type.Literal(icon)), { description: "Custom components only" })),
				label: Type.Optional(Type.String({ description: "Connection label describing the interaction" })),
				protocol: Type.Optional(Type.String()),
				ownerServiceId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Service that owns the Component; null releases it to system scope" })),
				linkedDesignId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Database component only: a design id from read_system_design; null unlinks it" })),
				memberIds: Type.Optional(Type.Array(Type.String(), { description: "Group members: Component, Service, or Group ids. Replaces the list; a Group cannot contain itself or a Group that contains it." })),
				fromSide: Type.Optional(Type.Union(SYSTEM_CONNECTION_SIDES.map((side) => Type.Literal(side)), { description: "Side the Connection leaves its source from; auto restores the default" })),
				toSide: Type.Optional(Type.Union(SYSTEM_CONNECTION_SIDES.map((side) => Type.Literal(side)), { description: "Side the Connection arrives at its target; auto restores the default" })),
				bendPoints: Type.Optional(Type.Array(Type.Object({ x: Type.Number(), y: Type.Number() }), { description: "Waypoints from source to target; an empty list removes them" })),
				labelOffset: Type.Optional(Type.Union([Type.Object({ x: Type.Number(), y: Type.Number() }), Type.Null()], { description: "Label offset from the route midpoint; null puts the label back on the route" })),
				x: Type.Optional(Type.Number()),
				y: Type.Optional(Type.Number()),
				width: Type.Optional(Type.Number({ description: "Group width" })),
				height: Type.Optional(Type.Number({ description: "Group height" })),
			})),
		}),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const input = params as { operations: SystemOperation[] };
			const { state, target } = requireBoundState(conversationId);
			const current = state.systemDesign;
			if (!current) throw new Error("The System design is not loaded for this project.");
			const readState = conversationReadStates.get(conversationId);
			checkSystemReadPreconditions(readState?.systemDesign, current, input.operations);
			const turnId = turnIds.get(conversationId);
			const plan = planSystemOperations(current, input.operations, turnId, new Set(state.designs.map((item) => item.id)));
			const before = systemDesignContent(current);
			const after = await applySystemOperationPlan(workspace, plan);
			assertTargetState(after, target, "The project changed before the System design edit completed.");
			const afterContent = systemDesignContent(after.systemDesign ?? current);
			turnTrackers.get(turnId ?? "")?.recordSystemMutation(before, afterContent);
			const afterDesign = after.systemDesign ?? current;
			const walkthroughImpacts = walkthroughImpactOfRemovedConnections(after.walkthroughs ?? [], current, afterDesign);
			if (readState) readState.systemDesign = structuredClone(afterContent);
			store.observeProjectSnapshot(conversationId, projectSnapshot(after), after.revision);
			const summary = {
				status: "applied",
				projectId: target.projectId,
				designId: target.designId,
				operations: plan.actions.length,
				impacts: plan.impacts,
				services: afterContent.services.map(({ id, name, position }) => ({ id, name, x: position.x, y: position.y })),
				groups: afterContent.groups.map(({ id, name, memberIds }) => ({ id, name, memberIds })),
				components: afterContent.components.map(({ id, kind, name, technology, position, serviceId, designId }) => ({
					id, kind, name, technology, x: position.x, y: position.y, ownerServiceId: serviceId, linkedDesignId: designId ?? null,
				})),
				connections: afterContent.connections.map(({ id, sourceId, targetId, label, protocol }) => ({ id, sourceId, targetId, label, protocol })),
				walkthroughImpacts: walkthroughImpacts.map(({ walkthroughName, stepId, title, connectionId }) => ({ walkthroughName, stepId, title, connectionId })),
				walkthroughDiagnostics: walkthroughDiagnostics(after.walkthroughs ?? [], afterDesign),
			};
			return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
		},
	},
	{
		name: "read_walkthroughs",
		label: "Read Walkthroughs",
		description: "Read every named Walkthrough in the Project: its stable id and version, its blocks in order (sequences, parallel blocks with branches, repeat blocks with a count), and each step's Connection, explanation, action, timing, and status against the System design (ok, dangling, or redirected). Returns diagnostics for steps that need repair or review. Read before editing; a Walkthrough changed after your read is refused.",
		parameters: Type.Object({}),
		execute: async () => {
			const { state, target } = requireBoundState(conversationId);
			const design = state.systemDesign;
			if (!design) throw new Error("The System design is not loaded for this project.");
			const walkthroughs = state.walkthroughs ?? [];
			const existing = conversationReadStates.get(conversationId);
			if (existing) existing.walkthroughs = structuredClone(walkthroughs);
			return {
				content: [{ type: "text", text: JSON.stringify({
					projectId: target.projectId,
					designId: target.designId,
					revision: state.revision,
					walkthroughs: readWalkthroughs(walkthroughs, design),
					diagnostics: walkthroughDiagnostics(walkthroughs, design),
				}) }],
				details: { projectId: target.projectId, designId: target.designId, revision: state.revision },
			};
		},
	},
	{
		name: "edit_walkthroughs",
		label: "Edit Walkthroughs",
		description: "Edit the Project's Walkthroughs in one batch: create, rename, move, or remove named Walkthroughs; add, update, move, remove, repair, or accept a redirected step that plays a System design Connection by connectionId; add parallel or repeat blocks, add branches, set repeat counts, move or remove blocks. A step's sequence can name a block id and branch. Give new Walkthroughs, steps, and blocks a new stable id and reuse it in later operations of the same batch. Each batch applies in full or not at all. Read the Walkthroughs before editing. Use sequential steps for ordered work, parallel blocks for work that runs together, and repeat blocks for a fixed number of attempts; a failed attempt and its retry are ordinary steps.",
		parameters: Type.Object({
			operations: Type.Array(Type.Object({
				op: Type.Union(WALKTHROUGH_OPERATION_NAMES.map((name) => Type.Literal(name))),
				id: Type.Optional(Type.String({ description: "New stable id for a create or add operation" })),
				walkthroughId: Type.Optional(Type.String()),
				stepId: Type.Optional(Type.String()),
				blockId: Type.Optional(Type.String()),
				name: Type.Optional(Type.String()),
				toIndex: Type.Optional(Type.Number({ description: "Position within the same list, from 0" })),
				connectionId: Type.Optional(Type.String({ description: "A Connection id from read_system_design" })),
				kind: Type.Optional(Type.Union([Type.Literal("parallel"), Type.Literal("repeat")])),
				count: Type.Optional(Type.Number({ description: "repeat blocks only: a whole number from 1 to 10" })),
				sequence: Type.Optional(Type.Object({
					blockId: Type.Union([Type.String(), Type.Null()], { description: "Null for the top-level sequence; otherwise a repeat or parallel block id" }),
					branch: Type.Optional(Type.Number({ description: "For a parallel block: the branch index, from 0" })),
				}, { description: "Where add_step or add_block places new content" })),
				title: Type.Optional(Type.String()),
				explanation: Type.Optional(Type.String()),
				action: Type.Optional(Type.Union(WALKTHROUGH_ACTIONS.map((action) => Type.Literal(action)), { description: "send, receive, process, succeed, or fail" })),
				operation: Type.Optional(Type.String({ description: "Visual preset such as Cache hit; empty text clears it" })),
				durationMs: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Illustrative duration in milliseconds, 100 to 10000; null clears it" })),
				travelPercent: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Whole percent of the step spent travelling, 10 to 90; null clears it" })),
				exampleMessage: Type.Optional(Type.String()),
				examplePayload: Type.Optional(Type.String()),
			})),
		}),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const input = params as { operations: WalkthroughOperation[] };
			const { state, target } = requireBoundState(conversationId);
			const design = state.systemDesign;
			if (!design) throw new Error("The System design is not loaded for this project.");
			const current = state.walkthroughs ?? [];
			const readState = conversationReadStates.get(conversationId);
			checkWalkthroughReadPreconditions(readState?.walkthroughs, current, input.operations);
			const turnId = turnIds.get(conversationId);
			const plan = planWalkthroughOperations(current, input.operations, design);
			const after = await workspace.replaceWalkthroughs({
				walkthroughs: plan.next,
				...(turnId !== undefined ? { assistantTurnId: turnId } : {}),
			});
			assertTargetState(after, target, "The project changed before the Walkthrough edit completed.");
			const afterWalkthroughs = after.walkthroughs ?? [];
			turnTrackers.get(turnId ?? "")?.recordWalkthroughMutation(current, afterWalkthroughs);
			if (readState) readState.walkthroughs = structuredClone(afterWalkthroughs);
			store.observeProjectSnapshot(conversationId, projectSnapshot(after), after.revision);
			const summary = {
				status: "applied",
				projectId: target.projectId,
				designId: target.designId,
				operations: input.operations.length,
				walkthroughs: readWalkthroughs(afterWalkthroughs, design),
				diagnostics: walkthroughDiagnostics(afterWalkthroughs, design),
			};
			return { content: [{ type: "text", text: JSON.stringify(summary) }], details: summary };
		},
	},
	{
		name: "run_scenarios",
		label: "Run Scenarios",
		description: "Run one saved Scenario or all saved Scenarios in the bound project. Returns concise expectations, console, request summary, and result-grid samples.",
		parameters: Type.Object({
			mode: Type.Union([Type.Literal("one"), Type.Literal("all")]),
			scenarioId: Type.Optional(Type.String()),
		}),
		executionMode: "sequential",
		execute: async (_toolCallId, params, signal) => {
			const input = params as { mode: "one" | "all"; scenarioId?: string };
			const { state, target } = requireBoundState(conversationId);
			if (!runScenario) throw new Error("Scenario runs are unavailable because the view is not connected.");
			if (input.mode === "one" && !input.scenarioId) throw new Error("A Scenario id is required to run one Scenario.");
			const scenarios = input.mode === "one"
				? state.scenarios.filter(({ id }) => id === input.scenarioId).map((scenario) => ({ ...scenario }))
				: state.scenarios.map((scenario) => ({ ...scenario }));
			if (input.mode === "one" && scenarios.length === 0) throw new Error("That Scenario does not exist in the bound project.");
			if (input.mode === "all" && scenarios.length === 0) return scenarioToolResult({ projectId: target.projectId, designId: target.designId, mode: "all", runs: [] });
			const stoppedScenarios: Scenario[] = [];
			const results = await runAllScenarios(scenarios, async (scenario) => {
				assertTargetState(workspace.getState(), target, "The project or Design changed before the Scenario run started.");
				try {
					const run = await runScenario(target.projectId, target.designId, scenario, signal, scenarioRunTimeoutMs);
					assertTargetState(workspace.getState(), target, "The project or Design changed while the Scenario run was in progress.");
					if (!run && signal?.aborted) stoppedScenarios.push(scenario);
					return run;
				} catch (cause) {
					if (!signal?.aborted) throw cause;
					stoppedScenarios.push(scenario);
					return null;
				}
			}, () => stateMatchesTarget(workspace.getState(), target));
			assertTargetState(workspace.getState(), target, "The project or Design changed while the Scenario run was in progress.");
			const runs: Record<string, unknown>[] = results.map(({ scenario, run }) =>
				compactScenarioRun(scenario.id, scenario.name, run),
			);
			const stoppedScenario = stoppedScenarios[0];
			if (stoppedScenario) {
				runs.push({ scenario: stoppedScenario.name, scenarioId: stoppedScenario.id, status: "stopped", reason: "stopped" });
			}
			return scenarioToolResult({ projectId: target.projectId, designId: target.designId, mode: input.mode, runs });
	},
		},
	{
		name: "apply_ddl",
		label: "Apply PostgreSQL DDL",
		description: "Translate the documented accepted PostgreSQL DDL subset into one atomic design change. Unsupported statements fail without changing the project. A drop with dependents returns a confirmation plan; do not claim it was applied.",
		parameters: Type.Object({ sql: Type.String({ description: "PostgreSQL DDL to parse and apply" }) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			const { state: invocationState, target } = requireBoundState(conversationId);
			const { sql } = params as { sql: string };
			const currentTurnId = turnIds.get(conversationId);
			const lastConfirmed = lastConfirmedDrops.get(conversationId);
			if (lastConfirmed && lastConfirmed.turnId === currentTurnId && lastConfirmed.projectId === target.projectId
				&& lastConfirmed.designId === target.designId && normalizeDdl(lastConfirmed.statement) === normalizeDdl(sql)) {
				lastConfirmedDrops.delete(conversationId);
				const currentState = workspace.getState();
				assertTargetState(currentState, target, "The project or Design changed after the confirmed DDL was applied.");
				const alreadyApplied = {
					status: "already applied" as const,
					message: "This DDL change was already applied upon confirmation. Do not re-run it.",
					statements: lastConfirmed.statements,
					affectedTables: lastConfirmed.affectedTables,
					revision: currentState.revision,
					sql: compactSqlStatus(currentState.sql),
					sandbox: compactSandboxStatus(currentState.sandbox),
				};
				return {
					content: [{ type: "text", text: JSON.stringify(alreadyApplied) }],
					details: { ...alreadyApplied, projectId: target.projectId, designId: target.designId },
				};
			}
			lastConfirmedDrops.delete(conversationId);
			const readState = conversationReadStates.get(conversationId);
			const before = invocationState.design ?? workspace.getState().design;
			const result = await applyAssistantDdl(workspace, sql, {
				assistantTurnId: turnIds.get(conversationId),
				expectedProjectId: target.projectId,
				expectedDesignId: target.designId,
				idFactory: deterministicDdlIdFactory(_toolCallId),
				readDesign: readState?.design,
			});
			if (result.status === "confirmation-required" &&
				(result.projectId !== target.projectId || result.designId !== target.designId)) {
				throw new Error("The DDL confirmation plan belongs to another project or Design.");
			}
			if (result.status === "confirmation-required") {
				const rejected = rejectedDrops.get(conversationId);
				if (rejected && rejected.turnId === turnIds.get(conversationId) && rejected.plans.has(JSON.stringify(result.removal))) {
					const refused = { status: "rejected-earlier", message: "Not applied: the designer already rejected this destructive change in this turn. Do not retry it; explain and ask what they want instead." };
					return { content: [{ type: "text", text: JSON.stringify(refused) }], details: refused };
				}
				pendingDdlTargets.set(conversationId, target);
				pendingConfirmations.add(conversationId);
				publish(conversationId, { type: "assistant_confirmation_required" });
				const details = { ...result, projectId: target.projectId, designId: target.designId };
				return {
					content: [{ type: "text", text: JSON.stringify(details) }],
					details,
					terminate: true,
				};
			}
			if (result.status === "applied") assertTargetState(result.state, target, "The project or Design changed before the DDL change completed.");
			const after = result.state;
			if (readState && result.state.design) {
				readState.design = structuredClone(result.state.design);
				readState.revision = result.state.revision;
			}
			store.observeProjectSnapshot(conversationId, projectSnapshot(after), after.revision);
			const beforeById = new Map((before?.tables ?? []).map((table) => [table.id, table]));
			const affectedTables: Array<{
				id: string;
				name: string;
				change: "added" | "changed" | "removed";
			}> = (after.design?.tables ?? [])
				.filter((table) => JSON.stringify(beforeById.get(table.id)) !== JSON.stringify(table))
				.map(({ id, name }) => ({
					id,
					name,
					change: !beforeById.has(id) ? "added" : "changed",
				}));
			const afterIds = new Set((after.design?.tables ?? []).map(({ id }) => id));
			for (const table of before?.tables ?? []) {
				if (!afterIds.has(table.id)) {
					affectedTables.push({
						id: table.id,
						name: table.name,
						change: "removed",
					});
				}
			}

			const modelAffectedTables = affectedTables.map(({ name, change }) => ({
				name,
				change,
			}));

			const appliedStatements = result.statements && result.statements.length > 0
				? result.statements
				: [sql.trim()];

			const modelResult = {
				status: "applied" as const,
				statements: appliedStatements,
				affectedTables: modelAffectedTables,
				revision: after.revision,
				sql: compactSqlStatus(after.sql),
				sandbox: compactSandboxStatus(after.sandbox),
			};

			const details = {
				status: "applied" as const,
				projectId: target.projectId,
				designId: target.designId,
				statements: appliedStatements,
				affectedTables,
				revision: after.revision,
				sql: compactSqlStatus(after.sql),
				sandbox: compactSandboxStatus(after.sandbox),
			};

			return {
				content: [{ type: "text", text: JSON.stringify({ ...modelResult, projectId: target.projectId, designId: target.designId }) }],
				details,
			};
		},
	},
	{
		name: "manage_code",
		label: "Manage project code",
		description: "Create (optionally with its full source), rename, or remove a Scenario or Edge function; write or exact-string-edit a Scenario, Edge function, or design Function body. Every edit must match exactly once. Code writes use ordinary workspace saves; tool results include the complete source diff and TypeScript diagnostics from the same declarations as Monaco (Function bodies are SQL, not TypeScript).",
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
			const { state: initialBoundState, target } = requireBoundState(conversationId);
			let boundState = initialBoundState;
			const kind = input.kind;
			const currentTurnId = turnIds.get(conversationId);
			const tracker = currentTurnId ? turnTrackers.get(currentTurnId) : undefined;
			const readState = conversationReadStates.get(conversationId);
			checkCodeRelevantContent(readState, workspace.getState(), kind, input.id, input.action, input.name);
			if (input.action === "create") {
				if (kind === "function-body") throw new Error("Function bodies cannot be created; define a Function through apply_ddl.");
				if (!input.name) throw new Error("A name is required to create a code item.");
				const state = kind === "scenario"
					? await workspace.createScenario({ name: input.name, designId: target.designId, assistantTurnId: currentTurnId })
					: await workspace.createEdgeFunction({ name: input.name, designId: target.designId, assistantTurnId: currentTurnId });
				assertTargetState(state, target, "The project or Design changed before the code item was created.");
				boundState = state as BoundWorkspaceState;
				const item = kind === "scenario"
					? state.scenarios.find((candidate) => candidate.name === input.name?.trim())
					: state.edgeFunctions.find((candidate) => candidate.name === input.name?.trim());
				if (!item) throw new Error("The created code item could not be found in the bound project and Design.");
				if (tracker) {
					if (kind === "scenario") tracker.recordScenarioCreated(item as Scenario);
					else tracker.recordEdgeFunctionCreated(item as EdgeFunction);
				}
				if (readState) {
					if (kind === "scenario") readState.scenarios = structuredClone(state.scenarios);
					else readState.edgeFunctions = structuredClone(state.edgeFunctions);
				}
				if (input.source === undefined) {
					const details = { action: "created", kind, id: item.id, name: item.name, projectId: target.projectId, designId: target.designId };
					return { content: [{ type: "text", text: JSON.stringify(details) }], details };
				}
				// A create that carries source continues as a whole-file write of the new item.
				input.id = item.id;
				input.action = "write";
			}
			if (input.action === "rename" || input.action === "remove") {
				if (kind === "function-body") throw new Error("Function bodies cannot be renamed or removed through code tools.");
				if (!input.id) throw new Error("An item id is required to rename or remove a code item.");
				if (input.action === "rename" && !input.name) throw new Error("A new name is required to rename a code item.");
				const currentBound = requireBoundState(conversationId);
				const beforeScenario = kind === "scenario" ? currentBound.state.scenarios.find((s) => s.id === input.id) : undefined;
				const beforeEdge = kind === "edge-function" ? currentBound.state.edgeFunctions.find((e) => e.id === input.id) : undefined;
				const state = kind === "scenario"
					? input.action === "rename"
						? await workspace.renameScenario({ scenarioId: input.id, name: input.name!, designId: target.designId, assistantTurnId: currentTurnId })
						: await workspace.removeScenario({ scenarioId: input.id, designId: target.designId, assistantTurnId: currentTurnId })
					: input.action === "rename"
						? await workspace.renameEdgeFunction({ edgeFunctionId: input.id, name: input.name!, designId: target.designId, assistantTurnId: currentTurnId })
						: await workspace.removeEdgeFunction({ edgeFunctionId: input.id, designId: target.designId, assistantTurnId: currentTurnId });
				assertTargetState(state, target, "The project or Design changed before the code item was updated.");
				if (tracker) {
					if (kind === "scenario") {
						if (input.action === "rename" && beforeScenario) {
							const afterScenario = state.scenarios.find((s) => s.id === input.id);
							if (afterScenario) tracker.recordScenarioModified(beforeScenario, afterScenario);
						} else if (input.action === "remove" && beforeScenario) {
							tracker.recordScenarioRemoved(beforeScenario);
						}
					} else {
						if (input.action === "rename" && beforeEdge) {
							const afterEdge = state.edgeFunctions.find((e) => e.id === input.id);
							if (afterEdge) tracker.recordEdgeFunctionModified(beforeEdge, afterEdge);
						} else if (input.action === "remove" && beforeEdge) {
							tracker.recordEdgeFunctionRemoved(beforeEdge);
						}
					}
				}
				if (readState) {
					if (kind === "scenario") readState.scenarios = structuredClone(state.scenarios);
					else readState.edgeFunctions = structuredClone(state.edgeFunctions);
				}
				const details = {
					action: input.action === "rename" ? "renamed" : "removed",
					kind,
					id: input.id,
					name: input.name,
					projectId: target.projectId,
					designId: target.designId,
				};
				return { content: [{ type: "text", text: JSON.stringify(details) }], details };
			}

			if (!input.id) throw new Error("An item id is required to write code.");
			let itemName: string;
			let before: string;
			if (kind === "scenario") {
				const item = boundState.scenarios.find(({ id }) => id === input.id);
				if (!item) throw new Error("That Scenario could not be found in the bound project.");
				itemName = item.name;
				before = item.source;
			} else if (kind === "edge-function") {
				const item = boundState.edgeFunctions.find(({ id }) => id === input.id);
				if (!item) throw new Error("That Edge function could not be found in the bound project.");
				itemName = item.name;
				before = item.source;
			} else {
				const item = boundState.design?.functions?.find(({ id }) => id === input.id);
				if (!item) throw new Error("That Function could not be found in the bound project.");
				itemName = item.name;
				before = item.body;
			}
			const beforeScenario = kind === "scenario" ? boundState.scenarios.find((s) => s.id === input.id) : undefined;
			const beforeEdge = kind === "edge-function" ? boundState.edgeFunctions.find((e) => e.id === input.id) : undefined;
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
			if (kind === "scenario") state = await workspace.updateScenarioSource({ scenarioId: input.id, source: after, designId: target.designId, assistantTurnId: turnIds.get(conversationId) });
			else if (kind === "edge-function") state = await workspace.updateEdgeFunctionSource({ edgeFunctionId: input.id, source: after, designId: target.designId, assistantTurnId: turnIds.get(conversationId) });
			else {
				const design = boundState.design;
				if (!design) throw new Error("Open a project before writing a Function body.");
				const functions = (design.functions ?? []).map((fn) => fn.id === input.id ? { ...fn, body: after } : fn);
				state = await workspace.applyAssistantDesign(
					{ ...design, functions },
					target.designId,
					turnIds.get(conversationId),
				);
			}
			assertTargetState(state, target, "The project or Design changed before the code write completed.");
			if (tracker) {
				if (kind === "scenario" && beforeScenario) {
					const afterScenario = state.scenarios.find((s) => s.id === input.id);
					if (afterScenario) tracker.recordScenarioModified(beforeScenario, afterScenario);
				} else if (kind === "edge-function" && beforeEdge) {
					const afterEdge = state.edgeFunctions.find((e) => e.id === input.id);
					if (afterEdge) tracker.recordEdgeFunctionModified(beforeEdge, afterEdge);
				}
			}
			if (readState) {
				if (kind === "scenario") readState.scenarios = structuredClone(state.scenarios);
				else if (kind === "edge-function") readState.edgeFunctions = structuredClone(state.edgeFunctions);
				else if (state.design) {
					readState.design = structuredClone(state.design);
					readState.revision = state.revision;
				}
			}
			const appliedSource = kind === "scenario"
				? state.scenarios.find(({ id }) => id === input.id)?.source
				: kind === "edge-function"
					? state.edgeFunctions.find(({ id }) => id === input.id)?.source
					: state.design?.functions?.find(({ id }) => id === input.id)?.body;
			if (appliedSource !== after) throw new Error("The code write was not saved to the bound project and Design.");
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
				projectId: target.projectId,
				designId: target.designId,
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
			const connections = store.listProviderConnections();
			let effectiveConnectionId = selection.connectionId;
			let effectiveModel = selection.model;
			const effectiveThinking = (selection.thinking || "medium") as ThinkingLevel;

			if (connections.length > 0) {
				const currentConn = effectiveConnectionId ? connections.find((c) => c.id === effectiveConnectionId) : undefined;
				const currentUsable = currentConn ? getUsableModelsForConnection(currentConn) : [];
				const isCurrentUsable = Boolean(effectiveModel && currentUsable.some((m) => m.id === effectiveModel));

				if (!isCurrentUsable) {
					let fallbackConn: AssistantProviderConnection | undefined = currentConn;
					let fallbackModel = currentUsable[0];

					if (!fallbackModel) {
						for (const conn of connections) {
							const usable = getUsableModelsForConnection(conn);
							if (usable[0]) {
								fallbackConn = conn;
								fallbackModel = usable[0];
								break;
							}
						}
					}

					if (fallbackConn && fallbackModel) {
						effectiveConnectionId = fallbackConn.id;
						effectiveModel = fallbackModel.id;
						store.updateDefaultSelection(effectiveConnectionId, effectiveModel, effectiveThinking);
					}
				}
			}

			return store.createConversation(projectId, {
				role: "system",
				kind: "assistant-context",
				payload: { text: "Conversation initialized." },
			}, { connectionId: effectiveConnectionId, model: effectiveModel, thinking: effectiveThinking });
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
			const existing = store.listProviderConnections().find((c) => c.provider_id === providerId && c.auth_method === "oauth");
			const hadCredential = existing ? Boolean(await createConnectionScopedStore(credentials, existing.id, existing.provider_id).read(existing.provider_id)) : false;
			const conn = store.saveProviderConnection(providerId, "oauth");
			const connModels = getOrInitConnectionModels(conn);
			oAuthLogins.get(providerId)?.abort();
			const loginAbort = new AbortController();
			oAuthLogins.set(providerId, loginAbort);
			try {
				await connModels.login(providerId, "oauth", {
					signal: loginAbort.signal,
					prompt: async (prompt) => {
						if (prompt.type === "select" && prompt.options[0]) {
							return prompt.options[0].id;
						}
						const promptId = crypto.randomUUID();
						const signal = prompt.signal;
						return await new Promise<string>((resolve, reject) => {
							if (signal?.aborted) return reject(new Error("Prompt cancelled"));
							pendingOAuthPrompts.set(promptId, { providerId, resolve, reject });
							signal?.addEventListener("abort", () => {
								closeOAuthPrompt(promptId)?.reject(new Error("Prompt cancelled"));
							}, { once: true });
							publishOAuthEvent(providerId, {
								type: "prompt",
								promptId,
								promptType: prompt.type,
								message: prompt.message,
								placeholder: "placeholder" in prompt ? prompt.placeholder : undefined,
							});
						});
					},
					notify: (event) => {
						if (event.type === "auth_url") {
							if (openExternal) {
								void openExternal(event.url);
							}
						}
						publishOAuthEvent(providerId, event);
					},
				}, { getDeviceId: () => store.getOrCreateDeviceId(), agentName: "Schema Designer" });
				finishOAuthLogin(providerId, loginAbort, { type: "login_finished", success: true });
				return { success: true, connection: conn };
			} catch (error) {
				// A failed first sign-in must not leave a connection without a credential behind.
				if (!hadCredential) {
					await createConnectionScopedStore(credentials, conn.id, conn.provider_id).delete(conn.provider_id).catch(() => undefined);
					connectionModelsMap.delete(conn.id);
					store.removeProviderConnection(conn.id);
				}
				const message = error instanceof Error ? error.message : String(error);
				finishOAuthLogin(providerId, loginAbort, { type: "login_finished", success: false, error: message });
				return { success: false, error: message };
			}
		},
		answerOAuthPrompt(promptId, value) {
			const pending = closeOAuthPrompt(promptId);
			if (!pending) return false;
			pending.resolve(value);
			return true;
		},
		cancelOAuthLogin(providerId) {
			oAuthLogins.get(providerId)?.abort();
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
				const connName = getProviderDisplayName(conn.provider_id, conn.auth_method);
				const usable = getUsableModelsForConnection(conn);
				const selection = store.getDefaultSelection();
				for (const m of usable) {
					result.push({
						isDefault: selection.connectionId === conn.id && selection.model === m.id,
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
			let connectionId: string | null;
			let model: string;
			let thinking: ThinkingLevel;
			if (maybeThinking !== undefined) {
				connectionId = connectionIdOrModel;
				model = modelOrThinking;
				thinking = maybeThinking;
			} else if (connectionIdOrModel && store.getConnection(connectionIdOrModel)) {
				connectionId = connectionIdOrModel;
				model = modelOrThinking;
				thinking = "medium";
			} else {
				connectionId = null;
				model = connectionIdOrModel ?? "";
				thinking = (modelOrThinking || "medium") as ThinkingLevel;
			}
			store.updateConversationSelection(conversationId, connectionId, model, thinking);
			store.updateDefaultSelection(connectionId, model, thinking);
		},
		subscribe(subscriber: (conversationId: string, event: unknown) => void) {
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		isTurnPaused: (conversationId: string) => pausedTurns.has(conversationId) || pendingConfirmations.has(conversationId),
		getMaxRequestsPerTurn: () => maxRequestsPerTurn ?? store.getMaxRequestsPerTurn(),
		setMaxRequestsPerTurn(limit) {
			store.setMaxRequestsPerTurn(limit);
		},
		isConfirmationPending: (conversationId: string) => pendingConfirmations.has(conversationId),
		isTurnRunning: (conversationId: string) => runningTurns.has(conversationId),
		canRevertTurn(conversationId) {
			const checkpoint = turnCheckpoints.get(conversationId);
			if (!checkpoint?.after || latestTurnByProject.get(checkpoint.projectId) !== conversationId) return false;
			const state = workspace.getState();
			if (state.project?.id !== checkpoint.projectId || !state.design) return false;
			const tracker = turnTrackers.get(checkpoint.turnId);
			if (!tracker || !tracker.hasChanges()) return false;
			return true;
		},
		async revertTurn(conversationId) {
			const checkpoint = turnCheckpoints.get(conversationId);
			if (!checkpoint?.after || latestTurnByProject.get(checkpoint.projectId) !== conversationId) throw new Error("This Assistant turn is no longer available to revert.");
			const tracker = turnTrackers.get(checkpoint.turnId);
			if (!tracker || !tracker.hasChanges()) throw new Error("This Assistant turn has no changes to revert.");
			assertTargetState(workspace.getState(), { projectId: checkpoint.projectId, designId: checkpoint.designId }, "Open the design this Assistant turn changed to revert it.");
			await workspace.restoreAssistantProjectSnapshot({
				projectId: checkpoint.projectId,
				designId: checkpoint.designId,
				validateAndRestore: (current) => tracker.computeRestoration(current),
			});
			turnCheckpoints.delete(conversationId);
			turnTrackers.delete(checkpoint.turnId);
			latestTurnByProject.delete(checkpoint.projectId);
			return store.loadConversation(conversationId);
		},
		async continueTurn(conversationId: string, options?: { waitForCompletion?: boolean }): Promise<any> {
			const waitForCompletion = options?.waitForCompletion ?? true;
			const agent = active.get(conversationId);
			if (!agent || pendingConfirmations.has(conversationId) || !pausedTurns.delete(conversationId)) throw new Error("This Assistant turn is not waiting to continue.");
			requestsThisTurn.set(conversationId, 0);
			const message = { role: "user" as const, content: "Continue the interrupted Assistant task.", timestamp: Date.now() };
			store.appendMessage(conversationId, { role: "user", kind: "assistant-continue", payload: message });
			agent.steer(message);
			runningTurns.add(conversationId);
			const run = agent.continue();
			if (!waitForCompletion) {
				run.catch((err) => {
					runningTurns.delete(conversationId);
					publish(conversationId, { type: "assistant_error", error: err instanceof Error ? err.message : String(err) });
					publish(conversationId, { type: "agent_end" });
					publish(conversationId, { type: "assistant_turn_ended" });
				});
				return { started: true };
			}
			await run;
			return store.loadConversation(conversationId);
		},
		stop(conversationId: string) {
			runningTurns.delete(conversationId);
			active.get(conversationId)?.abort();
		},
		async confirmDdlDrop(conversationId: string, toolCallId: string, options?: { waitForCompletion?: boolean }): Promise<any> {
			const waitForCompletion = options?.waitForCompletion ?? true;
			const agent = active.get(conversationId);
			if (!agent) throw new Error("The Assistant turn for this confirmation is no longer active.");
			const { conversation, state: invocationState } = requireBoundState(conversationId);
			if (confirmingDrops.has(toolCallId)) throw new Error("This DDL confirmation is already being processed.");
			if (conversation.messages.some((message) => {
				if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") return false;
				return "toolCallId" in message.payload && message.payload.toolCallId === toolCallId
					&& "status" in message.payload && (message.payload.status === "consumed" || message.payload.status === "rejected");
			})) throw new Error("This DDL confirmation has already been used.");
			if (!pendingConfirmations.has(conversationId)) throw new Error("This DDL confirmation is no longer available.");
			const target = pendingDdlTargets.get(conversationId);
			if (!target) throw new Error("The target Design for this DDL confirmation is no longer available.");
			assertTargetState(invocationState, target, "The project or Design changed before DDL confirmation.");
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
				designId?: string;
				revision: number;
				removal: unknown;
				targets: { targetId: string }[];
			};
			if (!originalDetails || typeof originalDetails !== "object" || !("statement" in originalDetails) || typeof savedPlan.statement !== "string"
				|| !Array.isArray(savedPlan.targets) || savedPlan.targets.some((item) => !item || typeof item.targetId !== "string")
				|| savedPlan.projectId !== conversation.project_id || savedPlan.designId !== target.designId) {
				throw new Error("The saved DDL confirmation is malformed or belongs to another project or Design.");
			}
			const statement = savedPlan.statement;
			confirmingDrops.add(toolCallId);
			try {
				const plan = await applyAssistantDdl(workspace, statement, {
					expectedProjectId: target.projectId,
					expectedDesignId: target.designId,
					idFactory: deterministicDdlIdFactory(toolCallId),
					planOnly: true,
				});
				assertTargetState(workspace.getState(), target, "The project or Design changed while refreshing the DDL confirmation.");
				if (plan.status !== "confirmation-required") throw new Error("Could not refresh the destructive DDL plan.");
				if (plan.projectId !== target.projectId || plan.designId !== target.designId) {
					throw new Error("The refreshed DDL plan belongs to another project or Design.");
				}
				if (plan.projectId !== savedPlan.projectId || plan.revision !== savedPlan.revision
					|| JSON.stringify(plan.removal) !== JSON.stringify(savedPlan.removal)
					|| JSON.stringify(plan.targets) !== JSON.stringify(savedPlan.targets)) {
					store.appendMessage(conversationId, {
						role: "system",
						kind: "assistant-drop-confirmation",
						payload: {
							toolCallId,
							status: "updated",
							details: { ...plan, projectId: target.projectId, designId: target.designId },
							note: "The plan changed. Review the updated plan before confirming.",
						},
					});
					publish(conversationId, { type: "assistant_confirmation_plan_updated" });
					return store.loadConversation(conversationId);
				}
				assertTargetState(workspace.getState(), target, "The project or Design changed while refreshing the DDL confirmation.");
				const before = workspace.getState().design;
				const beforeById = new Map((before?.tables ?? []).map((table) => [table.id, table]));
				const turnId = turnIds.get(conversationId) ?? `confirmed:${toolCallId}`;
				turnIds.set(conversationId, turnId);
				if (!turnTrackers.has(turnId)) {
					turnTrackers.set(turnId, new TurnTracker(turnId, conversation.project_id));
				}
				const result = await applyAssistantDdl(workspace, statement, {
					assistantTurnId: turnId,
					confirmedDrops: true,
					expectedProjectId: target.projectId,
					expectedDesignId: target.designId,
					idFactory: deterministicDdlIdFactory(toolCallId),
					confirmation: {
						projectId: savedPlan.projectId,
						designId: target.designId,
						revision: savedPlan.revision,
						targetIds: savedPlan.targets.map(({ targetId }) => targetId),
					},
				});
				if (result.status !== "applied") throw new Error("The DDL change still requires confirmation.");
				assertTargetState(result.state, target, "The project or Design changed before the confirmed DDL change completed.");
				const after = result.state;
				const readState = conversationReadStates.get(conversationId);
				if (readState && after.design) {
					readState.design = structuredClone(after.design);
					readState.revision = after.revision;
				}
				const affectedTables: Array<{
					id: string;
					name: string;
					change: "added" | "changed" | "removed";
				}> = (after.design?.tables ?? [])
					.filter((table) => JSON.stringify(beforeById.get(table.id)) !== JSON.stringify(table))
					.map(({ id, name }) => ({
						id,
						name,
						change: !beforeById.has(id) ? "added" : "changed",
					}));
				const afterIds = new Set((after.design?.tables ?? []).map(({ id }) => id));
				for (const table of before?.tables ?? []) {
					if (!afterIds.has(table.id)) {
						affectedTables.push({
							id: table.id,
							name: table.name,
							change: "removed",
						});
					}
				}

				const modelAffectedTables = affectedTables.map(({ name, change }) => ({
					name,
					change,
				}));

				const appliedStatements = result.statements && result.statements.length > 0
					? result.statements
					: [statement.trim()];

				const modelResult = {
					status: "applied" as const,
					projectId: target.projectId,
					designId: target.designId,
					statements: appliedStatements,
					affectedTables: modelAffectedTables,
					revision: after.revision,
					sql: compactSqlStatus(after.sql),
					sandbox: compactSandboxStatus(after.sandbox),
				};

				const details = {
					status: "applied" as const,
					projectId: target.projectId,
					designId: target.designId,
					statements: appliedStatements,
					affectedTables,
					revision: after.revision,
					sql: compactSqlStatus(after.sql),
					sandbox: compactSandboxStatus(after.sandbox),
				};


				store.appendMessage(conversationId, {
					role: "system",
					kind: "assistant-drop-confirmation",
					payload: { toolCallId, status: "consumed" },
				});
				const toolResult = {
					role: "toolResult" as const,
					toolCallId,
					content: [{ type: "text" as const, text: JSON.stringify(modelResult) }],
					details,
				};
				const rowId = store.appendMessage(conversationId, { role: "toolResult", kind: "tool-result", payload: toolResult });
				(toolResult as { id?: string }).id = rowId;
				pendingConfirmations.delete(conversationId);
				pendingDdlTargets.delete(conversationId);
				publish(conversationId, { type: "assistant_confirmation_resolved" });
				store.observeProjectSnapshot(conversationId, projectSnapshot(result.state), result.state.revision);
				lastConfirmedDrops.set(conversationId, {
					turnId,
					statement,
					statements: appliedStatements,
					affectedTables: modelAffectedTables,
					projectId: target.projectId,
					designId: target.designId,
				});
				pausedTurns.delete(conversationId);
				agent.state.messages.push(toolResult as never);
				runningTurns.add(conversationId);
				const run = agent.prompt("Continue after the confirmed destructive change.");
				if (!waitForCompletion) {
					run.catch((err) => {
						runningTurns.delete(conversationId);
						publish(conversationId, { type: "assistant_error", error: err instanceof Error ? err.message : String(err) });
						publish(conversationId, { type: "agent_end" });
						publish(conversationId, { type: "assistant_turn_ended" });
					}).finally(() => {
						confirmingDrops.delete(toolCallId);
					});
					return { started: true };
				}
				await run;
				return store.loadConversation(conversationId);
			} finally {
				if (waitForCompletion) {
					confirmingDrops.delete(toolCallId);
				}
			}
		},
		async rejectDdlDrop(conversationId: string, toolCallId: string, options?: { waitForCompletion?: boolean }): Promise<any> {
			const waitForCompletion = options?.waitForCompletion ?? true;
			const { conversation, state } = requireBoundState(conversationId);
			const target = pendingDdlTargets.get(conversationId);
			if (!target) throw new Error("The target Design for this DDL confirmation is no longer available.");
			assertTargetState(state, target, "The project or Design changed before DDL confirmation.");
			if (!pendingConfirmations.has(conversationId)) throw new Error("This DDL confirmation is no longer available.");
			if (conversation.messages.some((message) => {
				if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") return false;
				return "toolCallId" in message.payload && message.payload.toolCallId === toolCallId
					&& "status" in message.payload && (message.payload.status === "consumed" || message.payload.status === "rejected");
			})) throw new Error("This DDL confirmation has already been used.");
			const pendingPlan = [...conversation.messages].reverse().find((message) => {
				const payload = message.payload;
				if (message.role !== "toolResult" || !payload || typeof payload !== "object" || !("toolCallId" in payload) || !("details" in payload)) return false;
				const details = payload.details;
				return payload.toolCallId === toolCallId && details !== null && typeof details === "object"
					&& "status" in details && details.status === "confirmation-required";
			});
			if (!pendingPlan) throw new Error("This DDL confirmation is no longer available.");
			const rejectedRemoval = (pendingPlan.payload as { details: { removal?: unknown } }).details.removal;
			const turnId = turnIds.get(conversationId);
			const rejected = rejectedDrops.get(conversationId);
			if (!rejected || rejected.turnId !== turnId) rejectedDrops.set(conversationId, { turnId, plans: new Set([JSON.stringify(rejectedRemoval)]) });
			else rejected.plans.add(JSON.stringify(rejectedRemoval));
			store.appendMessage(conversationId, {
				role: "system",
				kind: "assistant-drop-confirmation",
				payload: { toolCallId, status: "rejected" },
			});
			const toolResult = {
				role: "toolResult" as const,
				toolCallId,
				content: [{ type: "text" as const, text: "Not applied: the designer rejected this destructive change. Do not retry it or an equivalent change; explain and ask what they want instead." }],
			};
			const rowId = store.appendMessage(conversationId, { role: "toolResult", kind: "tool-result", payload: toolResult });
			(toolResult as { id?: string }).id = rowId;
			pendingConfirmations.delete(conversationId);
			pendingDdlTargets.delete(conversationId);
			publish(conversationId, { type: "assistant_confirmation_resolved" });
				const agent = active.get(conversationId);
				if (agent) {
					agent.state.messages.push(toolResult as never);
					runningTurns.add(conversationId);
					const run = agent.prompt("Continue after the rejected destructive change.");
					if (!waitForCompletion) {
						run.catch((err) => {
							runningTurns.delete(conversationId);
							publish(conversationId, { type: "assistant_error", error: err instanceof Error ? err.message : String(err) });
							publish(conversationId, { type: "agent_end" });
							publish(conversationId, { type: "assistant_turn_ended" });
						});
						return { started: true };
					}
					await run;
				} else if (!waitForCompletion) {
					publish(conversationId, { type: "assistant_turn_ended" });
					return { started: true };
				}
				return store.loadConversation(conversationId);
		},
		async sendMessage(conversationId: string, text: string, modelId: string, thinkingLevel: ThinkingLevel = "medium", connectionId?: string, options?: { waitForCompletion?: boolean }): Promise<any> {
			const waitForCompletion = options?.waitForCompletion ?? true;
			await ensureLegacyCredentialsMigrated();
			const conversation = currentBoundState(conversationId).conversation;
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
				if (!isModelUsableWithConnection(targetConn, model)) {
					throw new Error(`Model ${modelId} is not usable with ${getProviderDisplayName(targetConn.provider_id, targetConn.auth_method)}.`);
				}
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
			const startBound = currentBoundState(conversationId);
			const startTarget = startBound.target;
			const currentState = startBound.state;
			let changeNote: { role: "user"; content: string; timestamp: number } | undefined;
			const currentSnapshot = projectSnapshot(currentState);
			const previousSnapshot = store.observeProjectSnapshot(conversationId, currentSnapshot, currentState.revision);
			if (previousSnapshot !== null && previousSnapshot.snapshot !== currentSnapshot) {
				const previous = JSON.parse(previousSnapshot.snapshot) as { design?: unknown; scenarios?: unknown; edgeFunctions?: unknown; systemDesign?: unknown; walkthroughs?: unknown };
				const changed = [
					...(JSON.stringify(previous.systemDesign) !== JSON.stringify(systemReadContent(currentState.systemDesign) ?? null) ? ["System design"] : []),
					...(JSON.stringify(previous.design) !== JSON.stringify(currentState.design) ? ["schema design"] : []),
					...(JSON.stringify(previous.scenarios) !== JSON.stringify(currentState.scenarios) ? ["scenarios"] : []),
					...(JSON.stringify(previous.edgeFunctions) !== JSON.stringify(currentState.edgeFunctions) ? ["Edge functions"] : []),
					...(JSON.stringify((previous as { walkthroughs?: unknown }).walkthroughs ?? []) !== JSON.stringify(currentState.walkthroughs ?? []) ? ["Walkthroughs"] : []),
				];
				changeNote = {
					role: "user",
					content: `Project changed since revision ${previousSnapshot.revision} (${changed.join(", ")}). These latest saved definitions are authoritative. Re-read the project before acting.`,
					timestamp: Date.now(),
				};
				const rowId = store.appendMessage(conversationId, { role: "user", kind: "assistant-change-note", payload: changeNote });
				(changeNote as { id?: string }).id = rowId;
			}
			const userMessage = { role: "user" as const, content: text, timestamp: Date.now() };
			if (!conversation.messages.some((message) => message.role === "user")) {
				store.renameConversation(conversationId, text.replace(/\s+/g, " ").trim().slice(0, 80) || "New conversation");
			}
			const userRowId = store.appendMessage(conversationId, { role: "user", payload: userMessage });
			(userMessage as { id?: string }).id = userRowId;
			lastConfirmedDrops.delete(conversationId);
			const checkpointBefore = {
				design: structuredClone(currentState.design),
				scenarios: structuredClone(currentState.scenarios),
				edgeFunctions: structuredClone(currentState.edgeFunctions),
			};
			let agent = active.get(conversationId);
			if (agent?.state.isStreaming) {
				if (changeNote) agent.steer(changeNote);
				agent.steer(userMessage);
				return waitForCompletion ? store.loadConversation(conversationId) : { started: true };
			}
			const hadAgent = Boolean(agent);
			if (!agent) {
				const transcript = (store.loadConversation(conversationId)?.messages ?? [])
					.slice(0, -1)
					.map((message) => {
						const payload = message.payload && typeof message.payload === "object" ? message.payload as Record<string, unknown> : {};
						return { ...payload, id: message.id, role: message.role };
					})
					.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
				const instance = new Agent({
					initialState: {
						systemPrompt: SYSTEM_PROMPT,
						model,
						thinkingLevel,
						tools: buildTools(conversationId),
						messages: transcript as never[],
					},
					transformContext: async (messages) => {
						return getModelContext(conversationId, messages);
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
				agent = instance;
				instance.finishTurn = async ({ message }) => {
					if (message.stopReason === "error" || message.stopReason === "aborted") return;
					if (pendingConfirmations.has(conversationId)) return { action: "end" };
					const requests = (requestsThisTurn.get(conversationId) ?? 0) + 1;
					requestsThisTurn.set(conversationId, requests);
					if (requests < requestLimit()) return;
					pausedTurns.add(conversationId);
					publish(conversationId, { type: "assistant_turn_paused", requestCount: requests });
					return { action: "end" };
				};
				instance.subscribe(async (event) => {
					const isApiKey = isConversationApiKeyConnection(conversationId);
					if (event.type === "message_end" && event.message.role !== "user") {
						const msg = event.message;
						if (!isApiKey && typeof msg === "object" && msg !== null && "usage" in msg) {
							const usageObj = (msg as { usage?: unknown }).usage;
							if (usageObj && typeof usageObj === "object" && "cost" in usageObj) {
								delete (usageObj as { cost?: unknown }).cost;
							}
						}
						const rowId = store.appendMessage(conversationId, { role: event.message.role, payload: event.message });
						(event.message as { id?: string }).id = rowId;
					}

					if (event.type === "message_end" && event.message.role === "assistant") {
						const assistantMsg = event.message as { usage?: Usage };
						if (assistantMsg.usage) {
							const u = assistantMsg.usage;
							const current = turnUsages.get(conversationId) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: null };
							current.inputTokens += u.input || 0;
							current.outputTokens += u.output || 0;
							current.cacheReadTokens += u.cacheRead || 0;

							const msgCost = computeUsageCost(instance.state.model, u, isApiKey);
							if (msgCost !== null) {
								current.cost = (current.cost ?? 0) + msgCost;
							} else {
								current.cost = null;
							}
							turnUsages.set(conversationId, current);

							const promptTokens = (u.cacheRead && u.cacheRead > 0) ? (u.input + u.cacheRead) : u.input;
							lastPromptTokens.set(conversationId, promptTokens);
						}
					}
					if (event.type === "agent_end") {
						runningTurns.delete(conversationId);
						const turnId = turnIds.get(conversationId);
						if (!pausedTurns.has(conversationId) && !pendingConfirmations.has(conversationId)) {
							const promptTokens = lastPromptTokens.get(conversationId) ?? 0;
							const contextWindow = instance.state.model.contextWindow;
							if (contextWindow > 0 && promptTokens >= contextWindow * 0.8) {
								await performCompaction(conversationId, instance);
							}
							lastPromptTokens.delete(conversationId);

							const usage = turnUsages.get(conversationId);
							if (turnId && usage) {
								if (!isApiKey) {
									usage.cost = null;
								}
								store.saveTurnUsage(conversationId, turnId, usage);
								publish(conversationId, {
									type: "assistant_turn_usage",
									turnId,
									usage,
								});
								turnUsages.delete(conversationId);
							}
							activeTurnIsApiKey.delete(conversationId);
							turnIds.delete(conversationId);
							const completedState = workspace.getState();
							const checkpoint = turnCheckpoints.get(conversationId);
							if (checkpoint && completedState.project?.id === checkpoint.projectId && completedState.design) {
								checkpoint.after = {
									design: structuredClone(completedState.design),
									scenarios: structuredClone(completedState.scenarios),
									edgeFunctions: structuredClone(completedState.edgeFunctions),
								};
								latestTurnByProject.set(checkpoint.projectId, conversationId);
							}
						}
						publish(conversationId, event);
						publish(conversationId, { type: "assistant_turn_ended" });
						return;
					}
					publish(conversationId, event);
				});
				active.set(conversationId, agent);
			}
			if (hadAgent) {
				if (changeNote) agent.state.messages.push(changeNote);
				(agent as unknown as { streamFunction: unknown }).streamFunction = streamFn ?? activeModels.streamSimple.bind(activeModels);
				(agent as unknown as { getApiKey: unknown }).getApiKey = async (provider: string) => {
					if (getApiKey) return getApiKey();
					const resolved = await activeModels.getAuth(provider);
					return resolved?.auth.apiKey;
				};
			}
			const turnIsApiKey = targetConn ? targetConn.auth_method === "api-key" : Boolean(getApiKey);
			activeTurnIsApiKey.set(conversationId, turnIsApiKey);
			agent.state.model = model;
			agent.state.thinkingLevel = thinkingLevel;
			requestsThisTurn.set(conversationId, 0);
			pausedTurns.delete(conversationId);
			turnUsages.set(conversationId, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: null });
			const turnId = crypto.randomUUID();
			turnIds.set(conversationId, turnId);
			turnTargets.set(conversationId, startTarget);
			turnTrackers.set(turnId, new TurnTracker(turnId, conversation.project_id));
			turnCheckpoints.set(conversationId, {
				turnId,
				projectId: conversation.project_id,
				designId: startTarget.designId,
				before: checkpointBefore,
			});
			if (!conversationReadStates.has(conversationId)) {
				conversationReadStates.set(conversationId, {
					revision: currentState.revision,
					design: structuredClone(currentState.design),
					scenarios: structuredClone(currentState.scenarios),
					edgeFunctions: structuredClone(currentState.edgeFunctions),
				});
			}
			runningTurns.add(conversationId);
			const run = agent.prompt([{ ...userMessage, content: [{ type: "text", text }] }]);
			if (!waitForCompletion) {
				run.catch((err) => {
					runningTurns.delete(conversationId);
					publish(conversationId, { type: "assistant_error", error: err instanceof Error ? err.message : String(err) });
					publish(conversationId, { type: "agent_end" });
					publish(conversationId, { type: "assistant_turn_ended" });
				});
				return { started: true };
			}
			await run;
			return store.loadConversation(conversationId);
		},
		close() {
			runningTurns.clear();
			for (const agent of active.values()) agent.abort();
			active.clear();
			store.close();
		},
	};
}

