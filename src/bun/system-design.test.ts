import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemService,
	createEmptySystemDesign,
	createMigratedSystemDesign,
	describeSystemComponentRemoval,
	describeSystemServiceRemoval,
	moveSystemComponent,
	moveSystemService,
	normalizeSystemDesign,
	removeSystemComponent,
	removeSystemService,
	resizeSystemService,
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

/** Two Services and a Component each side, with one Service boundary owning the worker. */
function servicedDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
	design = addSystemService(design, { id: "billing", name: "Billing", position: { x: 600, y: 0 } });
	design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 300, y: 60 } });
	return design;
}

describe("System design Services", () => {
	test("a Component is owned only by an explicit assignment, never by placing it inside a boundary", () => {
		let design = addSystemService(createEmptySystemDesign(), { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "worker", position: { x: 40, y: 60 } });
		expect(design.components[0]!.serviceId).toBeNull();

		design = moveSystemComponent(design, "worker", { x: 60, y: 80 });
		expect(design.components[0]!.serviceId).toBeNull();

		design = updateSystemComponent(design, "worker", { serviceId: "orders" });
		expect(design.components[0]!.serviceId).toBe("orders");
		design = addSystemService(design, { id: "billing", name: "Billing", position: { x: 600, y: 0 } });
		design = updateSystemComponent(design, "worker", { serviceId: "billing" });
		expect(design.components[0]!.serviceId).toBe("billing");
		design = updateSystemComponent(design, "worker", { serviceId: null });
		expect(design.components[0]!.serviceId).toBeNull();
		expect(() => updateSystemComponent(design, "worker", { serviceId: "missing" })).toThrow("That Service could not be found.");
	});

	test("Component and Service ids share one namespace so a Connection endpoint is never ambiguous", () => {
		const withService = addSystemService(createEmptySystemDesign(), { id: "orders", position: { x: 0, y: 0 } });
		expect(() => addSystemComponent(withService, { id: "orders", position: { x: 0, y: 0 } })).toThrow('"orders" is already used by a Service.');
		const withComponent = addSystemComponent(withService, { id: "worker", position: { x: 0, y: 0 } });
		expect(() => addSystemService(withComponent, { id: "worker", position: { x: 0, y: 0 } })).toThrow('"worker" is already used by a Component.');
	});

	test("Connections join Services and Components directly, with parallel pairs and optional interaction detail", () => {
		let design = servicedDesign();
		design = addSystemConnection(design, {
			id: "charge",
			sourceId: "orders",
			targetId: "billing",
			label: "Charges",
			interactionType: "Synchronous request",
			protocol: "HTTPS",
		});
		design = addSystemConnection(design, { id: "notify", sourceId: "orders", targetId: "billing", label: "Notifies" });
		design = addSystemConnection(design, { id: "dispatch", sourceId: "worker", targetId: "orders", label: "Reports" });

		expect(design.connections.map((connection) => connection.id)).toEqual(["charge", "notify", "dispatch"]);
		expect(design.connections[0]).toMatchObject({ interactionType: "Synchronous request", protocol: "HTTPS" });
		expect(design.connections[1]!.interactionType).toBeUndefined();
		const offsets = systemConnectionRouteOffsets(design);
		expect([offsets.get("charge"), offsets.get("notify")].sort((a, b) => a! - b!)).toEqual([-0.5, 0.5]);
		expect(() => addSystemConnection(design, { id: "loop", sourceId: "orders", targetId: "orders" })).toThrow(
			"A Connection must join two different Components.",
		);
		expect(() => addSystemConnection(design, { id: "ghost", sourceId: "orders", targetId: "nowhere" })).toThrow(
			"The Connection target Component could not be found.",
		);
	});

	test("moving a Service carries the Components it owns without changing ownership, and resizing keeps the minimum size", () => {
		const moved = moveSystemService(servicedDesign(), "orders", { x: 100, y: 50 });
		expect(moved.services.find((service) => service.id === "orders")!.position).toEqual({ x: 100, y: 50 });
		expect(moved.components.find((component) => component.id === "worker")).toMatchObject({
			position: { x: 140, y: 110 },
			serviceId: "orders",
		});
		expect(moved.components.find((component) => component.id === "queue")).toMatchObject({
			position: { x: 300, y: 60 },
			serviceId: null,
		});

		const resized = resizeSystemService(moved, "orders", { width: 10, height: 900 });
		expect(resized.services.find((service) => service.id === "orders")!.size).toEqual({ width: 240, height: 900 });
		expect(resizeSystemService(resized, "orders", { width: 240, height: 900 })).toBe(resized);
	});

	test("removing a Service releases its Components, keeps Component-to-Component Connections, and lists the Service-endpoint Connections it deletes", () => {
		let design = servicedDesign();
		design = addSystemComponent(design, { id: "db", name: "Database", position: { x: 40, y: 220 } });
		design = addSystemConnection(design, { id: "reads", sourceId: "orders", targetId: "db", label: "Reads" });
		design = addSystemConnection(design, { id: "charge", sourceId: "orders", targetId: "billing", label: "Charges" });
		design = addSystemConnection(design, { id: "writes", sourceId: "worker", targetId: "db", label: "Writes" });

		const plan = describeSystemServiceRemoval(design, "orders");
		expect(plan.serviceName).toBe("Orders");
		expect(plan.releasedComponents).toEqual([{ id: "worker", name: "Worker" }]);
		expect(plan.connections.map((connection) => connection.id).sort()).toEqual(["charge", "reads"]);

		const after = removeSystemService(design, "orders");
		expect(after.services.map((service) => service.id)).toEqual(["billing"]);
		expect(after.components.find((component) => component.id === "worker")).toMatchObject({
			serviceId: null,
			position: { x: 40, y: 60 },
		});
		expect(after.connections.map((connection) => connection.id)).toEqual(["writes"]);
	});

	test("a design saved before Services loads with every Component at system scope, and a dangling owner is rejected", () => {
		const legacy = normalizeSystemDesign({
			components: [{ id: "a", kind: "generic", name: "A", properties: [], position: { x: 0, y: 0 } }],
			connections: [],
			viewport: { x: 0, y: 0, zoom: 1 },
		});
		expect(legacy.services).toEqual([]);
		expect(legacy.components[0]!.serviceId).toBeNull();

		const design = servicedDesign();
		expect(normalizeSystemDesign(JSON.parse(JSON.stringify(design)))).toEqual(design);
		expect(() => normalizeSystemDesign({
			services: [],
			components: [{ id: "a", kind: "generic", name: "A", properties: [], position: { x: 0, y: 0 }, serviceId: "gone" }],
			connections: [],
		})).toThrow('Component "a" belongs to a Service that does not exist.');
	});
});

