import { describe, expect, test } from "bun:test";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	systemDesignContent,
	type SystemDesign,
} from "../shared/system-design";
import { checkSystemReadPreconditions, planSystemOperations } from "./system-design-operations";

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
		])).toThrow('Operation 2 (add_connection): targetId "missing" does not match a Component.');
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
