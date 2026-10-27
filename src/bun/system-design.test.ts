import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	componentsLinkedToDesign,
	createEmptySystemDesign,
	createMigratedSystemDesign,
	describeSystemComponentRemoval,
	canAddSystemGroupMember,
	describeSystemGroupMove,
	describeSystemServiceRemoval,
	findSystemComponent,
	keepSystemGroupMembers,
	systemGroupsContaining,
	moveSystemComponent,
	moveSystemGroup,
	moveSystemService,
	normalizeSystemDesign,
	removeSystemComponent,
	removeSystemGroup,
	removeSystemService,
	resizeSystemGroup,
	resizeSystemService,
	setSystemServiceCollapsed,
	systemConnectionRouteOffsets,
	systemDesignContent,
	updateSystemComponent,
	updateSystemGroup,
	visibleEndpointOf,
	isComponentHiddenByCollapse,
	withSystemPresentation,
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

/**
 * Two overlapping Groups, one nested inside the other, around a Service that
 * owns a Component and a shared Component at system scope.
 */
function groupedDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 300, y: 60 } });
	design = addSystemComponent(design, { id: "cache", name: "Cache", position: { x: 300, y: 200 } });
	design = addSystemConnection(design, { id: "writes", sourceId: "worker", targetId: "queue", label: "Writes" });
	design = addSystemGroup(design, { id: "domain", name: "Domain", position: { x: 20, y: 20 }, memberIds: ["queue", "orders"] });
	design = addSystemGroup(design, { id: "core", name: "Core", position: { x: 0, y: 0 }, memberIds: ["domain", "cache", "queue"] });
	return design;
}

