import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WorkspaceState } from "../shared/design";
import {
	addSystemComponent,
	addSystemService,
	createEmptySystemDesign,
	type SystemDesign,
} from "../shared/system-design";
import { installDom, press, settle, uninstallDom } from "./test-dom";

/**
 * The System design toolbar, pressed the way a designer presses it: real DOM
 * pointer and click events through happy-dom, against the real view. The client
 * records each request instead of saving, so the test sees what the view asked for.
 */

type View = typeof import("./system-design-view").SystemDesignView;

let SystemDesignView: View;
let root: Root | null = null;
let container: HTMLElement;
let calls: { name: string; args: unknown[] }[];

function recordingClient() {
	return new Proxy(
		{},
		{
			get(_target, name: string) {
				return (...args: unknown[]) => {
					calls.push({ name, args });
					// Export requests resolve to an outcome; everything else to the unchanged state.
					if (name.startsWith("export")) return Promise.resolve({ status: "cancelled" });
					return Promise.resolve(state);
				};
			},
		},
	) as never;
}

let state: WorkspaceState;

/** Each mount starts a fresh view, so no mode (connecting, grouping, the panel) carries over from another test. */
function mount(design: SystemDesign) {
	calls = [];
	act(() => root?.unmount());
	container.replaceChildren();
	const fresh = createRoot(container);
	root = fresh;
	state = {
		systemDesign: design,
		systemSave: { status: "saved", revision: 1, savedAt: 0, designId: "design-1" },
		designs: [],
		walkthroughs: [],
	} as unknown as WorkspaceState;
	act(() => {
		fresh.render(
			<SystemDesignView
				state={state}
				client={recordingClient()}
				onApply={(action) => void action()}
				onLayout={(action) => void action()}
				onOpenDatabase={() => {}}
			/>,
		);
	});
}

/** The toolbar's control with this visible label, found in the canvas the view draws. */
function control(label: string): HTMLButtonElement {
	const found = [...container.querySelectorAll<HTMLButtonElement>('[data-testid="system-design-canvas"] button')].find(
		(button) => button.textContent?.trim() === label,
	);
	if (!found) throw new Error(`No toolbar control "${label}"`);
	return found;
}

function labeled(label: string): HTMLButtonElement {
	const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!found) throw new Error(`No toolbar control "${label}"`);
	return found;
}

function zoomText(): string | null {
	return container.querySelector('[data-testid="system-zoom"]')?.textContent ?? null;
}

async function pressAndSettle(element: Element) {
	act(() => press(element));
	await act(async () => {
		await settle();
	});
}

function twoComponents(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 } });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 300, y: 60 } });
	return design;
}

beforeAll(async () => {
	installDom();
	({ SystemDesignView } = await import("./system-design-view"));
	container = document.createElement("div");
	container.style.width = "1200px";
	container.style.height = "700px";
	document.body.appendChild(container);
});

afterAll(() => {
	act(() => root?.unmount());
	uninstallDom();
});

describe("System design toolbar presses", () => {
	test("Add service asks the workspace for a new Service", async () => {
		mount(createEmptySystemDesign());
		await pressAndSettle(control("Add service"));
		expect(calls.map((call) => call.name)).toContain("addSystemService");
	});

	test("Walkthroughs opens and closes the Walkthrough panel, reporting the state on the button", async () => {
		mount(createEmptySystemDesign());
		expect(control("Walkthroughs").getAttribute("aria-pressed")).toBe("false");
		await pressAndSettle(control("Walkthroughs"));
		expect(control("Walkthroughs").getAttribute("aria-pressed")).toBe("true");
		await pressAndSettle(control("Walkthroughs"));
		expect(control("Walkthroughs").getAttribute("aria-pressed")).toBe("false");
	});

	test("Group enters grouping mode and Connect enters connecting mode once two endpoints exist", async () => {
		mount(twoComponents());
		await pressAndSettle(control("Group"));
		expect(control("Group").getAttribute("aria-pressed")).toBe("true");
		expect(container.textContent).toContain("Choose the components, services, or groups to enclose");

		await pressAndSettle(control("Group"));
		expect(control("Group").getAttribute("aria-pressed")).toBe("false");

		expect(control("Connect").disabled).toBe(false);
		await pressAndSettle(control("Connect"));
		expect(control("Choose source").getAttribute("aria-pressed")).toBe("true");
	});

	test("Connect stays disabled until two Components or Services exist", () => {
		mount(addSystemComponent(createEmptySystemDesign(), { id: "only", name: "Only", position: { x: 0, y: 0 } }));
		expect(control("Connect").disabled).toBe(true);
	});

	test("Zoom in and Zoom out change the shown zoom", async () => {
		mount(twoComponents());
		expect(zoomText()).toBe("100%");
		await pressAndSettle(labeled("Zoom in"));
		expect(zoomText()).toBe("120%");
		await pressAndSettle(labeled("Zoom out"));
		await pressAndSettle(labeled("Zoom out"));
		expect(zoomText()).toBe("83%");
	});

	test("Export SVG and Export PNG are offered once the System design has items", async () => {
		mount(createEmptySystemDesign());
		expect(control("Export SVG").disabled).toBe(true);
		expect(control("Export PNG").disabled).toBe(true);

		mount(twoComponents());
		expect(control("Export SVG").disabled).toBe(false);
		await pressAndSettle(control("Export SVG"));
		await act(async () => {
			for (let attempt = 0; attempt < 50 && !calls.some((call) => call.name === "exportSystemDesignSvg"); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		});
		expect(calls.map((call) => call.name)).toContain("exportSystemDesignSvg");
	});

	test("Add component opens its menu on screen, and choosing Component asks for a generic Component", async () => {
		mount(createEmptySystemDesign());
		const trigger = control("Add component");
		await pressAndSettle(trigger);

		const menu = document.querySelector<HTMLElement>('[role="menu"]');
		expect(menu).not.toBeNull();
		// Radix positions the menu after its trigger is known. Until then it sits above the viewport
		// (translate(0, -200%)), which is what made the button look dead when its ref was dropped.
		const positioner = menu!.closest<HTMLElement>("[data-radix-popper-content-wrapper]");
		expect(positioner?.style.transform ?? "").not.toContain("-200%");
		expect(document.body.style.pointerEvents).toBe("none");

		const component = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
			(item) => item.textContent?.trim() === "Component",
		);
		expect(component).toBeDefined();
		await pressAndSettle(component!);

		expect(calls.find((call) => call.name === "addSystemComponent")?.args[0]).toMatchObject({ kind: "generic" });
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.body.style.pointerEvents).toBe("");
	});

	test("a catalog entry in the Add component menu adds that kind of Component", async () => {
		mount(createEmptySystemDesign());
		await pressAndSettle(control("Add component"));
		const entry = document.querySelector<HTMLElement>('[role="menuitem"][data-kind]');
		expect(entry).not.toBeNull();
		const kind = entry!.getAttribute("data-kind");
		await pressAndSettle(entry!);
		expect(calls.find((call) => call.name === "addSystemComponent")?.args[0]).toMatchObject({ kind });
	});

	test("a Service already on the canvas is still pressable after the menu closes", async () => {
		mount(addSystemService(createEmptySystemDesign(), { id: "orders", name: "Orders", position: { x: 0, y: 0 } }));
		await pressAndSettle(control("Add component"));
		await pressAndSettle(document.querySelector<HTMLElement>('[role="menuitem"]')!);
		await pressAndSettle(control("Add service"));
		expect(calls.map((call) => call.name)).toContain("addSystemService");
	});
});
