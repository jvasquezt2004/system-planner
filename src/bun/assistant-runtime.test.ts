import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { applyAssistantDdl } from "./assistant-ddl";
import { createAssistantRuntime, SYSTEM_PROMPT, compactSandboxStatus, compactSqlStatus } from "./assistant-runtime";
import { openDesignStore } from "./store";
import { generateDesignSql } from "./sql";
import { createDesignWorkspace } from "./workspace";
import type { AssistantMessage } from "../shared/assistant";
import { assistantText, buildTranscript, foldAssistantEvent, type TranscriptToolItem } from "../mainview/assistant-transcript";

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
		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().design?.tables).toEqual([]);
	});
	test("folds real pi events into the same visible transcript as saved messages", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-transcript-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Transcript project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The project is ready.")]),
		]);
		const events: unknown[] = [];
		runtime.subscribe((conversationId, event) => {
			if (conversationId === conversation.id) events.push(event);
		});
		const prompt = "Read the project and summarize it.";
		await runtime.sendMessage(conversation.id, prompt, "scripted-model");

		const live = events.reduce<AssistantMessage[]>((messages, event) => foldAssistantEvent(messages, event), [
			{ role: "user", payload: prompt },
		]);
		const saved = runtime.loadConversation(conversation.id);
		if (!saved) throw new Error("Expected the conversation to be saved.");
		const visibleShape = (messages: AssistantMessage[]) => messages.flatMap((message) => {
			if (message.role === "user") return ["user"];
			if (message.kind === "live-tool" || message.role === "toolResult") return ["tool"];
			const text = assistantText(message.payload);
			return text ? [`assistant:${text}`] : [];
		});
		expect(visibleShape(live)).toEqual(visibleShape(saved.messages));
		expect(visibleShape(live)).toEqual(["user", "tool", "assistant:The project is ready."]);
		expect(live.filter((message) => message.kind === "live-assistant").every((message) => Boolean(assistantText(message.payload).trim()))).toBe(true);
		expect(live.find((message) => message.kind === "live-tool")?.payload).toMatchObject({ status: "complete" });
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
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "only_in_other_project" });
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
		await workspace.undo({ designId: workspace.getState().activeDesignId! });
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
		await workspace.createScenario({ designId: workspace.getState().activeDesignId!, name: "review scenario" });
		await workspace.createEdgeFunction({ designId: workspace.getState().activeDesignId!, name: "notify_change" });
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
					await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "manual_table" });
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

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
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
					async saveDesign(projectId, design, save, designId) {
						if (blockNextTargetSave && projectId === targetProjectId) {
							blockNextTargetSave = false;
							saveStarted.resolve();
							await saveGate.promise;
						}
						realStore.saveDesign(projectId, design, save, designId);
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
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "private_other_table" });
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
		const readProject = JSON.parse(readPayload?.content?.[0]?.text ?? "{}") as { projectId?: string; designId?: string; generatedSql?: string };
		expect(readProject.projectId).toBe(state.project.id);
		expect(readProject.designId).toBe(state.activeDesignId ?? undefined);
		expect(readProject.generatedSql).toContain('-- Column notes\n-- "t"."id": old private intent');
		expect(readProject.generatedSql).not.toContain("COMMENT ON COLUMN");
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
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "unrelated" });

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
	test("refuses a retry of a destructive change the designer rejected in the same turn", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-reject-retry-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Reject retry" });
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
			// After the rejection the model tries the same drop again.
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "DROP TABLE users" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Understood, users stays. What would you like instead?")]),
		]);
		await runtime.sendMessage(conversation.id, "Drop users.", "scripted-model");
		const plan = runtime.loadConversation(conversation.id)!.messages.find(({ role }) => role === "toolResult")!;
		await runtime.rejectDdlDrop(conversation.id, (plan.payload as { toolCallId: string }).toolCallId);

		expect(runtime.isConfirmationPending(conversation.id)).toBe(false);
		expect(scripted.state.callCount).toBe(3);
		expect(workspace.getState().design?.tables.map(({ name }) => name).sort()).toEqual(["posts", "users"]);
		const results = runtime.loadConversation(conversation.id)!.messages.filter(({ role }) => role === "toolResult").map(({ payload }) => JSON.stringify(payload));
		expect(results.some((text) => text.includes("rejected-earlier"))).toBe(true);
		expect(results.filter((text) => text.includes("confirmation-required"))).toHaveLength(1);
	});
	test("writes Scenario and Edge function source with unique exact edits, diagnostics, and fixed prompt tools", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-code-tools-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Code tools" });
		if (!state.project) throw new Error("Expected the project to be open.");
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const scenario = await workspace.createScenario({ designId: workspace.getState().activeDesignId!, name: "Original scenario" });
		const scenarioId = scenario.scenarios[0]?.id;
		if (!scenarioId) throw new Error("Expected a saved Scenario.");
		const edge = await workspace.createEdgeFunction({ designId: workspace.getState().activeDesignId!, name: "original_handler" });
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
	test("creating a Scenario with source saves that source and reports diagnostics", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-create-source-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Create with source" });
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
				requests.push(JSON.stringify(context));
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		const source = "const admin = asServiceRole();\nconst count: string = 1;\n";
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "Loan lifecycle", source })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create a scenario with source.", "scripted-model");

		expect(workspace.getState().scenarios).toEqual([expect.objectContaining({ name: "Loan lifecycle", source })]);
		const result = runtime.loadConversation(conversation.id)?.messages.find(({ role }) => role === "toolResult")?.payload as { details?: { action?: string; diagnostics?: string[] } };
		expect(result.details?.action).toBe("write");
		expect(result.details?.diagnostics?.some((diagnostic) => diagnostic.includes("Type 'number' is not assignable to type 'string'"))).toBe(true);
		expect(result.details?.diagnostics?.some((diagnostic) => diagnostic.includes("asServiceRole"))).toBe(false);
		expect(requests[0]).toContain("asServiceRole()");
		expect(requests[0]).toContain("Do not import or create a Supabase client");
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
				fauxToolCall("manage_code", { action: "rename", kind: "scenario", id: "workspace-3", name: "Renamed scenario" }),
				fauxToolCall("manage_code", { action: "remove", kind: "scenario", id: "workspace-3" }),
				fauxToolCall("manage_code", { action: "create", kind: "edge-function", name: "generated_handler" }),
				fauxToolCall("manage_code", { action: "rename", kind: "edge-function", id: "workspace-4", name: "renamed_handler" }),
				fauxToolCall("manage_code", { action: "remove", kind: "edge-function", id: "workspace-4" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The requested code items were updated.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create, rename, and remove both kinds of code item.", "scripted-model");
		expect(workspace.getState().scenarios).toEqual([]);
		expect(workspace.getState().edgeFunctions).toEqual([]);
		expect(runtime.loadConversation(conversation.id)?.messages.filter(({ role }) => role === "toolResult")).toHaveLength(6);
	});
	test("does not create a Scenario in the newly active Design when its tool call is pending", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-code-target-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const first = await workspace.createProject({ name: "Scenario target" });
		if (!first.project || !first.activeDesignId) throw new Error("Expected the first project Design to be open.");
		const firstProjectId = first.project.id;
		const firstDesignId = first.activeDesignId;
		const second = await workspace.createProject({ name: "Other target" });
		if (!second.project || !second.activeDesignId) throw new Error("Expected the second project Design to be open.");
		await workspace.openProject({ projectId: firstProjectId });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(firstProjectId);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "Must stay in source Design" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Finished.")]),
		]);

		const originalCreateScenario = workspace.createScenario.bind(workspace);
		const callStarted = Promise.withResolvers<{ designId?: string }>();
		const releaseCall = Promise.withResolvers<void>();
		workspace.createScenario = async (action) => {
			callStarted.resolve({ designId: action.designId });
			await releaseCall.promise;
			return originalCreateScenario(action);
		};
		const send = runtime.sendMessage(conversation.id, "Create a scenario.", "scripted-model");
		const action = await callStarted.promise;
		expect(action.designId).toBe(firstDesignId);
		await workspace.openProject({ projectId: second.project.id });
		releaseCall.resolve();
		await send;

		expect(workspace.getState().project?.id).toBe(second.project.id);
		expect(workspace.getState().scenarios).toEqual([]);
		const toolResults = runtime.loadConversation(conversation.id)?.messages.filter(({ role }) => role === "toolResult") ?? [];
		expect(toolResults).toHaveLength(1);
		expect(JSON.stringify(toolResults[0]?.payload)).toContain("not the active design");
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
		await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [{
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

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().design?.tables).toEqual([]);
		expect(workspace.getState().design?.functions?.[0]?.body).toBe("SELECT 1");
		await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["assistant_records"]);
		expect(workspace.getState().design?.functions?.[0]?.body).toBe("SELECT 2");
	});

	test("tracks per-turn token usage, cache reads, and estimated cost with running totals and persistence", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-usage-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Usage project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({
			provider: "anthropic",
			models: [{
				id: "scripted-pricing-model",
				name: "Scripted Pricing Model",
				contextWindow: 100000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			}],
		});
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-api-key",
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE items (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the items table.")]),
			fauxAssistantMessage([fauxText("The table has an id column.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create items table.", "scripted-pricing-model");
		let loaded = runtime.loadConversation(conversation.id)!;
		expect(loaded.usages?.length).toBe(1);
		const turn1Usage = loaded.usages![0]!;
		expect(turn1Usage.inputTokens).toBeGreaterThan(0);
		expect(turn1Usage.outputTokens).toBeGreaterThan(0);
		expect(typeof turn1Usage.cost).toBe("number");
		expect(turn1Usage.cost!).toBeGreaterThan(0);

		await runtime.sendMessage(conversation.id, "Describe items.", "scripted-pricing-model");
		loaded = runtime.loadConversation(conversation.id)!;
		expect(loaded.usages?.length).toBe(2);
		const turn2Usage = loaded.usages![1]!;
		expect(turn2Usage.inputTokens).toBeGreaterThan(0);
		expect(turn2Usage.cacheReadTokens).toBeGreaterThan(0);
		expect(typeof turn2Usage.cost).toBe("number");
		expect(turn2Usage.cost!).toBeGreaterThan(0);

		expect(loaded.totalUsage).toBeDefined();
		expect(loaded.totalUsage!.inputTokens).toBe(turn1Usage.inputTokens + turn2Usage.inputTokens);
		expect(loaded.totalUsage!.outputTokens).toBe(turn1Usage.outputTokens + turn2Usage.outputTokens);
		expect(loaded.totalUsage!.cacheReadTokens).toBe(turn1Usage.cacheReadTokens + turn2Usage.cacheReadTokens);
		expect(loaded.totalUsage!.cost).toBeCloseTo(turn1Usage.cost! + turn2Usage.cost!, 6);

		// Verify persistence survives reopening store
		runtime.close();
		const reopenedRuntime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-api-key",
		});
		runtimes.push(reopenedRuntime);
		const reloaded = reopenedRuntime.loadConversation(conversation.id)!;
		expect(reloaded.usages?.length).toBe(2);
		expect(reloaded.totalUsage?.inputTokens).toBe(loaded.totalUsage!.inputTokens);
		expect(reloaded.totalUsage?.cost).toBeCloseTo(loaded.totalUsage!.cost!, 6);
	});

	test("compaction lifecycle: turn boundary timing, no orphan toolResults, recent turns kept verbatim, repeated compaction folding previous summary, visible history unchanged, and stable prefix", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-compaction-lifecycle-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Compaction lifecycle" });
		if (!state.project) throw new Error("Expected the project to be open.");

		// Context window: 2500 tokens. 80% threshold = 2000 tokens.
		// System prompt with all tool declarations is ~1070 tokens.
		const scripted = fauxProvider({
			provider: "anthropic",
			models: [{
				id: "scripted-lifecycle-model",
				name: "Scripted Lifecycle Model",
				contextWindow: 2500,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			}],
		});
		const models = createModels();
		models.setProvider(scripted.provider);
		const receivedContexts: Array<{ messages: Array<{ role: string; toolCallId?: string; content?: unknown }> }> = [];
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-api-key",
			streamFn: async (model, context, options) => {
				receivedContexts.push(JSON.parse(JSON.stringify(context)));
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			// Turn 1
			fauxAssistantMessage([fauxText("Response 1")]),
			// Turn 2: Assistant tool call crossing 80% mid-turn, then text
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE users (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created users table.")]),
			// Compaction 1 summary response
			fauxAssistantMessage([fauxText("Summary 1: created users table.")]),
			// Turn 3
			fauxAssistantMessage([fauxText("Response 3")]),
			// Compaction 2 summary response
			fauxAssistantMessage([fauxText("Summary 2: created users and items.")]),
			// Turn 4
			fauxAssistantMessage([fauxText("Response 4")]),
			// Turn 5
			fauxAssistantMessage([fauxText("Response 5")]),
		]);

		// Turn 1: Short message (remains below 800 tokens)
		await runtime.sendMessage(conversation.id, "Prompt 1", "scripted-lifecycle-model");
		let saved = runtime.loadConversation(conversation.id)!;
		expect(saved.messages.some((m) => m.kind === "assistant-compaction")).toBe(false);

		// Turn 2: Long prompt (2400 chars = ~600 tokens + 1070 system + ~450 tool result = ~2120 tokens >= 2000 tokens) with tool call
		await runtime.sendMessage(conversation.id, "Create users: " + "X".repeat(2400), "scripted-lifecycle-model");
		saved = runtime.loadConversation(conversation.id)!;

		// (a) Compaction was decided on agent_end (not mid-turn); announcement was added
		const compactionAnnouncements = saved.messages.filter((m) => m.kind === "assistant-compaction");
		expect(compactionAnnouncements.length).toBe(1);

		// Turn 3: Request sent after compaction
		await runtime.sendMessage(conversation.id, "Prompt 3", "scripted-lifecycle-model");

		// Find the request for Turn 3 (not the summary request)
		// receivedContexts[0]: Turn 1
		// receivedContexts[1]: Turn 2 (first assistant call with toolCall)
		// receivedContexts[2]: Turn 2 (second assistant call after toolResult)
		// receivedContexts[3]: Compaction 1 summary request
		// receivedContexts[4]: Turn 3 request
		const turn3Req = receivedContexts[4]!;
		expect(turn3Req).toBeDefined();

		// (a) & (b) Assert every toolResult's toolCallId appears in a preceding assistant message of that request
		const toolResults = turn3Req.messages.filter((m) => m.role === "toolResult");
		expect(toolResults.length).toBeGreaterThan(0);
		const precedingAssistantMessages = turn3Req.messages.filter((m) => m.role === "assistant");
		const precedingToolCallIds = new Set(
			precedingAssistantMessages.flatMap((m) =>
				Array.isArray(m.content) ? m.content.filter((c) => c && typeof c === "object" && "type" in c && c.type === "toolCall").map((c) => {
					const toolBlock = c as { id: string };
					return toolBlock.id;
				}) : []
			)
		);
		for (const tr of toolResults) {
			expect(precedingToolCallIds.has(tr.toolCallId!)).toBe(true);
		}

		// (b) Next request contains the summary and the last turn verbatim
		const summaryMsg = turn3Req.messages.find((m) => typeof m.content === "string" && m.content.includes("Summary of earlier conversation:"));
		expect(summaryMsg).toBeDefined();
		expect(summaryMsg!.content).toContain("Summary 1: created users table.");
		// Last turn (Turn 2) is present verbatim
		expect(turn3Req.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => typeof c === "object" && c && "text" in c && typeof c.text === "string" && c.text.includes("Create users:")))).toBe(true);
		expect(turn3Req.messages.some((m) => Array.isArray(m.content) && m.content.some((c) => typeof c === "object" && c && "text" in c && typeof c.text === "string" && c.text.includes("Created users table.")))).toBe(true);

		// Turn 3 was over 80% (because it kept Turn 2 which had 1200 chars), so second compaction was triggered at end of Turn 3!
		// receivedContexts[5]: Compaction 2 summary request!
		const comp2Req = receivedContexts[5]!;
		expect(comp2Req).toBeDefined();
		// (c) A second compaction happens and its summary request included the previous summary
		const comp2SummaryInstruction = comp2Req.messages[comp2Req.messages.length - 1]!;
		expect(comp2SummaryInstruction.content).toContain("Summarise the conversation so far");
		expect(comp2Req.messages.some((m) => typeof m.content === "string" && m.content.includes("Summary 1: created users table."))).toBe(true);

		// Turn 4: Request after second compaction
		await runtime.sendMessage(conversation.id, "Prompt 4", "scripted-lifecycle-model");
		// receivedContexts[6]: Turn 4 request
		const turn4Req = receivedContexts[6]!;
		expect(turn4Req.messages.some((m) => typeof m.content === "string" && m.content.includes("Summary 2: created users and items."))).toBe(true);

		// Turn 5: Request after Turn 4
		await runtime.sendMessage(conversation.id, "Prompt 5", "scripted-lifecycle-model");
		// receivedContexts[7]: Turn 5 request
		const turn5Req = receivedContexts[7]!;

		// (e) Two consecutive requests after a compaction share an identical prefix
		expect(turn4Req.messages[0]!.role).toBe("system");
		expect(turn4Req.messages[1]!.role).toBe("user");
		expect(turn5Req.messages[0]!.role).toBe("system");
		expect(turn5Req.messages[1]!.role).toBe("user");
		expect(JSON.stringify(turn4Req.messages.slice(0, 2))).toBe(JSON.stringify(turn5Req.messages.slice(0, 2)));

		// (d) The designer's visible history (loadConversation) is unchanged and contains one announcement per compaction
		saved = runtime.loadConversation(conversation.id)!;
		const allAnnouncements = saved.messages.filter((m) => m.kind === "assistant-compaction");
		expect(allAnnouncements.length).toBe(2);
		const allDesignerMessages = saved.messages.filter((m) => m.role === "user");
		expect(allDesignerMessages.length).toBe(5);
		expect(allDesignerMessages.map((m) => {
			const payload = m.payload as { content?: string };
			return payload.content;
		})).toEqual([
			"Prompt 1",
			"Create users: " + "X".repeat(2400),
			"Prompt 3",
			"Prompt 4",
			"Prompt 5",
		]);
	});

	test("compaction survives runtime restart and keeps model context pruned to summary plus kept turns", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-compaction-restart-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Restart compaction" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({
			provider: "anthropic",
			models: [{
				id: "scripted-restart-model",
				name: "Scripted Restart Model",
				contextWindow: 2000,
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			}],
		});
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-api-key",
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([fauxText("Response to turn 1")]),
			fauxAssistantMessage([fauxText("Response to turn 2")]),
			fauxAssistantMessage([fauxText("Summary of turn 1: discussed initial schema decisions.")]),
		]);

		await runtime.sendMessage(conversation.id, "Turn 1 question", "scripted-restart-model");
		await runtime.sendMessage(conversation.id, "Turn 2 question: " + "K".repeat(2400), "scripted-restart-model");

		const savedBefore = runtime.loadConversation(conversation.id)!;
		expect(savedBefore.messages.some((m) => m.kind === "assistant-compaction")).toBe(true);

		runtime.close();

		const receivedAfterRestart: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
		const reopenedRuntime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-api-key",
			streamFn: async (model, context, options) => {
				receivedAfterRestart.push(JSON.parse(JSON.stringify(context)));
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(reopenedRuntime);

		scripted.setResponses([
			fauxAssistantMessage([fauxText("Response after restart")]),
			fauxAssistantMessage([fauxText("Summary after restart")]),
		]);

		await reopenedRuntime.sendMessage(conversation.id, "Turn 3 question after restart", "scripted-restart-model");

		expect(receivedAfterRestart.length).toBeGreaterThanOrEqual(1);
		const restartReq = receivedAfterRestart[0]!;

		// Model request must contain:
		// 1. System prompt
		expect(restartReq.messages[0]!.role).toBe("system");
		// 2. Summary
		expect(restartReq.messages[1]!.role).toBe("user");
		expect(typeof restartReq.messages[1]!.content === "string").toBe(true);
		expect(restartReq.messages[1]!.content as string).toContain("Summary of earlier conversation:");
		expect(restartReq.messages[1]!.content as string).toContain("Summary of turn 1: discussed initial schema decisions.");
		// 3. Kept turn (Turn 2)
		const containsTurn2 = restartReq.messages.some((m) => {
			if (typeof m.content === "string") return m.content.includes("Turn 2 question:");
			if (Array.isArray(m.content)) return m.content.some((c) => typeof c === "object" && c && "text" in c && typeof c.text === "string" && c.text.includes("Turn 2 question:"));
			return false;
		});
		expect(containsTurn2).toBe(true);
		// 4. NOT the compacted turn (Turn 1)
		const containsTurn1 = restartReq.messages.some((m) => {
			if (typeof m.content === "string") return m.content.includes("Turn 1 question");
			if (Array.isArray(m.content)) return m.content.some((c) => typeof c === "object" && c && "text" in c && typeof c.text === "string" && c.text.includes("Turn 1 question"));
			return false;
		});
		expect(containsTurn1).toBe(false);
		// 5. The new message (Turn 3)
		const containsTurn3 = restartReq.messages.some((m) => {
			if (typeof m.content === "string") return m.content.includes("Turn 3 question after restart");
			if (Array.isArray(m.content)) return m.content.some((c) => typeof c === "object" && c && "text" in c && typeof c.text === "string" && c.text.includes("Turn 3 question after restart"));
			return false;
		});
		expect(containsTurn3).toBe(true);
	});
	test("revert is available only while the project matches the latest completed turn", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-revert-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Revert turn" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_table (id integer PRIMARY KEY);" }),
				fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "assistant_scenario" }),
				fauxToolCall("manage_code", { action: "create", kind: "edge-function", name: "assistant_edge" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the project changes.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create the project changes.", "scripted-model");
		await workspace.setViewport({ designId: workspace.getState().activeDesignId!, x: 140, y: -35, zoom: 1.4 });
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["assistant_table"]);
		expect(workspace.getState().scenarios.map(({ name }) => name)).toEqual(["assistant_scenario"]);
		expect(workspace.getState().edgeFunctions.map(({ name }) => name)).toEqual(["assistant_edge"]);
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design?.viewport).toEqual({ x: 140, y: -35, zoom: 1.4 });
		expect(workspace.getState().design?.tables).toEqual([]);
		expect(workspace.getState().scenarios).toEqual([]);
		expect(workspace.getState().edgeFunctions).toEqual([]);
		expect(workspace.getState().undoRedo.canUndo).toBe(true);
	});
	test("does not offer revert when an Assistant turn leaves the project unchanged", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-revert-noop-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "No-op revert" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([fauxAssistantMessage([fauxText("There are no tables.")])]);
		await runtime.sendMessage(conversation.id, "List the tables.", "scripted-model");
		expect(runtime.canRevertTurn(conversation.id)).toBe(false);
	});

	test("preserves independent manual edits after turn on revert", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-revert-hand-edit-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Hand edit after turn" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_table (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the table.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create a table.", "scripted-model");
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "hand_table" });
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["hand_table"]);
	});
	test("delivers a message sent mid-turn as steering after the current tool call", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-steering-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Steering" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		let runtime: ReturnType<typeof createAssistantRuntime>;
		let conversationId = "";
		let requestCount = 0;
		let steeringPrompt = "";
		runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				requestCount += 1;
				if (requestCount === 2) {
					await runtime.sendMessage(conversationId, "Keep the next table name exact.", "scripted-model");
				}
				if (requestCount === 3) steeringPrompt = JSON.stringify(context.messages);
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		conversationId = conversation.id;
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE first_table (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE second_table (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Both tables are ready.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create two tables.", "scripted-model");
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["first_table", "second_table"]);
		expect(steeringPrompt).toContain("Keep the next table name exact.");
	});
	test("Stop keeps applied changes and leaves the stopped turn revertable", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-stop-revert-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Stop then revert" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const requestStarted = Promise.withResolvers<void>();
		const releaseRequest = Promise.withResolvers<void>();
		let requests = 0;
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				requests += 1;
				if (requests === 2) {
					requestStarted.resolve();
					await releaseRequest.promise;
				}
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE kept_after_stop (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("I would continue.")]),
		]);
		const turn = runtime.sendMessage(conversation.id, "Create and explain.", "scripted-model");
		await requestStarted.promise;
		runtime.stop(conversation.id);
		releaseRequest.resolve();
		await turn;
		expect(workspace.getState().design?.tables.map(({ name }) => name)).toEqual(["kept_after_stop"]);
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design?.tables).toEqual([]);
	});

	test("system prompt mentions GENERATED ALWAYS AS IDENTITY and states BY DEFAULT is unsupported (#107)", async () => {
		expect(SYSTEM_PROMPT).toContain("GENERATED ALWAYS AS IDENTITY");
		expect(SYSTEM_PROMPT).toContain("GENERATED BY DEFAULT is unsupported");

		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-prompt-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Prompt project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		let observedSystemPrompt = "";
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				const systemMessage = context.messages.find((m) => m.role === "system");
				if (systemMessage && typeof systemMessage.content === "string") {
					observedSystemPrompt = systemMessage.content;
				}
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([fauxAssistantMessage([fauxText("Ready.")])]);
		await runtime.sendMessage(conversation.id, "Hello", "scripted-model");

		expect(observedSystemPrompt).toContain("GENERATED ALWAYS AS IDENTITY");
		expect(observedSystemPrompt).toContain("GENERATED BY DEFAULT is unsupported");
	});

	test("apply_ddl tool result sent to the model is compact (<2 KB) without projects list or full design (#107)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-compact-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Compact project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const receivedContexts: Array<{ messages: Array<{ role: string; toolCallId?: string; content?: unknown }> }> = [];
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				receivedContexts.push(JSON.parse(JSON.stringify(context)));
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE users (id uuid PRIMARY KEY, name text);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the users table.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create users table.", "scripted-model");

		// streamFn was called twice: 1) initial user message, 2) after tool result
		expect(receivedContexts.length).toBe(2);
		const secondContext = receivedContexts[1]!;
		const toolResultMsg = secondContext.messages.find((m) => m.role === "toolResult");
		expect(toolResultMsg).toBeDefined();

		// Content sent to the model: [{ type: "text", text: string }]
		const contentBlocks = Array.isArray(toolResultMsg?.content) ? toolResultMsg.content : [];
		expect(contentBlocks.length).toBeGreaterThan(0);
		const textBlock = contentBlocks[0] as { type: string; text: string };
		expect(textBlock.type).toBe("text");
		const rawText = textBlock.text;

		// 1. Tool result content must be small (< 2 KB for a one-table change)
		expect(rawText.length).toBeLessThan(2048);

		// 2. Must not contain the projects list
		expect(rawText).not.toContain('"projects"');

		// 3. Must not contain the full design / tables state
		expect(rawText).not.toContain('"design"');
		expect(rawText).not.toContain('"position"');

		// 4. Compact content has the required single fields
		const parsed = JSON.parse(rawText) as Record<string, unknown>;
		expect(parsed).toEqual({
			status: "applied",
			statements: ["CREATE TABLE users (id uuid PRIMARY KEY, name text)"],
			affectedTables: [{ name: "users", change: "added" }],
			revision: 2,
			sql: "current",
			sandbox: "accepted",
			projectId: state.project.id,
			designId: state.activeDesignId,
		});

		// 5. Assert duplicate synonym fields are gone
		expect(parsed).not.toHaveProperty("statementsApplied");
		expect(parsed).not.toHaveProperty("newRevision");
		expect(parsed).not.toHaveProperty("generatedSqlStatus");
		expect(parsed).not.toHaveProperty("generatedSql");
		expect(parsed).not.toHaveProperty("sqlStatus");
		expect(parsed).not.toHaveProperty("sandboxOutcome");
		expect(parsed).not.toHaveProperty("sandboxStatus");
		const firstTable = (parsed.affectedTables as Array<Record<string, unknown>>)[0]!;
		expect(firstTable).not.toHaveProperty("status");
		expect(firstTable).not.toHaveProperty("action");
		expect(firstTable).not.toHaveProperty("added");
		expect(firstTable).not.toHaveProperty("changed");
		expect(firstTable).not.toHaveProperty("removed");

		// 6. Persisted message details in store also does not carry full WorkspaceState or duplicate fields
		const saved = runtime.loadConversation(conversation.id)!;
		const savedToolResult = saved.messages.find((m) => m.role === "toolResult");
		expect(savedToolResult).toBeDefined();
		const savedPayload = savedToolResult?.payload as { details?: Record<string, unknown> };
		expect(savedPayload.details).toBeDefined();
		expect(savedPayload.details).not.toHaveProperty("state");
		expect(savedPayload.details).not.toHaveProperty("projects");
		expect(savedPayload.details).not.toHaveProperty("design");
		expect(savedPayload.details).not.toHaveProperty("statementsApplied");
		expect(savedPayload.details).not.toHaveProperty("newRevision");
		expect(savedPayload.details).not.toHaveProperty("generatedSqlStatus");
		expect(savedPayload.details).not.toHaveProperty("sandboxOutcome");
		expect(savedPayload.details?.sql).toBe("current");
		expect(savedPayload.details?.sandbox).toBe("accepted");

		// 7. Trace rows and affected table links still work from compact details
		const items = buildTranscript(saved.messages, false);
		const toolItem = items.find((i) => i.kind === "tool" && (i as TranscriptToolItem).toolName === "apply_ddl") as TranscriptToolItem;
		expect(toolItem).toBeDefined();
		expect(toolItem.trace.title).toBe("Applied SQL to users");
		expect(toolItem.affectedTables).toEqual([
			expect.objectContaining({ name: "users", change: "added" }),
		]);
		expect(toolItem.affectedTables[0]!.id).toBeDefined();
	});

	test("maps sandbox outcomes exactly to accepted, checking, and { rejected: error } (#107, #108)", () => {
		// 1. applied -> "accepted"
		expect(compactSandboxStatus({
			status: "applied",
			revision: 1,
			tables: [],
			relationships: [],
			sql: "SELECT 1;",
		})).toBe("accepted");

		// 2. failed -> { rejected: error }
		expect(compactSandboxStatus({
			status: "failed",
			failure: "sql-rejected",
			revision: 1,
			attemptedSql: "CREATE TABLE bad (id bad_type);",
			error: 'type "bad_type" does not exist',
			lastApplied: null,
		})).toEqual({ rejected: 'type "bad_type" does not exist' });

		expect(compactSandboxStatus({
			status: "failed",
			failure: "sandbox-error",
			revision: 1,
			error: "database engine failure",
			lastApplied: null,
		})).toEqual({ rejected: "database engine failure" });

		// 3. anything else (idle, applying) -> "checking"
		expect(compactSandboxStatus({ status: "idle" })).toBe("checking");
		expect(compactSandboxStatus({
			status: "applying",
			revision: 2,
			attemptedSql: "CREATE TABLE users (id int);",
			lastApplied: null,
		})).toBe("checking");
	});

	test("maps sql status to current or { errors } (#107, #108)", () => {
		expect(compactSqlStatus({ status: "current", revision: 1, sql: "SELECT 1;" })).toBe("current");
		expect(compactSqlStatus({ status: "empty", draftRevision: 1, errors: ["No tables"] })).toEqual({ errors: ["No tables"] });
		expect(compactSqlStatus({ status: "stale", revision: 1, draftRevision: 2, sql: "SELECT 1;", errors: ["Missing column"] })).toEqual({ errors: ["Missing column"] });
		expect(compactSqlStatus({ status: "checking", draftRevision: 1, availableRevision: null, sql: null })).toEqual({ errors: [] });
	});

	test("system prompt guides Function and Trigger for foreign-key limits and forbids re-running confirmed drops (#112)", () => {
		expect(SYSTEM_PROMPT).toContain("When a requirement needs behaviour foreign keys cannot express (e.g. deleting a child also deletes its parent), implement it with a Function and a Trigger rather than proposing a simpler design.");
		expect(SYSTEM_PROMPT).toContain("a confirmed destructive change is already applied and must not be re-run");
	});

	test("confirmed destructive change provides applied toolResult to model with neutral continuation (#112)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-confirm-toolresult-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Confirm toolResult project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, author_id integer REFERENCES users(id));", { assistantTurnId: "setup" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const receivedContexts: Array<{ messages: Array<{ role: string; toolCallId?: string; content?: unknown }> }> = [];
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
			streamFn: async (model, context, options) => {
				receivedContexts.push(JSON.parse(JSON.stringify(context)));
				return models.streamSimple(model, context, options);
			},
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "DROP TABLE users; DROP TABLE posts;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The users and posts tables have been removed.")]),
		]);

		await runtime.sendMessage(conversation.id, "Drop users and posts.", "scripted-model");
		expect(runtime.isConfirmationPending(conversation.id)).toBe(true);

		const saved = runtime.loadConversation(conversation.id)!;
		const pendingToolResult = saved.messages.find(({ role }) => role === "toolResult")!;
		const toolCallId = (pendingToolResult.payload as { toolCallId: string }).toolCallId;

		await runtime.confirmDdlDrop(conversation.id, toolCallId);
		expect(runtime.isConfirmationPending(conversation.id)).toBe(false);

		expect(receivedContexts.length).toBe(2);
		const secondContext = receivedContexts[1]!;

		const toolResultMsg = [...secondContext.messages].reverse().find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
		expect(toolResultMsg).toBeDefined();

		const contentBlocks = Array.isArray(toolResultMsg?.content) ? toolResultMsg.content : [];
		const textBlock = contentBlocks[0] as { type: string; text: string };
		expect(textBlock.type).toBe("text");
		const appliedData = JSON.parse(textBlock.text);
		expect(appliedData.status).toBe("applied");
		expect(appliedData.statements).toEqual(["DROP TABLE users", "DROP TABLE posts"]);
		expect(appliedData.affectedTables).toEqual([
			{ name: "users", change: "removed" },
			{ name: "posts", change: "removed" },
		]);
		expect(typeof appliedData.revision).toBe("number");
		expect(appliedData.sql).toBeDefined();
		expect(appliedData.sandbox).toBeDefined();

		const continuationMsg = secondContext.messages[secondContext.messages.length - 1];
		expect(continuationMsg?.role).toBe("user");
		const continuationText = typeof continuationMsg?.content === "string"
			? continuationMsg.content
			: Array.isArray(continuationMsg?.content) && continuationMsg.content[0] && typeof continuationMsg.content[0] === "object" && "text" in continuationMsg.content[0]
				? (continuationMsg.content[0] as { text: string }).text
				: "";
		expect(continuationText).toBe("Continue after the confirmed destructive change.");
		expect(continuationText).not.toContain("Report its result");

		const loaded = runtime.loadConversation(conversation.id)!;
		const appliedToolResults = loaded.messages.filter(
			(m) => m.role === "toolResult" && JSON.stringify(m.payload).includes('"status":"applied"')
		);
		expect(appliedToolResults.length).toBeGreaterThan(0);
	});

	test("identical DDL re-run right after a confirmed apply returns already applied rather than error (#112)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-rerun-guard-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Guard project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, author_id integer REFERENCES users(id));", { assistantTurnId: "setup" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
		});
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "DROP TABLE users; DROP TABLE posts;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "DROP TABLE users; DROP TABLE posts;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Tables were already removed.")]),
		]);

		await runtime.sendMessage(conversation.id, "Drop users and posts.", "scripted-model");
		const saved = runtime.loadConversation(conversation.id)!;
		const pendingToolResult = saved.messages.find(({ role }) => role === "toolResult")!;
		const toolCallId = (pendingToolResult.payload as { toolCallId: string }).toolCallId;
		await runtime.confirmDdlDrop(conversation.id, toolCallId);
		expect(scripted.state.callCount).toBe(3);
		const loaded = runtime.loadConversation(conversation.id)!;
		const rerunToolResult = loaded.messages.find(
			(m) => m.role === "toolResult" && JSON.stringify(m.payload).includes("already applied")
		);
		expect(rerunToolResult).toBeDefined();
		const payloadStr = JSON.stringify(rerunToolResult?.payload);
		expect(payloadStr).toContain('"status":"already applied"');
		expect(payloadStr).not.toContain("does not exist");
	});
	test("stale relevant content: DDL on modified table prompts rereading while independent edit proceeds (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-stale-ddl-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Stale DDL" });
		if (!state.project) throw new Error("Expected the project to be open.");
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "authors" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "categories" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		// Turn 1: Assistant reads project.
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("read_project", {}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Read project complete.")]),
		]);
		await runtime.sendMessage(conversation.id, "Read project.", "scripted-model");

		// Designer modifies authors and creates an independent table logs:
		const authorsTable = workspace.getState().design!.tables.find((t) => t.name === "authors")!;
		await workspace.addColumn({ designId: workspace.getState().activeDesignId!, tableId: authorsTable.id, name: "bio", type: "text" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "logs" });

		// Turn 2: Assistant tries to alter authors without re-reading -> rejected as stale.
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "ALTER TABLE authors ADD COLUMN website text;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The alter was attempted.")]),
		]);
		await runtime.sendMessage(conversation.id, "Alter authors.", "scripted-model");
		const conv1 = runtime.loadConversation(conversation.id)!;
		const toolResults = conv1.messages.filter((m) => m.role === "toolResult");
		const ddlResult = toolResults[toolResults.length - 1];
		expect(JSON.stringify(ddlResult.payload)).toContain("Stale relevant content: table \\\"authors\\\" changed since last read");

		// Now assistant re-reads project and modifies categories while an independent table is added
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("read_project", {}),
				fauxToolCall("apply_ddl", { sql: "ALTER TABLE categories ADD COLUMN description text;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added description to categories.")]),
		]);
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "reviews" }); // independent manual edit
		await runtime.sendMessage(conversation.id, "Re-read and alter categories.", "scripted-model");
		const finalTables = workspace.getState().design!.tables.map((t) => t.name);
		expect(finalTables).toContain("authors");
		expect(finalTables).toContain("categories");
		expect(finalTables).toContain("logs");
		expect(finalTables).toContain("reviews");
		const cat = workspace.getState().design!.tables.find((t) => t.name === "categories")!;
		expect(cat.columns.map((c) => c.name)).toContain("description");
	}, 30_000);

	test("stale relevant content: source edit on modified Scenario prompts rereading (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-stale-source-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Stale Source" });
		if (!state.project) throw new Error("Expected the project to be open.");
		const s1State = await workspace.createScenario({ designId: workspace.getState().activeDesignId!, name: "Scenario 1" });
		const s1 = s1State.scenarios[0]!;
		await workspace.createScenario({ designId: workspace.getState().activeDesignId!, name: "Scenario 2" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		// Assistant reads project
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Read project done.")]),
		]);
		await runtime.sendMessage(conversation.id, "Read.", "scripted-model");

		// Designer manually edits Scenario 1
		await workspace.updateScenarioSource({ designId: workspace.getState().activeDesignId!, scenarioId: s1.id, source: "console.log('hand edit');" });

		// Assistant tries to write to Scenario 1
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("manage_code", { action: "write", kind: "scenario", id: s1.id, source: "console.log('stale overwrite');" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Wrote source.")]),
		]);
		await runtime.sendMessage(conversation.id, "Write code to Scenario 1.", "scripted-model");
		const conv = runtime.loadConversation(conversation.id)!;
		const toolResults = conv.messages.filter((m) => m.role === "toolResult");
		const writeResult = toolResults[toolResults.length - 1];
		expect(JSON.stringify(writeResult.payload)).toContain("Stale relevant content: Scenario \\\"Scenario 1\\\" changed since last read");
		expect(workspace.getState().scenarios.find((s) => s.id === s1.id)?.source).toBe("console.log('hand edit');");
	});

	test("conflicting inverse: dependent foreign key to assistant table leaves all content unchanged (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conflict-fk-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Conflict FK" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		// Assistant creates parent_table
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE parent_table (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created parent_table.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create parent_table.", "scripted-model");
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);

		// Designer manually adds child_table and a foreign key referencing parent_table
		const afterParent = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "child_table" });
		const parentTable = afterParent.design!.tables.find((t) => t.name === "parent_table")!;
		const childTable = afterParent.design!.tables.find((t) => t.name === "child_table")!;
		await workspace.addRelationship({
			designId: workspace.getState().activeDesignId!,
			referencingTableId: childTable.id,
			referencedTableId: parentTable.id,
			cardinality: "one-to-many",
		});

		// Attempt to revert the Assistant turn
		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			/Cannot revert Assistant turn due to conflicting items: table "parent_table" is referenced by foreign key on table "child_table"/,
		);

		// All project content remains unchanged!
		expect(workspace.getState().design!.tables.map((t) => t.name).sort()).toEqual(["child_table", "parent_table"]);
		expect(workspace.getState().design!.relationships).toHaveLength(1);
	});

	test("conflicting inverse: manual modification to assistant scenario leaves all content unchanged (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conflict-scenario-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Conflict Scenario" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "assistant_flow", source: "console.log(1);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created scenario.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create scenario.", "scripted-model");
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);

		const scenario = workspace.getState().scenarios.find((s) => s.name === "assistant_flow")!;
		await workspace.updateScenarioSource({ designId: workspace.getState().activeDesignId!, scenarioId: scenario.id, source: "console.log('manual edit');" });

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			/Cannot revert Assistant turn due to conflicting items: Scenario "assistant_flow" was modified after this turn/,
		);

		expect(workspace.getState().scenarios.find((s) => s.id === scenario.id)?.source).toBe("console.log('manual edit');");
	});

	test("atomic multi-artifact restoration: persistence failure rolls back SQLite and preserves workspace state (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-atomic-save-fail-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const store = openDesignStore(databasePath);
		const workspace = await createDesignWorkspace({ databasePath, openStore: () => store });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Atomic Fail" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t1 (id integer PRIMARY KEY);" }),
				fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "s1" }),
				fauxToolCall("manage_code", { action: "create", kind: "edge-function", name: "e1" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created changes.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create artifacts.", "scripted-model");
		expect(workspace.getState().design!.tables.map((t) => t.name)).toEqual(["t1"]);
		expect(workspace.getState().scenarios.map((s) => s.name)).toEqual(["s1"]);
		expect(workspace.getState().edgeFunctions.map((e) => e.name)).toEqual(["e1"]);

		// Intercept store.saveProjectArtifacts to simulate a failure inside the transaction
		const originalSave = store.saveProjectArtifacts.bind(store);
		let throwOnSave = true;
		store.saveProjectArtifacts = (input) => {
			if (throwOnSave) {
				throw new Error("Simulated SQLite write failure");
			}
			return originalSave(input);
		};

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow("Simulated SQLite write failure");

		// In-memory workspace state is completely preserved:
		expect(workspace.getState().design!.tables.map((t) => t.name)).toEqual(["t1"]);
		expect(workspace.getState().scenarios.map((s) => s.name)).toEqual(["s1"]);
		expect(workspace.getState().edgeFunctions.map((e) => e.name)).toEqual(["e1"]);

		// SQLite database was rolled back and still contains t1, s1, e1:
		const loadedProject = store.loadProject(state.project.id);
		expect(loadedProject!.design.tables.map((t) => t.name)).toEqual(["t1"]);
		const loadedScenarios = store.loadScenarios(state.project.id, state.activeDesignId!);
		expect(loadedScenarios.scenarios.map((s) => s.name)).toEqual(["s1"]);
		const loadedEdge = store.loadEdgeFunctions(state.project.id, state.activeDesignId!);
		expect(loadedEdge.edgeFunctions.map((e) => e.name)).toEqual(["e1"]);

		// When persistence succeeds, revert finishes cleanly
		throwOnSave = false;
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design!.tables).toEqual([]);
		expect(workspace.getState().scenarios).toEqual([]);
		expect(workspace.getState().edgeFunctions).toEqual([]);
	});
	test("preserves manual edits and persistence while Revert awaits an atomic save (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-restore-race-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const store = openDesignStore(databasePath);
		const workspace = await createDesignWorkspace({ databasePath, openStore: () => store });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Restore race" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_table (id integer PRIMARY KEY);" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created the table.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create a table.", "scripted-model");

		const originalSave = store.saveProjectArtifacts.bind(store);
		const { promise: entered, resolve: signal } = Promise.withResolvers<void>();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		store.saveProjectArtifacts = async (input) => {
			originalSave(input);
			signal();
			await gate;
		};

		const reverting = runtime.revertTurn(conversation.id);
		await entered;
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "manual_during_restore" });
		release();
		await reverting;

		expect(workspace.getState().design!.tables.map(({ name }) => name)).toEqual(["manual_during_restore"]);
		expect(store.loadProject(state.project.id)!.design.tables.map(({ name }) => name)).toEqual(["manual_during_restore"]);
	});

	test("Stop preserves live applied changes and leaves stopped turn safely revertable (#118)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-stop-revert-manual-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Stop Revert Manual" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		let stopTriggered = false;
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE kept_live (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			() => {
				if (!stopTriggered) {
					stopTriggered = true;
					runtime.stop(conversation.id);
				}
				return fauxAssistantMessage([fauxText("This will not be delivered.")]);
			},
		]);

		await runtime.sendMessage(conversation.id, "Create kept_live.", "scripted-model");
		expect(workspace.getState().design!.tables.map((t) => t.name)).toEqual(["kept_live"]);

		// Designer adds an independent manual table
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "hand_table" });
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);

		// Revert removes kept_live and keeps hand_table
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design!.tables.map((t) => t.name)).toEqual(["hand_table"]);
	});
	test("actor attribution: manual edit in microtask during apply_ddl await is preserved on Revert (#118 item 2)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-attribution-microtask-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Attribution Probe" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		const { promise: manualAdded, resolve: resolveManual } = Promise.withResolvers<void>();
		let probeFired = false;
		workspace.subscribe((event) => {
			if (!probeFired && event.design?.tables.some((t) => t.name === "assistant_table")) {
				probeFired = true;
				queueMicrotask(() => {
					void workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "manual_during_tool" }).then(() => resolveManual());
				});
			}
		});

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_table (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created assistant_table.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create assistant_table.", "scripted-model");
		await manualAdded;

		const tableNames = workspace.getState().design!.tables.map((t) => t.name);
		expect(tableNames).toContain("assistant_table");
		expect(tableNames).toContain("manual_during_tool");

		await runtime.revertTurn(conversation.id);
		const afterRevert = workspace.getState().design!.tables.map((t) => t.name);
		expect(afterRevert).not.toContain("assistant_table");
		expect(afterRevert).toContain("manual_during_tool");
	});

	test("conflicting inverse: manual edits to Assistant-created Function blocks Revert (#118 item 3)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-fn-conflict-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Fn Conflict" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE OR REPLACE FUNCTION answer() RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created function.")]),
		]);

		await runtime.sendMessage(conversation.id, "Create answer function.", "scripted-model");
		expect(workspace.getState().design!.functions?.map((f) => f.name)).toEqual(["answer"]);

		const fn = workspace.getState().design!.functions![0]!;
		await workspace.updateFunctions({
			designId: workspace.getState().activeDesignId!,
			functions: [{ ...fn, body: "SELECT 2;" }],
		});

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			/Cannot revert Assistant turn due to conflicting items: Function "answer" was modified after this turn/,
		);

		expect(workspace.getState().design!.functions?.find((f) => f.id === fn.id)?.body).toBe("SELECT 2;");
	});

	test("preserves manual indexes, unique constraints, and policies on Assistant-modified table (#118 item 4)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-preserve-metadata-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Preserve Metadata" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const tableState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "users" });
		const usersTable = tableState.design!.tables[0]!;
		await workspace.addColumn({ designId: workspace.getState().activeDesignId!, tableId: usersTable.id, name: "email", type: "text" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "ALTER TABLE users ADD COLUMN age integer;" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added age column.")]),
		]);
		await runtime.sendMessage(conversation.id, "Add age column.", "scripted-model");

		const updatedUsers = workspace.getState().design!.tables.find((t) => t.name === "users")!;
		const emailCol = updatedUsers.columns.find((c) => c.name === "email")!;
		await workspace.updateIndexes({
			designId: workspace.getState().activeDesignId!,
			tableId: updatedUsers.id,
			indexes: [{ id: "idx-1", name: "idx_users_email", method: "btree", keys: [{ columnId: emailCol.id }], unique: false }],
		});
		await workspace.updateUniqueConstraints({
			designId: workspace.getState().activeDesignId!,
			tableId: updatedUsers.id,
			uniqueConstraints: [{ id: "uc-1", name: "uc_users_email", columnIds: [emailCol.id] }],
		});
		await workspace.updatePolicies({
			designId: workspace.getState().activeDesignId!,
			tableId: updatedUsers.id,
			rowLevelSecurity: true,
			policies: [{ id: "pol-1", name: "allow_select", command: "SELECT", roles: ["public"], mode: "permissive", using: "true", withCheck: "" }],
		});

		await runtime.revertTurn(conversation.id);
		const restoredUsers = workspace.getState().design!.tables.find((t) => t.name === "users")!;
		expect(restoredUsers.columns.map((c) => c.name)).not.toContain("age");
		expect(restoredUsers.indexes?.map((i) => i.name)).toContain("idx_users_email");
		expect(restoredUsers.uniqueConstraints?.map((u) => u.name)).toContain("uc_users_email");
		expect(restoredUsers.policies?.map((p) => p.name)).toContain("allow_select");
	});

	test("dependency validation: manual referencing-side FK or trigger on Assistant table blocks Revert (#118 item 5)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-dep-val-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Dep Val" });
		if (!state.project) throw new Error("Expected the project to be open.");

		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "base_table" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE assistant_source (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created assistant_source.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create assistant_source.", "scripted-model");

		const curDesign = workspace.getState().design!;
		const astTable = curDesign.tables.find((t) => t.name === "assistant_source")!;
		const baseTable = curDesign.tables.find((t) => t.name === "base_table")!;
		await workspace.addRelationship({
			designId: workspace.getState().activeDesignId!,
			referencingTableId: astTable.id,
			referencedTableId: baseTable.id,
			cardinality: "one-to-many",
		});

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			/Cannot revert Assistant turn due to conflicting items:.*assistant_source/,
		);
		expect(workspace.getState().design!.tables.map((t) => t.name)).toContain("assistant_source");
	});

	test("atomic persistence: stale CAS revision triggers complete transaction rollback (#118 item 6)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-cas-rollback-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const store = openDesignStore(databasePath);
		const workspace = await createDesignWorkspace({ databasePath, openStore: () => store });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "CAS Rollback" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE ast_t (id integer PRIMARY KEY);" }),
				fauxToolCall("manage_code", { action: "create", kind: "scenario", name: "ast_s" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created changes.")]),
		]);
		await runtime.sendMessage(conversation.id, "Create.", "scripted-model");
		expect(workspace.getState().design!.tables.map((t) => t.name)).toEqual(["ast_t"]);
		expect(workspace.getState().scenarios.map((s) => s.name)).toEqual(["ast_s"]);

		store.saveScenarios(state.project.id, [{ id: "other", name: "other", source: "" }], { revision: 999, savedAt: Date.now() }, state.activeDesignId!);

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(/Stale scenario revision/);

		expect(workspace.getState().design!.tables.map((t) => t.name)).toEqual(["ast_t"]);
		expect(store.loadProject(state.project.id)!.design.tables.map((t) => t.name)).toEqual(["ast_t"]);
	});

	test("relevant stale-write: ALTER TABLE dependency on modified referenced table prompts rereading (#118 item 7)", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-alter-dep-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Alter Dep" });
		if (!state.project) throw new Error("Expected the project to be open.");

		await workspace.addTable({ designId: state.activeDesignId!, name: "users" });
		await workspace.addTable({ designId: state.activeDesignId!, name: "orders" });

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);
		const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
		runtimes.push(runtime);
		const conversation = runtime.createConversation(state.project.id);

		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Read complete.")]),
		]);
		await runtime.sendMessage(conversation.id, "Read.", "scripted-model");

		const usersTable = workspace.getState().design!.tables.find((t) => t.name === "users")!;
		await workspace.addColumn({ designId: state.activeDesignId!, tableId: usersTable.id, name: "bio", type: "text" });

		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "ALTER TABLE orders ADD COLUMN user_id integer REFERENCES users(id);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Alter attempted.")]),
		]);
		await runtime.sendMessage(conversation.id, "Alter orders.", "scripted-model");

		const conv = runtime.loadConversation(conversation.id)!;
		const toolResults = conv.messages.filter((m) => m.role === "toolResult");
		const lastResult = toolResults[toolResults.length - 1];
		expect(JSON.stringify(lastResult.payload)).toContain("Stale relevant content: referenced table \\\"users\\\" changed since last read");
	});
});
