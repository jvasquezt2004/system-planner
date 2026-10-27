import { describe, expect, test } from "bun:test";
import { computeConnectionPath, type ProofRect } from "./architecture-proof";
import {
	PLAYBACK_DEFAULT_STEP_MS,
	PLAYBACK_STEP_LIMIT,
	compileWalkthroughPlayback,
	createPlaybackTransport,
	deriveWalkthroughFrame,
	isTransportPlaying,
	nextStepStartMs,
	pauseTransport,
	playTransport,
	previousStepStartMs,
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
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	moveSystemComponent,
	removeSystemConnection,
	resizeSystemGroup,
	updateSystemComponent,
	updateSystemConnection,
	type SystemDesign,
} from "./system-design";
import {
	addWalkthrough,
	addWalkthroughBlock,
	addWalkthroughStep,
	updateWalkthroughRepeat,
	updateWalkthroughStep,
	type Walkthrough,
} from "./walkthrough";

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
		expect(frame.messages[0]?.progress).toBe(0);
		expect(frame.messages[0]?.point).toEqual(routes.get("upload")!.start);
		expect(frame.highlight).toEqual({ connectionId: "upload", endpointIds: ["client", "api"] });
	});

	test("the message reaches the destination's route end exactly at the authored arrival time", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const routes = routesFor(design);
		const arrival = timeline.steps[0]!.arrivalMs;

		const atArrival = deriveWalkthroughFrame(timeline, routes, arrival);
		expect(atArrival.messages[0]?.progress).toBe(1);
		expect(atArrival.messages[0]?.point.x).toBeCloseTo(routes.get("upload")!.end.x, 6);
		expect(atArrival.messages[0]?.point.y).toBeCloseTo(routes.get("upload")!.end.y, 6);

		const afterArrival = deriveWalkthroughFrame(timeline, routes, arrival + 1);
		expect(afterArrival.messages).toEqual([]);
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
		expect(done.messages).toEqual([]);
		expect(done.reactions).toEqual({});
		expect(done.stepProgress).toBe(1);
	});

	test("reduced motion removes the moving message and holds reactions as static highlights", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [{ id: "s1", connectionId: "upload", durationMs: 1000 }]));
		const routes = routesFor(design);

		const early = deriveWalkthroughFrame(timeline, routes, 100, { reducedMotion: true });
		expect(early.messages).toEqual([]);
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
		expect(arrival.messages[0]?.point.x).toBeCloseTo(movedRoutes.get("upload")!.end.x, 6);
		expect(arrival.messages[0]?.point.y).toBeCloseTo(movedRoutes.get("upload")!.end.y, 6);
		expect(arrival.messages[0]?.point).not.toEqual(routesFor(design).get("upload")!.end);
		expect(timeline.steps[0]!.arrivalMs).toBe(Math.round(1000 * 0.6));
	});
});

