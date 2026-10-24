import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AssistantConversation, AssistantConversationRecord, AssistantMessage, AssistantProviderConnection, AssistantTotalUsage, AssistantTurnUsage } from "../shared/assistant";
export type AssistantConversationOptions = { id?: string; connectionId?: string | null; provider?: string | null; model?: string | null; thinking?: string | null; title?: string };

export interface AssistantStore {
	listConversations(projectId: string): AssistantConversation[];
	getLatestConversation(projectId: string): AssistantConversation | null;
	loadConversation(id: string): AssistantConversationRecord | null;
	createConversation(projectId: string, firstMessage: AssistantMessage, options?: AssistantConversationOptions): AssistantConversation;
	renameConversation(id: string, title: string): boolean;
	deleteConversation(id: string): boolean;
	updateConversationSelection(id: string, connectionIdOrModel: string | null, modelOrThinking: string, maybeThinking?: string): boolean;
	getDefaultSelection(): { connectionId: string | null; model: string | null; thinking: string | null };
	updateDefaultSelection(connectionIdOrModel: string | null, modelOrThinking: string, maybeThinking?: string): void;
	getClaudeOptIn(): boolean;
	setClaudeOptIn(optIn: boolean): void;
	/** Stable id of this app installation, created on first use; sent to OpenAI as its agent host id. */
	getOrCreateDeviceId(): string;
	observeProjectRevision(conversationId: string, revision: number): number | null;
	observeProjectSnapshot(conversationId: string, snapshot: string, revision: number): { snapshot: string; revision: number } | null;
	appendMessage(conversationId: string, message: AssistantMessage): string;
	listProviderConnections(): AssistantProviderConnection[];
	getConnection(id: string): AssistantProviderConnection | null;
	findConnection(providerId: string, authMethod: string): AssistantProviderConnection | null;
	saveProviderConnection(providerId: string, authMethodOrCred?: string, credentialName?: string): AssistantProviderConnection;
	removeProviderConnection(connectionId: string): void;
	saveTurnUsage(conversationId: string, turnId: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cost?: number | null }): void;
	getTurnUsages(conversationId: string): AssistantTurnUsage[];
	getConversationTotalUsage(conversationId: string): AssistantTotalUsage;
	getMaxRequestsPerTurn(): number;
	setMaxRequestsPerTurn(limit: number): void;
	saveCompaction(conversationId: string, summary: string, firstKeptMessageId: string): void;
	getCompaction(conversationId: string): { summary: string; firstKeptMessageId: string | null; createdAt: number } | null;
	close(): void;
}

const SCHEMA = `
	PRAGMA foreign_keys = ON;
	CREATE TABLE IF NOT EXISTS assistant_conversations (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		connection_id TEXT,
		provider TEXT,
		model TEXT,
		thinking TEXT
	);
	CREATE INDEX IF NOT EXISTS assistant_conversations_project_updated
		ON assistant_conversations(project_id, updated_at DESC);
	CREATE TABLE IF NOT EXISTS assistant_messages (
		conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
		sequence INTEGER NOT NULL,
		id TEXT,
		role TEXT NOT NULL,
		kind TEXT,
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (conversation_id, sequence)
	);
	CREATE TABLE IF NOT EXISTS assistant_provider_connections (
		id TEXT PRIMARY KEY,
		provider_id TEXT NOT NULL,
		auth_method TEXT NOT NULL,
		credential_name TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS assistant_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		connection_id TEXT,
		model TEXT,
		thinking TEXT,
		claude_opt_in INTEGER DEFAULT 0,
		max_requests_per_turn INTEGER NOT NULL DEFAULT 40,
		device_id TEXT
	);
	CREATE TABLE IF NOT EXISTS assistant_project_observations (
		conversation_id TEXT PRIMARY KEY REFERENCES assistant_conversations(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		snapshot TEXT
	);
	CREATE TABLE IF NOT EXISTS assistant_turn_usage (
		conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
		turn_id TEXT NOT NULL,
		input_tokens INTEGER NOT NULL,
		output_tokens INTEGER NOT NULL,
		cache_read_tokens INTEGER NOT NULL,
		cost REAL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (conversation_id, turn_id)
	);
	CREATE TABLE IF NOT EXISTS assistant_compactions (
		conversation_id TEXT PRIMARY KEY REFERENCES assistant_conversations(id) ON DELETE CASCADE,
		summary TEXT NOT NULL,
		first_kept_message_id TEXT NOT NULL,
		created_at INTEGER NOT NULL
	);
`;