describe("System design Groups", () => {
	test("Groups overlap and nest without changing Service ownership or Component positions", () => {
		const design = groupedDesign();
		expect(design.groups.find((group) => group.id === "core")!.memberIds).toEqual(["domain", "cache", "queue"]);
		expect(design.groups.find((group) => group.id === "domain")!.memberIds).toEqual(["queue", "orders"]);
		expect(design.components.find((component) => component.id === "queue")!.serviceId).toBeNull();
		expect(design.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");

		const resized = resizeSystemGroup(design, "domain", { width: 600, height: 400 });
		expect(resized.groups.find((group) => group.id === "domain")!.memberIds).toEqual(["queue", "orders"]);
		expect(resized.components).toEqual(design.components);
		expect(resized.services).toEqual(design.services);
	});

	test("a Group that contains itself or closes a nesting cycle is refused and leaves the design as it was", () => {
		const design = groupedDesign();
		const before = JSON.stringify(design);
		expect(() => updateSystemGroup(design, "domain", { memberIds: ["domain"] })).toThrow("A Group cannot contain itself.");
		// Core already contains Domain, so Domain cannot also contain Core.
		expect(() => updateSystemGroup(design, "domain", { memberIds: ["core"] })).toThrow(/would create a cycle/);
		expect(() => updateSystemGroup(design, "domain", { memberIds: ["ghost"] })).toThrow(/does not match a Component, Service, or Group/);
		expect(JSON.stringify(design)).toBe(before);
	});

	test("moving a Group carries nested members and Service-owned Components exactly once", () => {
		const design = groupedDesign();
		const targets = describeSystemGroupMove(design, "core");
		expect([...targets.groupIds].sort()).toEqual(["core", "domain"]);
		expect(targets.serviceIds).toEqual(["orders"]);
		expect([...targets.componentIds].sort()).toEqual(["cache", "queue", "worker"]);

		const moved = moveSystemGroup(design, "core", { x: 100, y: 50 });
		expect(moved.groups.find((group) => group.id === "core")!.position).toEqual({ x: 100, y: 50 });
		expect(moved.groups.find((group) => group.id === "domain")!.position).toEqual({ x: 120, y: 70 });
		expect(moved.services[0]!.position).toEqual({ x: 100, y: 50 });
		// Queue is in both Groups; it shifts by the offset once, not twice.
		expect(moved.components.find((component) => component.id === "queue")!.position).toEqual({ x: 400, y: 110 });
		expect(moved.components.find((component) => component.id === "cache")!.position).toEqual({ x: 400, y: 250 });
		expect(moved.components.find((component) => component.id === "worker")!.position).toEqual({ x: 140, y: 110 });
		expect(moved.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");
	});

	test("Service membership is independent of ownership: a Group move does not reassign owners", () => {
		const design = groupedDesign();
		const moved = moveSystemGroup(design, "domain", { x: 200, y: 200 });
		expect(moved.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");
		expect(moved.components.find((component) => component.id === "queue")!.serviceId).toBeNull();

		const withWorker = updateSystemGroup(design, "domain", { memberIds: ["queue", "orders", "worker"] });
		expect(withWorker.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");
		expect(withWorker.services).toEqual(design.services);
	});

	test("removing a Group keeps its members, their ownership, and their Connections", () => {
		const design = groupedDesign();
		const removed = removeSystemGroup(design, "domain");
		expect(removed.groups.map((group) => group.id)).toEqual(["core"]);
		expect(removed.groups[0]!.memberIds).toEqual(["cache", "queue"]);
		expect(removed.components.map((component) => component.id).sort()).toEqual(["cache", "queue", "worker"]);
		expect(removed.services.map((service) => service.id)).toEqual(["orders"]);
		expect(removed.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");
		expect(removed.connections.map((connection) => connection.id)).toEqual(["writes"]);
	});

	test("removing a Component or Service also removes it from every Group that named it", () => {
		const design = groupedDesign();
		const withoutQueue = removeSystemComponent(design, "queue");
		expect(withoutQueue.groups.find((group) => group.id === "domain")!.memberIds).toEqual(["orders"]);
		expect(withoutQueue.groups.find((group) => group.id === "core")!.memberIds).toEqual(["domain", "cache"]);

		const withoutOrders = removeSystemService(design, "orders");
		expect(withoutOrders.groups.find((group) => group.id === "domain")!.memberIds).toEqual(["queue"]);
		expect(withoutOrders.components.find((component) => component.id === "worker")!.serviceId).toBeNull();
	});

	test("a stored Group document round-trips, a legacy document loads with no Groups, and invalid membership is rejected", () => {
		const design = groupedDesign();
		expect(normalizeSystemDesign(JSON.parse(JSON.stringify(design)))).toEqual(design);

		const legacy = normalizeSystemDesign({ components: [], connections: [], viewport: { x: 0, y: 0, zoom: 1 } });
		expect(legacy.groups).toEqual([]);

		const stored = JSON.parse(JSON.stringify(design));
		stored.groups[0].memberIds.push("ghost");
		expect(() => normalizeSystemDesign(stored)).toThrow('Group "domain" contains "ghost", which does not exist.');

		const cyclic = JSON.parse(JSON.stringify(design));
		cyclic.groups.find((group: { id: string }) => group.id === "domain").memberIds.push("core");
		expect(() => normalizeSystemDesign(cyclic)).toThrow(/cycle/);

		const selfNested = JSON.parse(JSON.stringify(design));
		selfNested.groups[0].memberIds.push(selfNested.groups[0].id);
		expect(() => normalizeSystemDesign(selfNested)).toThrow(/cannot contain itself/);
	});

	test("a Group cannot reuse the id of a Component or Service", () => {
		const design = groupedDesign();
		expect(() => addSystemGroup(design, { id: "queue", position: { x: 0, y: 0 } })).toThrow('"queue" is already used by a Component.');
		expect(() => addSystemComponent(design, { id: "domain", position: { x: 0, y: 0 } })).toThrow('"domain" is already used by a Group.');
		expect(() => normalizeSystemDesign({
			services: [],
			groups: [{ id: "queue", name: "G", position: { x: 0, y: 0 }, size: { width: 200, height: 160 }, memberIds: [] }],
			components: [{ id: "queue", kind: "generic", name: "Queue", properties: [], position: { x: 0, y: 0 } }],
			connections: [],
		})).toThrow('Component "queue" uses the id of a Group.');
	});
});

describe("System design Groups workspace", () => {
	test("Groups, memberships, frames, and their nesting persist across reopen", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await first.createProject({ name: "Regions" });
		await first.addSystemService({ id: "orders", name: "Orders", x: 0, y: 0 });
		await first.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 60 });
		await first.addSystemGroup({ id: "east", name: "East region", x: 260, y: 20, width: 400, height: 260, memberIds: ["queue"] });
		await first.addSystemGroup({ id: "platform", name: "Platform", x: 0, y: 0, memberIds: ["east", "orders"] });
		await first.moveSystemGroup({ groupId: "platform", x: 40, y: 40 });
		await first.resizeSystemGroup({ groupId: "east", width: 480, height: 300 });
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		const system = reopened.getState().systemDesign!;
		expect(system.groups).toEqual([
			// East moved with its parent Group by the same offset.
			{ id: "east", name: "East region", position: { x: 300, y: 60 }, size: { width: 480, height: 300 }, memberIds: ["queue"] },
			{ id: "platform", name: "Platform", position: { x: 40, y: 40 }, size: { width: 360, height: 240 }, memberIds: ["east", "orders"] },
		]);
		expect(system.components.find((component) => component.id === "queue")!.position).toEqual({ x: 340, y: 100 });
		expect(system.services[0]!.position).toEqual({ x: 40, y: 40 });
	});

	test("creating, renaming, changing members, moving, resizing, and removing a Group are named history actions that Undo and Redo step through", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "History" });
		await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 60 });
		await workspace.addSystemComponent({ id: "cache", name: "Cache", x: 300, y: 200 });

		const created = await workspace.addSystemGroup({ id: "domain", name: "Domain", x: 260, y: 20, memberIds: ["queue"] });
		expect(created.undoActionName).toBe("Add group “Domain”");
		const added = await workspace.updateSystemGroup({ groupId: "domain", changes: { memberIds: ["queue", "cache"] } });
		expect(added.undoActionName).toBe("Add “Cache” to “Domain”");
		const removedMember = await workspace.updateSystemGroup({ groupId: "domain", changes: { memberIds: ["cache"] } });
		expect(removedMember.undoActionName).toBe("Remove “Queue” from “Domain”");
		const renamed = await workspace.updateSystemGroup({ groupId: "domain", changes: { name: "Data" } });
		expect(renamed.undoActionName).toBe("Rename group to “Data”");
		const moved = await workspace.moveSystemGroup({ groupId: "domain", x: 0, y: 0 });
		expect(moved.undoActionName).toBe("Move group “Data”");
		const resized = await workspace.resizeSystemGroup({ groupId: "domain", width: 500, height: 300 });
		expect(resized.undoActionName).toBe("Resize group “Data”");
		const removed = await workspace.removeSystemGroup({ groupId: "domain" });
		expect(removed.undoActionName).toBe("Remove group “Data”");
		expect(removed.systemDesign!.groups).toEqual([]);
		expect(removed.systemDesign!.components.map((component) => component.id).sort()).toEqual(["cache", "queue"]);

		const designId = () => workspace.getState().activeDesignId!;
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups[0]).toMatchObject({ id: "domain", name: "Data", memberIds: ["cache"] });
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups[0]!.size).toEqual({ width: 360, height: 240 });
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups[0]!.position).toEqual({ x: 260, y: 20 });
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups[0]).toMatchObject({ name: "Domain", memberIds: ["cache"] });
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups[0]!.memberIds).toEqual(["queue", "cache"]);
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups[0]!.memberIds).toEqual(["queue"]);
		await workspace.undo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups).toEqual([]);

		await workspace.redo({ designId: designId() });
		expect(workspace.getState().systemDesign!.groups).toHaveLength(1);
	});

	test("a refused nesting cycle changes nothing and adds no history entry", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Cycles" });
		await workspace.addSystemGroup({ id: "outer", name: "Outer", x: 0, y: 0 });
		await workspace.addSystemGroup({ id: "inner", name: "Inner", x: 20, y: 20, memberIds: ["outer"] });
		const before = workspace.getState();
		await expect(workspace.updateSystemGroup({ groupId: "outer", changes: { memberIds: ["inner"] } })).rejects.toThrow(/would create a cycle/);
		expect(workspace.getState().systemDesign).toEqual(before.systemDesign);
		expect(workspace.getState().undoActionName).toBe(before.undoActionName);
	});

	test("removing a Component is one undoable action that restores its Group memberships", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Memberships" });
		await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 60 });
		await workspace.addSystemGroup({ id: "domain", name: "Domain", x: 260, y: 20, memberIds: ["queue"] });
		await workspace.removeSystemComponent({ componentId: "queue" });
		expect(workspace.getState().systemDesign!.groups[0]!.memberIds).toEqual([]);
		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign!.groups[0]!.memberIds).toEqual(["queue"]);
	});
});

