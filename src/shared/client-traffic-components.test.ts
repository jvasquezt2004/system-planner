import { describe, expect, test } from "bun:test";
import { CLIENT_TRAFFIC_KINDS } from "./component-catalog";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	normalizeSystemDesign,
	SYSTEM_COMPONENT_KINDS,
	updateSystemComponent,
	type SystemDesign,
} from "./system-design";

function everyKind(): SystemDesign {
	let design = createEmptySystemDesign();
	for (const [index, kind] of CLIENT_TRAFFIC_KINDS.entries()) {
		design = addSystemComponent(design, { id: kind, kind, position: { x: index * 220, y: 0 } });
	}
	return design;
}

describe("client and traffic Components in the shared System design", () => {
	test("every catalog kind is an accepted Component kind alongside the original two", () => {
		expect([...SYSTEM_COMPONENT_KINDS]).toEqual(["generic", "database", ...CLIENT_TRAFFIC_KINDS]);
	});

	test("each new Component gets its kind's default name and keeps optional branding and descriptive properties", () => {
		let design = everyKind();
		design = addSystemComponent(design, { id: "dns-2", kind: "dns", position: { x: 0, y: 300 } });
		expect(design.components.find((component) => component.id === "load_balancer")?.name).toBe("Load balancer");
		expect(design.components.find((component) => component.id === "dns-2")?.name).toBe("DNS 2");

		design = updateSystemComponent(design, "cdn", {
			technology: "Cloudflare",
			description: "Serves product images",
			properties: [{ key: "Content", value: "Product images" }, { key: "Cache policy", value: "One day" }],
		});
		const cdn = design.components.find((component) => component.id === "cdn")!;
		expect(cdn).toMatchObject({ kind: "cdn", technology: "Cloudflare", properties: [{ key: "Content", value: "Product images" }, { key: "Cache policy", value: "One day" }] });
	});

	test("a Component with no branding, description, or properties is valid, so no vendor is ever required", () => {
		const design = everyKind();
		for (const component of design.components) {
			expect(component.technology).toBeUndefined();
			expect(component.description).toBeUndefined();
			expect(component.properties).toEqual([]);
		}
	});

	test("all nine kinds round-trip through stored content, and a kind outside the catalog is refused", () => {
		let design = everyKind();
		design = addSystemConnection(design, { id: "lookup", sourceId: "browser", targetId: "dns", label: "Resolve" });
		design = addSystemConnection(design, { id: "serve", sourceId: "cdn", targetId: "load_balancer", label: "Origin fetch" });
		const reopened = normalizeSystemDesign(JSON.parse(JSON.stringify(design)));
		expect(reopened.components.map((component) => component.kind)).toEqual([...CLIENT_TRAFFIC_KINDS]);
		expect(reopened.connections.map((connection) => connection.id)).toEqual(["lookup", "serve"]);

		const stored = JSON.parse(JSON.stringify(design));
		stored.components[0].kind = "mainframe";
		expect(() => normalizeSystemDesign(stored)).toThrow('Unsupported Component kind "mainframe".');
	});

	test("a client or traffic Component cannot link a database Design", () => {
		const design = everyKind();
		expect(() => updateSystemComponent(design, "cdn", { designId: "design-1" })).toThrow();
	});
});