describe("System design Services workspace", () => {
	test("Services, Component ownership, boundary geometry, and Service Connections persist across reopen", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await first.createProject({ name: "Checkout" });
		await first.addSystemService({ id: "orders", name: "Orders", x: 40, y: 40 });
		await first.addSystemComponent({ id: "worker", name: "Worker", kind: "generic", x: 80, y: 120, serviceId: "orders" });
		await first.addSystemComponent({ id: "queue", name: "Queue", kind: "generic", x: 360, y: 120 });
		await first.moveSystemService({ serviceId: "orders", x: 60, y: 30 });
		await first.resizeSystemService({ serviceId: "orders", width: 500, height: 320 });
		await first.addSystemConnection({ id: "dispatch", sourceId: "orders", targetId: "queue", label: "Enqueues" });
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		const system = reopened.getState().systemDesign!;
		expect(system.services).toEqual([{ id: "orders", name: "Orders", position: { x: 60, y: 30 }, size: { width: 500, height: 320 } }]);
		expect(system.components.find((component) => component.id === "worker")).toMatchObject({
			serviceId: "orders",
			position: { x: 100, y: 110 },
		});
		expect(system.components.find((component) => component.id === "queue")!.serviceId).toBeNull();
		expect(system.connections.map((connection) => connection.id)).toEqual(["dispatch"]);
	});

	test("assigning, transferring, and releasing a Component are separate named actions that Undo steps through", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Ownership" });
		await workspace.addSystemService({ id: "orders", name: "Orders", x: 0, y: 0 });
		await workspace.addSystemService({ id: "billing", name: "Billing", x: 600, y: 0 });
		await workspace.addSystemComponent({ id: "worker", name: "Worker", x: 40, y: 60 });

		const assigned = await workspace.updateSystemComponent({ componentId: "worker", changes: { serviceId: "orders" } });
		expect(assigned.undoActionName).toBe("Assign “Worker” to “Orders”");
		const transferred = await workspace.updateSystemComponent({ componentId: "worker", changes: { serviceId: "billing" } });
		expect(transferred.undoActionName).toBe("Assign “Worker” to “Billing”");
		const released = await workspace.updateSystemComponent({ componentId: "worker", changes: { serviceId: null } });
		expect(released.undoActionName).toBe("Release “Worker” to system scope");
		expect(released.systemDesign?.components[0]!.serviceId).toBeNull();

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components[0]!.serviceId).toBe("billing");
		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components[0]!.serviceId).toBe("orders");
	});

	test("removing a Service is one undoable action that restores its boundary, ownership, and Connections", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Removal" });
		await workspace.addSystemService({ id: "orders", name: "Orders", x: 0, y: 0 });
		await workspace.addSystemService({ id: "billing", name: "Billing", x: 600, y: 0 });
		await workspace.addSystemComponent({ id: "worker", name: "Worker", x: 40, y: 60, serviceId: "orders" });
		await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 60 });
		await workspace.addSystemConnection({ id: "charge", sourceId: "orders", targetId: "billing", label: "Charges" });
		await workspace.addSystemConnection({ id: "writes", sourceId: "worker", targetId: "queue", label: "Writes" });

		expect(workspace.describeSystemServiceRemoval("orders")).toMatchObject({
			releasedComponents: [{ id: "worker", name: "Worker" }],
			connections: [expect.objectContaining({ id: "charge" })],
		});
		const removed = await workspace.removeSystemService({ serviceId: "orders" });
		expect(removed.undoActionName).toBe("Remove service “Orders”");
		expect(removed.systemDesign?.services.map((service) => service.id)).toEqual(["billing"]);
		expect(removed.systemDesign?.components.find((component) => component.id === "worker")!.serviceId).toBeNull();
		expect(removed.systemDesign?.connections.map((connection) => connection.id)).toEqual(["writes"]);

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		const restored = workspace.getState().systemDesign!;
		expect(restored.services.map((service) => service.id).sort()).toEqual(["billing", "orders"]);
		expect(restored.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");
		expect(restored.connections.map((connection) => connection.id).sort()).toEqual(["charge", "writes"]);
	});

	test("moving and resizing a Service are separate named actions, and Undo restores the boundary with its owned Components", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Geometry" });
		await workspace.addSystemService({ id: "orders", name: "Orders", x: 40, y: 40 });
		await workspace.addSystemComponent({ id: "worker", name: "Worker", x: 80, y: 120, serviceId: "orders" });

		const moved = await workspace.moveSystemService({ serviceId: "orders", x: 100, y: 100 });
		expect(moved.undoActionName).toBe("Move service “Orders”");
		expect(moved.systemDesign?.components[0]!.position).toEqual({ x: 140, y: 180 });
		const resized = await workspace.resizeSystemService({ serviceId: "orders", width: 300, height: 200 });
		expect(resized.undoActionName).toBe("Resize service “Orders”");
		expect(resized.systemDesign?.services[0]!.size).toEqual({ width: 300, height: 200 });

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.services[0]!.size).toEqual({ width: 420, height: 280 });
		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.services[0]!.position).toEqual({ x: 40, y: 40 });
		expect(workspace.getState().systemDesign?.components[0]!.position).toEqual({ x: 80, y: 120 });
	});
});