describe("System design Group helpers", () => {
	test("a Group offers only members that do not already enclose it and cannot close a cycle", () => {
		const design = groupedDesign();
		expect(systemGroupsContaining(design, "queue").map((group) => group.id).sort()).toEqual(["core", "domain"]);
		expect(canAddSystemGroupMember(design, "domain", "domain")).toBe(false);
		expect(canAddSystemGroupMember(design, "domain", "core")).toBe(false);
		expect(canAddSystemGroupMember(design, "core", "domain")).toBe(true);
		expect(canAddSystemGroupMember(design, "core", "ghost")).toBe(false);
	});

	test("Assistant Revert keeps Group membership only for items the restored design still has", () => {
		const groups = groupedDesign().groups;
		const kept = keepSystemGroupMembers(groups, new Set(["queue", "domain", "core", "orders"]));
		expect(kept.find((group) => group.id === "domain")!.memberIds).toEqual(["queue", "orders"]);
		const pruned = keepSystemGroupMembers(groups, new Set(["domain", "core", "orders"]));
		expect(pruned.find((group) => group.id === "domain")!.memberIds).toEqual(["orders"]);
		expect(pruned.find((group) => group.id === "core")!.memberIds).toEqual(["domain"]);
	});
});


describe("System design database links", () => {
	test("only a Database component may name a Design, and a linked Component cannot change kind until it is unlinked", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "orders-db", kind: "database", name: "Orders DB", position: { x: 0, y: 0 }, designId: "design-orders" });
		expect(() => addSystemComponent(design, { id: "cache", kind: "generic", name: "Cache", position: { x: 300, y: 0 }, designId: "design-orders" }))
			.toThrow("Only a Database component can link to a database design.");
		expect(() => updateSystemComponent(design, "orders-db", { kind: "generic" }))
			.toThrow("Unlink this Component from its database design before changing its kind.");

		const unlinked = updateSystemComponent(design, "orders-db", { designId: undefined });
		expect(findSystemComponent(unlinked, "orders-db")).not.toHaveProperty("designId");
		expect(updateSystemComponent(unlinked, "orders-db", { kind: "generic" }).components[0]!.kind).toBe("generic");
	});

	test("a stored document with a generic Component naming a Design is rejected", () => {
		expect(() => normalizeSystemDesign({
			components: [{ id: "cache", kind: "generic", name: "Cache", properties: [], position: { x: 0, y: 0 }, serviceId: null, designId: "design-1" }],
			connections: [],
		})).toThrow("Only a Database component can link to a database design.");
	});

	test("a conceptual database such as Redis stays unlinked, while a linked Database component keeps its own identity", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await workspace.createProject({ name: "Checkout" });
		await workspace.addSystemComponent({ id: "redis", kind: "database", name: "Session store", technology: "Redis", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "orders-db", kind: "database", name: "Orders DB", technology: "PostgreSQL", x: 300, y: 0 });

		expect(componentIn(workspace, "redis")).not.toHaveProperty("designId");
		const linked = await workspace.createSystemDatabaseDesign({ componentId: "orders-db", name: "Orders schema" });
		const designId = linked.activeDesignId!;
		expect(componentIn(workspace, "orders-db").designId).toBe(designId);
		expect(designId).not.toBe("orders-db");
		expect(componentIn(workspace, "redis")).not.toHaveProperty("designId");
		expect(linked.designs.find((design) => design.id === designId)?.name).toBe("Orders schema");

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(databasePath);
		expect(componentIn(reopened, "orders-db").designId).toBe(designId);
		expect(componentIn(reopened, "redis")).not.toHaveProperty("designId");
	});

	test("creating a Design for a Database component keeps the overview open and its save status, and switching Designs keeps them too", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Overview" });
		await workspace.addSystemComponent({ id: "orders-db", kind: "database", name: "Orders DB", x: 0, y: 0 });
		await workspace.setActiveView({ view: "system" });

		const created = await workspace.createSystemDatabaseDesign({ componentId: "orders-db" });
		expect(created.systemDesign?.components.map((component) => component.id)).toEqual(["orders-db"]);
		expect(created.activeView).toBe("system");
		expect(created.systemSave?.status).toBe("saved");

		const first = created.designs.find((design) => design.id !== created.activeDesignId)!;
		const switched = await workspace.openDesign({ designId: first.id });
		expect(switched.systemDesign?.components.map((component) => component.id)).toEqual(["orders-db"]);
		expect(switched.activeView).toBe("system");
	});

	test("linking, unlinking, and relinking are Project-history actions that Undo and Redo step through, naming each change", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "History" });
		await workspace.addSystemComponent({ id: "orders-db", kind: "database", name: "Orders DB", x: 0, y: 0 });
		const created = await workspace.createSystemDatabaseDesign({ componentId: "orders-db", name: "Orders schema" });
		const designId = created.activeDesignId!;
		expect(created.undoActionName).toBe("Link “Orders DB” to “Orders schema”");

		await workspace.linkSystemDatabase({ componentId: "orders-db", designId: null });
		expect(componentIn(workspace, "orders-db")).not.toHaveProperty("designId");
		expect(workspace.getState().undoActionName).toBe("Unlink “Orders DB” from its design");

		await workspace.undo({ designId });
		expect(componentIn(workspace, "orders-db").designId).toBe(designId);
		await workspace.redo({ designId });
		expect(componentIn(workspace, "orders-db")).not.toHaveProperty("designId");
	});

	test("two Database components can share one Design, and a schema edit is visible through either link across reopen", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await workspace.createProject({ name: "Replicas" });
		await workspace.addSystemComponent({ id: "primary", kind: "database", name: "Primary", technology: "PostgreSQL", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "replica", kind: "database", name: "Read replica", technology: "PostgreSQL", x: 300, y: 0 });
		const created = await workspace.createSystemDatabaseDesign({ componentId: "primary", name: "Orders schema" });
		const shared = created.activeDesignId!;
		const linked = await workspace.linkSystemDatabase({ componentId: "replica", designId: shared });

		expect(componentsLinkedToDesign(linked.systemDesign!, shared).map((component) => component.id)).toEqual(["primary", "replica"]);
		expect(linked.undoActionName).toBe("Link “Read replica” to “Orders schema”");

		await workspace.addTable({ name: "orders", designId: shared });
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		const state = reopened.getState();
		expect(componentsLinkedToDesign(state.systemDesign!, shared)).toHaveLength(2);
		const opened = await reopened.openDesign({ designId: shared });
		expect(opened.design?.tables.map((table) => table.name)).toEqual(["orders"]);
	});

	test("unlinking or removing a Database component keeps its Design, Scenarios, and Edge functions", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await workspace.createProject({ name: "Billing" });
		await workspace.addSystemComponent({ id: "billing-db", kind: "database", name: "Billing DB", x: 0, y: 0 });
		const created = await workspace.createSystemDatabaseDesign({ componentId: "billing-db", name: "Billing schema" });
		const designId = created.activeDesignId!;
		await workspace.createScenario({ name: "Charge card", designId });
		await workspace.createEdgeFunction({ name: "webhook", designId });

		await workspace.linkSystemDatabase({ componentId: "billing-db", designId: null });
		await workspace.removeSystemComponent({ componentId: "billing-db" });
		expect(workspace.getState().systemDesign?.components).toEqual([]);
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		const opened = await reopened.openDesign({ designId });
		expect(opened.designs.map((design) => design.name)).toContain("Billing schema");
		expect(opened.scenarios.map((scenario) => scenario.name)).toEqual(["Charge card"]);
		expect(opened.edgeFunctions.map((edgeFunction) => edgeFunction.name)).toEqual(["webhook"]);
	});

	test("link requests refuse a Design outside the Project, a generic Component, and a Component that is already linked", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Guards" });
		await workspace.addSystemComponent({ id: "orders-db", kind: "database", name: "Orders DB", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 300, y: 0 });
		await expect(workspace.linkSystemDatabase({ componentId: "orders-db", designId: "missing-design" }))
			.rejects.toThrow("That design could not be found in this project.");
		await expect(workspace.linkSystemDatabase({ componentId: "queue", designId: workspace.getState().activeDesignId! }))
			.rejects.toThrow("Only a Database component can link to a database design.");
		await expect(workspace.createSystemDatabaseDesign({ componentId: "queue" }))
			.rejects.toThrow("Only a Database component can link to a database design.");

		await workspace.createSystemDatabaseDesign({ componentId: "orders-db" });
		await expect(workspace.createSystemDatabaseDesign({ componentId: "orders-db" }))
			.rejects.toThrow("This database component is already linked to a design. Unlink it first.");
	});
});

