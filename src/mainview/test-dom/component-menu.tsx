// Run in its own process: Radix detects DOM availability when first imported.
import { Window } from "happy-dom";
import assert from "node:assert/strict";

const window = new Window({ url: "http://localhost/" });
for (const key of [
	"window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter",
	"HTMLInputElement", "SVGElement", "MutationObserver", "ResizeObserver", "CustomEvent",
	"Event", "PointerEvent", "MouseEvent", "KeyboardEvent", "DOMRect",
] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
}
for (const key of ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const) {
	Object.defineProperty(globalThis, key, { configurable: true, value: window[key].bind(window) });
}

const { createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { Button } = await import("../components/ui/button");
const { DropdownMenu, DropdownMenuTrigger } = await import("../components/ui/dropdown-menu");
const { SystemDesignView } = await import("../system-design-view");
const { applySystemLayout, systemCardsOverlap } = await import("../../shared/system-layout");
const { createEmptySystemDesign, addSystemComponent } = await import("../../shared/system-design");
import type { WorkspaceState } from "../../shared/design";
import type { workspaceClient } from "../workspace-client";

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
try {
	const ref = createRef<HTMLButtonElement>();
	flushSync(() => root.render(
		<DropdownMenu><DropdownMenuTrigger asChild><Button ref={ref}>Add component</Button></DropdownMenuTrigger></DropdownMenu>,
	));
	assert.equal(ref.current, host.querySelector("button"), "Radix must receive the DOM button as its menu anchor");

	// Button's own asChild composition must also preserve the underlying ref.
	flushSync(() => root.render(<Button asChild ref={ref}><button>Slotted button</button></Button>));
	assert.equal(ref.current, host.querySelector("button"));

	let state = {
		systemDesign: createEmptySystemDesign(),
		systemSave: { status: "saved", revision: 1, savedAt: 0, designId: "design-1" },
		designs: [], walkthroughs: [],
	} as unknown as WorkspaceState;
	const addedKinds: string[] = [];
	const client = {
		async addSystemComponent(action) {
			addedKinds.push(action.kind ?? "generic");
			state = { ...state, systemDesign: addSystemComponent(state.systemDesign!, {
				...action, position: { x: action.x!, y: action.y! },
			}) };
			return state;
		},
		async arrangeSystemLayout(action) {
			state = { ...state, systemDesign: applySystemLayout(state.systemDesign!, action.placement) };
			return state;
		},
	} satisfies Pick<typeof workspaceClient, "addSystemComponent" | "arrangeSystemLayout">;
	const render = () => root.render(<SystemDesignView
		state={state} client={client as typeof workspaceClient}
		onApply={(action) => { void action().then(() => flushSync(render)); }}
		onLayout={() => {}} onOpenDatabase={() => {}}
	/>);
	flushSync(render);

	for (const kind of ["generic", "database"]) {
		const trigger = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Add component"))!;
		flushSync(() => trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const menu = document.querySelector('[role="menu"]');
		assert.ok(menu, "Add component opens the catalog");
		const item = kind === "generic" ? menu.querySelector('[role="menuitem"]') : menu.querySelector(`[data-kind="${kind}"]`);
		assert.ok(item, `Catalog offers ${kind}`);
		flushSync(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(addedKinds[addedKinds.length - 1], kind, "Selecting a catalog entry creates its component kind");
		assert.equal(host.querySelectorAll("[data-component-id]").length, addedKinds.length, "New components appear on the canvas");
		assert.equal(document.querySelector('[role="menu"]'), null, "The catalog closes after selection");
	}
	// A saved compact layout must offer a working, ordinary workspace layout action.
	state.systemDesign = { ...state.systemDesign!, components: state.systemDesign!.components.map((component, index) => ({ ...component, position: { x: 32, y: 64 + index * 128 } })) };
	flushSync(render);
	assert.ok(host.querySelector('[data-testid="system-cards-overlap"]'));
	const arrange = host.querySelector('[data-testid="arrange-system-cards"]')!;
	flushSync(() => arrange.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(systemCardsOverlap(state.systemDesign!), false);
	assert.equal(host.querySelector('[data-testid="system-cards-overlap"]'), null);
	console.log("Button refs and Add component catalog interactions passed");
} finally {
	root.unmount();
	await window.happyDOM.abort();
}
