import { describe, expect, test } from "bun:test";
import { computeConnectionPath, type ProofRect } from "./architecture-proof";
import {
	PLAYBACK_DEFAULT_STEP_MS,
	compileWalkthroughPlayback,
	createPlaybackTransport,
	deriveWalkthroughFrame,
	isTransportPlaying,
	pauseTransport,
	playTransport,
	seekTransport,
	setTransportSpeed,
	stepStartMs,
	transportTimeMs,
	walkthroughPlaybackKey,
	type PlaybackRoute,
	type PlaybackTimeline,
} from "./walkthrough-playback";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemService,
	createEmptySystemDesign,
	moveSystemComponent,
	removeSystemConnection,
	updateSystemComponent,
	type SystemDesign,
} from "./system-design";
import { addWalkthrough, addWalkthroughStep, updateWalkthroughStep, type Walkthrough } from "./walkthrough";

/** A three-hop path: Client → API → Queue, with a second Connection from the API to the Client. */
function fixtureDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", name: "Client", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "api", name: "API", position: { x: 320, y: 0 } });
	design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 640, y: 0 } });
	design = addSystemConnection(design, { id: "upload", sourceId: "client", targetId: "api", label: "Upload" });
	design = addSystemConnection(design, { id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueue" });
	design = addSystemConnection(design, { id: "reply", sourceId: "api", targetId: "client", label: "Reply" });
	return design;
}

function walkthroughWith(design: SystemDesign, steps: Array<{ id: string; connectionId: string; durationMs?: number; action?: "send" | "receive" | "process" | "succeed" | "fail"; explanation?: string }>): Walkthrough[] {
	let walkthroughs = addWalkthrough([], { id: "upload" });
	for (const step of steps) {
		walkthroughs = addWalkthroughStep(walkthroughs, "upload", { id: step.id, connectionId: step.connectionId }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "upload", step.id, {
			durationMs: step.durationMs ?? 1000,
			action: step.action ?? "send",
			explanation: step.explanation ?? "",
		});
	}
	return walkthroughs;
}

function compiled(design: SystemDesign, walkthroughs: Walkthrough[]): PlaybackTimeline {
	const result = compileWalkthroughPlayback(walkthroughs[0]!, design);
	if (!result.ok) throw new Error(`Expected a playable Walkthrough: ${result.problems.join("; ")}`);
	return result.timeline;
}

/** Straight, horizontal routes from the real route geometry used by the overview. */
function routesFor(design: SystemDesign): Map<string, PlaybackRoute> {
	const rects = new Map<string, ProofRect>(
		design.components.map((component) => [component.id, { x: component.position.x, y: component.position.y, width: 180, height: 84 }]),
	);
	const routes = new Map<string, PlaybackRoute>();
	for (const connection of design.connections) {
		const route = computeConnectionPath(rects.get(connection.sourceId)!, rects.get(connection.targetId)!, 0);
		routes.set(connection.id, { start: route.start, cp1: route.cp1, cp2: route.cp2, end: route.end });
	}
	return routes;
}

describe("Walkthrough playback compilation", () => {
	test("lays steps out in authored order with their durations and a bounded arrival time", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [
			{ id: "s1", connectionId: "upload", durationMs: 1000 },
			{ id: "s2", connectionId: "enqueue", durationMs: 2000 },
		]));
		expect(timeline.totalMs).toBe(3000);
		expect(timeline.steps.map((step) => [step.stepId, step.startMs, step.endMs])).toEqual([
			["s1", 0, 1000],
			["s2", 1000, 3000],
		]);
		expect(timeline.steps[1]!.arrivalMs).toBe(1000 + Math.round(2000 * 0.6));
		expect(timeline.steps[0]!.sourceId).toBe("client");
		expect(timeline.steps[0]!.targetId).toBe("api");
	});

	test("uses the default duration for a step without one", () => {
		const design = fixtureDesign();
		let walkthroughs = addWalkthrough([], { id: "upload" });
		walkthroughs = addWalkthroughStep(walkthroughs, "upload", { id: "s1", connectionId: "upload" }, design);
		expect(compiled(design, walkthroughs).totalMs).toBe(PLAYBACK_DEFAULT_STEP_MS);
	});

	test("refuses an empty Walkthrough with a reason", () => {
		const design = fixtureDesign();
		const result = compileWalkthroughPlayback(addWalkthrough([], { id: "empty" })[0]!, design);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems[0]).toContain("at least one step");
	});

	test("refuses playback while a step is dangling or redirected, naming the step", () => {
		const design = fixtureDesign();
		const walkthroughs = walkthroughWith(design, [
			{ id: "s1", connectionId: "upload" },
			{ id: "s2", connectionId: "enqueue" },
		]);
		const removed = removeSystemConnection(design, "enqueue");
		const dangling = compileWalkthroughPlayback(walkthroughs[0]!, removed);
		expect(dangling.ok).toBe(false);
		if (!dangling.ok) expect(dangling.problems).toEqual([expect.stringContaining("Step 2 plays a Connection that was removed")]);

		// The Connection keeps its id but now joins different endpoints: the route the step was written for has changed.
		const rerouted = addSystemConnection(
			removeSystemConnection(design, "upload"),
			{ id: "upload", sourceId: "queue", targetId: "api", label: "Upload" },
		);
		const result = compileWalkthroughPlayback(walkthroughs[0]!, rerouted);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems).toEqual([expect.stringContaining("Step 1 now runs a changed route")]);
	});

	test("a Component moved on the canvas keeps the Walkthrough playable", () => {
		const design = fixtureDesign();
		const walkthroughs = walkthroughWith(design, [{ id: "s1", connectionId: "upload" }]);
		expect(compileWalkthroughPlayback(walkthroughs[0]!, moveSystemComponent(design, "api", { x: 400, y: 400 })).ok).toBe(true);
	});
});