function componentIn(workspace: DesignWorkspace, componentId: string) {
	const component = workspace.getState().systemDesign?.components.find((item) => item.id === componentId);
	if (!component) throw new Error(`Missing component ${componentId}`);
	return component;
}

describe("System design collapsed Services", () => {
	test("collapsing is presentation: it names the Service without changing its Components or Connections", () => {
		let design = servicedDesign();
		design = addSystemConnection(design, { id: "dispatch", sourceId: "worker", targetId: "queue", label: "Enqueues" });
		const collapsed = setSystemServiceCollapsed(design, "orders", true);

		expect(collapsed.collapsedServiceIds).toEqual(["orders"]);
		expect(collapsed.components).toEqual(design.components);
		expect(collapsed.connections).toEqual(design.connections);
		expect(systemDesignContent(collapsed)).toEqual(systemDesignContent(design));
		expect(setSystemServiceCollapsed(collapsed, "orders", true)).toBe(collapsed);
		expect(setSystemServiceCollapsed(collapsed, "orders", false).collapsedServiceIds).toEqual([]);
		expect(() => setSystemServiceCollapsed(design, "missing", true)).toThrow("That Service could not be found.");
	});

	test("an owned Component's endpoint is its collapsed Service, while system-scope and Service endpoints keep their own identity", () => {
		let design = setSystemServiceCollapsed(servicedDesign(), "orders", true);
		design = addSystemConnection(design, { id: "dispatch", sourceId: "orders", targetId: "queue", label: "Dispatches" });

		expect(visibleEndpointOf(design, "worker")).toBe("orders");
		expect(visibleEndpointOf(design, "queue")).toBe("queue");
		expect(visibleEndpointOf(design, "orders")).toBe("orders");
		expect(isComponentHiddenByCollapse(design, "worker")).toBe(true);
		expect(isComponentHiddenByCollapse(design, "queue")).toBe(false);
		expect(isComponentHiddenByCollapse(setSystemServiceCollapsed(design, "orders", false), "worker")).toBe(false);
	});

	test("route offsets use drawn endpoints, so Connections projected onto one boundary stay distinct", () => {
		let design = servicedDesign();
		design = addSystemComponent(design, { id: "cache", name: "Cache", position: { x: 300, y: 200 }, serviceId: "orders" });
		design = addSystemConnection(design, { id: "reads", sourceId: "worker", targetId: "queue", label: "Reads" });
		design = addSystemConnection(design, { id: "writes", sourceId: "cache", targetId: "queue", label: "Writes" });
		const drawn = (id: string) => visibleEndpointOf(setSystemServiceCollapsed(design, "orders", true), id);

		expect(systemConnectionRouteOffsets(design).get("reads")).toBe(0);
		const offsets = systemConnectionRouteOffsets(setSystemServiceCollapsed(design, "orders", true), drawn);
		expect(offsets.get("reads")).not.toBe(offsets.get("writes"));
	});

	test("removing a Service forgets its collapsed presentation, and loading ignores stale or missing collapse state", () => {
		const collapsed = setSystemServiceCollapsed(servicedDesign(), "orders", true);
		expect(removeSystemService(collapsed, "orders").collapsedServiceIds).toEqual([]);

		const legacy = normalizeSystemDesign({
			services: [{ id: "orders", name: "Orders", position: { x: 0, y: 0 } }],
			components: [],
			connections: [],
		});
		expect(legacy.collapsedServiceIds).toEqual([]);

		const restored = normalizeSystemDesign({
			services: [{ id: "orders", name: "Orders", position: { x: 0, y: 0 } }],
			components: [],
			connections: [],
			collapsedServiceIds: ["orders", "orders", "gone", 7],
		});
		expect(restored.collapsedServiceIds).toEqual(["orders"]);
		expect(normalizeSystemDesign(JSON.parse(JSON.stringify(collapsed)))).toEqual(collapsed);
	});

	test("restoring content keeps the open presentation and drops collapsed Services that no longer exist", () => {
		const open = setSystemServiceCollapsed(servicedDesign(), "orders", true);
		const restored = withSystemPresentation(systemDesignContent(removeSystemService(open, "orders")), open);
		expect(restored.collapsedServiceIds).toEqual([]);
		expect(restored.viewport).toEqual(open.viewport);
		expect(withSystemPresentation(systemDesignContent(open), open).collapsedServiceIds).toEqual(["orders"]);
	});
});

