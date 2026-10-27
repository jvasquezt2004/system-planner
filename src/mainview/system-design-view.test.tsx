import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceState } from "../shared/design";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemService,
	createEmptySystemDesign,
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
});
