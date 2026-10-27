import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceState } from "../shared/design";
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

function exportButton(html: string): string {
	return html.match(/<button[^>]*data-testid="export-system-svg"[^>]*>/)?.[0] ?? "";
}

function pngButton(html: string): string {
	return html.match(/<button[^>]*data-testid="export-system-png"[^>]*>/)?.[0] ?? "";
}

describe("system overview SVG export", () => {
	test("the toolbar offers Export SVG, and it is unavailable for an empty System design", () => {
		const empty = render(createEmptySystemDesign());
		expect(empty).toContain('data-testid="export-system-svg"');
		expect(exportButton(empty)).toContain(' disabled=""');

		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		const drawn = render(design);
		expect(exportButton(drawn)).not.toContain(' disabled=""');
	});

	test("the toolbar offers Export PNG beside Export SVG, unavailable for an empty System design", () => {
		const empty = render(createEmptySystemDesign());
		expect(empty).toContain('data-testid="export-system-png"');
		expect(pngButton(empty)).toContain(' disabled=""');

		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		const drawn = render(design);
		expect(pngButton(drawn)).not.toContain(' disabled=""');
	});
});

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

	test("each compute kind draws its own labelled artwork on the card", () => {
		const kinds = ["application", "api", "worker", "scheduled_job", "serverless_handler"] as const;
		let design = createEmptySystemDesign();
		kinds.forEach((kind, index) => {
			design = addSystemComponent(design, { id: kind, kind, name: `Node ${index}`, position: { x: index * 220, y: 0 } });
		});

		const html = render(design);
		for (const kind of kinds) {
			expect(html).toContain(`data-artwork="${kind}"`);
		}
		expect(html.match(/data-testid="component-artwork"/g)).toHaveLength(kinds.length);
		expect(html).toContain(">SCHEDULED JOB<");
		expect(html).toContain(">SERVERLESS HAND…<");
		expect(html).toContain('aria-label="Serverless handler: Node 4"');
	});

	test("each data and messaging kind draws its own labelled artwork, and a long kind label stops before the artwork", () => {
		const kinds = ["database", "cache", "object_storage_bucket", "file_storage", "search_index", "queue", "topic", "event_bus", "event_stream"] as const;
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
		expect(html).toContain(">OBJECT-STORAGE…<");
		expect(html).toContain(">EVENT STREAM<");
		expect(html).toContain('aria-label="Object-storage bucket: Node 2"');
	});

	test("a linked Database keeps its badge and moves its artwork left of the badge", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "primary", kind: "database", name: "Primary", position: { x: 0, y: 0 }, designId: "design-orders" });
		const html = render(design);
		expect(html).toContain('data-artwork="database"');
		expect(html).toContain('transform="translate(86 8)"');
		expect(html).toContain(">DATABASE<");
		expect(html).toContain(">LINKED<");
	});

	test("the original generic Component draws no catalog artwork, while an unlinked Database draws its own", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "plain", name: "Plain", position: { x: 0, y: 0 } });
		expect(render(design)).not.toContain("data-testid=\"component-artwork\"");

		design = addSystemComponent(design, { id: "store", kind: "database", name: "Store", position: { x: 220, y: 0 } });
		const html = render(design);
		expect(html.match(/data-testid="component-artwork"/g)).toHaveLength(1);
		expect(html).toContain('data-artwork="database"');
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

