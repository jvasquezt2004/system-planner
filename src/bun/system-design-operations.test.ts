import { describe, expect, test } from "bun:test";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	systemDesignContent,
	type SystemDesign,
} from "../shared/system-design";
import { SYSTEM_LAYOUT_COLUMN_GAP } from "../shared/system-layout";
import {
	checkSystemReadPreconditions,
	planSystemOperations,
	readSystemArchitecture,
	systemDiagnostics,
} from "./system-design-operations";

function twoComponentDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", name: "Client", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "api", name: "API", position: { x: 300, y: 0 } });
	return addSystemConnection(design, { id: "reads", sourceId: "client", targetId: "api", label: "Reads" });
}

describe("Assistant System design operations", () => {
	test("a batch can add a Component and a Connection to it by the id it chose", () => {
		const plan = planSystemOperations(twoComponentDesign(), [
			{ op: "add_component", id: "worker", name: "Worker", x: 600, y: 0 },
			{ op: "add_connection", id: "jobs", sourceId: "api", targetId: "worker", label: "Enqueues job" },
		], "turn-1");

		expect(plan.next.components.map((component) => component.id)).toEqual(["client", "api", "worker"]);
		expect(plan.next.connections.map((connection) => connection.label)).toEqual(["Reads", "Enqueues job"]);
		expect(plan.actions.map((planned) => planned.type)).toEqual(["addComponent", "addConnection"]);
		expect(plan.actions.every((planned) => (planned.action as { assistantTurnId?: string }).assistantTurnId === "turn-1")).toBe(true);
	});

	test("an invalid operation anywhere in the batch refuses the whole batch before anything changes", () => {
		const current = twoComponentDesign();
		const before = JSON.stringify(systemDesignContent(current));
		expect(() => planSystemOperations(current, [
			{ op: "add_component", id: "worker", name: "Worker", x: 600, y: 0 },
			{ op: "add_connection", id: "broken", sourceId: "api", targetId: "missing", label: "Calls" },
		])).toThrow('Operation 2 (add_connection): targetId "missing" does not match a Component or Service.');
		expect(JSON.stringify(systemDesignContent(current))).toBe(before);
	});

	test("an empty batch and an unknown operation are refused", () => {
		expect(() => planSystemOperations(twoComponentDesign(), [])).toThrow("At least one System design operation is required.");
		expect(() => planSystemOperations(twoComponentDesign(), [{ op: "rename_everything" as never }])).toThrow('Unsupported operation "rename_everything"');
	});

	test("removing a Component plans the removal of its Connections in the same batch", () => {
		const plan = planSystemOperations(twoComponentDesign(), [{ op: "remove_component", componentId: "api" }]);
		expect(plan.next.components.map((component) => component.id)).toEqual(["client"]);
		expect(plan.next.connections).toEqual([]);
	});

	test("refuses an edit to a Component that changed after the Assistant read it", () => {
		const read = systemDesignContent(twoComponentDesign());
		const changedByDesigner = {
			...twoComponentDesign(),
			components: twoComponentDesign().components.map((component) => (
				component.id === "api" ? { ...component, position: { x: 500, y: 90 } } : component
			)),
		};
		expect(() => checkSystemReadPreconditions(read, changedByDesigner, [
			{ op: "update_component", componentId: "api", name: "Gateway" },
		])).toThrow("These items changed after you read the project: component api.");
	});

	test("does not refuse an edit to an item that was unchanged since the read", () => {
		const current = twoComponentDesign();
		expect(() => checkSystemReadPreconditions(systemDesignContent(current), current, [
			{ op: "update_component", componentId: "api", name: "Gateway" },
		])).not.toThrow();
	});
});

/** A Project with two Services, a database Component linked to design "orders", and a worker chain. */
function architectureDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemService(design, { id: "edge", name: "Edge", position: { x: 0, y: 0 } });
	design = addSystemService(design, { id: "core", name: "Core", position: { x: 520, y: 0 } });
	design = addSystemComponent(design, { id: "gateway", name: "Gateway", position: { x: 40, y: 60 }, serviceId: "edge" });
	design = addSystemComponent(design, { id: "orders", name: "Orders", position: { x: 600, y: 60 }, serviceId: "core" });
	design = addSystemComponent(design, { id: "store", kind: "database", name: "Orders DB", position: { x: 900, y: 60 }, designId: "orders" });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 1200, y: 60 } });
	design = addSystemConnection(design, { id: "routes", sourceId: "gateway", targetId: "orders", label: "Routes order" });
	return addSystemConnection(design, { id: "writes", sourceId: "orders", targetId: "store", label: "Writes" });
}

