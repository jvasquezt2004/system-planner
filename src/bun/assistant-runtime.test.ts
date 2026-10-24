import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { applyAssistantDdl } from "./assistant-ddl";
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
	test("rejects a tool execution when the open project changes during model streaming", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-project-binding-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const first = await workspace.createProject({ name: "Conversation project" });
		if (!first.project) throw new Error("Expected the first project to be open.");
		const conversationProjectId = first.project.id;
		const second = await workspace.createProject({ name: "Other project" });
		if (!second.project) throw new Error("Expected the second project to be open.");
		const secondProjectId = second.project.id;
		await workspace.addTable({ name: "only_in_other_project" });
		await workspace.openProject({ projectId: conversationProjectId });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		let switched = false;
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				if (!switched) {
					switched = true;
					await workspace.openProject({ projectId: secondProjectId });
				}
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(conversationProjectId);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("read_project", {}),
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE leaked (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I could not access the other project.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create leaked.", "scripted-model");

		expect(workspace.getState().project?.id).toBe(secondProjectId);
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["only_in_other_project"]);
		await workspace.openProject({ projectId: conversationProjectId });
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual([]);
		expect(JSON.stringify(runtime.loadConversation(conversation.id)?.messages)).not.toContain("only_in_other_project");
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
				fauxToolCall("apply_ddl", { sql: "DROP TABLE users; DROP TABLE posts;" }),
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE escaped (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The drops are confirmed.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create users and posts, then remove users.", "scripted-model");
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["users", "posts"]);
		expect(runtime.isTurnPaused(conversation.id)).toBe(true);
		expect(scripted.state.callCount).toBe(1);
		expect(workspace.getState().design?.tables.some(({ name }) => name === "escaped")).toBe(false);
		await expect(runtime.sendMessage(conversation.id, "Ignore the confirmation.", "scripted-model")).rejects.toThrow(/Confirm or reject/);
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
		const confirmationDetails = (payload as { details: { targets: { targetId: string }[]; projectId: string; revision: number } }).details;
		expect(confirmationDetails.projectId).toBe(state.project.id);
		expect(confirmationDetails.revision).toBe(workspace.getState().revision);
		expect(confirmationDetails.targets.map(({ targetId }) => targetId)).toEqual(["table:users", "table:posts"]);
		await runtime.confirmDdlDrop(conversation.id, toolCallId);
		expect(runtime.isTurnPaused(conversation.id)).toBe(false);
		await expect(runtime.confirmDdlDrop(conversation.id, toolCallId)).rejects.toThrow();
		expect(scripted.state.callCount).toBe(2);
		expect(workspace.getState().design?.tables).toEqual([]);
		expect(workspace.getState().design?.relationships).toEqual([]);
		await workspace.undo();
		expect(workspace.getState().design?.tables).toEqual([]);
	});
	test("rejects replaying an old destructive confirmation after the project changes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-confirm-binding-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const first = await workspace.createProject({ name: "Drop target" });
		if (!first.project) throw new Error("Expected the first project to be open.");
		const targetProjectId = first.project.id;
		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, author_id integer REFERENCES users(id));", { assistantTurnId: "setup" });
		const second = await workspace.createProject({ name: "Unrelated project" });
		if (!second.project) throw new Error("Expected the second project to be open.");
		await workspace.openProject({ projectId: targetProjectId });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(targetProjectId);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "DROP TABLE users;" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Waiting for confirmation.")]),
		]);
		await runtime.sendMessage(conversation.id, "Drop users.", "scripted-model");
		const confirmation = runtime.loadConversation(conversation.id)?.messages.find((message) => {
			const payload = message.payload;
			if (message.role !== "toolResult" || !payload || typeof payload !== "object" || !("details" in payload)) return false;
			const details = payload.details;
			return Boolean(details && typeof details === "object" && "status" in details && details.status === "confirmation-required");
		});
		const payload = confirmation?.payload;
		const toolCallId = payload && typeof payload === "object" && "toolCallId" in payload && typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
		if (!toolCallId) throw new Error("Expected a persisted destructive confirmation.");

		await workspace.openProject({ projectId: second.project.id });
		await expect(runtime.confirmDdlDrop(conversation.id, toolCallId)).rejects.toThrow();
		expect(workspace.getState().design?.tables).toEqual([]);
	});
	test("sends saved scenario and edge-function edits to the existing agent and updates thinking level", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-live-context-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Live context" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const requests: string[] = [];
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: (model, context, options) => {
				requests.push(JSON.stringify({ context, options }));
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I read the project.")]),
			fauxAssistantMessage([fauxText("I have the updated context.")]),
		]);
		await runtime.sendMessage(conversation.id, "Read this project.", "scripted-model", "low");
		await workspace.createScenario({ name: "review scenario" });
		await workspace.createEdgeFunction({ name: "notify_change" });
		await runtime.sendMessage(conversation.id, "What changed?", "scripted-model", "high");

		expect(requests).toHaveLength(3);
		expect(requests[2]).toContain("Project changed since your last snapshot (scenarios, Edge functions)");
		expect(requests[2]).toContain("scenario");
		expect(requests[2]).toContain("Edge functions");
		expect(requests[0]).toContain("low");
		expect(requests[2]).toContain("high");
		const saved = runtime.loadConversation(conversation.id);
		expect(saved?.messages.some(({ kind, payload }) => kind === "assistant-change-note" && JSON.stringify(payload).includes("Edge functions"))).toBe(true);
	});
	test("undoes one whole Assistant turn while retaining intervening hand edits", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-whole-turn-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Whole turn undo" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		let requestCount = 0;
		let insertedManualEdit = false;
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				requestCount += 1;
				if (requestCount === 2 && !insertedManualEdit) {
					insertedManualEdit = true;
					await workspace.addTable({ name: "manual_table" });
				}
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_first (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_second (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The Assistant changes are complete.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create two tables.", "scripted-model");
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["assistant_first", "manual_table", "assistant_second"]);

		await workspace.undo();
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["manual_table"]);
		expect(workspace.getState().undoRedo).toEqual({ canUndo: true, canRedo: true });
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
