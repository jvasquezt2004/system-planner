import { describe, expect, test } from "bun:test";
import {
	createDefaultProofArchitecture,
	moveGroupDeduplicated,
	computeConnectionPath,
	pathStringOf,
	routeConnectionPath,
	samplePath,
	scheduleWalkthrough,
	getPlaybackFrame,
	getEndpointAnchor,
	sideAnchor,
} from "./architecture-proof";

describe("architecture proof model and invariants", () => {
	test("creates fixture with explicit Service ownership, system scope, and overlapping groups", () => {
		const arch = createDefaultProofArchitecture();

		// Component count and catalog kinds
		expect(arch.components.length).toBe(9);
		const api = arch.components.find((c) => c.id === "comp-api");
		const worker = arch.components.find((c) => c.id === "comp-worker");
		const queue = arch.components.find((c) => c.id === "comp-queue");
		const dbPrimary = arch.components.find((c) => c.id === "comp-db-primary");
		const dbReplica = arch.components.find((c) => c.id === "comp-db-replica");

		// Service ownership is explicit
		expect(api?.serviceId).toBe("svc-ingestion");
		expect(worker?.serviceId).toBe("svc-processing");
		// System scope
		expect(queue?.serviceId).toBeNull();
		expect(dbPrimary?.serviceId).toBeNull();
		// Shared schema indicator
		expect(dbPrimary?.designId).toBe("design-main-schema");
		expect(dbReplica?.designId).toBe("design-main-schema");
		expect(dbReplica?.isSharedSchema).toBe(true);

		// Groups overlap without changing ownership
		const vpc = arch.groups.find((g) => g.id === "grp-vpc");
		const compliance = arch.groups.find((g) => g.id === "grp-compliance");
		expect(vpc).toBeDefined();
		expect(compliance).toBeDefined();

		// Compliance group overlaps: contains api (owned by Ingestion) and db-primary (system scope)
		expect(compliance?.memberComponentIds).toContain("comp-api");
		expect(compliance?.memberComponentIds).toContain("comp-db-primary");
		expect(compliance?.memberComponentIds).toContain("comp-bucket");

		// Duplicate endpoints
		const uploadPost = arch.connections.find((c) => c.id === "conn-upload-post");
		const uploadPoll = arch.connections.find((c) => c.id === "conn-upload-poll");
		expect(uploadPost?.sourceId).toBe("comp-client");
		expect(uploadPost?.targetId).toBe("comp-api");
		expect(uploadPoll?.sourceId).toBe("comp-client");
		expect(uploadPoll?.targetId).toBe("comp-api");
		expect(uploadPost?.routeOffset).not.toEqual(uploadPoll?.routeOffset);

		// Abstract Service-to-Service connection
		const svcConn = arch.connections.find((c) => c.id === "conn-svc-dispatch");
		expect(svcConn?.sourceId).toBe("svc-ingestion");
		expect(svcConn?.targetId).toBe("svc-processing");
	});

	test("moving a group translates overlapping and nested members exactly once", () => {
		const arch = createDefaultProofArchitecture();
		const apiBefore = arch.components.find((c) => c.id === "comp-api")!.position;
		const dbPrimaryBefore = arch.components.find((c) => c.id === "comp-db-primary")!.position;

		// Move US-East region (which contains VPC, Compliance, and nested components)
		const moved = moveGroupDeduplicated(arch, "grp-region", { x: 50, y: 30 });

		const apiAfter = moved.components.find((c) => c.id === "comp-api")!.position;
		const dbPrimaryAfter = moved.components.find((c) => c.id === "comp-db-primary")!.position;

		// Even though comp-api is in grp-region, grp-vpc, and grp-compliance, it moved by exactly 50, 30
		expect(apiAfter.x - apiBefore.x).toBe(50);
		expect(apiAfter.y - apiBefore.y).toBe(30);

		expect(dbPrimaryAfter.x - dbPrimaryBefore.x).toBe(50);
		expect(dbPrimaryAfter.y - dbPrimaryBefore.y).toBe(30);

		// Group bounds moved
		const regionBefore = arch.groups.find((g) => g.id === "grp-region")!.bounds;
		const regionAfter = moved.groups.find((g) => g.id === "grp-region")!.bounds;
		expect(regionAfter.x - regionBefore.x).toBe(50);
		expect(regionAfter.y - regionBefore.y).toBe(30);
	});

	test("service collapse preserves connection IDs and original endpoint identities", () => {
		const arch = createDefaultProofArchitecture();
		// Collapse Ingestion Service
		const collapsedArch = {
			...arch,
			services: arch.services.map((s) => (s.id === "svc-ingestion" ? { ...s, isCollapsed: true } : s)),
		};

		// Connections still have their authoritative source and target IDs
		const uploadPost = collapsedArch.connections.find((c) => c.id === "conn-upload-post")!;
		expect(uploadPost.sourceId).toBe("comp-client");
		expect(uploadPost.targetId).toBe("comp-api");

		// Visible anchor projects to the collapsed service box
		const anchor = getEndpointAnchor(collapsedArch, "comp-api");
		expect(anchor.isService).toBe(true);
		expect(anchor.rect).toEqual(collapsedArch.services.find((s) => s.id === "svc-ingestion")!.collapsedBounds);
	});

	test("parallel connection paths calculate distinct non-overlapping bezier routes", () => {
		const arch = createDefaultProofArchitecture();
		const client = arch.components.find((c) => c.id === "comp-client")!;
		const api = arch.components.find((c) => c.id === "comp-api")!;

		const clientRect = { x: client.position.x, y: client.position.y, width: client.width, height: client.height };
		const apiRect = { x: api.position.x, y: api.position.y, width: api.width, height: api.height };

		const route1 = computeConnectionPath(clientRect, apiRect, -1.2);
		const route2 = computeConnectionPath(clientRect, apiRect, 1.2);

		expect(route1.pathString).not.toEqual(route2.pathString);
		// Control points are vertically displaced by routeOffset
		expect(route1.cp1.y).toBeLessThan(route2.cp1.y);
		expect(route1.cp2.y).toBeLessThan(route2.cp2.y);
	});

	test("timeline schedules parallel steps with concurrent completion", () => {
		const arch = createDefaultProofArchitecture();
		const { scheduledSteps, totalDurationMs } = scheduleWalkthrough(arch.walkthrough);

		expect(totalDurationMs).toBeGreaterThan(0);
		const stepBucket = scheduledSteps.find((s) => s.step.id === "step-4a-bucket-write")!;
		const stepDb = scheduledSteps.find((s) => s.step.id === "step-4b-db-write")!;

		expect(stepBucket).toBeDefined();
		expect(stepDb).toBeDefined();

		// Both parallel steps start at the exact same timestamp
		expect(stepBucket.startTimeMs).toBe(stepDb.startTimeMs);
		// Group duration is max of the two
		const groupEnd = Math.max(stepBucket.endTimeMs, stepDb.endTimeMs);
		const nextStep = scheduledSteps.find((s) => s.step.id === "step-5-retry-sync")!;
		expect(nextStep.startTimeMs).toBe(groupEnd);
	});

	test("playback frame is deterministic across seeking, reverse seeking, and restart", () => {
		const arch = createDefaultProofArchitecture();
		const timeT = 1800; // During step 2

		const frame1 = getPlaybackFrame(arch, timeT);
		// Advance time
		getPlaybackFrame(arch, 3500);
		// Reverse seek back to timeT
		const frameBack = getPlaybackFrame(arch, timeT);

		expect(frame1.currentTimeMs).toBe(frameBack.currentTimeMs);
		expect(frame1.activeStep?.id).toBe(frameBack.activeStep?.id);
		expect(frame1.stepProgress).toBeCloseTo(frameBack.stepProgress, 5);
		expect(frame1.activeParticles.length).toBe(frameBack.activeParticles.length);
		if (frame1.activeParticles.length > 0) {
			expect(frame1.activeParticles[0].point.x).toBeCloseTo(frameBack.activeParticles[0].point.x, 3);
			expect(frame1.activeParticles[0].point.y).toBeCloseTo(frameBack.activeParticles[0].point.y, 3);
		}

		// Restart to 0
		const frameZero = getPlaybackFrame(arch, 0);
		expect(frameZero.currentTimeMs).toBe(0);
		expect(frameZero.activeStepIndex).toBe(0);
		expect(frameZero.isComplete).toBe(false);
	});

	test("finite retry step shows failure on cycle 1 and success on cycle 2", () => {
		const arch = createDefaultProofArchitecture();
		const { scheduledSteps } = scheduleWalkthrough(arch.walkthrough);
		const retryStep = scheduledSteps.find((s) => s.step.id === "step-5-retry-sync")!;

		// Near end of cycle 1 (arrival at progress ~0.4)
		const cycle1Time = retryStep.startTimeMs + retryStep.durationMs * 0.42;
		const frameCycle1 = getPlaybackFrame(arch, cycle1Time);
		const targetReaction1 = frameCycle1.reactions["comp-db-replica"];
		expect(targetReaction1).toBeDefined();
		expect(targetReaction1.action).toBe("fail");
		expect(targetReaction1.isError).toBe(true);

		// Near end of cycle 2 (arrival at progress ~0.9)
		const cycle2Time = retryStep.startTimeMs + retryStep.durationMs * 0.92;
		const frameCycle2 = getPlaybackFrame(arch, cycle2Time);
		const targetReaction2 = frameCycle2.reactions["comp-db-replica"];
		expect(targetReaction2).toBeDefined();
		expect(targetReaction2.action).toBe("succeed");
		expect(targetReaction2.isError).toBe(false);
	});

	test("reduced motion disables traveling particles while preserving static step highlights and reactions", () => {
		const arch = createDefaultProofArchitecture();
		const normalFrame = getPlaybackFrame(arch, 600, { reducedMotion: false });
		const reducedFrame = getPlaybackFrame(arch, 600, { reducedMotion: true });

		expect(normalFrame.activeParticles.length).toBeGreaterThan(0);
		expect(reducedFrame.activeParticles.length).toBe(0);
		expect(reducedFrame.highlightedConnectionIds).toEqual(normalFrame.highlightedConnectionIds);
		expect(reducedFrame.activeStep?.id).toBe(normalFrame.activeStep?.id);
	});
});