describe("Walkthrough frames derive from authored time", () => {
	test("the sender activates and the message leaves the sender's real route at the start", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const routes = routesFor(design);
		const frame = deriveWalkthroughFrame(timeline, routes, 0);

		expect(frame.reactions.client).toEqual({ action: "send", role: "sender", phase: "depart", intensity: 1 });
		expect(frame.reactions.api).toBeUndefined();
		expect(frame.message?.progress).toBe(0);
		expect(frame.message?.point).toEqual(routes.get("upload")!.start);
		expect(frame.highlight).toEqual({ connectionId: "upload", endpointIds: ["client", "api"] });
	});

	test("the message reaches the destination's route end exactly at the authored arrival time", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const routes = routesFor(design);
		const arrival = timeline.steps[0]!.arrivalMs;

		const atArrival = deriveWalkthroughFrame(timeline, routes, arrival);
		expect(atArrival.message?.progress).toBe(1);
		expect(atArrival.message?.point.x).toBeCloseTo(routes.get("upload")!.end.x, 6);
		expect(atArrival.message?.point.y).toBeCloseTo(routes.get("upload")!.end.y, 6);

		const afterArrival = deriveWalkthroughFrame(timeline, routes, arrival + 1);
		expect(afterArrival.message).toBeNull();
		expect(afterArrival.reactions.client).toBeUndefined();
		expect(afterArrival.reactions.api).toEqual({ action: "receive", role: "destination", phase: "arrive", intensity: expect.any(Number) });
	});

	test("the destination shows the step's own outcome after the arrival hold", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [
			{ id: "s1", connectionId: "enqueue", durationMs: 1000, action: "fail" },
		]));
		const routes = routesFor(design);
		const step = timeline.steps[0]!;
		const hold = step.arrivalMs + Math.round((step.endMs - step.arrivalMs) * 0.5);

		expect(deriveWalkthroughFrame(timeline, routes, hold).reactions.queue).toEqual({
			action: "fail",
			role: "destination",
			phase: "outcome",
			intensity: 1,
		});
		expect(deriveWalkthroughFrame(timeline, routes, hold - 1).reactions.queue?.phase).toBe("arrive");
	});

	test("a send step's destination keeps receive for its outcome", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000, action: "send" }]));
		expect(deriveWalkthroughFrame(timeline, routesFor(design), 900).reactions.api?.action).toBe("receive");
	});

	test("a later step never inherits a reaction from the step before it", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [
			{ id: "s1", connectionId: "upload", durationMs: 1000 },
			{ id: "s2", connectionId: "enqueue", durationMs: 1000 },
		]));
		const frame = deriveWalkthroughFrame(timeline, routesFor(design), 1000);
		expect(frame.stepIndex).toBe(1);
		expect(frame.reactions.api).toEqual({ action: "send", role: "sender", phase: "depart", intensity: 1 });
		expect(frame.reactions.client).toBeUndefined();
		expect(frame.reactions.queue).toBeUndefined();
	});

	test("seeking backwards gives the same frame as playing straight to that time", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [
			{ id: "s1", connectionId: "upload", durationMs: 1000 },
			{ id: "s2", connectionId: "enqueue", durationMs: 1500, action: "process" },
		]));
		const routes = routesFor(design);
		const forward = [400, 1300, 2100].map((time) => deriveWalkthroughFrame(timeline, routes, time));
		const backward = [2100, 1300, 400].map((time) => deriveWalkthroughFrame(timeline, routes, time)).reverse();
		expect(backward).toEqual(forward);
	});

	test("the Walkthrough reports completion with no travelling message or reactions", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const done = deriveWalkthroughFrame(timeline, routesFor(design), 5000);
		expect(done.complete).toBe(true);
		expect(done.timeMs).toBe(1000);
		expect(done.message).toBeNull();
		expect(done.reactions).toEqual({});
		expect(done.stepProgress).toBe(1);
	});

	test("reduced motion removes the moving message and holds reactions as static highlights", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const routes = routesFor(design);

		const early = deriveWalkthroughFrame(timeline, routes, 100, { reducedMotion: true });
		expect(early.message).toBeNull();
		expect(early.reactions.client).toEqual({ action: "send", role: "sender", phase: "depart", intensity: 1 });

		const late = deriveWalkthroughFrame(timeline, routes, timeline.steps[0]!.arrivalMs + 50, { reducedMotion: true });
		expect(late.reactions.api?.intensity).toBe(1);
		expect(late.highlight.connectionId).toBe("upload");
		expect(late.step.explanation).toBe("");
	});

	test("changing layout keeps authored durations and still arrives on the new route's end", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const moved = moveSystemComponent(design, "api", { x: 900, y: 320 });
		const movedRoutes = routesFor(moved);

		const arrival = deriveWalkthroughFrame(timeline, movedRoutes, timeline.steps[0]!.arrivalMs);
		expect(arrival.message?.point.x).toBeCloseTo(movedRoutes.get("upload")!.end.x, 6);
		expect(arrival.message?.point.y).toBeCloseTo(movedRoutes.get("upload")!.end.y, 6);
		expect(arrival.message?.point).not.toEqual(routesFor(design).get("upload")!.end);
		expect(timeline.steps[0]!.arrivalMs).toBe(Math.round(1000 * 0.6));
	});
});