describe("Walkthrough travel share and time scrubbing", () => {
	test("a step's travel share moves its arrival while its duration and the Walkthrough's total stay the same", () => {
		const design = fixtureDesign();
		let walkthroughs = walkthroughWith(design, [
			{ id: "s1", connectionId: "upload", durationMs: 1000 },
			{ id: "s2", connectionId: "enqueue", durationMs: 1000 },
		]);
		walkthroughs = updateWalkthroughStep(walkthroughs, "upload", "s1", { travelPercent: 25 });
		const timeline = compiled(design, walkthroughs);

		expect(timeline.steps[0]).toMatchObject({ startMs: 0, durationMs: 1000, arrivalMs: 250, endMs: 1000 });
		expect(timeline.steps[1]).toMatchObject({ startMs: 1000, arrivalMs: 1600 });
		expect(timeline.totalMs).toBe(2000);

		const arrived = deriveWalkthroughFrame(timeline, routesFor(design), 250);
		expect(arrived.messages[0]?.progress).toBe(1);
		expect(arrived.reactions.api).toEqual({ action: "receive", role: "destination", phase: "arrive", intensity: 0 });
	});

	test("scrubbing forward past a message and back gives the same frame, with no leftover message or reaction", () => {
		const design = fixtureDesign();
		const timeline = compiled(design, walkthroughWith(design, [
			{ id: "s1", connectionId: "upload", durationMs: 1000 },
			{ id: "s2", connectionId: "enqueue", durationMs: 1000, action: "fail" },
		]));
		const routes = routesFor(design);

		const before = deriveWalkthroughFrame(timeline, routes, 300);
		deriveWalkthroughFrame(timeline, routes, 1700);
		expect(deriveWalkthroughFrame(timeline, routes, 300)).toEqual(before);

		const later = deriveWalkthroughFrame(timeline, routes, 1700);
		expect(later.step.connectionId).toBe("enqueue");
		expect(later.reactions.client).toBeUndefined();
		expect(later.reactions.api).toBeUndefined();
		expect(later.messages).toEqual([]);
		expect(later.reactions.queue).toEqual({ action: "receive", role: "destination", phase: "arrive", intensity: expect.any(Number) });
	});

	test("a time scrub keeps a paused clock paused at the chosen time and a playing clock playing from it", () => {
		const total = 4000;
		const paused = seekTransport(createPlaybackTransport(), 1500, 100, total);
		expect(isTransportPlaying(paused, 9000, total)).toBe(false);
		expect(transportTimeMs(paused, 9000, total)).toBe(1500);

		const playing = seekTransport(playTransport(createPlaybackTransport(), 0, total), 2500, 1000, total);
		expect(isTransportPlaying(playing, 1000, total)).toBe(true);
		expect(transportTimeMs(playing, 1200, total)).toBe(2700);
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

		const grouped = addSystemGroup(design, { id: "tier", name: "Tier", position: { x: -20, y: -20 }, memberIds: ["api"] });
		expect(walkthroughPlaybackKey(walkthroughs[0]!, grouped)).not.toBe(key);
		const resized = resizeSystemGroup(grouped, "tier", { width: 600, height: 300 });
		expect(walkthroughPlaybackKey(walkthroughs[0]!, resized)).toBe(walkthroughPlaybackKey(walkthroughs[0]!, grouped));

		const edited = updateWalkthroughStep(walkthroughs, "upload", "s1", { explanation: "Now explained" });
		expect(walkthroughPlaybackKey(edited[0]!, design)).not.toBe(key);
	});
});

describe("Walkthrough playback after architecture changes", () => {
	test("a redirected step blocks only its own Walkthrough, and an unaffected Walkthrough still plays", () => {
		const design = fixtureDesign();
		let walkthroughs = addWalkthrough([], { id: "upload", name: "Upload" });
		walkthroughs = addWalkthroughStep(walkthroughs, "upload", { id: "u1", connectionId: "upload", title: "Send" }, design);
		walkthroughs = addWalkthrough(walkthroughs, { id: "reply", name: "Reply" });
		walkthroughs = addWalkthroughStep(walkthroughs, "reply", { id: "r1", connectionId: "reply", title: "Answer" }, design);
		walkthroughs = addWalkthroughStep(walkthroughs, "upload", { id: "u2", connectionId: "enqueue", title: "Queue" }, design);

		// Retaining the Connection id alone does not accept its new endpoints.
		const redirected = updateSystemConnection(design, "enqueue", { sourceId: "client" });
		const affected = compileWalkthroughPlayback(walkthroughs[0]!, redirected);
		expect(affected.ok).toBe(false);
		if (affected.ok) throw new Error("Expected the redirected Walkthrough to be blocked.");
		expect(affected.problems).toEqual(["Step 2 now runs a changed route. Accept the current route or repair the step."]);

		expect(compileWalkthroughPlayback(walkthroughs[1]!, redirected).ok).toBe(true);
	});

	test("a removed Connection blocks only the Walkthroughs that play it", () => {
		const design = fixtureDesign();
		let walkthroughs = addWalkthrough([], { id: "upload", name: "Upload" });
		walkthroughs = addWalkthroughStep(walkthroughs, "upload", { id: "u1", connectionId: "upload", title: "Send" }, design);
		walkthroughs = addWalkthrough(walkthroughs, { id: "reply", name: "Reply" });
		walkthroughs = addWalkthroughStep(walkthroughs, "reply", { id: "r1", connectionId: "reply", title: "Answer" }, design);

		const removed = removeSystemConnection(design, "upload");
		const blocked = compileWalkthroughPlayback(walkthroughs[0]!, removed);
		expect(blocked.ok).toBe(false);
		if (blocked.ok) throw new Error("Expected the dangling Walkthrough to be blocked.");
		expect(blocked.problems).toEqual(["Step 1 plays a Connection that was removed. Choose a Connection to repair it."]);
		expect(compileWalkthroughPlayback(walkthroughs[1]!, removed).ok).toBe(true);
	});
});

