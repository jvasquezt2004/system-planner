import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom, uninstallDom } from "../../test-dom";

let Button: typeof import("./button").Button;
let root: Root;
let container: HTMLElement;

beforeAll(async () => {
	installDom();
	({ Button } = await import("./button"));
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterAll(() => {
	act(() => root.unmount());
	uninstallDom();
});

describe("Button ref forwarding", () => {
	test("a ref reaches the rendered button element", () => {
		const ref = React.createRef<HTMLButtonElement>();
		act(() => root.render(<Button ref={ref}>Save</Button>));
		expect(ref.current).toBeInstanceOf(HTMLButtonElement);
		expect(ref.current?.textContent).toBe("Save");
	});

	test("a ref passed through asChild reaches the child element, as Radix triggers need", () => {
		const ref = React.createRef<HTMLButtonElement>();
		act(() =>
			root.render(
				<Button asChild ref={ref}>
					<span data-testid="child">Open</span>
				</Button>,
			),
		);
		const child = container.querySelector('[data-testid="child"]');
		expect(child).not.toBeNull();
		expect(ref.current as unknown).toBe(child);
		// The Button's own classes and data attributes are merged onto the child.
		expect(child?.getAttribute("data-slot")).toBe("button");
	});
});
