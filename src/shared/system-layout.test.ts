import { expect, test } from "bun:test";
import { addSystemComponent, addSystemService, createEmptySystemDesign, SYSTEM_COMPONENT_SIZE } from "./system-design";
import { applySystemLayout, computeSystemLayout, systemCardsOverlap } from "./system-layout";

test("older compact rows can be arranged for taller cards without changing ownership or identity", () => {
	let design = addSystemService(createEmptySystemDesign(), { id: "service", name: "Orders", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "api", kind: "api", name: "API", position: { x: 32, y: 64 }, serviceId: "service" });
	design = addSystemComponent(design, { id: "worker", kind: "worker", name: "Worker", position: { x: 32, y: 192 }, serviceId: "service" });
	const original = structuredClone(design);
	expect(systemCardsOverlap(design)).toBe(true);
	const arranged = applySystemLayout(design, computeSystemLayout(design));
	expect(systemCardsOverlap(arranged)).toBe(false);
	expect(design).toEqual(original);
	expect(arranged.components.map(({ id, serviceId }) => ({ id, serviceId }))).toEqual([
		{ id: "api", serviceId: "service" }, { id: "worker", serviceId: "service" },
	]);
	const service = arranged.services[0]!;
	for (const component of arranged.components) {
		expect(component.position.y + SYSTEM_COMPONENT_SIZE.height).toBeLessThan(service.position.y + service.size.height);
	}
	expect(systemCardsOverlap({ ...design, collapsedServiceIds: ["service"] })).toBe(false);
});
