import { Window } from "happy-dom";

/**
 * A real DOM for interaction tests, installed for one test file at a time. The
 * globals a file adds are removed again, so other files in the same `bun test`
 * run keep the runtime they expect. Call `installDom()` in `beforeAll` and
 * `uninstallDom()` in `afterAll`.
 */

/** Globals bun itself relies on; happy-dom never replaces them. */
const KEEP = new Set([
	"Infinity",
	"NaN",
	"undefined",
	"fetch",
	"Request",
	"Response",
	"Headers",
	"URL",
	"URLSearchParams",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"queueMicrotask",
	"structuredClone",
	"crypto",
	"performance",
	"console",
	"process",
	"Buffer",
	"AbortController",
	"AbortSignal",
	"TextEncoder",
	"TextDecoder",
	"atob",
	"btoa",
]);

const saved = new Map<string, PropertyDescriptor | undefined>();
let window: Window | null = null;

export function installDom(): Window {
	if (window) return window;
	window = new Window({ url: "http://localhost/" });
	const target = globalThis as unknown as Record<string, unknown>;
	const names = new Set([...Object.getOwnPropertyNames(window), "window", "document", "navigator", "HTMLElement", "Node", "Element"]);
	for (const name of names) {
		if (KEEP.has(name) || name === "globalThis") continue;
		const value = (window as unknown as Record<string, unknown>)[name];
		if (value === undefined) continue;
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	}
	target.window = window;
	target.document = window.document;
	target.navigator = window.navigator;
	// React reads this to decide whether state updates from `act` are expected.
	target.IS_REACT_ACT_ENVIRONMENT = true;
	return window;
}

export function uninstallDom() {
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else delete (globalThis as unknown as Record<string, unknown>)[name];
	}
	saved.clear();
	delete (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT;
	window?.happyDOM.abort();
	window = null;
}

/**
 * Presses a control the way a mouse does: the pointer and mouse events, then
 * click. Radix menus open on `pointerdown`, so a plain `click()` is not enough.
 */
export function press(element: Element) {
	// The installed globals are happy-dom's event classes, so these events dispatch on its elements.
	const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: "mouse", isPrimary: true };
	element.dispatchEvent(new PointerEvent("pointerdown", init));
	element.dispatchEvent(new MouseEvent("mousedown", init));
	element.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
	element.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
	element.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
}

/** Waits for pending React work and floating-ui positioning to settle. */
export async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}