describe("Walkthrough clock transport", () => {
	test("plays, pauses, and resumes on a controlled clock", () => {
		const total = 3000;
		let transport = createPlaybackTransport();
		transport = playTransport(transport, 1000, total);
		expect(transportTimeMs(transport, 1500, total)).toBe(500);
		transport = pauseTransport(transport, 1500, total);
		expect(transportTimeMs(transport, 9000, total)).toBe(500);
		expect(isTransportPlaying(transport, 9000, total)).toBe(false);
		transport = playTransport(transport, 3000, total);
		expect(transportTimeMs(transport, 3500, total)).toBe(1000);
	});

	test("a speed change continues from the current position", () => {
		const total = 10_000;
		let transport = playTransport(createPlaybackTransport(), 0, total);
		transport = setTransportSpeed(transport, 2, 1000, total);
		expect(transportTimeMs(transport, 1000, total)).toBe(1000);
		expect(transportTimeMs(transport, 1500, total)).toBe(2000);
	});

	test("playing stops at the end and starts again from the beginning", () => {
		const total = 1000;
		let transport = playTransport(createPlaybackTransport(), 0, total);
		expect(isTransportPlaying(transport, 999, total)).toBe(true);
		expect(transportTimeMs(transport, 5000, total)).toBe(total);
		expect(isTransportPlaying(transport, 5000, total)).toBe(false);
		transport = playTransport(transport, 5000, total);
		expect(transportTimeMs(transport, 5000, total)).toBe(0);
		expect(isTransportPlaying(transport, 5100, total)).toBe(true);
	});

	test("seeking keeps the playing state and clamps to the Walkthrough", () => {
		const total = 4000;
		const playing = seekTransport(playTransport(createPlaybackTransport(), 0, total), 1200, 100, total);
		expect(playing.playing).toBe(true);
		expect(transportTimeMs(playing, 200, total)).toBe(1300);
		const paused = seekTransport(createPlaybackTransport(), 99_999, 0, total);
		expect(paused.playing).toBe(false);
		expect(transportTimeMs(paused, 0, total)).toBe(total);
	});

	test("step starts clamp to the first and last step", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [
			{ id: "s1", connectionId: "upload", durationMs: 1000 },
			{ id: "s2", connectionId: "enqueue", durationMs: 2000 },
		]));
		expect(stepStartMs(timeline, -3)).toBe(0);
		expect(stepStartMs(timeline, 1)).toBe(1000);
		expect(stepStartMs(timeline, 42)).toBe(1000);
	});
});

