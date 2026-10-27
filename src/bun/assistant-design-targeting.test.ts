import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace } from "./workspace";

// Each test starts real PGlite sandboxes, which take several seconds under load.
setDefaultTimeout(30_000);

/**
 * Assistant turns act on the Design they start on. Switching the open Design
 * during a turn must not retarget its tools, and Revert must restore only the
 * Design the turn changed. A new turn binds to the Design open when it starts.
 */

const directories: string[] = [];
const workspaces: Awaited<ReturnType<typeof createDesignWorkspace>>[] = [];
const runtimes: ReturnType<typeof createAssistantRuntime>[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setUp() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-design-"));
	directories.push(directory);
	const databasePath = join(directory, "project.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	const project = await workspace.createProject({ name: "Shop" });
	const orders = project.activeDesignId!;
	const support = (await workspace.createDesign({ name: "Support" })).activeDesignId!;
	await workspace.openDesign({ designId: orders });

	const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
	const models = createModels();
	models.setProvider(scripted.provider);
	const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
	runtimes.push(runtime);
	const conversation = runtime.createConversation(project.project!.id);
	return { workspace, runtime, scripted, conversation, orders, support };
}

function tableNames(workspace: Awaited<ReturnType<typeof createDesignWorkspace>>) {
	return (workspace.getState().design?.tables ?? []).map((table) => table.name);
}

describe("Assistant turns and the open design", () => {
	test("a tool call after the user opens another design refuses instead of writing it", async () => {
		const { workspace, runtime, scripted, conversation, support } = await setUp();
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE orders_table (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			async () => {
				await workspace.openDesign({ designId: support });
				return fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxText("Done.")]),
		]);

		await runtime.sendMessage(conversation.id, "Add an orders table.", "scripted-model");

		expect(workspace.getState().activeDesignId).toBe(support);
		expect(tableNames(workspace)).toEqual([]);
		expect(JSON.stringify(store(runtime, conversation.id))).toContain("works on another design");
	});

	test("revert refuses until the turn's design is open, then restores only that design", async () => {
		const { workspace, runtime, scripted, conversation, orders, support } = await setUp();
		await workspace.openDesign({ designId: support });
		await workspace.addTable({ designId: support, name: "tickets" });
		await workspace.openDesign({ designId: orders });
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE orders_table (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added the orders table.")]),
		]);
		await runtime.sendMessage(conversation.id, "Add an orders table.", "scripted-model");
		expect(tableNames(workspace)).toEqual(["orders_table"]);

		await workspace.openDesign({ designId: support });
		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow("Open the design this Assistant turn changed");
		expect(tableNames(workspace)).toEqual(["tickets"]);

		await workspace.openDesign({ designId: orders });
		await runtime.revertTurn(conversation.id);
		expect(tableNames(workspace)).toEqual([]);

		await workspace.openDesign({ designId: support });
		expect(tableNames(workspace)).toEqual(["tickets"]);
	});

	test("a new turn binds to the design open when it starts", async () => {
		const { workspace, runtime, scripted, conversation, orders, support } = await setUp();
		await workspace.openDesign({ designId: support });
		scripted.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE tickets_v2 (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added to Support.")]),
		]);
		await runtime.sendMessage(conversation.id, "Add a tickets table.", "scripted-model");

		expect(tableNames(workspace)).toEqual(["tickets_v2"]);
		await workspace.openDesign({ designId: orders });
		expect(tableNames(workspace)).toEqual([]);
	});
});

/** The conversation as stored, for asserting on the messages a tool returned. */
function store(runtime: ReturnType<typeof createAssistantRuntime>, conversationId: string) {
	return runtime.loadConversation(conversationId)?.messages ?? [];
}
