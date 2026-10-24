import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignWorkspace } from "./workspace";
import { openAssistantStore } from "./assistant-store";

const directories: string[] = [];
const workspaces: Awaited<ReturnType<typeof createDesignWorkspace>>[] = [];

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-"));
	directories.push(directory);
	const databasePath = join(directory, "project.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	const project = await workspace.createProject({ name: "Assistant persistence" });
	if (!project.project) throw new Error("Project was not created.");
	return { databasePath, projectId: project.project.id, workspace };
}

describe("Assistant conversations", () => {
	test("persists ordered tool messages and rename/delete leave project content unchanged", async () => {
		const { databasePath, projectId, workspace } = await setup();
		const store = openAssistantStore(databasePath);
		try {
			store.saveProviderConnection("anthropic", "anthropic-api-key");
			expect(store.listProviderConnections()).toEqual([
				expect.objectContaining({ id: "anthropic", auth_method: "api-key", credential_name: "anthropic-api-key" }),
			]);
			expect(Object.keys(store.listProviderConnections()[0] ?? {}).sort()).toEqual(["auth_method", "created_at", "credential_name", "id", "updated_at"]);
			const conversation = store.createConversation(projectId, { role: "user", payload: { role: "user", content: "Add authors" } });
			expect(store.updateConversationSelection(conversation.id, "claude-sonnet-4-6", "high")).toBe(true);
			expect(store.getDefaultSelection()).toEqual({ model: null, thinking: null });
			store.updateDefaultSelection("claude-haiku-4-5", "low");
			expect(store.getDefaultSelection()).toEqual({ model: "claude-haiku-4-5", thinking: "low" });
			expect(store.observeProjectRevision(conversation.id, 4)).toBeNull();
			expect(store.observeProjectRevision(conversation.id, 4)).toBe(4);
			expect(store.observeProjectRevision(conversation.id, 5)).toBe(4);
			expect(store.observeProjectSnapshot(conversation.id, "{\"scenarios\":[]}", 4)).toBeNull();
			expect(store.observeProjectSnapshot(conversation.id, "{\"scenarios\":[\"review\"]}", 5)).toEqual({ snapshot: "{\"scenarios\":[]}", revision: 4 });
			store.appendMessage(conversation.id, { role: "assistant", payload: { role: "assistant", content: [{ type: "toolCall", name: "apply_ddl", arguments: { sql: "CREATE TABLE authors (id integer);" } }] } });
			store.appendMessage(conversation.id, { role: "toolResult", kind: "tool-result", payload: { toolCallId: "t1", content: [{ type: "text", text: "applied" }] } });
			const loaded = store.loadConversation(conversation.id);
			expect(loaded?.messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
			expect(loaded?.model).toBe("claude-sonnet-4-6");
			expect(loaded?.thinking).toBe("high");
			expect(loaded?.title).toBe("Add authors");
			expect(store.renameConversation(conversation.id, "Schema notes")).toBe(true);
			expect(store.listConversations(projectId)[0]?.title).toBe("Schema notes");
			const tablesBefore = workspace.getState().design?.tables;
			expect(store.deleteConversation(conversation.id)).toBe(true);
			expect(store.loadConversation(conversation.id)).toBeNull();
			expect(workspace.getState().design?.tables).toEqual(tablesBefore);
		} finally {
			store.close();
		}
	});

	test("cascades conversation data when its project is deleted", async () => {
		const { databasePath, projectId } = await setup();
		const store = openAssistantStore(databasePath);
		const conversation = store.createConversation(projectId, { role: "user", payload: "Hello" });
		store.close();
		const database = new Database(databasePath);
		try {
			database.exec("PRAGMA foreign_keys = ON");
			database.query("DELETE FROM projects WHERE id = ?").run(projectId);
			const remaining = database.query("SELECT id FROM assistant_conversations WHERE id = ?").get(conversation.id);
			expect(remaining).toBeNull();
		} finally {
			database.close();
		}
	});
});