describe("System design collapsed Services workspace", () => {
	test("collapsing is saved with the design across reopen and never becomes an undoable action", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await first.createProject({ name: "Overview" });
		await first.addSystemService({ id: "orders", name: "Orders", x: 0, y: 0 });
		await first.addSystemComponent({ id: "worker", name: "Worker", x: 40, y: 60, serviceId: "orders" });
		const before = first.getState();
		const collapsed = await first.setSystemServiceCollapsed({ serviceId: "orders", collapsed: true });

		expect(collapsed.systemDesign?.collapsedServiceIds).toEqual(["orders"]);
		expect(collapsed.undoActionName).toBe(before.undoActionName);
		expect(collapsed.undoRedo).toEqual(before.undoRedo);
		expect(collapsed.systemDesign?.components.find((component) => component.id === "worker")).toMatchObject({ serviceId: "orders" });

		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);
		const reopened = await openWorkspace(databasePath);
		expect(reopened.getState().systemDesign?.collapsedServiceIds).toEqual(["orders"]);
	});

	test("Undo reverses content edits but leaves a collapsed Service collapsed, and expanding is not undoable", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Overview" });
		await workspace.addSystemService({ id: "orders", name: "Orders", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "worker", name: "Worker", x: 40, y: 60, serviceId: "orders" });
		await workspace.setSystemServiceCollapsed({ serviceId: "orders", collapsed: true });
		await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 360, y: 60 });

		await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(workspace.getState().systemDesign?.components.map((component) => component.id)).toEqual(["worker"]);
		expect(workspace.getState().systemDesign?.collapsedServiceIds).toEqual(["orders"]);

		await workspace.setSystemServiceCollapsed({ serviceId: "orders", collapsed: false });
		expect(workspace.getState().systemDesign?.collapsedServiceIds).toEqual([]);
		expect(workspace.getState().undoActionName).toBe("Add component “Worker”");
	});
});
