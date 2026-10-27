import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlaybackFrame, PlaybackTimeline } from "../shared/walkthrough-playback";
import type { WalkthroughPlaybackControls } from "./use-walkthrough-playback";
import { WalkthroughTransport } from "./walkthrough-transport";

const noop = () => {};

const timeline: PlaybackTimeline = {
	walkthroughId: "w",
	totalMs: 2000,
	steps: [
		{
			index: 0, stepId: "s1", connectionId: "upload", sourceId: "client", targetId: "api", action: "send",
			title: "Upload", explanation: "", startMs: 0, durationMs: 1000, arrivalMs: 600, endMs: 1000,
		},
		{
			index: 1, stepId: "s2", connectionId: "enqueue", sourceId: "api", targetId: "queue", action: "process",
			title: "Enqueue", explanation: "", startMs: 1000, durationMs: 1000, arrivalMs: 1600, endMs: 2000,
		},
	],
};

function controls(overrides: Partial<WalkthroughPlaybackControls> = {}): WalkthroughPlaybackControls {
	return {
		problems: [],
		timeline,
		active: null,
		play: noop,
		pause: noop,
		restart: noop,
		previous: noop,
		next: noop,
		seekStep: noop,
		seekTime: noop,
		setSpeed: noop,
		...overrides,
	};
}

/** The frame only needs the fields the transport reads. */
function activeAt(stepIndex: number, playing: boolean) {
	const step = timeline.steps[stepIndex]!;
	return {
		frame: { stepIndex, step, complete: false, activeStepIndexes: [stepIndex] } as unknown as PlaybackFrame,
		playing,
		speed: 1 as const,
	};
}

/** Whether the button with this label carries the `disabled` attribute (not just the disabled: utility classes). */
function isDisabled(html: string, label: string): boolean {
	const match = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
	return match !== null && /\sdisabled=""/.test(match[0]);
}

describe("walkthrough transport controls", () => {
	test("a Walkthrough that needs repair lists why it cannot play and disables playback", () => {
		const html = renderToStaticMarkup(
			<WalkthroughTransport controls={controls({ problems: ["Step 2 plays a Connection that was removed."], timeline: null })} />,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Step 2 plays a Connection that was removed.");
		expect(isDisabled(html, "Play walkthrough")).toBe(true);
	});

	test("a playable Walkthrough that has not started offers Play and reports the start", () => {
		const html = renderToStaticMarkup(<WalkthroughTransport controls={controls()} />);
		expect(isDisabled(html, "Play walkthrough")).toBe(false);
		expect(html).toContain("Not started");
		expect(html).toContain("Illustrative timing");
	});

	test("while playing it offers Pause and names the current step of the Walkthrough", () => {
		const html = renderToStaticMarkup(<WalkthroughTransport controls={controls({ active: activeAt(1, true) })} />);
		expect(isDisabled(html, "Pause walkthrough")).toBe(false);
		expect(html).toContain("Step 2 of 2");
		expect(html).toContain("2. Enqueue");
	});

	test("the time scrubber spans the whole Walkthrough and follows the clock", () => {
		const html = renderToStaticMarkup(
			<WalkthroughTransport controls={controls({ active: { ...activeAt(1, true), frame: { ...activeAt(1, true).frame, timeMs: 1400 } as PlaybackFrame } })} />,
		);
		expect(html).toMatch(/<input[^>]*aria-label="Playback time"[^>]*>/);
		const scrubber = html.match(/<input[^>]*aria-label="Playback time"[^>]*>/)![0];
		expect(scrubber).toContain('max="2000"');
		expect(scrubber).toContain('value="1400"');
	});

	test("the time scrubber is unavailable while a step needs repair", () => {
		const html = renderToStaticMarkup(
			<WalkthroughTransport controls={controls({ problems: ["Step 1 plays a Connection that was removed."], timeline: null })} />,
		);
		const scrubber = html.match(/<input[^>]*aria-label="Playback time"[^>]*>/)![0];
		expect(/\sdisabled=""/.test(scrubber)).toBe(true);
	});

	test("camera follow is offered as a toggle that shows whether it is on", () => {
		const off = renderToStaticMarkup(
			<WalkthroughTransport controls={controls()} follow={{ enabled: false, onChange: noop }} />,
		);
		expect(off).toContain('aria-pressed="false"');
		expect(off).toContain("Follow camera");

		const on = renderToStaticMarkup(
			<WalkthroughTransport controls={controls({ active: activeAt(0, true) })} follow={{ enabled: true, onChange: noop }} />,
		);
		const button = on.match(/<button[^>]*aria-pressed="true"[^>]*>/);
		expect(button).not.toBeNull();
	});

	test("without a follow prop the transport offers no camera toggle", () => {
		const html = renderToStaticMarkup(<WalkthroughTransport controls={controls()} />);
		expect(html).not.toContain("Follow camera");
	});
});
