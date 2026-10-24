import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { applyAssistantDdl } from "./assistant-ddl";
import { createAssistantRuntime } from "./assistant-runtime";
import { openDesignStore } from "./store";
import { generateDesignSql } from "./sql";
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
		expect(requests[2]).toContain("Project changed since revision 1 (scenarios, Edge functions)");
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

	test("keeps an Assistant write result bound to its conversation project during pending persistence", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-project-result-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		let targetProjectId = "";
		let blockNextTargetSave = false;
		const saveStarted = Promise.withResolvers<void>();
		const saveGate = Promise.withResolvers<void>();
		const workspace = await createDesignWorkspace({
			databasePath,
			openStore: (path) => {
				const realStore = openDesignStore(path);
				return {
					...realStore,
					async saveDesign(projectId, design, save) {
						if (blockNextTargetSave && projectId === targetProjectId) {
							blockNextTargetSave = false;
							saveStarted.resolve();
							await saveGate.promise;
						}
						realStore.saveDesign(projectId, design, save);
					},
				};
			},
		});
		workspaces.push(workspace);
		const target = await workspace.createProject({ name: "Conversation target" });
		if (!target.project) throw new Error("Expected target project.");
		targetProjectId = target.project.id;
		const other = await workspace.createProject({ name: "Other project" });
		if (!other.project) throw new Error("Expected other project.");
		await workspace.addTable({ name: "private_other_table" });
		await workspace.openProject({ projectId: targetProjectId });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(targetProjectId);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE created_in_target (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The target-project change is done.")]),
		]);
		blockNextTargetSave = true;
		const send = runtime.sendMessage(conversation.id, "Create a table.", "scripted-model");
		await saveStarted.promise;
		await workspace.openProject({ projectId: other.project.id });
		saveGate.resolve();
		await send;

		const result = runtime.loadConversation(conversation.id)?.messages.find(({ role }) => role === "toolResult");
		expect(JSON.stringify(result?.payload)).toContain("created_in_target");
		expect(JSON.stringify(result?.payload)).not.toContain("private_other_table");
		expect(workspace.getState().project?.id).toBe(other.project.id);
	});

	test("adds column notes only to Assistant read_project SQL with safe comment formatting", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-notes-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Column notes" });
		if (!state.project) throw new Error("Expected the project to be open.");
		await applyAssistantDdl(workspace, "CREATE TABLE t (id integer PRIMARY KEY); COMMENT ON COLUMN t.id IS 'old private\nintent';");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I read the column note.")]),
		]);
		await runtime.sendMessage(conversation.id, "Read this project.", "scripted-model");

		const design = workspace.getState().design!;
		const generated = generateDesignSql(design);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).not.toContain("COMMENT ON COLUMN");
		const readResult = runtime.loadConversation(conversation.id)?.messages.find(({ role }) => role === "toolResult");
		const readPayload = readResult?.payload as { content?: Array<{ text?: string }> } | undefined;
		const readProject = JSON.parse(readPayload?.content?.[0]?.text ?? "{}") as { generatedSql?: string };
		expect(readProject.generatedSql).toContain('-- Column notes\n-- "t"."id": old private intent');
		expect(readProject.generatedSql).not.toContain("COMMENT ON COLUMN");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("confirms staged table dependencies from a deterministic plan", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-staged-confirm-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Staged confirmation" });
		if (!state.project) throw new Error("Expected the project to be open.");
		await applyAssistantDdl(workspace, "CREATE TABLE parent (id integer PRIMARY KEY);");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE child (id integer PRIMARY KEY, parent_id integer REFERENCES parent(id)); DROP TABLE parent;" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The staged dependency was removed.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create then remove the dependent table.", "scripted-model");
		expect(runtime.isConfirmationPending(conversation.id)).toBe(true);
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["parent"]);
		const saved = runtime.loadConversation(conversation.id)!;
		const toolResult = saved.messages.find(({ role }) => role === "toolResult")!;
		const payload = toolResult.payload as { toolCallId: string };

		await runtime.confirmDdlDrop(conversation.id, payload.toolCallId);

		expect(runtime.isConfirmationPending(conversation.id)).toBe(false);
		expect(scripted.state.callCount).toBe(2);
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["child"]);
		expect(workspace.getState().design?.relationships).toEqual([]);
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("refreshes an invalidated destructive plan and rejects it without stranding the turn", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-reject-drop-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Reject confirmation" });
		if (!state.project) throw new Error("Expected the project to be open.");
		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, user_id integer REFERENCES users(id));");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "DROP TABLE users;" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The designer rejected this destructive change.")]),
			fauxAssistantMessage([fauxText("I will continue without the rejected change.")]),
		]);
		await runtime.sendMessage(conversation.id, "Drop users.", "scripted-model");
		const firstPlan = runtime.loadConversation(conversation.id)!.messages.find(({ role }) => role === "toolResult")!;
		const toolCallId = (firstPlan.payload as { toolCallId: string }).toolCallId;
		await workspace.addTable({ name: "unrelated" });

		const refreshed = await runtime.confirmDdlDrop(conversation.id, toolCallId);

		expect(runtime.isConfirmationPending(conversation.id)).toBe(true);
		expect(refreshed?.messages.some(({ kind, payload }) => kind === "assistant-drop-confirmation" && JSON.stringify(payload).includes('"status":"updated"'))).toBe(true);
		await runtime.rejectDdlDrop(conversation.id, toolCallId);
		expect(runtime.isConfirmationPending(conversation.id)).toBe(false);
		expect(scripted.state.callCount).toBe(2);
		expect(workspace.getState().design?.tables.map(({ name }) => name).sort()).toEqual(["posts", "unrelated", "users"]);
		const saved = runtime.loadConversation(conversation.id)!;
		expect(saved.messages.some(({ role, payload }) => role === "toolResult" && JSON.stringify(payload).includes("the designer rejected this destructive change"))).toBe(true);
		await expect(runtime.sendMessage(conversation.id, "Continue.", "scripted-model")).resolves.toBeDefined();
	});
	test("writes Scenario and Edge function source with unique exact edits, diagnostics, and fixed prompt tools", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-code-tools-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Code tools" });
		if (!state.project) throw new Error("Expected the project to be open.");
		await workspace.addTable({ name: "Books" });
		const scenario = await workspace.createScenario({ name: "Original scenario" });
		const scenarioId = scenario.scenarios[0]?.id;
		if (!scenarioId) throw new Error("Expected a saved Scenario.");
		const edge = await workspace.createEdgeFunction({ name: "original_handler" });
		const edgeId = edge.edgeFunctions[0]?.id;
		if (!edgeId) throw new Error("Expected a saved Edge function.");
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
			fauxAssistantMessage([
				fauxToolCall("manage_code", { action: "write", kind: "scenario", id: scenarioId, source: `import { createClient } from "@supabase/supabase-js";
const client = createClient<Database>("http://scenario.local", "key");
const query = client.from("Books").select("id");` }),
				fauxToolCall("manage_code", { action: "write", kind: "edge-function", id: edgeId, source: `import { createClient } from "@supabase/supabase-js";
const client = createClient<Database>("http://scenario.local", "key");
Deno.serve(async () => { const result = await client.from("Books").select("id"); return new Response(String(result.data?.[0]?.id ?? 0)); });` }),
				fauxToolCall("manage_code", { action: "write", kind: "scenario", id: scenarioId, source: "const value: string = 42; const duplicate = 1; const duplicate = 2;" }),
				fauxToolCall("manage_code", { action: "edit", kind: "scenario", id: scenarioId, oldText: "const", newText: "let" }),
				fauxToolCall("manage_code", { action: "edit", kind: "edge-function", id: edgeId, oldText: "not present", newText: "replacement" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The sources are saved; the ambiguous edit was rejected.")]),
		]);
		await runtime.sendMessage(conversation.id, "Update both source files.", "scripted-model");

		expect(workspace.getState().scenarios[0]?.source).toContain("const value: string = 42;");
		expect(workspace.getState().edgeFunctions[0]?.source).toContain("Deno.serve");
		const saved = runtime.loadConversation(conversation.id);
		const toolResults = saved?.messages.filter(({ role }) => role === "toolResult") ?? [];
		expect(toolResults).toHaveLength(5);
		const validScenario = toolResults[0]?.payload as { details?: { diagnostics?: string[] } };
		expect(validScenario.details?.diagnostics).toEqual([]);
		const validEdgeFunction = toolResults[1]?.payload as { details?: { diagnostics?: string[] } };
		expect(validEdgeFunction.details?.diagnostics).toEqual([]);
		const invalidScenario = toolResults[2]?.payload as { details?: { diagnostics?: string[] } };
		expect(invalidScenario.details?.diagnostics?.some((diagnostic) => diagnostic.includes("Type 'number' is not assignable to type 'string'"))).toBe(true);
		const multipleMatches = toolResults[3]?.payload as { content?: Array<{ text?: string }> };
		expect(multipleMatches.content?.[0]?.text).toContain("Exact-string edit expected exactly one match; found 3.");
		const noMatches = toolResults[4]?.payload as { content?: Array<{ text?: string }> };
		expect(noMatches.content?.[0]?.text).toContain("Exact-string edit expected exactly one match; found 0.");
		expect(requests[0]).toContain("Sandbox API subset");
		expect(requests[0]).toContain("manage_code");
	});
	test("creates, renames, and removes Scenarios and Edge functions through workspace actions", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-code-lifecycle-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		let nextId = 0;
		const workspace = await createDesignWorkspace({ databasePath, createId: () => `workspace-${++nextId}` });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Lifecycle" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "Generated scenario" }),
				fauxToolCall("manage_code", { action: "rename", kind: "scenario", id: "workspace-2", name: "Renamed scenario" }),
				fauxToolCall("manage_code", { action: "remove", kind: "scenario", id: "workspace-2" }),
				fauxToolCall("manage_code", { action: "create", kind: "edge-function", name: "generated_handler" }),
				fauxToolCall("manage_code", { action: "rename", kind: "edge-function", id: "workspace-3", name: "renamed_handler" }),
				fauxToolCall("manage_code", { action: "remove", kind: "edge-function", id: "workspace-3" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The requested code items were updated.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create, rename, and remove both kinds of code item.", "scripted-model");
		expect(workspace.getState().scenarios).toEqual([]);
		expect(workspace.getState().edgeFunctions).toEqual([]);
		expect(runtime.loadConversation(conversation.id)?.messages.filter(({ role }) => role === "toolResult")).toHaveLength(6);
	});
	test("undoes and redoes a Function-body write together with DDL in one Assistant turn", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-function-turn-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Function undo" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const functionId = "turn-function";
		await workspace.updateFunctions({ functions: [{
			id: functionId,
			name: "turn_function",
			arguments: [],
			returnType: "integer",
			returnsSet: false,
			language: "sql",
			volatility: "immutable",
			security: "invoker",
			body: "SELECT 1",
		}] });
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_records (id integer PRIMARY KEY);" }),
				fauxToolCall("manage_code", { action: "edit", kind: "function-body", id: functionId, oldText: "SELECT 1", newText: "SELECT 2" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the table and updated the Function body.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create a table and update the Function.", "scripted-model");
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["assistant_records"]);
		expect(workspace.getState().design?.functions?.[0]?.body).toBe("SELECT 2");

		await workspace.undo();
		expect(workspace.getState().design?.tables).toEqual([]);
		expect(workspace.getState().design?.functions?.[0]?.body).toBe("SELECT 1");
		await workspace.redo();
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["assistant_records"]);
		expect(workspace.getState().design?.functions?.[0]?.body).toBe("SELECT 2");
	});
});
