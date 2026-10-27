import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type JsonValue } from "@earendil-works/pi-ai";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { rebaseManualEdits } from "./project-history";
import { planWalkthroughOperations, walkthroughDiagnostics, checkWalkthroughReadPreconditions, type WalkthroughOperation } from "./walkthrough-operations";
import { compileWalkthroughPlayback } from "../shared/walkthrough-playback";
import { createEmptySystemDesign, findSystemConnection, type SystemDesign } from "../shared/system-design";
import { walkthroughSteps, type Walkthrough } from "../shared/walkthrough";

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];
const runtimes: ReturnType<typeof createAssistantRuntime>[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.close?.();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/**
 * An image-upload architecture with a database component linked to an "Orders"
 * design, opened as the active design, and a manual Walkthrough that plays the
 * publish Connection. The Assistant runs against this Project through a scripted provider.
 */
async function walkthroughProject(name: string) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-walkthroughs-"));
	directories.push(directory);
	const databasePath = join(directory, "project.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	const state = await workspace.createProject({ name });
	if (!state.project) throw new Error("Expected the project to be open.");
	await workspace.addSystemComponent({ id: "api", name: "API", x: 0, y: 0 });
	await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 0 });
	await workspace.addSystemConnection({ id: "publish", sourceId: "api", targetId: "queue", label: "Publishes" });
	await workspace.addSystemComponent({ id: "orders-db", kind: "database", name: "Orders DB", x: 600, y: 0 });
	const orders = await workspace.createSystemDatabaseDesign({ componentId: "orders-db", name: "Orders" });
	const ordersId = orders.designs.find((design) => design.name === "Orders")!.id;
	await workspace.openDesign({ designId: ordersId });
	const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
	const models = createModels();
	models.setProvider(scripted.provider);
	const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
	runtimes.push(runtime);
	const conversation = runtime.createConversation(state.project.id);
	return { workspace, runtime, scripted, conversation, ordersId, databasePath };
}

/** Three Connections the demo request adds, plus the Walkthrough it writes. */
const DEMO_SYSTEM_OPERATIONS: JsonValue[] = [
	{ op: "add_component", id: "worker", name: "Fulfilment worker", kind: "worker", x: 300, y: 200 },
	{ op: "add_connection", id: "deliver", sourceId: "queue", targetId: "worker", label: "Delivers order" },
	{ op: "add_connection", id: "write", sourceId: "worker", targetId: "orders-db", label: "Writes fulfilment" },
	{ op: "add_connection", id: "confirm", sourceId: "worker", targetId: "api", label: "Confirms order" },
];

const DEMO_WALKTHROUGH_OPERATIONS: JsonValue[] = [
	{ op: "create_walkthrough", id: "fulfil", name: "Order fulfilment" },
	{ op: "add_step", id: "s-publish", walkthroughId: "fulfil", connectionId: "publish", title: "Publish order", action: "send", explanation: "The API publishes the order." },
	{ op: "add_step", id: "s-deliver", walkthroughId: "fulfil", connectionId: "deliver", title: "Deliver order", action: "receive", explanation: "The queue hands the order to a worker." },
	{ op: "add_block", id: "fanout", walkthroughId: "fulfil", kind: "parallel" },
	{ op: "add_step", id: "s-write", walkthroughId: "fulfil", connectionId: "write", title: "Write fulfilment", action: "process", sequence: { blockId: "fanout", branch: 0 }, explanation: "The worker records the fulfilment." },
	{ op: "add_step", id: "s-confirm", walkthroughId: "fulfil", connectionId: "confirm", title: "Confirm order", action: "send", sequence: { blockId: "fanout", branch: 1 }, explanation: "The worker confirms to the API." },
	{ op: "update_step", walkthroughId: "fulfil", stepId: "s-write", durationMs: 900, travelPercent: 70 },
	{ op: "add_block", id: "retry", walkthroughId: "fulfil", kind: "repeat" },
	{ op: "update_repeat", walkthroughId: "fulfil", blockId: "retry", count: 2 },
	{ op: "add_step", id: "s-attempt", walkthroughId: "fulfil", connectionId: "write", title: "Retry write", action: "process", sequence: { blockId: "retry" }, explanation: "A failed write is retried." },
];

