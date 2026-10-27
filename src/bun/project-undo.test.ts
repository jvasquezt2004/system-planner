import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design, DesignTable } from "../shared/design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { openDesignStore } from "./store";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

type Clock = { now: number; advance(milliseconds: number): void };

/** Opens a workspace whose clock the test controls, so typing groups are deterministic. */
async function openClockedWorkspace(options: { failSaves?: { remaining: number } } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-project-undo-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "designs.sqlite");
	const clock: Clock = {
		now: 1_000_000,
		advance(milliseconds) {
			this.now += milliseconds;
		},
	};
	const workspace = await createDesignWorkspace({
		databasePath,
		now: () => clock.now,
		openStore: (path) => {
			const store = openDesignStore(path);
			return {
				...store,
				saveProjectArtifacts(input) {
					if (options.failSaves && options.failSaves.remaining > 0) {
						options.failSaves.remaining -= 1;
						throw new Error("simulated write failure");
					}
					return store.saveProjectArtifacts(input);
				},
			};
		},
	});
	openWorkspaces.push(workspace);
	return { workspace, clock };
}

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function requireTable(design: Design | null | undefined, name: string): DesignTable {
	const table = design?.tables.find((candidate) => candidate.name === name);
	if (!table) throw new Error(`Expected table ${name}.`);
	return table;
}

function designId(workspace: DesignWorkspace): string {
	return workspace.getState().activeDesignId!;
}

