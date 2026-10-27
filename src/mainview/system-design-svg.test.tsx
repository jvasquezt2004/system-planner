import { describe, expect, test } from "bun:test";
import { COMPONENT_CATALOG, CUSTOM_ICONS } from "../shared/component-catalog";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	setSystemFocus,
	setSystemServiceCollapsed,
	type SystemDesign,
} from "../shared/system-design";
import { embeddedFontFaceCss, systemDesignSvg } from "./system-design-svg";

const TITLE = "Shop";

function exportSvg(design: SystemDesign): string {
	return systemDesignSvg(design, { title: TITLE });
}

/** A small system: two Services, a Group around one of them, a shared database, and parallel Connections. */
function sampleDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
	design = addSystemService(design, { id: "billing", name: "Billing", position: { x: 620, y: 0 } });
	design = addSystemComponent(design, { id: "api", kind: "api", name: "Order API", technology: "HTTP", position: { x: 40, y: 80 }, serviceId: "orders" });
	design = addSystemComponent(design, { id: "worker", kind: "worker", name: "Order Worker", position: { x: 240, y: 80 }, serviceId: "orders" });
	design = addSystemComponent(design, { id: "ledger", kind: "database", name: "Ledger", position: { x: 680, y: 80 }, serviceId: "billing", designId: "design-ledger" });
	design = addSystemComponent(design, { id: "reports", kind: "database", name: "Reports", position: { x: 680, y: 260 }, designId: "design-ledger" });
	design = addSystemComponent(design, { id: "cdn", kind: "cdn", name: "Edge", position: { x: -320, y: 80 } });
	design = addSystemGroup(design, { id: "region", name: "EU Region", position: { x: -360, y: -60 }, size: { width: 1400, height: 520 }, memberIds: ["orders", "billing"] });
	design = addSystemConnection(design, { id: "place", sourceId: "api", targetId: "ledger", label: "Places order" });
	design = addSystemConnection(design, { id: "confirm", sourceId: "api", targetId: "ledger", label: "Confirms order" });
	design = addSystemConnection(design, { id: "edge-in", sourceId: "cdn", targetId: "api", label: "Requests" });
	design = addSystemConnection(design, { id: "enqueue", sourceId: "api", targetId: "worker", label: "Enqueues" });
	return design;
}

