import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceState } from "../shared/design";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	type SystemDesign,
} from "../shared/system-design";
import { Dialog } from "@/components/ui/dialog";
import { RemovalSummary, SystemDesignView, type PendingRemoval } from "./system-design-view";

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

	test("each client and traffic kind draws its own labelled artwork on the card", () => {
		const kinds = ["person", "browser", "mobile_app", "external_system", "dns", "cdn", "load_balancer", "api_gateway", "proxy"] as const;
		let design = createEmptySystemDesign();
		kinds.forEach((kind, index) => {
			design = addSystemComponent(design, { id: kind, kind, name: `Node ${index}`, position: { x: index * 220, y: 0 } });
		});

		const html = render(design);
		for (const kind of kinds) {
			expect(html).toContain(`data-component-id="${kind}" data-kind="${kind}"`);
			expect(html).toContain(`data-artwork="${kind}"`);
		}
		expect(html.match(/data-testid="component-artwork"/g)).toHaveLength(kinds.length);
		expect(html).toContain(">LOAD BALANCER<");
		expect(html).toContain('aria-label="API gateway: Node 7"');
	});

	test("the original generic and database Components draw no catalog artwork", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "plain", name: "Plain", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "store", kind: "database", name: "Store", position: { x: 220, y: 0 } });
		expect(render(design)).not.toContain("data-testid=\"component-artwork\"");
	});
});

/** The summary sits inside the confirmation dialog, which needs its context to render. */
function renderSummary(removal: PendingRemoval): string {
	return renderToStaticMarkup(
		<Dialog open onOpenChange={() => {}}>
			<RemovalSummary removal={removal} />
		</Dialog>,
	);
}

describe("removal confirmation", () => {
	test("removing a Component lists the Walkthrough steps it leaves dangling", () => {
		const removal: PendingRemoval = {
			kind: "component",
			plan: {
				componentId: "api",
				componentName: "API",
				connections: [{ id: "upload", label: "Upload", sourceId: "client", targetId: "api" }],
			},
			walkthroughSteps: [{ walkthroughId: "w", walkthroughName: "Upload flow", stepId: "s", title: "Send", connectionId: "upload" }],
		};
		const html = renderSummary(removal);
		expect(html).toContain("Remove “API”?");
		expect(html).toContain("1 Walkthrough step will become dangling and keep its text.");
		expect(html).toContain('aria-label="Affected Walkthrough steps"');
		expect(html).toContain("Upload flow: Send");
	});

	test("removing a Connection that a step plays names that step; a Connection with no steps lists none", () => {
		const affected: PendingRemoval = {
			kind: "connection",
			plan: { connectionId: "enqueue", connectionLabel: "Enqueue" },
			walkthroughSteps: [{ walkthroughId: "w", walkthroughName: "Upload flow", stepId: "t", title: "Queue", connectionId: "enqueue" }],
		};
		const html = renderSummary(affected);
		expect(html).toContain("Remove “Enqueue”?");
		expect(html).toContain("1 Walkthrough step play this connection.");
		expect(html).toContain("Upload flow: Queue");

		const unreferenced: PendingRemoval = { kind: "connection", plan: { connectionId: "reply", connectionLabel: "Reply" }, walkthroughSteps: [] };
		const plain = renderSummary(unreferenced);
		expect(plain).not.toContain("Affected Walkthrough steps");
	});
});
