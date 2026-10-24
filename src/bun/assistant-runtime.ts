import { Agent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type, createModels, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { BunSecretCredentialStore } from "./assistant-credentials";
import { applyAssistantDdl } from "./assistant-ddl";
import type { AssistantStore } from "./assistant-store";
import { openAssistantStore } from "./assistant-store";
import { generateDesignSql } from "./sql";
import type { DesignWorkspace } from "./workspace";

const SYSTEM_PROMPT = `You are the Assistant for Schema Designer. The current project is the only project in scope; the Design is authoritative. Read the current project before making changes and use only its project tools. Apply schema changes only through the apply_ddl tool. The accepted DDL subset is CREATE/ALTER/DROP TABLE; ADD/RENAME/ALTER TYPE/DROP COLUMN; NOT NULL, UNIQUE, single-column PRIMARY KEY; structured defaults (typed literals, now(), gen_random_uuid(), identity); REFERENCES with referential actions; CREATE INDEX; CREATE TYPE AS ENUM; CREATE OR REPLACE FUNCTION; CREATE TRIGGER; CREATE POLICY; ENABLE ROW LEVEL SECURITY; COMMENT ON COLUMN. Composite primary keys, CHECK constraints, views and arbitrary defaults are unsupported and must be rejected, never approximated. A destructive drop with dependents requires user confirmation. Keep existing card positions and viewport unchanged. Sandbox Scenarios use the documented PostgREST subset: table reads/projections/embeds, supported filters/order/range/count, CRUD/upsert, row-level security and design Function RPC; Edge functions run in the restricted Deno.serve environment with the documented Supabase imports. Unsupported requests must be treated as errors, never approximated. Report tool errors without claiming changes that were not applied.`;


export type AssistantRuntimeOptions = {
	databasePath: string;
	workspace: DesignWorkspace;
	models?: MutableModels;
	getApiKey?: () => Promise<string | undefined>;
	streamFn?: ConstructorParameters<typeof Agent>[0]["streamFn"];
	maxRequestsPerTurn?: number;
};

/** Main-process Assistant entry point; credentials remain outside application SQLite. */
export function createAssistantRuntime({ databasePath, workspace, models: suppliedModels, streamFn, getApiKey, maxRequestsPerTurn = 40 }: AssistantRuntimeOptions) {
	const store: AssistantStore = openAssistantStore(databasePath);
	const credentials = new BunSecretCredentialStore(databasePath);
	const models = suppliedModels ?? createModels({ credentials });
	if (!suppliedModels) models.setProvider(anthropicProvider());
	const resolveApiKey = getApiKey ?? (async () => {
		const credential = await credentials.read("anthropic");
		return credential?.type === "api_key" ? credential.key : undefined;
	});
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
			store.observeProjectSnapshot(conversationId, projectSnapshot(state));
			return {
				content: [{ type: "text", text: JSON.stringify({
					project: state.project,
					revision: state.revision,
					design: state.design,
					generatedSql: generated.ok ? generated.sql : { errors: generated.errors },
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
			});
			if (result.status === "confirmation-required") {
				pendingConfirmations.add(conversationId);
				publish(conversationId, { type: "assistant_confirmation_required" });
			}
			let affectedTables: { id: string; name: string; removed?: boolean }[] = [];
			if (result.status === "applied") {
				const after = result.state;
				store.observeProjectSnapshot(conversationId, projectSnapshot(after));
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
			}, { model: selection.model, thinking: selection.thinking });
		},
		renameConversation: (conversationId: string, title: string) => store.renameConversation(conversationId, title),
		deleteConversation(conversationId: string) {
			active.get(conversationId)?.abort();
			active.delete(conversationId);
			return store.deleteConversation(conversationId);
		},
		async setAnthropicApiKey(apiKey: string) {
			const normalized = apiKey.trim();
			if (!normalized) throw new Error("Enter an Anthropic API key.");
			await credentials.modify("anthropic", async () => ({ type: "api_key", key: normalized }));
			store.saveProviderConnection("anthropic", "anthropic-api-key");
		},
		async removeAnthropicApiKey() {
			await credentials.delete("anthropic");
			store.removeProviderConnection("anthropic");
		},
		async getAnthropicConnectionStatus() {
			if (!store.listProviderConnections().some(({ id }) => id === "anthropic")) return { connected: false, error: null };
			try {
				const credential = await credentials.read("anthropic");
				return credential?.type === "api_key" && credential.key
					? { connected: true, error: null }
					: { connected: false, error: "Anthropic API key is missing from the operating-system credential store." };
			} catch (error) {
				return { connected: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
		listModels() {
			return models.getModels("anthropic").map(({ id, name, reasoning, contextWindow }) => ({ id, name, reasoning, contextWindow }));
		},
		updateConversationSelection(conversationId: string, model: string, thinking: ThinkingLevel) {
			store.updateConversationSelection(conversationId, model, thinking);
			store.updateDefaultSelection(model, thinking);
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
			const { conversation, state } = requireBoundState(conversationId);
			if (confirmingDrops.has(toolCallId)) throw new Error("This DDL confirmation is already being processed.");
			if (conversation.messages.some((message) => {
				if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") return false;
				return "toolCallId" in message.payload && message.payload.toolCallId === toolCallId;
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
			const payload = confirmation.payload;
			if (!payload || typeof payload !== "object" || !("details" in payload) || !("toolCallId" in payload)) throw new Error("The saved DDL confirmation is malformed.");
			const details = payload.details;
			const savedPlan = details as {
				statement: string;
				projectId: string;
				revision: number;
				removal: unknown;
				targets: { targetId: string }[];
			};
			if (!details || typeof details !== "object" || !("statement" in details) || typeof details.statement !== "string"
				|| !Array.isArray(savedPlan.targets) || savedPlan.targets.some((target) => !target || typeof target.targetId !== "string")
				|| savedPlan.projectId !== conversation.project_id || savedPlan.revision !== state.revision) {
			}
			const statement = savedPlan.statement;
			confirmingDrops.add(toolCallId);
			try {
				const plan = await applyAssistantDdl(workspace, statement, { expectedProjectId: conversation.project_id });
				if (plan.status !== "confirmation-required" || plan.projectId !== savedPlan.projectId || plan.revision !== savedPlan.revision
					|| JSON.stringify(plan.removal) !== JSON.stringify(savedPlan.removal)
					|| JSON.stringify(plan.targets) !== JSON.stringify(savedPlan.targets)) {
					throw new Error("The destructive DDL plan changed. Review the updated plan before confirming.");
				}
				const turnId = turnIds.get(conversationId) ?? `confirmed:${toolCallId}`;
				turnIds.set(conversationId, turnId);
				store.appendMessage(conversationId, {
					role: "system",
					kind: "assistant-drop-confirmation",
					payload: { toolCallId, status: "consumed" },
				});
				const result = await applyAssistantDdl(workspace, statement, {
					assistantTurnId: turnId,
					confirmedDrops: true,
					expectedProjectId: conversation.project_id,
					confirmation: {
						projectId: savedPlan.projectId,
						revision: savedPlan.revision,
						targetIds: savedPlan.targets.map(({ targetId }) => targetId),
					},
				});
				if (result.status !== "applied") throw new Error("The DDL change still requires confirmation.");
				pendingConfirmations.delete(conversationId);
				publish(conversationId, { type: "assistant_confirmation_resolved" });
				store.observeProjectSnapshot(conversationId, projectSnapshot(workspace.getState()));
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
		async sendMessage(conversationId: string, text: string, modelId: string, thinkingLevel: ThinkingLevel = "medium") {
			const conversation = requireBoundState(conversationId).conversation;
			if (pendingConfirmations.has(conversationId)) throw new Error("Confirm or reject the pending destructive DDL plan before sending another message.");
			const model = models.getModel("anthropic", modelId);
			if (!model) throw new Error(`Unknown Anthropic model: ${modelId}`);
			if (!(await resolveApiKey())) throw new Error("Configure an Anthropic API key before sending a message.");
			const currentState = requireBoundState(conversationId).state;
			let changeNote: { role: "user"; content: string; timestamp: number } | undefined;
			store.updateConversationSelection(conversationId, modelId, thinkingLevel);
			store.updateDefaultSelection(modelId, thinkingLevel);
			const currentSnapshot = projectSnapshot(currentState);
			const previousSnapshot = store.observeProjectSnapshot(conversationId, currentSnapshot);
			if (previousSnapshot !== null && previousSnapshot !== currentSnapshot) {
				const previous = JSON.parse(previousSnapshot) as { design?: unknown; scenarios?: unknown; edgeFunctions?: unknown };
				const changed = [
					...(JSON.stringify(previous.design) !== JSON.stringify(currentState.design) ? ["schema design"] : []),
					...(JSON.stringify(previous.scenarios) !== JSON.stringify(currentState.scenarios) ? ["scenarios"] : []),
					...(JSON.stringify(previous.edgeFunctions) !== JSON.stringify(currentState.edgeFunctions) ? ["Edge functions"] : []),
				];
				changeNote = {
					role: "user",
					content: `Project changed since your last snapshot (${changed.join(", ")}). These latest saved definitions are authoritative. Re-read the project before acting.`,
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
					streamFn: streamFn ?? models.streamSimple.bind(models),
					getApiKey: resolveApiKey,
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