/** Opens the same saved Project in a fresh workspace, as after an app restart. */
async function reopenSaved(databasePath: string, projectId: string): Promise<DesignWorkspace> {
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	await workspace.openProject({ projectId });
	return workspace;
}

/** One Assistant request: adds a worker, changes the linked Orders schema, and writes the Walkthrough. */
function demoResponses(scripted: ReturnType<typeof fauxProvider>) {
	scripted.setResponses([
		fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read_walkthroughs", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("edit_system_design", { operations: DEMO_SYSTEM_OPERATIONS })], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("apply_ddl", { sql: "CREATE TABLE fulfilments (id uuid PRIMARY KEY, order_id uuid NOT NULL, status text NOT NULL);" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("edit_walkthroughs", { operations: DEMO_WALKTHROUGH_OPERATIONS })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Added the worker, the fulfilments table, and the fulfilment Walkthrough.")]),
	]);
}

function toolResultsText(runtime: ReturnType<typeof createAssistantRuntime>, conversationId: string): string {
	const saved = runtime.loadConversation(conversationId);
	return JSON.stringify(saved?.messages.filter((message) => message.role === "toolResult") ?? []);
}

describe("One Assistant request across architecture, schema, and Walkthroughs", () => {
	test("adds a worker, changes the linked Orders schema, and writes a Walkthrough with parallel branches and a finite retry", async () => {
		const { workspace, runtime, scripted, conversation, ordersId } = await walkthroughProject("Fulfilment");
		demoResponses(scripted);

		await runtime.sendMessage(conversation.id, "Add a fulfilment worker that writes to Orders and show the flow.", "scripted-model");

		const state = workspace.getState();
		expect(state.systemDesign?.components.map((component) => component.id)).toEqual(["api", "queue", "orders-db", "worker"]);
		expect(state.design?.tables.map((table) => table.name)).toEqual(["fulfilments"]);
		expect(state.activeDesignId).toBe(ordersId);

		const walkthrough = state.walkthroughs?.find((item) => item.id === "fulfil") as Walkthrough;
		expect(walkthrough.blocks.map((block) => block.kind)).toEqual(["step", "step", "parallel", "repeat"]);
		const parallel = walkthrough.blocks[2] as Extract<Walkthrough["blocks"][number], { kind: "parallel" }>;
		expect(parallel.branches.map((branch) => branch.map((block) => block.kind === "step" ? block.step.id : block.kind))).toEqual([["s-write"], ["s-confirm"]]);
		const repeat = walkthrough.blocks[3] as Extract<Walkthrough["blocks"][number], { kind: "repeat" }>;
		expect(repeat.count).toBe(2);
		expect(walkthroughSteps(walkthrough).find((step) => step.id === "s-write")).toMatchObject({ durationMs: 900, travelPercent: 70 });

		// The saved Walkthrough compiles into a playback timeline against the same System design.
		const playback = compileWalkthroughPlayback(walkthrough, state.systemDesign!);
		expect(playback.ok).toBe(true);
		if (!playback.ok) throw new Error(playback.problems.join("; "));
		expect(playback.timeline.steps.map((step) => step.stepId)).toEqual([
			"s-publish", "s-deliver", "s-write", "s-confirm", "s-attempt", "s-attempt",
		]);
		expect(playback.timeline.steps.filter((step) => step.stepId === "s-attempt").map((step) => step.repetition)).toEqual([
			{ iteration: 1, count: 2 },
			{ iteration: 2, count: 2 },
		]);
		expect(toolResultsText(runtime, conversation.id)).toContain('"status\\":\\"applied');
	});

	test("the whole request is one Project history action: Undo reverses architecture, schema, and Walkthroughs together, and Redo restores them", async () => {
		const { workspace, runtime, scripted, conversation } = await walkthroughProject("Undo");
		demoResponses(scripted);
		await runtime.sendMessage(conversation.id, "Add a fulfilment worker.", "scripted-model");
		expect(workspace.getState().undoActionName).toBe("Assistant turn");

		await workspace.undo({ designId: workspace.getState().activeDesignId! });

		const undone = workspace.getState();
		expect(undone.systemDesign?.components.map((component) => component.id)).toEqual(["api", "queue", "orders-db"]);
		expect(undone.design?.tables).toEqual([]);
		expect(undone.walkthroughs).toEqual([]);
		expect(undone.redoActionName).toBe("Assistant turn");
		expect(undone.undoActionName).not.toBe("Assistant turn");

		await workspace.redo({ designId: undone.activeDesignId! });
		const redone = workspace.getState();
		expect(redone.design?.tables.map((table) => table.name)).toEqual(["fulfilments"]);
		expect(redone.walkthroughs?.map((item) => item.id)).toEqual(["fulfil"]);
		expect(redone.systemDesign?.components.map((component) => component.id)).toContain("worker");
	});

	test("the request's architecture, schema, and Walkthrough changes persist after a restart, and Revert persists its restoration", async () => {
		const { workspace, runtime, scripted, conversation, databasePath } = await walkthroughProject("Persist");
		const projectId = workspace.getState().project!.id;
		demoResponses(scripted);
		await runtime.sendMessage(conversation.id, "Add a fulfilment worker.", "scripted-model");
		const saved = await reopenSaved(databasePath, projectId);
		expect(saved.getState().walkthroughs?.map((item) => item.id)).toEqual(["fulfil"]);
		expect(saved.getState().systemDesign?.components.map((component) => component.id)).toContain("worker");
		expect(saved.getState().walkthroughs?.[0]?.blocks.length).toBe(4);

		await runtime.revertTurn(conversation.id);
		const reverted = await reopenSaved(databasePath, projectId);
		expect(reverted.getState().walkthroughs).toEqual([]);
		expect(reverted.getState().systemDesign?.components.map((component) => component.id)).toEqual(["api", "queue", "orders-db"]);
	});

	test("Revert reverses the whole request in one step, and leaves an unrelated Walkthrough a designer added afterwards", async () => {
		const { workspace, runtime, scripted, conversation } = await walkthroughProject("Revert");
		demoResponses(scripted);
		await runtime.sendMessage(conversation.id, "Add a fulfilment worker.", "scripted-model");
		await workspace.createWalkthrough({ id: "manual", name: "Manual cache path" });

		await runtime.revertTurn(conversation.id);

		const reverted = workspace.getState();
		expect(reverted.systemDesign?.components.map((component) => component.id)).toEqual(["api", "queue", "orders-db"]);
		expect(reverted.systemDesign?.connections.map((connection) => connection.id)).toEqual(["publish"]);
		expect(reverted.design?.tables).toEqual([]);
		expect(reverted.walkthroughs?.map((item) => item.id)).toEqual(["manual"]);
	});

	test("Revert is refused, naming the Walkthrough, when a designer edits one of its steps after the turn", async () => {
		const { workspace, runtime, scripted, conversation } = await walkthroughProject("Conflict");
		demoResponses(scripted);
		await runtime.sendMessage(conversation.id, "Add a fulfilment worker.", "scripted-model");
		await workspace.updateWalkthroughStep({ walkthroughId: "fulfil", stepId: "s-write", changes: { explanation: "Writes the order row first." } });

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			'Cannot revert Assistant turn due to conflicting items: Walkthrough "Order fulfilment" was modified after this Assistant turn',
		);
		expect(workspace.getState().design?.tables.map((table) => table.name)).toEqual(["fulfilments"]);
		expect(workspace.getState().walkthroughs?.find((item) => item.id === "fulfil")?.blocks.length).toBe(4);
	});

	test("a Walkthrough edit made after the Assistant read it is refused, and nothing in the batch applies", async () => {
		const { workspace, runtime, scripted, conversation } = await walkthroughProject("Stale read");
		await workspace.createWalkthrough({ id: "tour", name: "Tour" });
		await workspace.addWalkthroughStep({ id: "tour-publish", walkthroughId: "tour", connectionId: "publish", explanation: "Original text." });
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_walkthroughs", {})], { stopReason: "toolUse" }),
			async () => {
				await workspace.updateWalkthroughStep({ walkthroughId: "tour", stepId: "tour-publish", changes: { explanation: "Designer's edit." } });
				return fauxAssistantMessage([
					fauxToolCall("edit_walkthroughs", {
						operations: [
							{ op: "update_step", walkthroughId: "tour", stepId: "tour-publish", explanation: "Assistant's edit." },
							{ op: "create_walkthrough", id: "extra", name: "Extra" },
						],
					}),
				], { stopReason: "toolUse" });
			},
			fauxAssistantMessage([fauxText("The Walkthrough changed; I did not apply the edit.")]),
		]);

		await runtime.sendMessage(conversation.id, "Rewrite the tour explanation.", "scripted-model");

		expect(workspace.getState().walkthroughs?.find((item) => item.id === "tour")?.blocks).toEqual([
			expect.objectContaining({ kind: "step", step: expect.objectContaining({ explanation: "Designer's edit." }) }),
		]);
		expect(workspace.getState().walkthroughs?.map((item) => item.id)).toEqual(["tour"]);
		expect(toolResultsText(runtime, conversation.id)).toContain("changed after you read the Walkthroughs: Walkthrough \\\"Tour\\\"");
	});

	test("removing a Connection that a step plays keeps the step's explanation and reports it as dangling for repair", async () => {
		const { workspace, runtime, scripted, conversation } = await walkthroughProject("Dangling");
		await workspace.createWalkthrough({ id: "tour", name: "Tour" });
		await workspace.addWalkthroughStep({ id: "tour-publish", walkthroughId: "tour", connectionId: "publish", explanation: "Keep this text." });
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([
				fauxToolCall("edit_system_design", { operations: [{ op: "remove_connection", connectionId: "publish" }] }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Removed the publish Connection.")]),
		]);

		await runtime.sendMessage(conversation.id, "Remove the publish connection.", "scripted-model");

		const step = walkthroughSteps(workspace.getState().walkthroughs!.find((item) => item.id === "tour")!)[0]!;
		expect(step).toMatchObject({ id: "tour-publish", connectionId: "publish", explanation: "Keep this text." });
		const text = toolResultsText(runtime, conversation.id);
		expect(text).toContain("walkthroughImpacts");
		expect(text).toContain('Walkthrough \\\"Tour\\\" step \\\"Publishes\\\" (tour-publish) plays Connection publish, which no longer exists');
	});

	test("a manual edit made during the turn to a step the Assistant did not touch survives Revert's rebase", () => {
		const base = [{ id: "w", name: "W", blocks: [{ kind: "step", step: { id: "a", title: "A" } }] }];
		const manualBefore = base;
		const manualAfter = [{ id: "w", name: "W", blocks: [{ kind: "step", step: { id: "a", title: "A renamed" } }] }];
		const assistantAfter = [{ id: "w", name: "W", blocks: [
			{ kind: "step", step: { id: "a", title: "A" } },
			{ kind: "step", step: { id: "b", title: "Added by the Assistant" } },
		] }];
		const merged = rebaseManualEdits(manualBefore, manualAfter, assistantAfter) as typeof base & Array<{ blocks: Array<{ step: { id: string; title: string } }> }>;
		expect(merged[0]!.blocks.map((block) => block.step)).toEqual([
			{ id: "a", title: "A renamed" },
			{ id: "b", title: "Added by the Assistant" },
		]);
	});
});

