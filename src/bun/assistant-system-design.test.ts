import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];
const runtimes: ReturnType<typeof createAssistantRuntime>[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.close?.();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Opens a Project whose Assistant replies come from a scripted provider. */
async function scriptedProject(name: string) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-system-"));
	directories.push(directory);
	const databasePath = join(directory, "project.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	const state = await workspace.createProject({ name });
	if (!state.project) throw new Error("Expected the project to be open.");
	const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
	const models = createModels();
	models.setProvider(scripted.provider);
	const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
	runtimes.push(runtime);
	const conversation = runtime.createConversation(state.project.id);
	return { workspace, runtime, scripted, conversation };
}

describe("Assistant edits to the System design", () => {
	test("reads the project, adds a Component and a labeled Connection in one turn, and Revert undoes the whole turn", async () => {
		const { workspace, runtime, scripted, conversation } = await scriptedProject("Image upload");
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [
						{ op: "add_component", id: "api", name: "Upload API", kind: "generic", x: 100, y: 40 },
						{ op: "add_component", id: "queue", name: "Upload queue", kind: "generic", x: 360, y: 40 },
						{ op: "add_connection", id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueues upload" },
					],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added the upload API and queue.")]),
		]);

		await runtime.sendMessage(conversation.id, "Add an upload API that enqueues work.", "scripted-model");

		const system = workspace.getState().systemDesign!;
		expect(system.components.map((component) => component.name)).toEqual(["Upload API", "Upload queue"]);
		expect(system.connections.map((connection) => connection.label)).toEqual(["Enqueues upload"]);
		expect(workspace.getState().systemSave?.status).toBe("saved");

		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().systemDesign?.components).toEqual([]);
		expect(workspace.getState().systemDesign?.connections).toEqual([]);
	});

	test("a batch with one invalid operation changes nothing and reports the error to the Assistant", async () => {
		const { workspace, runtime, scripted, conversation } = await scriptedProject("Atomic batch");
		await workspace.addSystemComponent({ id: "manual", name: "Manual", x: 0, y: 0 });
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [
						{ op: "add_component", id: "worker", name: "Worker", x: 200, y: 0 },
						{ op: "add_connection", id: "broken", sourceId: "manual", targetId: "nowhere", label: "Calls" },
					],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("That batch was refused.")]),
		]);

		await runtime.sendMessage(conversation.id, "Add a worker and connect it.", "scripted-model");

		expect(workspace.getState().systemDesign?.components.map((component) => component.id)).toEqual(["manual"]);
		const saved = runtime.loadConversation(conversation.id);
		const toolResults = saved?.messages.filter((message) => message.role === "toolResult") ?? [];
		expect(JSON.stringify(toolResults)).toContain('targetId \\"nowhere\\" does not match a Component.');
	});

	test("Revert drops Group membership of a Component it removes, and keeps the Group and its other members", async () => {
		const { workspace, runtime, scripted, conversation } = await scriptedProject("Groups");
		await workspace.addSystemComponent({ id: "manual", name: "Manual", x: 0, y: 0 });
		await workspace.addSystemGroup({ id: "domain", name: "Domain", x: -24, y: -48, memberIds: ["manual"] });
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [{ op: "add_component", id: "cache", name: "Cache", kind: "generic", x: 40, y: 40 }],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added a cache.")]),
		]);
		await runtime.sendMessage(conversation.id, "Add a cache.", "scripted-model");
		// A designer then files the Assistant's new Component into the existing Group.
		await workspace.updateSystemGroup({ groupId: "domain", changes: { memberIds: ["manual", "cache"] } });

		await runtime.revertTurn(conversation.id);
		const system = workspace.getState().systemDesign!;
		expect(system.components.map((component) => component.id)).toEqual(["manual"]);
		expect(system.groups).toEqual([expect.objectContaining({ id: "domain", memberIds: ["manual"] })]);
	});

	test("Revert is refused with the conflicting Component named when a designer moved it after the turn", async () => {
		const { workspace, runtime, scripted, conversation } = await scriptedProject("Conflict");
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [{ op: "add_component", id: "cache", name: "Cache", kind: "generic", x: 40, y: 40 }],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Added a cache.")]),
		]);
		await runtime.sendMessage(conversation.id, "Add a cache.", "scripted-model");
		await workspace.moveSystemComponent({ componentId: "cache", x: 500, y: 300 });

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			'Cannot revert Assistant turn due to conflicting items: Component "Cache" was modified after this Assistant turn',
		);
		expect(workspace.getState().systemDesign?.components).toEqual([
			expect.objectContaining({ id: "cache", position: { x: 500, y: 300 } }),
		]);
	});
});
