import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace } from "./workspace";

const directories: string[] = [];
const workspaces: Awaited<ReturnType<typeof createDesignWorkspace>>[] = [];
const runtimes: ReturnType<typeof createAssistantRuntime>[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Assistant pi agent runtime", () => {
	test("streams and persists a scripted response through pi's model stream", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-agent-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Assistant project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key-not-sent-to-a-provider",
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE users (id uuid PRIMARY KEY);" }),
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE posts (id uuid PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the users and posts tables.")]),
		]);
		const streamed: string[] = [];
		runtime.subscribe((_conversationId, event) => {
			const eventRecord = event as { type?: string; assistantMessageEvent?: { type?: string; delta?: string } };
			if (eventRecord.type === "message_update" && eventRecord.assistantMessageEvent?.type === "text_delta" && typeof eventRecord.assistantMessageEvent.delta === "string") {
				streamed.push(eventRecord.assistantMessageEvent.delta);
			}
		});
		await runtime.sendMessage(conversation.id, "What is in the design?", "scripted-model");

		expect(streamed.join("")).toBe("Created the users and posts tables.");
		expect(scripted.state.callCount).toBe(2);
		const saved = runtime.loadConversation(conversation.id);
		expect(saved?.messages.map(({ role }) => role)).toEqual(["system", "user", "assistant", "toolResult", "toolResult", "assistant"]);
		expect(saved?.title).toBe("What is in the design?");
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["users", "posts"]);
		expect(workspace.getState().undoRedo).toEqual({ canUndo: true, canRedo: false });
		await workspace.undo();
		expect(workspace.getState().design?.tables).toEqual([]);
	});
	test("holds dependent drops until explicit confirmation, then undoes the turn once", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-confirm-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Drop confirmation" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, author_id integer REFERENCES users(id));" }),
				fauxToolCall("apply_ddl", { sql: "DROP TABLE users;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The drop needs your confirmation.")]),
			fauxAssistantMessage([fauxText("The drop is confirmed; posts remains.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create users and posts, then remove users.", "scripted-model");
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["users", "posts"]);
		const confirmation = runtime.loadConversation(conversation.id)?.messages.find((message) => {
			const payload = message.payload;
			if (message.role !== "toolResult" || !payload || typeof payload !== "object" || !("details" in payload)) return false;
			const details = payload.details;
			return Boolean(details && typeof details === "object" && "status" in details && details.status === "confirmation-required");
		});
		const payload = confirmation?.payload;
		const toolCallId = payload && typeof payload === "object" && "toolCallId" in payload && typeof payload.toolCallId === "string"
			? payload.toolCallId
			: undefined;
		if (!toolCallId) throw new Error("Expected a persisted confirmation tool result.");
		await runtime.confirmDdlDrop(conversation.id, toolCallId);
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["posts"]);
		expect(workspace.getState().design?.relationships).toEqual([]);
		await workspace.undo();
		expect(workspace.getState().design?.tables).toEqual([]);
	});
	test("pauses at the request cap and continues on explicit request", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-cap-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Request cap" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({
			databasePath, workspace, models,
			getApiKey: async () => "test-key",
			maxRequestsPerTurn: 1,
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxText("First response.")]),
			fauxAssistantMessage([fauxText("Continued response.")]),
		]);
		await runtime.sendMessage(conversation.id, "Begin a task.", "scripted-model");
		expect(runtime.isTurnPaused(conversation.id)).toBe(true);
		expect(scripted.state.callCount).toBe(1);
		await runtime.continueTurn(conversation.id);
		expect(runtime.isTurnPaused(conversation.id)).toBe(true);
		expect(scripted.state.callCount).toBe(2);
		expect(runtime.loadConversation(conversation.id)?.messages.some(({ kind }) => kind === "assistant-continue")).toBe(true);
	});
});
