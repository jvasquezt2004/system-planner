import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceState } from "../shared/design";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	setSystemServiceCollapsed,
	type SystemDesign,
} from "../shared/system-design";
import { SystemDesignView } from "./system-design-view";

function render(design: SystemDesign): string {
	const state = {
		systemDesign: design,
		systemSave: { status: "saved", revision: 1, savedAt: 0, designId: "design-1" },
	} as unknown as WorkspaceState;
	return renderToStaticMarkup(
		<SystemDesignView
			state={state}
			client={{} as never}
			onApply={() => {}}
			onLayout={() => {}}
			onOpenDatabase={() => {}}
		/>,
	);
}

describe("system overview rendering", () => {
	test("draws each Service boundary with its name, owned Components, and resize handle", () => {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemService(design, { id: "billing", name: "Billing", position: { x: 600, y: 0 } });
		design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 300, y: 380 } });

		const html = render(design);
		expect(html).toContain('data-service-id="orders"');
		expect(html).toContain('data-service-id="billing"');
		expect(html).toContain('aria-label="Service: Orders"');
		expect(html).toContain("in Orders");
		expect(html.match(/data-testid="service-resize-handle"/g)).toHaveLength(2);
		expect(html).toContain("Add service");
	});

	test("a Component at system scope shows no owner, and Service-endpoint Connections are drawn", () => {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 600, y: 60 } });
		design = addSystemConnection(design, { id: "dispatch", sourceId: "orders", targetId: "queue", label: "Dispatches" });

		const html = render(design);
		expect(html).not.toContain("in Orders");
		expect(html).toContain('data-connection-id="dispatch"');
		expect(html).toContain("Dispatches");
	});

	test("a Group frame draws behind the Services it spans without changing their ownership", () => {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 600, y: 60 } });
		design = addSystemGroup(design, { id: "platform", name: "Platform", position: { x: -24, y: -48 }, memberIds: ["orders", "queue"] });

		const html = render(design);
		expect(html).toContain('data-group-id="platform"');
		expect(html).toContain('aria-label="Group: Platform"');
		expect(html).toContain("GROUP · 2");
		expect(html).toContain('data-testid="group-resize-handle"');
		expect(html.indexOf('data-group-id="platform"')).toBeLessThan(html.indexOf('data-service-id="orders"'));
		expect(html).toContain('data-service-id="orders"');
		expect(html).toContain("in Orders");
		expect(html).toContain('data-component-id="worker"');
		expect(html).toContain('data-component-id="queue"');
		expect(html).toContain("Group");
	});

	test("a Database component with a linked Design is badged LINKED, and SHARED when several Database components link that Design", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "primary", kind: "database", name: "Primary", position: { x: 0, y: 0 }, designId: "design-orders" });
		design = addSystemComponent(design, { id: "concept", kind: "database", name: "Session store", position: { x: 300, y: 0 } });

		const single = render(design);
		expect(single.match(/data-testid="schema-link-badge"/g)).toHaveLength(1);
		expect(single).toContain(">LINKED<");
		expect(single).not.toContain(">SHARED<");

		design = addSystemComponent(design, { id: "replica", kind: "database", name: "Read replica", position: { x: 300, y: 160 }, designId: "design-orders" });
		const shared = render(design);
		expect(shared.match(/data-testid="schema-link-badge"/g)).toHaveLength(2);
		expect(shared.match(/>SHARED</g)).toHaveLength(2);
		expect(shared).not.toContain(">LINKED<");
	});
});

describe("system overview collapsed Services", () => {
	function collapsibleOverview(): SystemDesign {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "cache", name: "Cache", position: { x: 40, y: 200 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 600, y: 60 } });
		design = addSystemConnection(design, { id: "reads", sourceId: "worker", targetId: "queue", label: "Reads" });
		design = addSystemConnection(design, { id: "fills", sourceId: "cache", targetId: "queue", label: "Fills" });
		design = addSystemConnection(design, { id: "warms", sourceId: "worker", targetId: "cache", label: "Warms" });
		return design;
	}

	test("a collapsed Service hides the Components it owns, says what they contain, and keeps its projected Connections drawn", () => {
		const html = render(setSystemServiceCollapsed(collapsibleOverview(), "orders", true));
		expect(html).toContain('data-service-id="orders"');
		expect(html).toContain('data-collapsed="true"');
		expect(html).toContain("SERVICE · COLLAPSED");
		expect(html).toContain("2 components · 1 internal");
		expect(html).not.toContain('data-component-id="worker"');
		expect(html).not.toContain('data-component-id="cache"');
		expect(html).toContain('data-component-id="queue"');
		expect(html).toContain('data-connection-id="reads"');
		expect(html).toContain('data-connection-id="fills"');
		expect(html).not.toContain('data-connection-id="warms"');
		expect(html.match(/data-testid="service-resize-handle"/g)).toBeNull();
	});

	test("expanding a Service draws its Components and Connections again with its resize handle", () => {
		const collapsed = setSystemServiceCollapsed(collapsibleOverview(), "orders", true);
		const expanded = render(setSystemServiceCollapsed(collapsed, "orders", false));
		expect(expanded).toContain('data-collapsed="false"');
		expect(expanded).toContain('data-component-id="worker"');
		expect(expanded).toContain('data-component-id="cache"');
		expect(expanded).toContain('data-connection-id="warms"');
		expect(expanded.match(/data-testid="service-resize-handle"/g)).toHaveLength(1);
	});
});
