import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	createMigratedSystemDesign,
	describeSystemComponentRemoval,
	normalizeSystemDesign,
	removeSystemComponent,
	systemConnectionRouteOffsets,
	updateSystemComponent,
	type SystemDesign,
} from "../shared/system-design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { openDesignStore, type DesignStore } from "./store";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePathForTest(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-system-design-"));
	temporaryDirectories.push(directory);
	return join(directory, "designs.sqlite");
}

async function openWorkspace(databasePath: string, options: { failSystemSaves?: { remaining: number } } = {}) {
	const workspace = await createDesignWorkspace({
		databasePath,
		openStore: (path) => {
			const store: DesignStore = openDesignStore(path);
			if (!options.failSystemSaves) return store;
			return {
				...store,
				saveProjectArtifacts(input) {
					return store.saveProjectArtifacts(input);
				},
				saveSystemDesign(projectId, document, save) {
					if (options.failSystemSaves!.remaining > 0) {
						options.failSystemSaves!.remaining -= 1;
						throw new Error("simulated System design write failure");
					}
					return store.saveSystemDesign(projectId, document, save);
				},
			};
		},
	});
	openWorkspaces.push(workspace);
	return workspace;
}

function ids(prefix: string) {
	let counter = 0;
	return () => `${prefix}-${++counter}`;
}

describe("System design model", () => {
	test("keeps several directed labeled Connections between the same endpoints with distinct routes", () => {
		let design: SystemDesign = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "client", position: { x: 0, y: 0 }, name: "Client" });
		design = addSystemComponent(design, { id: "api", position: { x: 300, y: 0 }, name: "API" });
		design = addSystemConnection(design, { id: "c1", sourceId: "client", targetId: "api", label: "Reads" });
		design = addSystemConnection(design, { id: "c2", sourceId: "client", targetId: "api", label: "Writes" });
		design = addSystemConnection(design, { id: "c3", sourceId: "api", targetId: "client", label: "Replies" });

		expect(design.connections.map((connection) => connection.label)).toEqual(["Reads", "Writes", "Replies"]);
		const offsets = systemConnectionRouteOffsets(design);
		expect([...offsets.values()].sort((a, b) => a - b)).toEqual([-1, 0, 1]);
	});

	test("rejects self-connections and dangling endpoints without changing the design", () => {
		const design = addSystemComponent(createEmptySystemDesign(), { id: "api", position: { x: 0, y: 0 } });
		expect(() => addSystemConnection(design, { id: "loop", sourceId: "api", targetId: "api" })).toThrow(
			"A Connection must join two different Components.",
		);
		expect(() => addSystemConnection(design, { id: "dangling", sourceId: "api", targetId: "missing" })).toThrow(
			"The Connection target Component could not be found.",
		);
	});

	test("lists affected Connections before removing a Component and removes them with it", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "a", name: "A", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "b", name: "B", position: { x: 200, y: 0 } });
		design = addSystemComponent(design, { id: "c", name: "C", position: { x: 400, y: 0 } });
		design = addSystemConnection(design, { id: "ab", sourceId: "a", targetId: "b", label: "Calls" });
		design = addSystemConnection(design, { id: "bc", sourceId: "b", targetId: "c", label: "Publishes" });

		const plan = describeSystemComponentRemoval(design, "b");
		expect(plan.connections.map((connection) => connection.id).sort()).toEqual(["ab", "bc"]);

		const after = removeSystemComponent(design, "b");
		expect(after.components.map((component) => component.id)).toEqual(["a", "c"]);
		expect(after.connections).toEqual([]);
	});

	test("trims names, defaults the Database kind label, and ignores no-op edits", () => {
		let design = addSystemComponent(createEmptySystemDesign(), { id: "db", kind: "database", position: { x: 0, y: 0 } });
		expect(design.components[0]!.name).toBe("Database");
		const same = updateSystemComponent(design, "db", { name: "Database" });
		expect(same).toBe(design);
		design = updateSystemComponent(design, "db", { name: "  Orders  ", technology: " PostgreSQL " });
		expect(design.components[0]).toMatchObject({ name: "Orders", technology: "PostgreSQL" });
		expect(() => updateSystemComponent(design, "db", { name: "   " })).toThrow("Component name is required.");
	});

	test("the migrated overview holds one system-scope Database component and no other structure", () => {
		const migrated = createMigratedSystemDesign("design-1", "component-1");
		expect(migrated.components).toEqual([expect.objectContaining({ id: "component-1", kind: "database", designId: "design-1" })]);
		expect(migrated.connections).toEqual([]);
	});

	test("rejects a stored System design with dangling or duplicate identities", () => {
		const dangling = {
			components: [{ id: "a", kind: "generic", name: "A", properties: [], position: { x: 0, y: 0 } }],
			connections: [{ id: "x", sourceId: "a", targetId: "gone", label: "Calls" }],
			viewport: { x: 0, y: 0, zoom: 1 },
		};
		expect(() => normalizeSystemDesign(dangling)).toThrow('Connection "x" refers to a Component that does not exist.');
		expect(() => normalizeSystemDesign({ components: [{ id: "a" }, { id: "a" }], connections: [] })).toThrow();
	});
});