describe("Project-wide content history", () => {
	test("names the next Undo and Redo action and keeps navigation outside history", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Navigation" });
		const added = await workspace.addTable({ designId: designId(workspace), name: "Authors" });
		expect(added.undoActionName).toBe("Add table “Authors”");
		expect(added.redoActionName).toBeUndefined();

		const panned = await workspace.setViewport({ designId: designId(workspace), x: 40, y: -20, zoom: 1.25 });
		expect(panned.undoActionName).toBe("Add table “Authors”");
		expect(panned.undoRedo).toEqual({ canUndo: true, canRedo: false });

		const undone = await workspace.undo({ designId: designId(workspace) });
		expect(undone.design?.tables).toEqual([]);
		expect(undone.undoActionName).toBeUndefined();
		expect(undone.redoActionName).toBe("Add table “Authors”");
		expect(undone.design?.viewport).toEqual({ x: 40, y: -20, zoom: 1.25 });
	});

	test("groups continuous source typing into one named action and splits it after a pause", async () => {
		const { workspace, clock } = await openClockedWorkspace();
		await workspace.createProject({ name: "Typing" });
		const created = await workspace.createScenario({ designId: designId(workspace), name: "Signup" });
		const scenarioId = created.scenarios[0].id;

		await workspace.updateScenarioSource({ designId: designId(workspace), scenarioId, source: "a" });
		clock.advance(300);
		await workspace.updateScenarioSource({ designId: designId(workspace), scenarioId, source: "ab" });
		clock.advance(300);
		const typed = await workspace.updateScenarioSource({ designId: designId(workspace), scenarioId, source: "abc" });
		expect(typed.undoActionName).toBe("Edit “Signup” source");

		const undone = await workspace.undo({ designId: designId(workspace) });
		expect(undone.scenarios[0].source).toBe("");
		expect(undone.undoActionName).toBe("Add scenario “Signup”");
		expect(undone.redoActionName).toBe("Edit “Signup” source");

		clock.advance(5_000);
		await workspace.updateScenarioSource({ designId: designId(workspace), scenarioId, source: "x" });
		clock.advance(5_000);
		const separate = await workspace.updateScenarioSource({ designId: designId(workspace), scenarioId, source: "xy" });
		expect(separate.scenarios[0].source).toBe("xy");
		const once = await workspace.undo({ designId: designId(workspace) });
		expect(once.scenarios[0].source).toBe("x");
		const twice = await workspace.undo({ designId: designId(workspace) });
		expect(twice.scenarios[0].source).toBe("");
	});

	test("undoes and redoes Scenario and Edge function lifecycle changes", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Lifecycle" });
		const created = await workspace.createScenario({ designId: designId(workspace), name: "Checkout" });
		const scenarioId = created.scenarios[0].id;
		const renamed = await workspace.renameScenario({ designId: designId(workspace), scenarioId, name: "Purchase" });
		expect(renamed.undoActionName).toBe("Rename scenario to “Purchase”");
		const removed = await workspace.removeScenario({ designId: designId(workspace), scenarioId });
		expect(removed.scenarios).toEqual([]);
		expect(removed.undoActionName).toBe("Remove scenario “Purchase”");

		const restored = await workspace.undo({ designId: designId(workspace) });
		expect(restored.scenarios.map((scenario) => scenario.name)).toEqual(["Purchase"]);
		const back = await workspace.undo({ designId: designId(workspace) });
		expect(back.scenarios.map((scenario) => scenario.name)).toEqual(["Checkout"]);
		const redone = await workspace.redo({ designId: designId(workspace) });
		expect(redone.scenarios.map((scenario) => scenario.name)).toEqual(["Purchase"]);

		const edge = await workspace.createEdgeFunction({ designId: designId(workspace), name: "send-receipt" });
		const edgeId = edge.edgeFunctions[0].id;
		const edited = await workspace.updateEdgeFunctionSource({ designId: designId(workspace), edgeFunctionId: edgeId, source: "export {};" });
		expect(edited.undoActionName).toBe("Edit “send-receipt” handler");
		const withoutSource = await workspace.undo({ designId: designId(workspace) });
		expect(withoutSource.edgeFunctions[0].source).toContain("Deno.serve");
		const withoutEdge = await workspace.undo({ designId: designId(workspace) });
		expect(withoutEdge.edgeFunctions).toEqual([]);
		expect(withoutEdge.redoActionName).toBe("Add Edge function “send-receipt”");
	});

	test("treats each completed table drag as its own named action", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Drag" });
		const created = await workspace.addTable({ designId: designId(workspace), name: "Books" });
		const books = requireTable(created.design, "Books");
		const first = await workspace.moveTable({ designId: designId(workspace), tableId: books.id, position: { x: 100, y: 100 } });
		const second = await workspace.moveTable({ designId: designId(workspace), tableId: books.id, position: { x: 300, y: 200 } });
		expect(second.undoActionName).toBe("Move table “Books”");

		const afterFirst = await workspace.undo({ designId: designId(workspace) });
		expect(requireTable(afterFirst.design, "Books").position).toEqual({ x: 100, y: 100 });
		expect(afterFirst.undoActionName).toBe("Move table “Books”");
		const beforeDrag = await workspace.undo({ designId: designId(workspace) });
		expect(requireTable(beforeDrag.design, "Books").position).toEqual(books.position);
		expect(first.revision).toBe(created.revision);
	});

	test("combines an Assistant turn's design and Scenario changes into one undoable action", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Turn" });
		const id = designId(workspace);
		const table = await workspace.addTable({ designId: id, name: "Orders" });
		const orders = requireTable(table.design, "Orders");
		const scenario = await workspace.createScenario({ designId: id, name: "Place order" });
		const scenarioId = scenario.scenarios[0].id;

		const turnId = "turn-combined";
		await workspace.applyAssistantDesign(
			{ ...table.design!, tables: table.design!.tables.map((candidate) => candidate.id === orders.id ? { ...candidate, name: "Purchases" } : candidate) },
			id,
			turnId,
		);
		const turned = await workspace.updateScenarioSource({ designId: id, scenarioId, source: "select 1", assistantTurnId: turnId });
		expect(turned.design?.tables.map((candidate) => candidate.name)).toEqual(["Purchases"]);
		expect(turned.scenarios[0].source).toBe("select 1");
		expect(turned.undoActionName).toBe("Assistant turn");

		const undone = await workspace.undo({ designId: id });
		expect(undone.design?.tables.map((candidate) => candidate.name)).toEqual(["Orders"]);
		expect(undone.scenarios[0].source).toBe("");
		expect(undone.undoActionName).toBe("Add scenario “Place order”");

		const redone = await workspace.redo({ designId: id });
		expect(redone.design?.tables.map((candidate) => candidate.name)).toEqual(["Purchases"]);
		expect(redone.scenarios[0].source).toBe("select 1");
		expect(redone.redoActionName).toBeUndefined();
	});

	test("keeps manual edits made during an Assistant turn when that turn is undone", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Interleaved" });
		const id = designId(workspace);
		const table = await workspace.addTable({ designId: id, name: "Orders" });
		const orders = requireTable(table.design, "Orders");
		const scenario = await workspace.createScenario({ designId: id, name: "Checkout" });
		const scenarioId = scenario.scenarios[0].id;
		const rename = (name: string) => ({
			...table.design!,
			tables: table.design!.tables.map((candidate) => candidate.id === orders.id ? { ...candidate, name } : candidate),
		});

		const turnId = "turn-interleaved";
		await workspace.applyAssistantDesign(rename("Purchases"), id, turnId);
		const manual = await workspace.updateScenarioSource({ designId: id, scenarioId, source: "hand written" });
		expect(manual.undoActionName).toBe("Edit “Checkout” source");
		await workspace.applyAssistantDesign(rename("Sales"), id, turnId);

		const undone = await workspace.undo({ designId: id });
		expect(undone.design?.tables.map((candidate) => candidate.name)).toEqual(["Orders"]);
		expect(undone.scenarios[0].source).toBe("hand written");
		expect(undone.undoActionName).toBe("Edit “Checkout” source");
		const withoutHandEdit = await workspace.undo({ designId: id });
		expect(withoutHandEdit.scenarios[0].source).toBe("");
		expect(withoutHandEdit.undoActionName).toBe("Add scenario “Checkout”");
	});

	test("restores a failed Undo with no change to the Project or the history", async () => {
		const failSaves = { remaining: 0 };
		const { workspace } = await openClockedWorkspace({ failSaves });
		await workspace.createProject({ name: "Atomic" });
		const id = designId(workspace);
		const created = await workspace.createScenario({ designId: id, name: "Atomic check" });
		const scenarioId = created.scenarios[0].id;
		const edited = await workspace.updateScenarioSource({ designId: id, scenarioId, source: "keep" });
		const revision = edited.revision;
		const scenarioRevision = edited.scenarioSave.status === "saved" ? edited.scenarioSave.revision : null;

		failSaves.remaining = 1;
		await expect(workspace.undo({ designId: id })).rejects.toThrow("simulated write failure");
		const unchanged = workspace.getState();
		expect(unchanged.scenarios[0].source).toBe("keep");
		expect(unchanged.revision).toBe(revision);
		expect(unchanged.undoActionName).toBe("Edit “Atomic check” source");
		expect(unchanged.redoActionName).toBeUndefined();
		expect(unchanged.scenarioSave.status === "saved" ? unchanged.scenarioSave.revision : null).toBe(scenarioRevision);

		const retried = await workspace.undo({ designId: id });
		expect(retried.scenarios[0].source).toBe("");
		expect(retried.redoActionName).toBe("Edit “Atomic check” source");
	});

	test("names a Revert of an Assistant turn and undoes it as one action", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Revert" });
		const id = designId(workspace);
		const before = await workspace.addTable({ designId: id, name: "Audit" });
		const beforeDesign = before.design!;
		const scenario = await workspace.createScenario({ designId: id, name: "Trail" });
		const beforeScenarios = scenario.scenarios;
		const turnId = "turn-revert";
		await workspace.applyAssistantDesign({ ...beforeDesign, tables: [] }, id, turnId);

		const reverted = await workspace.restoreAssistantProjectSnapshot({
			projectId: workspace.getState().project!.id,
			designId: id,
			design: beforeDesign,
			scenarios: beforeScenarios,
			edgeFunctions: [],
		});
		expect(reverted.design?.tables.map((candidate) => candidate.name)).toEqual(["Audit"]);
		expect(reverted.undoActionName).toBe("Revert Assistant turn");

		const undone = await workspace.undo({ designId: id });
		expect(undone.design?.tables).toEqual([]);
		expect(undone.undoActionName).toBe("Assistant turn");
	});

	test("keeps each Project's history for the session and isolates it from others", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "First" });
		await workspace.addTable({ designId: designId(workspace), name: "Alpha" });
		const firstProject = workspace.getState().project!.id;
		await workspace.createProject({ name: "Second" });
		expect(workspace.getState().undoActionName).toBeUndefined();
		await workspace.openProject({ projectId: firstProject });
		expect(workspace.getState().undoActionName).toBe("Add table “Alpha”");
	});


	test("Service ownership and boundary edits share the Project-wide history with Design edits", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Shared history" });
		await workspace.addTable({ designId: designId(workspace), name: "Orders" });
		await workspace.addSystemService({ id: "api", name: "API", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "writer", name: "Order writer", x: 40, y: 60 });
		const owned = await workspace.updateSystemComponent({ componentId: "writer", changes: { serviceId: "api" } });
		expect(owned.undoActionName).toBe("Assign “Order writer” to “API”");

		const undoneAssignment = await workspace.undo({ designId: designId(workspace) });
		expect(undoneAssignment.systemDesign?.components[0]!.serviceId).toBeNull();
		expect(undoneAssignment.undoActionName).toBe("Add component “Order writer”");

		const undoneComponent = await workspace.undo({ designId: designId(workspace) });
		expect(undoneComponent.systemDesign?.components).toEqual([]);
		expect(undoneComponent.undoActionName).toBe("Add service “API”");

		const undoneService = await workspace.undo({ designId: designId(workspace) });
		expect(undoneService.systemDesign?.services).toEqual([]);
		expect(undoneService.undoActionName).toBe("Add table “Orders”");
		expect(requireTable(undoneService.design, "Orders")).toBeDefined();
	});
});