describe("Parallel and repeated playback", () => {
	/** Builds a Walkthrough from block-level steps, using the same authoring operations as the editor. */
	function nested(build: (walkthroughs: Walkthrough[]) => Walkthrough[]): Walkthrough[] {
		return build(addWalkthrough([], { id: "nested" }));
	}

	function addStep(walkthroughs: Walkthrough[], design: SystemDesign, id: string, connectionId: string, durationMs: number, sequence?: { blockId: string | null; branch?: number }, action: "send" | "receive" | "process" | "succeed" | "fail" = "send") {
		const added = addWalkthroughStep(walkthroughs, "nested", { id, connectionId, sequence }, design);
		return updateWalkthroughStep(added, "nested", id, { durationMs, action });
	}

	test("a parallel block starts every branch together and ends with its longest branch", () => {
		const design = fixtureDesign();
		const walkthroughs = nested((start) => {
			let next = addWalkthroughBlock(start, "nested", { id: "p", kind: "parallel" });
			next = addStep(next, design, "a", "upload", 1000, { blockId: "p", branch: 0 });
			next = addStep(next, design, "b", "enqueue", 2000, { blockId: "p", branch: 1 });
			next = addStep(next, design, "c", "reply", 500);
			return next;
		});
		const timeline = compiled(design, walkthroughs);
		expect(timeline.totalMs).toBe(2500);
		expect(timeline.steps.map((step) => [step.stepId, step.startMs, step.endMs])).toEqual([
			["a", 0, 1000],
			["b", 0, 2000],
			["c", 2000, 2500],
		]);

		const routes = routesFor(design);
		const together = deriveWalkthroughFrame(timeline, routes, 500);
		expect(together.activeStepIndexes).toEqual([0, 1]);
		expect(together.messages.map((message) => message.connectionId)).toEqual(["upload", "enqueue"]);

		const shorterDone = deriveWalkthroughFrame(timeline, routes, 1500);
		expect(shorterDone.activeStepIndexes).toEqual([1]);
		expect(shorterDone.step.stepId).toBe("b");

		const afterBlock = deriveWalkthroughFrame(timeline, routes, 2100);
		expect(afterBlock.step.stepId).toBe("c");
		expect(afterBlock.complete).toBe(false);
		expect(deriveWalkthroughFrame(timeline, routes, 2500).complete).toBe(true);
	});

	test("reactions at one endpoint compose by phase: an outcome outranks another branch's departure", () => {
		const design = fixtureDesign();
		const walkthroughs = nested((start) => {
			let next = addWalkthroughBlock(start, "nested", { id: "p", kind: "parallel" });
			next = addStep(next, design, "a", "upload", 1000, { blockId: "p", branch: 0 }, "succeed");
			next = addStep(next, design, "b", "enqueue", 2000, { blockId: "p", branch: 1 });
			return next;
		});
		const timeline = compiled(design, walkthroughs);
		// At 900 the upload has arrived at api and is showing its outcome, while enqueue departs from api.
		const frame = deriveWalkthroughFrame(timeline, routesFor(design), 900);
		expect(frame.reactions.api).toMatchObject({ phase: "outcome", action: "succeed" });
	});

	test("a repeated block plays its body once per pass, in order, and numbers each pass", () => {
		const design = fixtureDesign();
		const walkthroughs = nested((start) => {
			let next = addWalkthroughBlock(start, "nested", { id: "r", kind: "repeat" });
			next = updateWalkthroughRepeat(next, "nested", "r", 3);
			next = addStep(next, design, "attempt", "upload", 1000, { blockId: "r" }, "fail");
			next = addStep(next, design, "retry-ok", "upload", 1000, undefined, "succeed");
			return next;
		});
		const timeline = compiled(design, walkthroughs);
		expect(timeline.steps.map((step) => [step.stepId, step.startMs, step.repetition?.iteration ?? null])).toEqual([
			["attempt", 0, 1],
			["attempt", 1000, 2],
			["attempt", 2000, 3],
			["retry-ok", 3000, null],
		]);
		expect(timeline.totalMs).toBe(4000);
		const secondPass = deriveWalkthroughFrame(timeline, routesFor(design), 1500);
		expect(secondPass.step.repetition).toEqual({ iteration: 2, count: 3 });
		expect(secondPass.step.index).toBe(1);
	});

	test("seeking and previous or next step respect nested block boundaries", () => {
		const design = fixtureDesign();
		const walkthroughs = nested((start) => {
			let next = addWalkthroughBlock(start, "nested", { id: "p", kind: "parallel" });
			next = addStep(next, design, "a", "upload", 1000, { blockId: "p", branch: 0 });
			next = addStep(next, design, "b", "enqueue", 2000, { blockId: "p", branch: 1 });
			next = addStep(next, design, "c", "reply", 1000);
			next = addWalkthroughBlock(next, "nested", { id: "r", kind: "repeat" });
			next = updateWalkthroughRepeat(next, "nested", "r", 2);
			return addStep(next, design, "d", "upload", 500, { blockId: "r" });
		});
		const timeline = compiled(design, walkthroughs);
		expect(timeline.steps.map((step) => step.startMs)).toEqual([0, 0, 2000, 3000, 3500]);
		// The parallel branches start together, so stepping forward from the block's start skips the sibling.
		expect(nextStepStartMs(timeline, 0)).toBe(2000);
		expect(previousStepStartMs(timeline, 2500)).toBe(0);
		expect(nextStepStartMs(timeline, 3200)).toBe(3500);
		expect(previousStepStartMs(timeline, 3600)).toBe(3000);
		expect(nextStepStartMs(timeline, 3600)).toBe(timeline.totalMs);
		// Seeking to a pass's start lands on that pass, and derived frames match a fresh derivation.
		const seeked = deriveWalkthroughFrame(timeline, routesFor(design), 3500);
		expect(seeked).toEqual(deriveWalkthroughFrame(timeline, routesFor(design), 3500));
		expect(seeked.step.repetition).toEqual({ iteration: 2, count: 2 });
	});

	test("a Walkthrough whose repeats play too many steps is refused before it is expanded", () => {
		const design = fixtureDesign();
		const walkthroughs = nested((start) => {
			let next = start;
			let parent: string | null = null;
			for (const id of ["r1", "r2", "r3"]) {
				next = addWalkthroughBlock(next, "nested", { id, kind: "repeat", sequence: parent ? { blockId: parent } : undefined });
				next = updateWalkthroughRepeat(next, "nested", id, 10);
				parent = id;
			}
			for (const id of ["x", "y", "z"]) next = addStep(next, design, id, "upload", 500, { blockId: parent });
			return next;
		});
		const result = compileWalkthroughPlayback(walkthroughs[0]!, design);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.problems).toEqual([`Repeated blocks play 3000 steps, more than the ${PLAYBACK_STEP_LIMIT} playback allows. Lower a repeat count.`]);
	});

	test("a dangling step inside a parallel branch blocks playback and names the step", () => {
		const design = fixtureDesign();
		const walkthroughs = nested((start) => {
			let next = addWalkthroughBlock(start, "nested", { id: "p", kind: "parallel" });
			next = addStep(next, design, "a", "upload", 1000, { blockId: "p", branch: 0 });
			return addStep(next, design, "b", "enqueue", 1000, { blockId: "p", branch: 1 });
		});
		const withoutEnqueue = removeSystemConnection(design, "enqueue");
		const result = compileWalkthroughPlayback(walkthroughs[0]!, withoutEnqueue);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.problems).toEqual(["Step 2 plays a Connection that was removed. Choose a Connection to repair it."]);
	});
});
