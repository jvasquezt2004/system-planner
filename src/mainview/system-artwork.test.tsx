import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SYSTEM_COMPONENT_KINDS, addSystemComponent, addSystemConnection, createEmptySystemDesign } from "../shared/system-design";
import { compileWalkthroughPlayback, deriveWalkthroughFrame, type PlaybackStep, type PlaybackTimeline } from "../shared/walkthrough-playback";
import { addWalkthrough, addWalkthroughStep } from "../shared/walkthrough";
import { ComponentArtwork, componentArtworkTime } from "./system-artwork";
import { ArtworkDurationReporter, finiteTween, sampleKeyframes } from "./system-artwork/timeline-motion";
import { COMPONENT_ANIMATION_MS } from "./system-artwork/animation-durations";
import { useWalkthroughPlayback } from "./use-walkthrough-playback";
import { connectionGeometries, playbackRoutes } from "./system-design-geometry";

const first: PlaybackStep = {
	index: 0, stepId: "first", connectionId: "request", sourceId: "browser", targetId: "api",
	action: "process", title: "", explanation: "", startMs: 0, arrivalMs: 600, durationMs: 1200, endMs: 1200,
};
const timeline: PlaybackTimeline = {
	walkthroughId: "walk", totalMs: 2400,
	steps: [first, { ...first, index: 1, stepId: "second", sourceId: "api", targetId: "database", startMs: 1200, arrivalMs: 1800, endMs: 2400 }],
};
const frameAt = (ms: number) => deriveWalkthroughFrame(timeline, new Map(), ms);
const draw = (kind: typeof SYSTEM_COMPONENT_KINDS[number], time: number | null = null) =>
	renderToStaticMarkup(<svg><ComponentArtwork artwork={kind} time={time} /></svg>);