describe("Connection route history", () => {
	test("each completed route edit is one named Project action, and Undo steps back through them without merging", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Routes" });
		await workspace.addSystemComponent({ id: "client", name: "Client", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "api", name: "API", x: 320, y: 0 });
		await workspace.addSystemConnection({ id: "reads", sourceId: "client", targetId: "api", label: "Reads" });

		const bent = await workspace.updateSystemConnection({ connectionId: "reads", changes: { bendPoints: [{ x: 160, y: -80 }] } });
		expect(bent.undoActionName).toBe("Reroute connection “Reads”");
		const rerouted = await workspace.updateSystemConnection({
			connectionId: "reads",
			changes: { bendPoints: [{ x: 200, y: -60 }], fromSide: "top" },
		});
		expect(rerouted.undoActionName).toBe("Reroute connection “Reads”");
		expect(rerouted.systemDesign?.connections[0]).toMatchObject({ bendPoints: [{ x: 200, y: -60 }], fromSide: "top" });

		const undoneSecond = await workspace.undo({ designId: designId(workspace) });
		expect(undoneSecond.systemDesign?.connections[0]!.bendPoints).toEqual([{ x: 160, y: -80 }]);
		expect(undoneSecond.systemDesign?.connections[0]!.fromSide).toBeUndefined();
		expect(undoneSecond.undoActionName).toBe("Reroute connection “Reads”");

		const undoneFirst = await workspace.undo({ designId: designId(workspace) });
		expect(undoneFirst.systemDesign?.connections[0]!.bendPoints).toBeUndefined();
		expect(undoneFirst.undoActionName).toBe("Add connection “Reads”");
	});

	test("a route edit does not merge with a label edit made just before it, so each keeps its own name", async () => {
		const { workspace } = await openClockedWorkspace();
		await workspace.createProject({ name: "Routes" });
		await workspace.addSystemComponent({ id: "client", name: "Client", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "api", name: "API", x: 320, y: 0 });
		await workspace.addSystemConnection({ id: "reads", sourceId: "client", targetId: "api", label: "Reads" });
		await workspace.updateSystemConnection({ connectionId: "reads", changes: { label: "Loads" } });
		const rerouted = await workspace.updateSystemConnection({ connectionId: "reads", changes: { labelOffset: { x: 12, y: -8 } } });
		expect(rerouted.undoActionName).toBe("Reroute connection “Loads”");
		const undone = await workspace.undo({ designId: designId(workspace) });
		expect(undone.systemDesign?.connections[0]!.labelOffset).toBeUndefined();
		expect(undone.systemDesign?.connections[0]!.label).toBe("Loads");
		expect(undone.undoActionName).toBe("Edit connection “Loads”");
	});
});