describe("routed Connection paths", () => {
	const source = { x: 0, y: 0, width: 180, height: 84 };
	const target = { x: 400, y: 0, width: 180, height: 84 };

	test("without hints the route is the automatic curve, so existing Connections draw as they did", () => {
		const automatic = computeConnectionPath(source, target, -1.2);
		const [piece] = routeConnectionPath(source, target, -1.2);
		expect(piece).toEqual({ start: automatic.start, cp1: automatic.cp1, cp2: automatic.cp2, end: automatic.end });
		expect(pathStringOf([piece!])).toBe(automatic.pathString);
	});

	test("a manual side attaches to the midpoint of that side of the endpoint", () => {
		expect(routeConnectionPath(source, target, 0, { fromSide: "top" })[0]!.start).toEqual({ x: 90, y: 0 });
		expect(sideAnchor(target, "bottom")).toEqual({ x: 490, y: 84 });
		const pieces = routeConnectionPath(source, target, 0, { toSide: "bottom" });
		expect(pieces[pieces.length - 1]!.end).toEqual({ x: 490, y: 84 });
	});

	test("bend points split the route into one piece per leg, and the path passes exactly through each one", () => {
		const bends = [{ x: 200, y: -120 }, { x: 300, y: 200 }];
		const pieces = routeConnectionPath(source, target, 0, { bendPoints: bends });
		expect(pieces).toHaveLength(3);
		expect(pieces[0]!.end).toEqual(bends[0]!);
		expect(pieces[1]!.start).toEqual(bends[0]!);
		expect(pieces[1]!.end).toEqual(bends[1]!);
		expect(pieces[2]!.start).toEqual(bends[1]!);
		const path = pathStringOf(pieces);
		expect(path.startsWith("M 90.0 0.0 C ")).toBe(true);
		expect(path).toContain("200.0 -120.0");
		expect(path).toContain("300.0 200.0");
	});

	test("sampling a routed path is continuous across its pieces and lands on both ends", () => {
		const pieces = routeConnectionPath(source, target, 0, { bendPoints: [{ x: 200, y: -120 }, { x: 300, y: 200 }] });
		let previous = samplePath(pieces, 0);
		expect(previous).toEqual(pieces[0]!.start);
		let largestStep = 0;
		for (let step = 1; step <= 400; step++) {
			const point = samplePath(pieces, step / 400);
			largestStep = Math.max(largestStep, Math.hypot(point.x - previous.x, point.y - previous.y));
			previous = point;
		}
		expect(largestStep).toBeLessThan(10);
		expect(samplePath(pieces, 1)).toEqual(pieces[pieces.length - 1]!.end);
	});

	test("parallel routes through the same bend points keep distinct paths while their bends stay exact", () => {
		const bends = [{ x: 200, y: -120 }];
		const upper = routeConnectionPath(source, target, -0.5, { bendPoints: bends });
		const lower = routeConnectionPath(source, target, 0.5, { bendPoints: bends });
		expect(pathStringOf(upper)).not.toBe(pathStringOf(lower));
		expect(upper[0]!.end).toEqual(bends[0]!);
		expect(lower[0]!.end).toEqual(bends[0]!);
	});

	test("the technical-proof fixture's duplicate-endpoint Connections route apart, and a bent one still reaches its endpoints", () => {
		const arch = createDefaultProofArchitecture();
		const post = arch.connections.find((connection) => connection.id === "conn-upload-post")!;
		const poll = arch.connections.find((connection) => connection.id === "conn-upload-poll")!;
		const from = getEndpointAnchor(arch, post.sourceId).rect;
		const to = getEndpointAnchor(arch, post.targetId).rect;

		const postPath = routeConnectionPath(from, to, post.routeOffset ?? 0);
		const pollPath = routeConnectionPath(from, to, poll.routeOffset ?? 0);
		expect(pathStringOf(postPath)).not.toBe(pathStringOf(pollPath));

		const bend = { x: from.x + from.width / 2, y: from.y - 60 };
		const bent = routeConnectionPath(from, to, post.routeOffset ?? 0, { bendPoints: [bend] });
		expect(samplePath(bent, 0)).toEqual(bent[0]!.start);
		expect(samplePath(bent, 1)).toEqual(bent[bent.length - 1]!.end);
		expect(bent[0]!.end).toEqual(bend);
	});
});
