import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { AssistantConversation, AssistantConversationRecord, AssistantMessage, AssistantProviderConnection } from "../shared/assistant";
export type AssistantConversationOptions = { id?: string; provider?: string | null; model?: string | null; thinking?: string | null; title?: string };

export interface AssistantStore {
	listConversations(projectId: string): AssistantConversation[];
	getLatestConversation(projectId: string): AssistantConversation | null;
	loadConversation(id: string): AssistantConversationRecord | null;
	createConversation(projectId: string, firstMessage: AssistantMessage, options?: AssistantConversationOptions): AssistantConversation;
	renameConversation(id: string, title: string): boolean;
	deleteConversation(id: string): boolean;
	updateConversationSelection(id: string, model: string, thinking: string): boolean;
	getDefaultSelection(): { model: string | null; thinking: string | null };
	updateDefaultSelection(model: string, thinking: string): void;
	observeProjectRevision(conversationId: string, revision: number): number | null;
	observeProjectSnapshot(conversationId: string, snapshot: string): string | null;
	appendMessage(conversationId: string, message: AssistantMessage): void;
	listProviderConnections(): AssistantProviderConnection[];
	saveProviderConnection(connectionId: AssistantProviderConnection["id"], credentialName: AssistantProviderConnection["credential_name"]): void;
	removeProviderConnection(connectionId: string): void;
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
		provider TEXT,
		model TEXT,
		thinking TEXT
	);
	CREATE INDEX IF NOT EXISTS assistant_conversations_project_updated
		ON assistant_conversations(project_id, updated_at DESC);
	CREATE TABLE IF NOT EXISTS assistant_messages (
		conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
		sequence INTEGER NOT NULL,
		role TEXT NOT NULL,
		kind TEXT,
		payload TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		PRIMARY KEY (conversation_id, sequence)
	);
	CREATE TABLE IF NOT EXISTS assistant_provider_connections (
		id TEXT PRIMARY KEY,
		auth_method TEXT NOT NULL,
		credential_name TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS assistant_settings (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		model TEXT,
		thinking TEXT
	);
	CREATE TABLE IF NOT EXISTS assistant_project_observations (
		conversation_id TEXT PRIMARY KEY REFERENCES assistant_conversations(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		snapshot TEXT
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
	const list = database.query<AssistantConversation, [string]>(`SELECT id, project_id, title, created_at, updated_at, provider, model, thinking FROM assistant_conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC`);
	const latest = database.query<AssistantConversation, [string]>(`SELECT id, project_id, title, created_at, updated_at, provider, model, thinking FROM assistant_conversations WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT 1`);
	const selectConversation = database.query<AssistantConversation, [string]>(`SELECT id, project_id, title, created_at, updated_at, provider, model, thinking FROM assistant_conversations WHERE id = ?`);
	const insertConversation = database.query(`INSERT INTO assistant_conversations (id, project_id, title, created_at, updated_at, provider, model, thinking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	const insertMessage = database.query(`INSERT INTO assistant_messages (conversation_id, sequence, role, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
	const nextSequence = database.query<{ sequence: number }, [string]>(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM assistant_messages WHERE conversation_id = ?`);
	const touchConversation = database.query(`UPDATE assistant_conversations SET updated_at = ? WHERE id = ?`);
	const rename = database.query(`UPDATE assistant_conversations SET title = ?, updated_at = ? WHERE id = ?`);
	const remove = database.query(`DELETE FROM assistant_conversations WHERE id = ?`);
	const updateSelection = database.query(`UPDATE assistant_conversations SET provider = 'anthropic', model = ?, thinking = ?, updated_at = ? WHERE id = ?`);
	const messages = database.query<{ role: string; kind: string | null; payload: string; created_at: number }, [string]>(`SELECT role, kind, payload, created_at FROM assistant_messages WHERE conversation_id = ? ORDER BY sequence ASC`);
	const listProviderConnections = database.query<AssistantProviderConnection, []>(`SELECT id, auth_method, credential_name, created_at, updated_at FROM assistant_provider_connections ORDER BY id`);
	const saveProviderConnection = database.query(`INSERT INTO assistant_provider_connections (id, auth_method, credential_name, created_at, updated_at) VALUES (?, 'api-key', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET auth_method = excluded.auth_method, credential_name = excluded.credential_name, updated_at = excluded.updated_at`);
	const removeProviderConnection = database.query(`DELETE FROM assistant_provider_connections WHERE id = ?`);
	const getSelection = database.query<{ model: string | null; thinking: string | null }, []>(`SELECT model, thinking FROM assistant_settings WHERE id = 1`);
	const saveSelection = database.query(`INSERT INTO assistant_settings (id, model, thinking) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET model = excluded.model, thinking = excluded.thinking`);
	const getObservedRevision = database.query<{ revision: number }, [string]>(`SELECT revision FROM assistant_project_observations WHERE conversation_id = ?`);
	const saveObservedRevision = database.query(`INSERT INTO assistant_project_observations (conversation_id, revision) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET revision = excluded.revision`);
	const readAndSaveRevision = database.transaction((conversationId: string, revision: number) => {
		const previous = getObservedRevision.get(conversationId)?.revision ?? null;
		saveObservedRevision.run(conversationId, revision);
		return previous;
	});
	const getObservedSnapshot = database.query<{ snapshot: string | null }, [string]>(`SELECT snapshot FROM assistant_project_observations WHERE conversation_id = ?`);
	const saveObservedSnapshot = database.query(`INSERT INTO assistant_project_observations (conversation_id, revision, snapshot) VALUES (?, 0, ?) ON CONFLICT(conversation_id) DO UPDATE SET snapshot = excluded.snapshot`);
	const readAndSaveSnapshot = database.transaction((conversationId: string, snapshot: string) => {
		const previous = getObservedSnapshot.get(conversationId)?.snapshot ?? null;
		saveObservedSnapshot.run(conversationId, snapshot);
		return previous;
	});
	const create = database.transaction((projectId: string, message: AssistantMessage, options: AssistantConversationOptions, now: number) => {
		const id = options.id ?? crypto.randomUUID();
		insertConversation.run(id, projectId, options.title ?? titleFromMessage(message), now, now, options.provider ?? null, options.model ?? null, options.thinking ?? null);
		insertMessage.run(id, 1, message.role, message.kind ?? null, JSON.stringify(message.payload), message.created_at ?? now);
		return selectConversation.get(id)!;
	});
	const append = database.transaction((conversationId: string, message: AssistantMessage, now: number) => {
		const row = nextSequence.get(conversationId);
		if (!row) throw new Error(`Conversation not found: ${conversationId}`);
		insertMessage.run(conversationId, row.sequence, message.role, message.kind ?? null, JSON.stringify(message.payload), message.created_at ?? now);
		touchConversation.run(now, conversationId);
	});
	return {
		listConversations: (projectId) => list.all(projectId),
		getLatestConversation: (projectId) => latest.get(projectId) ?? null,
		createConversation: (projectId, message, options = {}) => create.immediate(projectId, message, options, Date.now()),
		renameConversation: (id, title) => Number(rename.run(title, Date.now(), id).changes) > 0,
		deleteConversation: (id) => Number(remove.run(id).changes) > 0,
		updateConversationSelection(id, model, thinking) {
			return Number(updateSelection.run(model, thinking, Date.now(), id).changes) > 0;
		},
		getDefaultSelection: () => getSelection.get() ?? { model: null, thinking: null },
		updateDefaultSelection: (model, thinking) => { saveSelection.run(model, thinking); },
		observeProjectRevision: (conversationId, revision) => readAndSaveRevision.immediate(conversationId, revision),
		observeProjectSnapshot: (conversationId, snapshot) => readAndSaveSnapshot.immediate(conversationId, snapshot),
		appendMessage: (conversationId, message) => append.immediate(conversationId, message, Date.now()),
		loadConversation: (id) => {
			const conversation = selectConversation.get(id);
			if (!conversation) return null;
			return { ...conversation, messages: messages.all(id).map((message) => ({ role: message.role, ...(message.kind === null ? {} : { kind: message.kind }), payload: JSON.parse(message.payload), created_at: message.created_at })) };
		},
		listProviderConnections: () => listProviderConnections.all(),
		saveProviderConnection(connectionId, credentialName) {
			const now = Date.now();
			const existing = listProviderConnections.all().find((connection) => connection.id === connectionId);
			saveProviderConnection.run(connectionId, credentialName, existing?.created_at ?? now, now);
		},
		removeProviderConnection(connectionId) {
			removeProviderConnection.run(connectionId);
		},
		close: () => database.close(),
	};
}
