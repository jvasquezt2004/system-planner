import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { systemDesignContent } from "../shared/system-design";

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
		expect(JSON.stringify(toolResults)).toContain('targetId \\"nowhere\\" does not match a Component or Service.');
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

	test("one turn reads the architecture, assigns ownership, groups, links a database design, routes, and arranges; Revert restores all of it", async () => {
		const { workspace, runtime, scripted, conversation } = await architectureProject("Commerce");
		const designId = workspace.getState().designs.find((design) => design.name === "Orders")!.id;
		const before = JSON.stringify(systemDesignContent(workspace.getState().systemDesign!));
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [
						{ op: "add_service", id: "edge", name: "Edge" },
						{ op: "update_component", componentId: "api", ownerServiceId: "edge" },
						{ op: "add_group", id: "commerce", name: "Commerce", memberIds: ["api", "orders-db"] },
						{ op: "add_component", id: "replica", kind: "database", name: "Read replica", linkedDesignId: designId, x: 600, y: 200 },
						{ op: "update_connection", connectionId: "publish", fromSide: "right", toSide: "left", bendPoints: [{ x: 250, y: -40 }] },
						{ op: "arrange_layout" },
					],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Arranged the commerce system.")]),
		]);

		await runtime.sendMessage(conversation.id, "Put the API at the edge, group the commerce parts, and arrange the layout.", "scripted-model");

		const system = workspace.getState().systemDesign!;
		expect(system.services.map((service) => service.id)).toEqual(["edge"]);
		expect(system.components.find((component) => component.id === "api")?.serviceId).toBe("edge");
		expect(system.groups).toEqual([expect.objectContaining({ id: "commerce", memberIds: ["api", "orders-db"] })]);
		expect(system.components.find((component) => component.id === "replica")?.designId).toBe(designId);
		expect(system.connections.find((connection) => connection.id === "publish")).toMatchObject({
			fromSide: "right",
			toSide: "left",
			bendPoints: [{ x: 250, y: -40 }],
		});
		const at = (id: string) => system.components.find((component) => component.id === id)!.position;
		expect(at("queue").x - at("api").x).toBe(240);
		expect(workspace.getState().systemSave?.status).toBe("saved");

		const saved = runtime.loadConversation(conversation.id);
		const readResult = saved?.messages.find((message) => message.role === "toolResult" && JSON.stringify(message).includes('\\"diagnostics\\"'));
		expect(readResult).toBeDefined();
		expect(JSON.stringify(readResult)).toContain(designId);

		await runtime.revertTurn(conversation.id);
		expect(JSON.stringify(systemDesignContent(workspace.getState().systemDesign!))).toBe(before);
	});

	test("Undo steps back over the whole Assistant turn in one action, including ownership and the layout", async () => {
		const { workspace, runtime, scripted, conversation } = await architectureProject("Undo turn");
		const designId = workspace.getState().designs.find((design) => design.name === "Orders")!.id;
		const before = JSON.stringify(systemDesignContent(workspace.getState().systemDesign!));
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [
						{ op: "add_service", id: "edge", name: "Edge" },
						{ op: "update_component", componentId: "api", ownerServiceId: "edge" },
						{ op: "update_component", componentId: "orders-db", linkedDesignId: designId },
						{ op: "arrange_layout" },
					],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Done.")]),
		]);
		await runtime.sendMessage(conversation.id, "Assign the API to an edge Service and arrange the layout.", "scripted-model");
		expect(workspace.getState().systemDesign?.services.map((service) => service.id)).toEqual(["edge"]);

		await workspace.undo({ designId: workspace.getState().activeDesignId! });

		expect(JSON.stringify(systemDesignContent(workspace.getState().systemDesign!))).toBe(before);
	});

	test("an arrangement based on a read the designer has since outdated is refused, and the designer's move stays", async () => {
		const { workspace, runtime, scripted, conversation } = await architectureProject("Stale read");
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Read the architecture.")]),
		]);
		await runtime.sendMessage(conversation.id, "Read the architecture.", "scripted-model");

		await workspace.moveSystemComponent({ componentId: "queue", x: 900, y: 500 });
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("edit_system_design", { operations: [{ op: "arrange_layout" }] })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The layout changed; I need to read it again.")]),
		]);
		await runtime.sendMessage(conversation.id, "Arrange the layout.", "scripted-model");

		expect(workspace.getState().systemDesign?.components.find((component) => component.id === "queue")?.position).toEqual({ x: 900, y: 500 });
		const saved = runtime.loadConversation(conversation.id);
		const toolResults = saved?.messages.filter((message) => message.role === "toolResult") ?? [];
		expect(JSON.stringify(toolResults)).toContain("These items changed after you read the project: component queue.");
	});

	test("an unknown database design is refused and nothing in the batch applies", async () => {
		const { workspace, runtime, scripted, conversation } = await architectureProject("Unknown design");
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [
						{ op: "add_service", id: "edge", name: "Edge" },
						{ op: "update_component", componentId: "orders-db", linkedDesignId: "nowhere" },
					],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("That design is not in this Project.")]),
		]);

		await runtime.sendMessage(conversation.id, "Link the database to a missing design.", "scripted-model");

		expect(workspace.getState().systemDesign?.services).toEqual([]);
		const saved = runtime.loadConversation(conversation.id);
		expect(JSON.stringify(saved?.messages ?? [])).toContain('linkedDesignId \\"nowhere\\" does not match a database design in this Project.');
	});

	test("Revert is refused and names the Group when a designer changed it after the turn", async () => {
		const { workspace, runtime, scripted, conversation } = await architectureProject("Group conflict");
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", {
					operations: [{ op: "add_group", id: "commerce", name: "Commerce", memberIds: ["api"] }],
				}),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Grouped the API.")]),
		]);
		await runtime.sendMessage(conversation.id, "Group the API.", "scripted-model");
		await workspace.updateSystemGroup({ groupId: "commerce", changes: { name: "Renamed" } });

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			'Cannot revert Assistant turn due to conflicting items: Group "Commerce" was modified after this Assistant turn',
		);
		expect(workspace.getState().systemDesign?.groups).toEqual([expect.objectContaining({ id: "commerce", name: "Renamed" })]);
	});
});

/** A Project with an API, a queue it publishes to, and a database Component linked to a design named Orders. */
async function architectureProject(name: string) {
	const project = await scriptedProject(name);
	const { workspace } = project;
	await workspace.addSystemComponent({ id: "api", name: "API", x: 0, y: 0 });
	await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 0 });
	await workspace.addSystemConnection({ id: "publish", sourceId: "api", targetId: "queue", label: "Publishes" });
	await workspace.addSystemComponent({ id: "orders-db", kind: "database", name: "Orders DB", x: 600, y: 0 });
	await workspace.createSystemDatabaseDesign({ componentId: "orders-db", name: "Orders" });
	return project;
}