describe("Walkthrough batches", () => {
	function designWithConnection(): SystemDesign {
		let design = createEmptySystemDesign();
		design = {
			...design,
			components: [
				{ id: "api", kind: "generic", name: "API", position: { x: 0, y: 0 }, serviceId: null, properties: [] },
				{ id: "queue", kind: "generic", name: "Queue", position: { x: 300, y: 0 }, serviceId: null, properties: [] },
			] as SystemDesign["components"],
			connections: [{ id: "publish", sourceId: "api", targetId: "queue", label: "Publishes", bendPoints: [] } as SystemDesign["connections"][number]],
		};
		return design;
	}

	test("a batch with one invalid operation changes nothing and names the failing operation", () => {
		const design = designWithConnection();
		const operations: WalkthroughOperation[] = [
			{ op: "create_walkthrough", id: "tour", name: "Tour" },
			{ op: "add_step", id: "s1", walkthroughId: "tour", connectionId: "missing" },
		];
		expect(() => planWalkthroughOperations([], operations, design)).toThrow(
			/Operation 2 \(add_step\): connectionId "missing" does not match a Connection in the System design/,
		);
	});

	test("a parallel block needs a branch to place a step in, and a repeat block takes a fixed count", () => {
		const design = designWithConnection();
		expect(() => planWalkthroughOperations([], [
			{ op: "create_walkthrough", id: "tour", name: "Tour" },
			{ op: "add_block", id: "fan", walkthroughId: "tour", kind: "parallel" },
			{ op: "add_step", id: "s1", walkthroughId: "tour", connectionId: "publish", sequence: { blockId: "fan" } },
		], design)).toThrow(/Choose a branch of the parallel block/);
		expect(() => planWalkthroughOperations([], [
			{ op: "create_walkthrough", id: "tour", name: "Tour" },
			{ op: "add_block", id: "again", walkthroughId: "tour", kind: "repeat" },
			{ op: "update_repeat", walkthroughId: "tour", blockId: "again", count: 0 },
		], design)).toThrow(/runs from 1 to 10 times/);
	});

	test("a redirected step is reported for review, and accept_redirection clears the review while keeping the explanation", () => {
		const design = designWithConnection();
		const created = planWalkthroughOperations([], [
			{ op: "create_walkthrough", id: "tour", name: "Tour" },
			{ op: "add_step", id: "s1", walkthroughId: "tour", connectionId: "publish", explanation: "Keep me." },
		], design).next;
		const redirected: SystemDesign = {
			...design,
			connections: design.connections.map((connection) => ({ ...connection, targetId: "api" })),
		};
		expect(walkthroughDiagnostics(created, redirected)).toEqual([
			expect.stringContaining("now runs from api to api instead of api to queue"),
		]);
		const accepted = planWalkthroughOperations(created, [{ op: "accept_redirection", walkthroughId: "tour", stepId: "s1" }], redirected).next;
		expect(walkthroughDiagnostics(accepted, redirected)).toEqual([]);
		expect(walkthroughSteps(accepted[0]!)[0]).toMatchObject({ explanation: "Keep me.", route: { sourceId: "api", targetId: "api" } });
		expect(findSystemConnection(redirected, "publish")).toBeDefined();
	});

	test("read precondition names only the Walkthroughs the batch edits", () => {
		const design = designWithConnection();
		const read = planWalkthroughOperations([], [
			{ op: "create_walkthrough", id: "tour", name: "Tour" },
			{ op: "create_walkthrough", id: "other", name: "Other" },
		], design).next;
		const changed = read.map((walkthrough) => walkthrough.id === "other" ? { ...walkthrough, name: "Renamed" } : walkthrough);
		expect(() => checkWalkthroughReadPreconditions(read, changed, [{ op: "rename_walkthrough", walkthroughId: "tour", name: "Trip" }])).not.toThrow();
		expect(() => checkWalkthroughReadPreconditions(read, changed, [{ op: "rename_walkthrough", walkthroughId: "other", name: "Trip" }])).toThrow(
			'These changed after you read the Walkthroughs: Walkthrough "Other"',
		);
	});
});
