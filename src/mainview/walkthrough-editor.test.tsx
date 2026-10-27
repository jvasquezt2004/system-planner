import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	removeSystemConnection,
	updateSystemConnection,
	type SystemDesign,
} from "../shared/system-design";
import { addWalkthrough, addWalkthroughStep, type Walkthrough } from "../shared/walkthrough";
import type { WalkthroughPlaybackControls } from "./use-walkthrough-playback";
import { WalkthroughEditor } from "./walkthrough-editor";

const noop = () => {};

function uploadDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", name: "Browser", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "api", name: "API", position: { x: 300, y: 0 } });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 600, y: 0 } });
	design = addSystemConnection(design, { id: "upload", sourceId: "client", targetId: "api", label: "Upload" });
	return addSystemConnection(design, { id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueue" });
}

function uploadWalkthrough(design: SystemDesign): Walkthrough[] {
	let walkthroughs = addWalkthrough([], { id: "w", name: "Upload" });
	walkthroughs = addWalkthroughStep(walkthroughs, "w", { id: "s", connectionId: "upload", title: "Send" }, design);
	return addWalkthroughStep(walkthroughs, "w", { id: "t", connectionId: "enqueue", title: "Queue", explanation: "Work is queued." }, design);
}

const playback: WalkthroughPlaybackControls = {
	problems: [],
	timeline: null,
	active: null,
	play: noop,
	pause: noop,
	restart: noop,
	previous: noop,
	next: noop,
	seekStep: noop,
	setSpeed: noop,
} as unknown as WalkthroughPlaybackControls;

function renderStep(design: SystemDesign, walkthroughs: Walkthrough[], stepId: string): string {
	return renderToStaticMarkup(
		<WalkthroughEditor
			walkthroughs={walkthroughs}
			design={design}
			client={{} as never}
			onApply={() => {}}
			selection={{ walkthroughId: "w", stepId }}
			onSelect={() => {}}
			onClose={() => {}}
			playback={playback}
		/>,
	);
}

describe("Walkthrough editor repair", () => {
	test("a step whose Connection was removed says so and offers only a replacement Connection", () => {
		const design = removeSystemConnection(uploadDesign(), "enqueue");
		const walkthroughs = uploadWalkthrough(uploadDesign());
		const html = renderStep(design, walkthroughs, "t");

		expect(html).toContain("The Connection this step played was removed. The step keeps its text.");
		expect(html).toContain("Connection removed");
		expect(html).toContain("Choose a Connection");
		expect(html).toContain("1 to repair");
		expect(html).not.toContain("Accept current route");
		expect(html).toContain("Work is queued.");
	});

	test("a step whose Connection now joins different endpoints offers explicit acceptance of the changed route", () => {
		const design = updateSystemConnection(uploadDesign(), "enqueue", { sourceId: "client" });
		const walkthroughs = uploadWalkthrough(uploadDesign());
		const html = renderStep(design, walkthroughs, "t");

		expect(html).toContain("Route changed");
		expect(html).toContain("This Connection now runs");
		expect(html).toContain("Accept current route");
		expect(html).not.toContain("The Connection this step played was removed.");
		expect(html).toContain("1 to repair");
	});

	test("a step that still plays its recorded route has no repair prompt", () => {
		const design = uploadDesign();
		const html = renderStep(design, uploadWalkthrough(design), "s");

		expect(html).not.toContain("Accept current route");
		expect(html).not.toContain("to repair");
		expect(html).not.toContain("Route changed");
	});
});