describe("imported System design artwork", () => {
	test("every component finishes all its effects within its playback budget, then holds still", () => {
		for (const kind of SYSTEM_COMPONENT_KINDS) {
			const effects: number[] = [];
			renderToStaticMarkup(<ArtworkDurationReporter.Provider value={(duration) => effects.push(duration)}>
				<svg><ComponentArtwork artwork={kind} time={0} /></svg>
			</ArtworkDurationReporter.Provider>);
			expect(effects.length).toBeGreaterThan(0);
			const seconds = COMPONENT_ANIMATION_MS[kind] / 1000;
			expect(Math.max(...effects)).toBeLessThanOrEqual(seconds + 0.00001);
			expect(draw(kind, seconds)).toBe(draw(kind, seconds + 1));
		}
	});

	test("finite keyframes finish once rather than restarting while waiting to advance", () => {
		const tween = finiteTween({ duration: 1, repeat: Infinity, repeatDelay: 2, ease: "linear" });
		expect(sampleKeyframes([0, 10], tween, 1)).toBe(10);
		expect(sampleKeyframes([0, 10], tween, 5)).toBe(10);
		const mirrored = finiteTween({ duration: 1, repeat: Infinity, repeatType: "mirror", ease: "linear" });
		expect(sampleKeyframes([0, 10], mirrored, 1.5)).toBe(5);
		expect(sampleKeyframes([0, 10], mirrored, 5)).toBe(0);
	});
	test("a short authored step waits for source and destination animations before the next element", () => {
		let design = createEmptySystemDesign();
		for (const [id, kind] of [["client", "browser"], ["job", "worker"], ["store", "database"]] as const) {
			design = addSystemComponent(design, { id, kind, name: id, position: { x: 0, y: 0 } });
		}
		design = addSystemConnection(design, { id: "request", sourceId: "client", targetId: "job", label: "Request" });
		design = addSystemConnection(design, { id: "save", sourceId: "job", targetId: "store", label: "Request" });
		let walks = addWalkthrough([], { id: "walk", name: "Request" });
		walks = addWalkthroughStep(walks, "walk", { id: "request-step", connectionId: "request", explanation: "" }, design);
		walks = addWalkthroughStep(walks, "walk", { id: "save-step", connectionId: "save", explanation: "" }, design);
		const result = compileWalkthroughPlayback(walks[0]!, design, {
			componentAnimationMs: (id: string) => id === "client" ? 3400 : id === "job" ? 6000 : 2400,
		});
		if (!result.ok) throw new Error(result.problems.join(", "));
		const [step, next] = result.timeline.steps;
		expect(step!.arrivalMs - step!.startMs).toBeGreaterThanOrEqual(3400);
		expect(step!.endMs - step!.arrivalMs).toBeGreaterThanOrEqual(6000);
		expect(next!.startMs).toBe(step!.endMs);
		// The worker has just finished receiving; sending onward does not replay its action.
		expect(next!.sourceAnimationMs).toBe(0);
		expect(componentArtworkTime("job", deriveWalkthroughFrame(result.timeline, new Map(), next!.startMs), result.timeline, false)).toBeNull();
		const halfway = deriveWalkthroughFrame(result.timeline, new Map(), step!.arrivalMs + 3000);
		expect(halfway.stepIndex).toBe(0);
		expect(componentArtworkTime("job", halfway, result.timeline, false)).toBe(3);
		const routes = playbackRoutes(connectionGeometries(design));
		expect(deriveWalkthroughFrame(result.timeline, routes, 1000).messages).toHaveLength(0);
		expect(deriveWalkthroughFrame(result.timeline, routes, step!.travelStartMs!).messages[0]!.progress).toBe(0);
		expect(deriveWalkthroughFrame(result.timeline, routes, step!.arrivalMs).messages[0]!.progress).toBe(1);
		// Exercise the actual UI hook as well as the standalone compiler.
		function Capture() {
			const controls = useWalkthroughPlayback({ walkthrough: walks[0]!, design, routes, reducedMotion: false });
			const live = controls.timeline!.steps[0]!;
			expect(live.arrivalMs - live.startMs).toBeGreaterThanOrEqual(COMPONENT_ANIMATION_MS.browser);
			expect(live.endMs - live.arrivalMs).toBeGreaterThanOrEqual(COMPONENT_ANIMATION_MS.worker);
			return null;
		}
		renderToStaticMarkup(<Capture />);
	});
	test("all 29 kinds render a static idle pose without autonomous animations", () => {
		expect(SYSTEM_COMPONENT_KINDS).toHaveLength(29);
		for (const kind of SYSTEM_COMPONENT_KINDS) {
			const svg = draw(kind);
			expect(svg).toContain('data-state="idle"');
			expect(svg).not.toMatch(/<animate|<script|NaN|Infinity/);
			expect(draw(kind)).toBe(svg);
		}
	});

	test("only the reacting endpoint animates, then returns to its idle pose", () => {
		expect(componentArtworkTime("browser", frameAt(300), timeline, false)).toBe(0.3);
		expect(componentArtworkTime("api", frameAt(300), timeline, false)).toBeNull();
		expect(componentArtworkTime("api", frameAt(800), timeline, false)).toBe(0.2);
		expect(componentArtworkTime("browser", frameAt(800), timeline, false)).toBeNull();
		expect(componentArtworkTime("browser", frameAt(1300), timeline, false)).toBeNull();
		expect(componentArtworkTime("database", frameAt(2400), timeline, false)).toBeNull();
	});

	test("pause freezes the same pose and backwards seeking reproduces it exactly", () => {
		const pose = () => draw("worker", componentArtworkTime("api", frameAt(800), timeline, false));
		const paused = pose();
		expect(pose()).toBe(paused);
		expect(draw("worker", componentArtworkTime("api", frameAt(850), timeline, false))).not.toBe(paused);
		expect(pose()).toBe(paused);
		expect(paused).not.toMatch(/<animate/);
	});

	test("reduced motion and missing playback always use the idle pose", () => {
		expect(componentArtworkTime("api", frameAt(800), timeline, true)).toBeNull();
		expect(componentArtworkTime("api", null, timeline, false)).toBeNull();
		expect(componentArtworkTime("api", frameAt(800), null, false)).toBeNull();
	});

	test("parallel phases use the reaction that wins, and repetitions restart locally", () => {
		const parallel = { ...timeline, steps: [first, { ...first, index: 1, sourceId: "other", targetId: "api", startMs: 500, arrivalMs: 1000, endMs: 1700 }] };
		// The first arrival wins over a later step that has not arrived yet.
		expect(componentArtworkTime("api", deriveWalkthroughFrame(parallel, new Map(), 800), parallel, false)).toBe(0.2);
		const repeated = { ...timeline, steps: [first, { ...first, index: 1, startMs: 1200, arrivalMs: 1800, endMs: 2400 }] };
		expect(componentArtworkTime("browser", deriveWalkthroughFrame(repeated, new Map(), 1500), repeated, false)).toBe(0.3);
	});

	test("Motion sampling keeps delays, keyframe stops, repeat holds and mirrored cycles", () => {
		const tween = { duration: 1, delay: 0.5, repeat: Infinity, repeatDelay: 0.5, ease: "linear" as const };
		expect(sampleKeyframes([0, 10], tween, 0.25)).toBe(0);
		expect(sampleKeyframes([0, 10], tween, 1)).toBe(5);
		expect(sampleKeyframes([0, 10], tween, 1.75)).toBe(10);
		expect(sampleKeyframes([0, 10], tween, 2)).toBe(0);
		expect(sampleKeyframes([0, 10], { ...tween, repeatType: "mirror" }, 2)).toBe(10);
		expect(sampleKeyframes([0, 10, 0], { duration: 1, times: [0, 0.25, 1], ease: "linear" }, 0.25)).toBe(10);
	});
});