describe("System design SVG export", () => {
	test("writes a standalone SVG document with every drawn element", () => {
		const svg = exportSvg(sampleDesign());
		expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
		expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
		expect(svg).toContain(`<title>${TITLE}</title>`);
		for (const text of ["Orders", "Billing", "EU Region", "Order API", "Order Worker", "Ledger", "Reports", "Edge", "Places order", "Confirms order", "Requests", "HTTP"]) {
			expect(svg).toContain(text);
		}
		expect(svg).toContain('data-service-id="orders"');
		expect(svg).toContain('data-group-id="region"');
		expect(svg).toContain('data-connection-id="edge-in"');
		expect(svg).toContain("in Orders");
		expect(svg).toContain("GROUP · 2");
	});

	test("draws parallel Connections between the same endpoints as distinct routes", () => {
		const svg = exportSvg(sampleDesign());
		const paths = [...svg.matchAll(/data-connection-id="(place|confirm)"[^>]*>\s*<path d="([^"]+)"/g)].map((match) => match[2]);
		expect(paths).toHaveLength(2);
		expect(paths[0]).not.toBe(paths[1]);
	});

	test("labels linked database Components as SHARED when several Components use one Design, and LINKED otherwise", () => {
		const svg = exportSvg(sampleDesign());
		expect(svg.match(/>SHARED</g)).toHaveLength(2);
		let single = createEmptySystemDesign();
		single = addSystemComponent(single, { id: "db", kind: "database", name: "Solo", position: { x: 0, y: 0 }, designId: "design-solo" });
		expect(exportSvg(single)).toContain(">LINKED<");
		expect(exportSvg(single)).not.toContain(">SHARED<");
	});

	test("every registered catalog kind is drawn with its own artwork, without a separate list", () => {
		let design = createEmptySystemDesign();
		COMPONENT_CATALOG.forEach((entry, index) => {
			design = addSystemComponent(design, { id: `kind-${entry.kind}`, kind: entry.kind, name: entry.label, position: { x: (index % 7) * 200, y: Math.floor(index / 7) * 120 } });
		});
		const svg = exportSvg(design);
		for (const entry of COMPONENT_CATALOG) {
			expect(svg).toContain(`data-kind="${entry.kind}"`);
			expect(svg).toContain(`data-artwork="${entry.kind}"`);
		}
		expect(COMPONENT_CATALOG).toHaveLength(28);
	});

	test("draws generic Components without artwork and Custom Components with their chosen icon", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "plain", name: "Plain box", position: { x: 0, y: 0 } });
		CUSTOM_ICONS.forEach((icon, index) => {
			design = addSystemComponent(design, { id: `custom-${icon}`, kind: "custom", name: icon, icon, position: { x: index * 200, y: 200 } });
		});
		const svg = exportSvg(design);
		expect(svg).toContain('data-kind="generic"');
		expect(svg).not.toContain('data-artwork="generic"');
		for (const icon of CUSTOM_ICONS) {
			expect(svg).toContain(`data-icon="${icon}"`);
		}
	});

	test("a collapsed Service hides its Components, states what it contains, and carries their Connections", () => {
		let design = sampleDesign();
		design = setSystemServiceCollapsed(design, "orders", true);
		const svg = exportSvg(design);
		expect(svg).toContain('data-service-id="orders" data-collapsed="true"');
		expect(svg).toContain("2 components · 1 internal");
		expect(svg).not.toContain("Order API");
		expect(svg).not.toContain("Order Worker");
		expect(svg).toContain('data-connection-id="place"');
		expect(svg).toContain('data-connection-id="edge-in"');
	});

	test("a focused view draws the Service, its owned Components, and outside context only, without Groups", () => {
		let design = sampleDesign();
		design = setSystemFocus(design, "orders");
		const svg = exportSvg(design);
		expect(svg).toContain(">SERVICE</text>");
		expect(svg).toContain('data-service-id="orders" data-collapsed="false"');
		expect(svg).toContain('data-context="true"');
		expect(svg).toContain("Edge");
		expect(svg).toContain("· OUTSIDE");
		expect(svg).not.toContain("EU Region");
		expect(svg).not.toContain("data-group-id");
		expect(svg).toContain("in Billing");
		// Connections that reach the focused Service's Components stay drawn, to their outside endpoint.
		expect(svg).toContain('data-connection-id="confirm"');
		expect(svg).not.toContain('data-connection-id="edge-in"'.replace("edge-in", "missing"));
	});

	test("keeps output identical when the Project changes after the snapshot is taken", () => {
		const design = sampleDesign();
		const captured = structuredClone(design);
		const expected = exportSvg(captured);
		design.components[0]!.name = "Renamed after export";
		design.components[0]!.position = { x: 900, y: 900 };
		design.services.push({ id: "late", name: "Late", position: { x: 0, y: 900 }, size: { width: 240, height: 160 } });
		expect(exportSvg(captured)).toBe(expected);
		expect(exportSvg(captured)).not.toContain("Renamed after export");
	});

	test("resolves every colour token, so the file depends on no CSS variable", () => {
		const svg = exportSvg(sampleDesign());
		expect(svg).not.toContain("var(");
		expect(svg).toContain("#1b1a17");
	});

	test("references no remote asset, script, or external stylesheet", () => {
		const svg = systemDesignSvg(sampleDesign(), { title: TITLE, fontFaceCss: embeddedFontFaceCss("data:font/woff2;base64,AAAA") });
		expect(svg.replaceAll('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http");
		// Only the embedded data URL and same-document references may appear.
		expect(svg).not.toMatch(/href=|@import|<script|<link|url\((?!#|"data:|'data:)/);
	});

	test("embeds the font declaration inline, and names the font the labels use", () => {
		const svg = systemDesignSvg(sampleDesign(), { title: TITLE, fontFaceCss: embeddedFontFaceCss("data:font/woff2;base64,AAAA") });
		expect(svg).toContain("@font-face");
		expect(svg).toContain('src: url("data:font/woff2;base64,AAAA")');
		expect(svg).toContain("IBM Plex Sans Variable");
		expect(svg).toContain("font-family=");
	});

	test("escapes user text so names cannot inject markup", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "tricky", name: '<script>alert("x")</script> & "more"', position: { x: 0, y: 0 } });
		const svg = exportSvg(design);
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("&lt;script&gt;");
		expect(svg).toContain("&amp;");
	});

	test("an empty System design still produces a valid, finite SVG", () => {
		const svg = exportSvg(createEmptySystemDesign());
		expect(svg).toContain("<svg");
		expect(svg).not.toMatch(/NaN|undefined|Infinity/);
	});

	test("omits interactive chrome such as focus buttons, resize handles and bend handles", () => {
		const svg = exportSvg(sampleDesign());
		expect(svg).not.toContain("FOCUS");
		expect(svg).not.toContain("resize");
		expect(svg).not.toContain("data-bend-handle");
	});
});