describe("System design workspace", () => {
	test("new Projects open the overview and persist components, connections, and the last-used view across reopen", async () => {
		const databasePath = databasePathForTest();
		const nextId = ids("id");
		const first = await openWorkspace(databasePath);
		const created = await first.createProject({ name: "Image upload" });
		expect(created.activeView).toBe("system");

		await first.addSystemComponent({ id: "client", name: "Browser", kind: "generic", x: 40, y: 40 });
		await first.addSystemComponent({ id: "api", name: "API", kind: "generic", x: 300, y: 40 });
		await first.addSystemConnection({ id: nextId(), sourceId: "client", targetId: "api", label: "Upload" });
		await first.addSystemConnection({ id: nextId(), sourceId: "client", targetId: "api", label: "Poll status" });
		await first.moveSystemComponent({ componentId: "api", x: 320, y: 60 });
		await first.setActiveView({ view: "database" });
		const saved = first.getState();
		expect(saved.systemSave?.status).toBe("saved");
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		const state = reopened.getState();
		expect(state.activeView).toBe("database");
		expect(state.systemDesign?.components).toEqual([
			expect.objectContaining({ id: "client", name: "Browser" }),
			expect.objectContaining({ id: "api", name: "API", position: { x: 320, y: 60 } }),
		]);
		expect(state.systemDesign?.connections.map((connection) => connection.label)).toEqual(["Upload", "Poll status"]);
	});

	test("System design edits undo and redo as Project-wide actions, while navigation and viewport stay outside history", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Checkout" });
		await workspace.addSystemComponent({ id: "queue", name: "Orders queue", kind: "generic", x: 0, y: 0 });
		await workspace.moveSystemComponent({ componentId: "queue", x: 100, y: 50 });
		await workspace.setSystemViewport({ x: 10, y: 10, zoom: 1.5 });
		await workspace.setActiveView({ view: "database" });

		expect(workspace.getState().undoRedo.canUndo).toBe(true);
		expect(workspace.getState().undoActionName).toBe("Move “Orders queue”");

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components[0]!.position).toEqual({ x: 0, y: 0 });
		expect(workspace.getState().undoActionName).toBe("Add component “Orders queue”");

		await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components[0]!.position).toEqual({ x: 100, y: 50 });
		expect(workspace.getState().systemDesign?.viewport).toEqual({ x: 10, y: 10, zoom: 1.5 });
	});

	test("renaming and removing a Component is one action that Undo restores with its Connections", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Reports" });
		await workspace.addSystemComponent({ id: "a", name: "A", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "b", name: "B", x: 200, y: 0 });
		await workspace.addSystemConnection({ id: "ab", sourceId: "a", targetId: "b", label: "Calls" });

		await workspace.updateSystemComponent({ componentId: "a", changes: { name: "Gateway" } });
		expect(workspace.getState().undoActionName).toBe("Rename component to “Gateway”");

		expect(workspace.describeSystemComponentRemoval("b").connections).toHaveLength(1);
		await workspace.removeSystemComponent({ componentId: "b" });
		expect(workspace.getState().systemDesign?.connections).toEqual([]);

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components.map((c) => c.id)).toEqual(["a", "b"]);
		expect(workspace.getState().systemDesign?.connections.map((c) => c.id)).toEqual(["ab"]);
	});

	test("Assistant-attributed System design edits form one turn that Undo reverts together", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Chat" });
		await workspace.addSystemComponent({ id: "manual", name: "Manual", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "turn-a", name: "Worker", x: 200, y: 0, assistantTurnId: "turn-1" });
		await workspace.addSystemConnection({ id: "turn-link", sourceId: "manual", targetId: "turn-a", label: "Jobs", assistantTurnId: "turn-1" });

		expect(workspace.getState().undoActionName).toBe("Assistant turn");
		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components.map((c) => c.id)).toEqual(["manual"]);
		expect(workspace.getState().systemDesign?.connections).toEqual([]);
	});

	test("a failed System design save keeps the draft visible and the next successful save writes it", async () => {
		const databasePath = databasePathForTest();
		const failures = { remaining: 1 };
		const workspace = await openWorkspace(databasePath, { failSystemSaves: failures });
		await workspace.createProject({ name: "Failing save" });
		const failed = await workspace.addSystemComponent({ id: "x", name: "Draft", x: 0, y: 0 });
		expect(failed.systemSave?.status).toBe("failed");
		expect(failed.systemDesign?.components.map((c) => c.id)).toEqual(["x"]);

		const recovered = await workspace.moveSystemComponent({ componentId: "x", x: 30, y: 30 });
		expect(recovered.systemSave?.status).toBe("saved");
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		expect(reopened.getState().systemDesign?.components).toEqual([
			expect.objectContaining({ id: "x", name: "Draft", position: { x: 30, y: 30 } }),
		]);
	});

	test("an existing Project migrates to a system-scope Database component and reopens its database view", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		const created = await first.createProject({ name: "Legacy library" });
		const designId = created.activeDesignId!;
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		// A database written before System designs existed has no system row.
		const raw = new Database(databasePath);
		raw.run("DELETE FROM system_designs");
		raw.close();

		const migrated = await openWorkspace(databasePath);
		const state = migrated.getState();
		expect(state.activeView).toBe("database");
		expect(state.systemDesign?.connections).toEqual([]);
		expect(state.systemDesign?.components).toEqual([
			expect.objectContaining({ kind: "database", name: "Database", designId }),
		]);
		expect(state.design).not.toBeNull();
	});
});