describe("system overview focused Service", () => {
	/** Orders owns Worker and Cache; Billing owns Ledger; Queue is at system scope; Audit is connected to nothing. */
	function focusable(): SystemDesign {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemService(design, { id: "billing", name: "Billing", position: { x: 700, y: 0 } });
		design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "cache", name: "Cache", position: { x: 40, y: 200 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "ledger", name: "Ledger", position: { x: 740, y: 60 }, serviceId: "billing" });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 400, y: 420 } });
		design = addSystemComponent(design, { id: "audit", name: "Audit", position: { x: 900, y: 420 } });
		design = addSystemConnection(design, { id: "reads", sourceId: "worker", targetId: "queue", label: "Reads" });
		design = addSystemConnection(design, { id: "posts", sourceId: "ledger", targetId: "worker", label: "Posts" });
		design = addSystemConnection(design, { id: "settles", sourceId: "billing", targetId: "orders", label: "Settles" });
		design = addSystemConnection(design, { id: "warms", sourceId: "cache", targetId: "worker", label: "Warms" });
		design = addSystemConnection(design, { id: "elsewhere", sourceId: "queue", targetId: "ledger", label: "Elsewhere" });
		return design;
	}

	test("the overview offers Focus on every Service, and the focused view draws its Service, owned Components, and outside context only", () => {
		const overview = render(focusable());
		expect(overview.match(/data-testid="service-focus-button"/g)).toHaveLength(2);
		expect(overview).toContain('data-component-id="audit"');
		expect(overview).toContain("Add service");
		// The negative checks on the focused view below are only meaningful if the overview shows these tools.
		expect(overview).toContain("Group</button>");

		const html = render(setSystemFocus(focusable(), "orders", { x: 0, y: 0, zoom: 1 }));
		expect(html).toContain('data-service-id="orders"');
		expect(html).toContain('data-component-id="worker"');
		expect(html).toContain('data-component-id="cache"');
		expect(html).toContain('data-component-id="queue"');
		expect(html).toContain('data-component-id="ledger"');
		expect(html.match(/data-context="true"/g)?.length).toBeGreaterThanOrEqual(2);
		expect(html).toContain("OUTSIDE");
		expect(html).toContain('data-service-id="billing"');
		expect(html).toContain("SERVICE · OUTSIDE");
		expect(html).toContain('data-connection-id="reads"');
		expect(html).toContain('data-connection-id="posts"');
		expect(html).toContain('data-connection-id="settles"');
		expect(html).toContain('data-connection-id="warms"');
		expect(html).not.toContain('data-connection-id="elsewhere"');
		expect(html).not.toContain('data-component-id="audit"');
	});

	test("a focused Component keeps its owner label, so an outside Component reads as belonging to its real Service", () => {
		const html = render(setSystemFocus(focusable(), "orders", { x: 0, y: 0, zoom: 1 }));
		expect(html).toContain("in Orders");
		expect(html).toContain("in Billing");
		expect(html).toContain('aria-label="Component: Ledger"');
	});

	test("the focused view names its Service, offers a way back, and drops the overview-only tools", () => {
		const html = render(setSystemFocus(focusable(), "orders", { x: 0, y: 0, zoom: 1 }));
		expect(html).toContain('data-testid="system-focus-back"');
		expect(html).toContain('data-testid="system-focus-name"');
		expect(html).toContain("Orders");
		expect(html).not.toContain('data-testid="service-focus-button"');
		expect(html).not.toContain("Add service");
		expect(html).not.toContain("Group</button>");
		expect(html).toContain("Add component");
		expect(html).toContain("Walkthroughs");
	});

	test("a focused Service is drawn expanded even when the overview collapses it", () => {
		const collapsed = setSystemServiceCollapsed(focusable(), "orders", true);
		expect(render(collapsed)).not.toContain('data-component-id="worker"');
		const html = render(setSystemFocus(collapsed, "orders", { x: 0, y: 0, zoom: 1 }));
		expect(html).toContain('data-component-id="worker"');
		expect(html).toContain('data-collapsed="false"');
	});

	test("a focus on a Service that no longer exists opens the overview", () => {
		const stale = { ...focusable(), focusedServiceId: "gone" };
		const html = render(stale);
		expect(html).toContain("Add service");
		expect(html).not.toContain('data-testid="system-focus-back"');
		expect(html.match(/data-testid="service-focus-button"/g)).toHaveLength(2);
	});

	test("the toolbar and inspector keep to the canvas width, so a narrow window does not push them off screen", () => {
		expect(render(focusable())).toContain("max-w-[calc(100%-2rem)]");
		expect(render(setSystemFocus(focusable(), "orders", { x: 0, y: 0, zoom: 1 }))).toContain("max-w-[calc(100%-2rem)]");
	});
});

describe("supporting and Custom Component rendering", () => {
	test("each supporting kind draws its own labelled artwork on the card", () => {
		const kinds = ["identity_provider", "secrets_store", "configuration", "observability"] as const;
		let design = createEmptySystemDesign();
		kinds.forEach((kind, index) => {
			design = addSystemComponent(design, { id: kind, kind, name: `Node ${index}`, position: { x: index * 220, y: 0 } });
		});

		const html = render(design);
		for (const kind of kinds) {
			expect(html).toContain(`data-artwork="${kind}"`);
		}
		expect(html.match(/data-testid="component-artwork"/g)).toHaveLength(kinds.length);
		expect(html).toContain('aria-label="Identity provider: Node 0"');
		expect(html).toContain(">SECRETS STORE<");
	});

	test("a Custom Component draws its chosen icon or shape, and the rectangle when none is chosen", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "plain", kind: "custom", name: "Plain", position: { x: 0, y: 0 } });
		const defaulted = render(design);
		expect(defaulted).toContain('data-artwork="custom"');
		expect(defaulted).toContain('data-icon="rectangle"');

		design = addSystemComponent(design, { id: "chosen", kind: "custom", name: "Chosen", icon: "cylinder", position: { x: 220, y: 0 } });
		const html = render(design);
		expect(html).toContain('data-icon="cylinder"');
		expect(html).toContain(">CUSTOM<");
		expect(html).toContain('aria-label="Custom: Chosen"');
	});

	test("the original generic Component still draws no artwork and no icon", () => {
		const design = addSystemComponent(createEmptySystemDesign(), { id: "plain", name: "Plain", position: { x: 0, y: 0 } });
		const html = render(design);
		expect(html).not.toContain('data-testid="component-artwork"');
		expect(html).not.toContain("data-icon=");
	});
});