function titleFromMessage(message: AssistantMessage): string {
	const payload = message.payload;
	let text = "";
	if (typeof payload === "string") text = payload;
	else if (payload && typeof payload === "object" && "content" in payload) {
		const content = (payload as { content?: unknown }).content;
		if (typeof content === "string") text = content;
	}
	const compact = text.replace(/\s+/g, " ").trim();
	return Array.from(compact).slice(0, 80).join("") || "New conversation";
}

export function openAssistantStore(databasePath: string): AssistantStore {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true });
	database.exec(SCHEMA);
	const observationColumns = database.query<{ name: string }, []>("PRAGMA table_info(assistant_project_observations)").all();
	if (!observationColumns.some(({ name }) => name === "snapshot")) {
		database.exec("ALTER TABLE assistant_project_observations ADD COLUMN snapshot TEXT");
	}
	const conversationColumns = database.query<{ name: string }, []>("PRAGMA table_info(assistant_conversations)").all();
	if (!conversationColumns.some(({ name }) => name === "connection_id")) {
		database.exec("ALTER TABLE assistant_conversations ADD COLUMN connection_id TEXT");
	}
	const connectionColumns = database.query<{ name: string }, []>("PRAGMA table_info(assistant_provider_connections)").all();
	if (!connectionColumns.some(({ name }) => name === "provider_id")) {
		database.exec("ALTER TABLE assistant_provider_connections ADD COLUMN provider_id TEXT");
		database.exec("UPDATE assistant_provider_connections SET provider_id = id WHERE provider_id IS NULL");
	}
	database.exec("CREATE UNIQUE INDEX IF NOT EXISTS assistant_provider_connections_provider_auth ON assistant_provider_connections(provider_id, auth_method)");

	// Migrate legacy row where id was 'anthropic' to unique UUID connection
	const legacyAnthropic = database.query<{ id: string; auth_method: string; credential_name: string; created_at: number; updated_at: number }, []>(
		"SELECT id, auth_method, credential_name, created_at, updated_at FROM assistant_provider_connections WHERE id = 'anthropic'",
	).get();
	if (legacyAnthropic) {
		const newId = crypto.randomUUID();
		database.run("DELETE FROM assistant_provider_connections WHERE id = 'anthropic'");
		database.run(
			"INSERT INTO assistant_provider_connections (id, provider_id, auth_method, credential_name, created_at, updated_at) VALUES (?, 'anthropic', ?, ?, ?, ?)",
			[newId, legacyAnthropic.auth_method, `connection-${newId}`, legacyAnthropic.created_at, legacyAnthropic.updated_at],
		);
		database.run("UPDATE assistant_conversations SET connection_id = ? WHERE connection_id IS NULL AND provider = 'anthropic'", [newId]);
	}

	const settingsColumns = database.query<{ name: string }, []>("PRAGMA table_info(assistant_settings)").all();
	if (!settingsColumns.some(({ name }) => name === "claude_opt_in")) {
		database.exec("ALTER TABLE assistant_settings ADD COLUMN claude_opt_in INTEGER DEFAULT 0");
	}
	if (!settingsColumns.some(({ name }) => name === "connection_id")) {
		database.exec("ALTER TABLE assistant_settings ADD COLUMN connection_id TEXT");
	}
	if (!settingsColumns.some(({ name }) => name === "max_requests_per_turn")) {
		database.exec("ALTER TABLE assistant_settings ADD COLUMN max_requests_per_turn INTEGER NOT NULL DEFAULT 40");
	}
	if (!settingsColumns.some(({ name }) => name === "device_id")) {
		database.exec("ALTER TABLE assistant_settings ADD COLUMN device_id TEXT");
	}
	const messageColumns = database.query<{ name: string }, []>("PRAGMA table_info(assistant_messages)").all();
	if (!messageColumns.some(({ name }) => name === "id")) {
		database.exec("ALTER TABLE assistant_messages ADD COLUMN id TEXT");
	}
	const compactionColumns = database.query<{ name: string }, []>("PRAGMA table_info(assistant_compactions)").all();
	if (compactionColumns.length > 0 && !compactionColumns.some(({ name }) => name === "first_kept_message_id")) {
		database.exec("ALTER TABLE assistant_compactions ADD COLUMN first_kept_message_id TEXT");
	}
	const list = database.query<AssistantConversation, [string]>(`SELECT id, project_id, title, created_at, updated_at, connection_id, provider, model, thinking FROM assistant_conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC`);
	const latest = database.query<AssistantConversation, [string]>(`SELECT id, project_id, title, created_at, updated_at, connection_id, provider, model, thinking FROM assistant_conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1`);
	const selectConversation = database.query<AssistantConversation, [string]>(`SELECT id, project_id, title, created_at, updated_at, connection_id, provider, model, thinking FROM assistant_conversations WHERE id = ?`);
	const insertConversation = database.query(`INSERT INTO assistant_conversations (id, project_id, title, created_at, updated_at, connection_id, provider, model, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	const insertMessage = database.query(`INSERT INTO assistant_messages (conversation_id, sequence, id, role, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
	const nextSequence = database.query<{ sequence: number }, [string]>(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM assistant_messages WHERE conversation_id = ?`);
	const touchConversation = database.query(`UPDATE assistant_conversations SET updated_at = ? WHERE id = ?`);
	const rename = database.query(`UPDATE assistant_conversations SET title = ?, updated_at = ? WHERE id = ?`);
	const remove = database.query(`DELETE FROM assistant_conversations WHERE id = ?`);
	const updateSelection = database.query(`UPDATE assistant_conversations SET connection_id = ?, model = ?, thinking = ?, updated_at = ? WHERE id = ?`);
	const messages = database.query<{ rowid: number; sequence: number; id: string | null; role: string; kind: string | null; payload: string; created_at: number }, [string]>(`SELECT rowid, sequence, id, role, kind, payload, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY sequence ASC`);
	const listProviderConnections = database.query<AssistantProviderConnection, []>(`SELECT id, provider_id, auth_method, credential_name, created_at, updated_at FROM assistant_provider_connections ORDER BY created_at ASC`);
	const selectConnection = database.query<AssistantProviderConnection, [string]>(`SELECT id, provider_id, auth_method, credential_name, created_at, updated_at FROM assistant_provider_connections WHERE id = ?`);
	const selectConnectionByProviderAuth = database.query<AssistantProviderConnection, [string, string]>(`SELECT id, provider_id, auth_method, credential_name, created_at, updated_at FROM assistant_provider_connections WHERE provider_id = ? AND auth_method = ?`);
	const removeProviderConnection = database.query(`DELETE FROM assistant_provider_connections WHERE id = ?`);
	const getSelection = database.query<{ connection_id: string | null; model: string | null; thinking: string | null }, []>(`SELECT connection_id, model, thinking FROM assistant_settings WHERE id = 1`);
	const saveSelection = database.query(`INSERT INTO assistant_settings (id, connection_id, model, thinking) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id, model = excluded.model, thinking = excluded.thinking`);
	const getClaudeOptInQuery = database.query<{ claude_opt_in: number | null }, []>(`SELECT claude_opt_in FROM assistant_settings WHERE id = 1`);
	const saveClaudeOptInQuery = database.query(`INSERT INTO assistant_settings (id, claude_opt_in) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET claude_opt_in = excluded.claude_opt_in`);
	const getDeviceIdQuery = database.query<{ device_id: string | null }, []>(`SELECT device_id FROM assistant_settings WHERE id = 1`);
	const saveDeviceIdQuery = database.query(`INSERT INTO assistant_settings (id, device_id) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET device_id = COALESCE(assistant_settings.device_id, excluded.device_id)`);
	const getMaxRequestsQuery = database.query<{ max_requests_per_turn: number }, []>(`SELECT max_requests_per_turn FROM assistant_settings WHERE id = 1`);
	const setMaxRequestsQuery = database.query(`INSERT INTO assistant_settings (id, max_requests_per_turn) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET max_requests_per_turn = excluded.max_requests_per_turn`);
	const getObservedRevision = database.query<{ revision: number }, [string]>(`SELECT revision FROM assistant_project_observations WHERE conversation_id = ?`);
	const saveObservedRevision = database.query(`INSERT INTO assistant_project_observations (conversation_id, revision) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision`);
	const readAndSaveRevision = database.transaction((conversationId: string, revision: number) => {
		const previous = getObservedRevision.get(conversationId)?.revision ?? null;
		saveObservedRevision.run(conversationId, revision);
		return previous;
	});
	const getObservedSnapshot = database.query<{ snapshot: string | null; revision: number }, [string]>(`SELECT snapshot, revision FROM assistant_project_observations WHERE conversation_id = ?`);
	const saveObservedSnapshot = database.query(`INSERT INTO assistant_project_observations (conversation_id, revision, snapshot) VALUES (?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision, snapshot = excluded.snapshot`);
	const readAndSaveSnapshot = database.transaction((conversationId: string, snapshot: string, revision: number) => {
		const previous = getObservedSnapshot.get(conversationId);
		saveObservedSnapshot.run(conversationId, revision, snapshot);
		return previous === null || previous === undefined || previous.snapshot === null
			? null
			: { snapshot: previous.snapshot, revision: previous.revision };
	});
	const insertTurnUsage = database.query(`INSERT INTO assistant_turn_usage (conversation_id, turn_id, input_tokens, output_tokens, cache_read_tokens, cost, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(conversation_id, turn_id) DO UPDATE SET input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, cost = excluded.cost`);
	const selectTurnUsages = database.query<{ turn_id: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost: number | null; created_at: number }, [string]>(`SELECT turn_id, input_tokens, output_tokens, cache_read_tokens, cost, created_at FROM assistant_turn_usage WHERE conversation_id = ? ORDER BY created_at ASC`);
	const selectTotalUsage = database.query<{ input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cost: number | null }, [string]>(`SELECT SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cache_read_tokens) AS cache_read_tokens, SUM(cost) AS cost FROM assistant_turn_usage WHERE conversation_id = ?`);
	const insertCompaction = database.query(`INSERT INTO assistant_compactions (conversation_id, summary, first_kept_message_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO UPDATE SET summary = excluded.summary, first_kept_message_id = excluded.first_kept_message_id, created_at = excluded.created_at`);
	const selectCompaction = database.query<{ summary: string; first_kept_message_id: string | null; created_at: number }, [string]>(`SELECT summary, first_kept_message_id, created_at FROM assistant_compactions WHERE conversation_id = ?`);
	const create = database.transaction((projectId: string, message: AssistantMessage, options: AssistantConversationOptions, now: number) => {
		const id = options.id ?? crypto.randomUUID();
		insertConversation.run(id, projectId, options.title ?? titleFromMessage(message), now, now, options.connectionId ?? null, options.provider ?? null, options.model ?? null, options.thinking ?? null);
		insertMessage.run(id, 1, message.id ?? null, message.role, message.kind ?? null, JSON.stringify(message.payload), message.created_at ?? now);
		return selectConversation.get(id)!;
	});
	const append = database.transaction((conversationId: string, message: AssistantMessage, now: number) => {
		const row = nextSequence.get(conversationId);
		if (!row) throw new Error(`Conversation not found: ${conversationId}`);
		const result = insertMessage.run(conversationId, row.sequence, message.id ?? null, message.role, message.kind ?? null, JSON.stringify(message.payload), message.created_at ?? now);
		touchConversation.run(now, conversationId);
		return String(result.lastInsertRowid);
	});
	return {
		listConversations: (projectId) => list.all(projectId),
		getLatestConversation: (projectId) => latest.get(projectId) ?? null,
		createConversation: (projectId, message, options = {}) => create.immediate(projectId, message, options, Date.now()),
		renameConversation: (id, title) => Number(rename.run(title, Date.now(), id).changes) > 0,
		deleteConversation: (id) => Number(remove.run(id).changes) > 0,
		updateConversationSelection(id, connectionIdOrModel, modelOrThinking, maybeThinking) {
			const connectionId = maybeThinking !== undefined ? connectionIdOrModel : null;
			const model = maybeThinking !== undefined ? modelOrThinking : (connectionIdOrModel ?? "");
			const thinking = maybeThinking !== undefined ? maybeThinking : modelOrThinking;
			return Number(updateSelection.run(connectionId, model, thinking, Date.now(), id).changes) > 0;
		},
		getDefaultSelection: () => {
			const row = getSelection.get();
			return { connectionId: row?.connection_id ?? null, model: row?.model ?? null, thinking: row?.thinking ?? null };
		},
		updateDefaultSelection: (connectionIdOrModel, modelOrThinking, maybeThinking) => {
			const connectionId = maybeThinking !== undefined ? connectionIdOrModel : null;
			const model = maybeThinking !== undefined ? modelOrThinking : (connectionIdOrModel ?? "");
			const thinking = maybeThinking !== undefined ? maybeThinking : modelOrThinking;
			saveSelection.run(connectionId, model, thinking);
		},
		getClaudeOptIn: () => (getClaudeOptInQuery.get()?.claude_opt_in ?? 0) === 1,
		setClaudeOptIn: (optIn) => { saveClaudeOptInQuery.run(optIn ? 1 : 0); },
		getOrCreateDeviceId() {
			const existing = getDeviceIdQuery.get()?.device_id;
			if (existing) return existing;
			saveDeviceIdQuery.run(crypto.randomUUID());
			return getDeviceIdQuery.get()!.device_id!;
		},
		getMaxRequestsPerTurn: () => getMaxRequestsQuery.get()?.max_requests_per_turn ?? 40,
		setMaxRequestsPerTurn(limit) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Request cap must be an integer between 1 and 500.");
			setMaxRequestsQuery.run(limit);
		},
		observeProjectRevision: (conversationId, revision) => readAndSaveRevision.immediate(conversationId, revision),
		observeProjectSnapshot: (conversationId, snapshot, revision) => readAndSaveSnapshot.immediate(conversationId, snapshot, revision),
		appendMessage: (conversationId, message) => append.immediate(conversationId, message, Date.now()),
		loadConversation: (id) => {
			const conversation = selectConversation.get(id);
			if (!conversation) return null;
			const turnUsages = selectTurnUsages.all(id).map((row) => ({
				turnId: row.turn_id,
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				cacheReadTokens: row.cache_read_tokens,
				cost: row.cost,
				createdAt: row.created_at,
			}));
			const totalRow = selectTotalUsage.get(id);
			return {
				...conversation,
				messages: messages.all(id).map((message) => {
					const parsedPayload = JSON.parse(message.payload);
					const rowId = String(message.rowid);
					if (parsedPayload && typeof parsedPayload === "object") {
						parsedPayload.id = rowId;
					}
					return {
						id: rowId,
						role: message.role,
						...(message.kind === null ? {} : { kind: message.kind }),
						payload: parsedPayload,
						created_at: message.created_at,
					};
				}),
				usages: turnUsages,
				totalUsage: {
					inputTokens: totalRow?.input_tokens ?? 0,
					outputTokens: totalRow?.output_tokens ?? 0,
					cacheReadTokens: totalRow?.cache_read_tokens ?? 0,
					cost: totalRow?.cost ?? null,
				},
			};
		},
		saveTurnUsage(conversationId, turnId, usage) {
			insertTurnUsage.run(conversationId, turnId, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cost ?? null, Date.now());
		},
		getTurnUsages(conversationId) {
			return selectTurnUsages.all(conversationId).map((row) => ({
				turnId: row.turn_id,
				inputTokens: row.input_tokens,
				outputTokens: row.output_tokens,
				cacheReadTokens: row.cache_read_tokens,
				cost: row.cost,
				createdAt: row.created_at,
			}));
		},
		getConversationTotalUsage(conversationId) {
			const row = selectTotalUsage.get(conversationId);
			return {
				inputTokens: row?.input_tokens ?? 0,
				outputTokens: row?.output_tokens ?? 0,
				cacheReadTokens: row?.cache_read_tokens ?? 0,
				cost: row?.cost ?? null,
			};
		},
		saveCompaction(conversationId, summary, firstKeptMessageId) {
			insertCompaction.run(conversationId, summary, firstKeptMessageId, Date.now());
		},
		getCompaction(conversationId) {
			const row = selectCompaction.get(conversationId);
			return row ? { summary: row.summary, firstKeptMessageId: row.first_kept_message_id, createdAt: row.created_at } : null;
		},
		listProviderConnections: () => listProviderConnections.all(),
		getConnection: (id) => selectConnection.get(id) ?? null,
		findConnection: (providerId, authMethod) => selectConnectionByProviderAuth.get(providerId, authMethod) ?? null,
		saveProviderConnection(providerId, authMethodOrCred = "api-key", credentialName) {
			const authMethod = (authMethodOrCred === "api-key" || authMethodOrCred === "oauth") ? authMethodOrCred : "api-key";
			const effectiveCredentialName = (authMethodOrCred === "api-key" || authMethodOrCred === "oauth")
				? credentialName
				: authMethodOrCred;
			const existing = selectConnectionByProviderAuth.get(providerId, authMethod);
			const now = Date.now();
			const id = existing?.id ?? crypto.randomUUID();
			const credName = effectiveCredentialName ?? `connection-${id}`;
			if (existing) {
				database.run("UPDATE assistant_provider_connections SET credential_name = ?, updated_at = ? WHERE id = ?", [credName, now, id]);
			} else {
				database.run("INSERT INTO assistant_provider_connections (id, provider_id, auth_method, credential_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [id, providerId, authMethod, credName, now, now]);
			}
			return selectConnection.get(id)!;
		},
		removeProviderConnection(connectionId) {
			removeProviderConnection.run(connectionId);
		},
		close: () => database.close(),
	};
}