describe("Assistant ownership, Groups, database links, routes, and layout", () => {
	test("assigns and releases Service ownership, and reports the release as an impact", () => {
		const assigned = planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "queue", ownerServiceId: "core" },
		]);
		expect(assigned.next.components.find((component) => component.id === "queue")?.serviceId).toBe("core");

		const released = planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "orders", ownerServiceId: null },
		]);
		expect(released.next.components.find((component) => component.id === "orders")?.serviceId).toBeNull();
		expect(released.impacts).toEqual(['Released 1 Component to system scope: orders.']);
	});

	test("refuses an owner that is not a Service", () => {
		expect(() => planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "queue", ownerServiceId: "gateway" },
		])).toThrow('ownerServiceId "gateway" does not match a Service.');
	});

	test("removing a Service releases its Components, deletes its Connections, and reports both", () => {
		const plan = planSystemOperations(architectureDesign(), [{ op: "remove_service", serviceId: "edge" }]);
		expect(plan.next.services.map((service) => service.id)).toEqual(["core"]);
		expect(plan.next.components.find((component) => component.id === "gateway")?.serviceId).toBeNull();
		// Connections between Components stay; only Connections whose endpoint is the Service are deleted.
		expect(plan.next.connections.map((connection) => connection.id)).toEqual(["routes", "writes"]);
		expect(plan.impacts).toEqual(["Released 1 Component to system scope: gateway."]);
	});

	test("moving a Service carries the Components it owns and reports them", () => {
		const plan = planSystemOperations(architectureDesign(), [{ op: "move_service", serviceId: "core", x: 500, y: 200 }]);
		expect(plan.next.components.find((component) => component.id === "orders")?.position).toEqual({ x: 580, y: 260 });
		expect(plan.impacts).toEqual(['Moved 1 Component with the frame: orders.']);
	});

	test("a Group takes the frame around its members when it is given none, and its members keep their ownership", () => {
		const plan = planSystemOperations(architectureDesign(), [
			{ op: "add_group", id: "domain", name: "Orders domain", memberIds: ["orders", "store"] },
		]);
		const group = plan.next.groups[0]!;
		expect(group.memberIds).toEqual(["orders", "store"]);
		expect(group.position.x).toBeLessThanOrEqual(600);
		expect(group.position.x + group.size.width).toBeGreaterThanOrEqual(900 + 180);
		expect(plan.next.components.find((component) => component.id === "orders")?.serviceId).toBe("core");
	});

	test("refuses Group membership that nests a Group inside its own member, and unknown members", () => {
		let design = architectureDesign();
		design = addSystemGroup(design, { id: "inner", name: "Inner", position: { x: 0, y: 0 }, memberIds: ["orders"] });
		design = addSystemGroup(design, { id: "outer", name: "Outer", position: { x: 0, y: 0 }, memberIds: ["inner"] });
		expect(() => planSystemOperations(design, [
			{ op: "update_group", groupId: "inner", memberIds: ["outer"] },
		])).toThrow("would create a cycle");
		expect(() => planSystemOperations(design, [
			{ op: "update_group", groupId: "inner", memberIds: ["nobody"] },
		])).toThrow('"nobody" does not match a Component, Service, or Group.');
	});

	test("updating a Group replaces its members without changing any Component's ownership", () => {
		let design = architectureDesign();
		design = addSystemGroup(design, { id: "domain", name: "Domain", position: { x: 0, y: 0 }, memberIds: ["gateway"] });
		const plan = planSystemOperations(design, [{ op: "update_group", groupId: "domain", memberIds: ["queue", "edge"] }]);
		expect(plan.next.groups[0]?.memberIds).toEqual(["queue", "edge"]);
		expect(plan.next.components.find((component) => component.id === "gateway")?.serviceId).toBe("edge");
	});

	test("links and unlinks a database Component only to a design the Project has", () => {
		const designIds = new Set(["orders", "reporting"]);
		const linked = planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "store", linkedDesignId: "reporting" },
		], undefined, designIds);
		expect(linked.next.components.find((component) => component.id === "store")?.designId).toBe("reporting");

		const unlinked = planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "store", linkedDesignId: null },
		], undefined, designIds);
		expect(unlinked.next.components.find((component) => component.id === "store")?.designId).toBeUndefined();

		expect(() => planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "store", linkedDesignId: "missing" },
		], undefined, designIds)).toThrow('linkedDesignId "missing" does not match a database design in this Project.');
		expect(() => planSystemOperations(architectureDesign(), [
			{ op: "update_component", componentId: "queue", linkedDesignId: "orders" },
		], undefined, designIds)).toThrow("Only a Database component can link to a database design.");
	});

	test("a database Component added with a link names a design the Project has", () => {
		const plan = planSystemOperations(architectureDesign(), [
			{ op: "add_component", id: "replica", kind: "database", name: "Replica", linkedDesignId: "orders", x: 900, y: 240 },
		], undefined, new Set(["orders"]));
		expect(plan.next.components.find((component) => component.id === "replica")?.designId).toBe("orders");
		expect(plan.actions[0]).toMatchObject({ type: "addComponent", action: { designId: "orders" } });
	});

	test("sets Connection attachment sides, bend points, and label offsets, and restores them", () => {
		const routed = planSystemOperations(architectureDesign(), [
			{ op: "update_connection", connectionId: "routes", fromSide: "right", toSide: "left", bendPoints: [{ x: 300, y: -30 }], labelOffset: { x: 0, y: -14 } },
		]);
		expect(routed.next.connections.find((connection) => connection.id === "routes")).toMatchObject({
			fromSide: "right",
			toSide: "left",
			bendPoints: [{ x: 300, y: -30 }],
			labelOffset: { x: 0, y: -14 },
		});

		const restored = planSystemOperations(routed.next, [
			{ op: "update_connection", connectionId: "routes", fromSide: "auto", toSide: "auto", bendPoints: [], labelOffset: null },
		]);
		const connection = restored.next.connections.find((item) => item.id === "routes");
		expect(connection).not.toHaveProperty("fromSide");
		expect(connection).not.toHaveProperty("toSide");
		expect(connection).not.toHaveProperty("bendPoints");
		expect(connection).not.toHaveProperty("labelOffset");
	});

	test("arranges Components in layers along their Connections, left to right, and keeps unrequested positions", () => {
		const design = architectureDesign();
		const plan = planSystemOperations(design, [{ op: "arrange_layout", componentIds: ["gateway", "orders", "store"] }]);
		const at = (id: string) => plan.next.components.find((component) => component.id === id)!.position;
		expect(at("gateway").x).toBeLessThan(at("orders").x);
		expect(at("orders").x).toBeLessThan(at("store").x);
		expect(at("orders").x - at("gateway").x).toBe(SYSTEM_LAYOUT_COLUMN_GAP);
		// The Component left out of the arrangement keeps its place.
		expect(at("queue")).toEqual({ x: 1200, y: 60 });
		expect(plan.impacts).toContain("Arranged layout for 4 Components.");
	});

	test("an arrangement never overlaps two Service boundaries, even when their layers interleave", () => {
		let design = architectureDesign();
		// "auth" sits in the same layer as "orders" but belongs to another Service, the case that interleaved frames before.
		design = addSystemComponent(design, { id: "auth", name: "Auth", position: { x: 0, y: 0 }, serviceId: "edge" });
		design = addSystemConnection(design, { id: "gw-auth", sourceId: "gateway", targetId: "auth", label: "Checks" });
		const next = planSystemOperations(design, [{ op: "arrange_layout" }]).next;
		const [edge, core] = ["edge", "core"].map((id) => next.services.find((service) => service.id === id)!);
		const overlaps = edge!.position.x < core!.position.x + core!.size.width
			&& core!.position.x < edge!.position.x + edge!.size.width
			&& edge!.position.y < core!.position.y + core!.size.height
			&& core!.position.y < edge!.position.y + edge!.size.height;
		expect(overlaps).toBe(false);
	});

	test("a layout keeps every Component of a Service inside its refitted frame", () => {
		const design = architectureDesign();
		const next = planSystemOperations(design, [{ op: "arrange_layout" }]).next;
		const core = next.services.find((service) => service.id === "core")!;
		const orders = next.components.find((component) => component.id === "orders")!;
		expect(orders.position.x).toBeGreaterThanOrEqual(core.position.x);
		expect(orders.position.y).toBeGreaterThanOrEqual(core.position.y);
		expect(orders.position.x + 180).toBeLessThanOrEqual(core.position.x + core.size.width);
		expect(orders.position.y + 84).toBeLessThanOrEqual(core.position.y + core.size.height);
	});

	test("an arrangement refuses when an item it depends on changed after the read", () => {
		const read = systemDesignContent(architectureDesign());
		const changedByDesigner = architectureDesign();
		const moved = { ...changedByDesigner, components: changedByDesigner.components.map((component) => (
			component.id === "queue" ? { ...component, position: { x: 9, y: 9 } } : component
		)) };
		expect(() => checkSystemReadPreconditions(read, moved, [{ op: "arrange_layout" }]))
			.toThrow("These items changed after you read the project: component queue.");
	});

	test("removing a Service refuses when a Component it owns changed after the read, but not when an unrelated one did", () => {
		const current = architectureDesign();
		const read = systemDesignContent(current);
		const unrelated = { ...current, components: current.components.map((component) => (
			component.id === "queue" ? { ...component, position: { x: 1, y: 1 } } : component
		)) };
		expect(() => checkSystemReadPreconditions(read, unrelated, [{ op: "remove_service", serviceId: "core" }])).not.toThrow();

		const owned = { ...current, components: current.components.map((component) => (
			component.id === "orders" ? { ...component, position: { x: 1, y: 1 } } : component
		)) };
		expect(() => checkSystemReadPreconditions(read, owned, [{ op: "remove_service", serviceId: "core" }]))
			.toThrow("component orders");
	});

	test("removing a Component reports the Connections its removal deletes", () => {
		const plan = planSystemOperations(architectureDesign(), [{ op: "remove_component", componentId: "orders" }]);
		expect(plan.impacts).toEqual([
			'Removed Connection "Routes order" (routes) because one of its endpoints was removed.',
			'Removed Connection "Writes" (writes) because one of its endpoints was removed.',
		]);
	});

	test("the read view names ownership, Group membership, links, routes, versions, and diagnostics by their stable ids", () => {
		let design = architectureDesign();
		design = addSystemGroup(design, { id: "domain", name: "Domain", position: { x: 0, y: 0 }, memberIds: ["orders", "store"] });
		const view = readSystemArchitecture(design, [{ id: "orders", name: "Orders" }]);
		expect(view.components.find((component) => component.id === "orders")).toMatchObject({
			ownerServiceId: "core",
			linkedDesignId: null,
			groupIds: ["domain"],
		});
		expect(view.components.find((component) => component.id === "store")).toMatchObject({ linkedDesignId: "orders" });
		expect(view.groups[0]).toMatchObject({ id: "domain", memberIds: ["orders", "store"] });
		expect(view.connections.find((connection) => connection.id === "routes")?.attachment).toEqual({ fromSide: "auto", toSide: "auto" });
		expect(view.components[0]?.version).toHaveLength(12);
		expect(view.designs).toEqual([{ id: "orders", name: "Orders" }]);
		expect(view.diagnostics).toEqual([]);
	});

	test("diagnostics name unlinked database components, missing designs, and shared schemas", () => {
		let design = architectureDesign();
		design = addSystemComponent(design, { id: "bare", kind: "database", name: "Bare DB", position: { x: 0, y: 300 } });
		design = addSystemComponent(design, { id: "mirror", kind: "database", name: "Mirror", position: { x: 300, y: 300 }, designId: "orders" });
		const notes = systemDiagnostics(design, new Set(["orders"]));
		expect(notes).toContain('Database component "Bare DB" (bare) has no linked database design.');
		expect(notes).toContain('Design "orders" is a shared schema linked from store, mirror.');
		expect(systemDiagnostics(design, new Set())).toContain('Component "Orders DB" (store) links design "orders", which is not in this Project.');
	});
});