describe("Walkthrough playback key", () => {
	test("layout, viewport, and names do not stop playback", () => {
		const design = fixtureDesign();
		const walkthroughs = walkthroughWith(design, [{ id: "s1", connectionId: "upload" }]);
		const key = walkthroughPlaybackKey(walkthroughs[0]!, design);
		const moved = moveSystemComponent(design, "api", { x: 500, y: 500 });
		expect(walkthroughPlaybackKey(walkthroughs[0]!, moved)).toBe(key);
		const renamed = updateSystemComponent(design, "api", { name: "Renamed API" });
		expect(walkthroughPlaybackKey(walkthroughs[0]!, renamed)).toBe(key);
		expect(walkthroughPlaybackKey(walkthroughs[0]!, { ...design, viewport: { x: 1, y: 2, zoom: 1.5 } })).toBe(key);
	});

	test("structural System design edits and Walkthrough edits change the key", () => {
		const design = fixtureDesign();
		const walkthroughs = walkthroughWith(design, [{ id: "s1", connectionId: "upload" }]);
		const key = walkthroughPlaybackKey(walkthroughs[0]!, design);

		expect(walkthroughPlaybackKey(walkthroughs[0]!, addSystemComponent(design, { id: "cache", position: { x: 0, y: 200 } }))).not.toBe(key);
		expect(walkthroughPlaybackKey(walkthroughs[0]!, removeSystemConnection(design, "reply"))).not.toBe(key);
		expect(walkthroughPlaybackKey(walkthroughs[0]!, addSystemService(design, { id: "svc", name: "Svc", position: { x: 0, y: 0 } }))).not.toBe(key);

		const edited = updateWalkthroughStep(walkthroughs, "upload", "s1", { explanation: "Now explained" });
		expect(walkthroughPlaybackKey(edited[0]!, design)).not.toBe(key);
	});
});
