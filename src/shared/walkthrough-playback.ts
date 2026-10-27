import { sampleCubicBezier, type ProofPoint } from "./architecture-proof";
import { findSystemConnection, type SystemDesign } from "./system-design";
import { findSystemEndpoint, walkthroughStepStatus, type Walkthrough, type WalkthroughAction } from "./walkthrough";

/**
 * Deterministic playback of a saved linear Walkthrough (ADR-0010). One authored
 * clock drives every visible effect: each frame is derived from elapsed time `t`
 * and the current route geometry, never from callbacks that already fired. A
 * seek, a pause, a speed change, or a geometry change therefore yields the same
 * state for the same `t`.
 *
 * Each step's authored duration is split into illustrative phases. The travel
 * share (`travelPercent`, 60 by default) sets where the arrival falls:
 *   - depart:  the sender activates with `send` while the message travels;
 *   - arrive:  the destination reacts with `receive` on arrival;
 *   - outcome: the destination shows the step's own `process`, `succeed`, or `fail`
 *              (a `send` or `receive` step keeps `receive`).
 * Layout changes alter the drawn route but not these durations, so the message
 * still reaches its destination at the authored arrival time.
 */

/** Share of a step's duration spent before the message reaches the destination, unless the step sets its own. */
export const PLAYBACK_DEFAULT_TRAVEL_PERCENT = 60;
/** Share of the post-arrival time that shows the arrival reaction before the outcome. */
export const PLAYBACK_ARRIVAL_HOLD_FRACTION = 0.5;
/** Duration used for a step whose designer has not set one. */
export const PLAYBACK_DEFAULT_STEP_MS = 1200;
export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type PlaybackStep = {
	index: number;
	stepId: string;
	connectionId: string;
	sourceId: string;
	targetId: string;
	action: WalkthroughAction;
	title: string;
	explanation: string;
	operation?: string;
	exampleMessage?: string;
	examplePayload?: string;
	/** Start of the step on the Walkthrough clock, in milliseconds. */
	startMs: number;
	durationMs: number;
	/** Absolute time the message reaches its destination. */
	arrivalMs: number;
	endMs: number;
};

export type PlaybackTimeline = {
	walkthroughId: string;
	totalMs: number;
	steps: PlaybackStep[];
};

export type PlaybackCompileResult =
	| { ok: true; timeline: PlaybackTimeline }
	| { ok: false; problems: string[] };

/** Endpoints of a drawn Connection, in the same space as the overview's routes. */
export type PlaybackRoute = { start: ProofPoint; cp1: ProofPoint; cp2: ProofPoint; end: ProofPoint };

export type PlaybackMessage = { connectionId: string; progress: number; point: ProofPoint };

export type PlaybackReaction = {
	action: WalkthroughAction;
	role: "sender" | "destination";
	phase: "depart" | "arrive" | "outcome";
	/** 0 to 1. Reduced motion holds every visible reaction at 1. */
	intensity: number;
	/** The step's operation, carried to the destination so its kind preset can name it. */
	operation?: string;
};

export type PlaybackFrame = {
	timeMs: number;
	totalMs: number;
	complete: boolean;
	stepIndex: number;
	step: PlaybackStep;
	/** Progress through the active step, from 0 to 1. */
	stepProgress: number;
	/** The travelling message, or null once it has arrived, when reduced motion is on, or when no route is drawn. */
	message: PlaybackMessage | null;
	/** Reactions keyed by endpoint id (Component or Service). */
	reactions: Record<string, PlaybackReaction>;
	highlight: { connectionId: string; endpointIds: string[] };
};

/**
 * Turns a Walkthrough into a timeline when every step still plays a Connection
 * with its recorded endpoints. Dangling, redirected, or endpoint-less steps are
 * reported so the designer can repair them before playback starts.
 */
export function compileWalkthroughPlayback(walkthrough: Walkthrough, design: SystemDesign): PlaybackCompileResult {
	if (walkthrough.steps.length === 0) {
		return { ok: false, problems: ["Add at least one step before playing this Walkthrough."] };
	}
	const problems: string[] = [];
	walkthrough.steps.forEach((step, index) => {
		const label = `Step ${index + 1}`;
		const status = walkthroughStepStatus(step, design);
		if (status.status === "dangling") {
			problems.push(`${label} plays a Connection that was removed. Choose a Connection to repair it.`);
			return;
		}
		if (status.status === "redirected") {
			problems.push(`${label} now runs a changed route. Accept the current route or repair the step.`);
			return;
		}
		const connection = findSystemConnection(design, step.connectionId);
		if (!connection || !findSystemEndpoint(design, connection.sourceId) || !findSystemEndpoint(design, connection.targetId)) {
			problems.push(`${label} has an endpoint that is no longer in the System design.`);
		}
	});
	if (problems.length > 0) return { ok: false, problems };

	let cursor = 0;
	const steps = walkthrough.steps.map((step, index): PlaybackStep => {
		const connection = findSystemConnection(design, step.connectionId)!;
		const durationMs = step.durationMs ?? PLAYBACK_DEFAULT_STEP_MS;
		const travelPercent = step.travelPercent ?? PLAYBACK_DEFAULT_TRAVEL_PERCENT;
		const startMs = cursor;
		cursor += durationMs;
		return {
			index,
			stepId: step.id,
			connectionId: connection.id,
			sourceId: connection.sourceId,
			targetId: connection.targetId,
			action: step.action,
			title: step.title,
			explanation: step.explanation,
			operation: step.operation,
			exampleMessage: step.exampleMessage,
			examplePayload: step.examplePayload,
			startMs,
			durationMs,
			arrivalMs: startMs + Math.round(durationMs * (travelPercent / 100)),
			endMs: cursor,
		};
	});
	return { ok: true, timeline: { walkthroughId: walkthrough.id, totalMs: cursor, steps } };
}

/**
 * Derives the visible state at `timeMs`. Pure: the same inputs always produce the
 * same frame, so seeking backwards or repeating a step needs no replay.
 */
export function deriveWalkthroughFrame(
	timeline: PlaybackTimeline,
	routes: ReadonlyMap<string, PlaybackRoute>,
	timeMs: number,
	options: { reducedMotion?: boolean } = {},
): PlaybackFrame {
	const reducedMotion = options.reducedMotion ?? false;
	const last = timeline.steps[timeline.steps.length - 1];
	if (!last) throw new Error("A playback timeline needs at least one step.");
	const clamped = Math.max(0, Math.min(timeline.totalMs, timeMs));
	const complete = clamped >= timeline.totalMs;
	const step = complete ? last : activeStep(timeline, clamped);
	const local = clamped - step.startMs;
	const arrivalLocal = step.arrivalMs - step.startMs;
	const base = {
		timeMs: clamped,
		totalMs: timeline.totalMs,
		complete,
		stepIndex: step.index,
		step,
		stepProgress: complete ? 1 : Math.min(1, local / step.durationMs),
		highlight: { connectionId: step.connectionId, endpointIds: [step.sourceId, step.targetId] },
	};
	if (complete) return { ...base, message: null, reactions: {} };

	const reactions: Record<string, PlaybackReaction> = {};
	const departing = local < arrivalLocal;
	if (departing) {
		reactions[step.sourceId] = {
			action: "send",
			role: "sender",
			phase: "depart",
			intensity: reducedMotion ? 1 : 1 - local / arrivalLocal,
		};
	}

	const holdEndLocal = arrivalLocal + Math.round((step.durationMs - arrivalLocal) * PLAYBACK_ARRIVAL_HOLD_FRACTION);
	if (!departing) {
		const arriving = local < holdEndLocal;
		const span = Math.max(1, holdEndLocal - arrivalLocal);
		reactions[step.targetId] = arriving
			? {
				action: "receive",
				role: "destination",
				phase: "arrive",
				intensity: reducedMotion ? 1 : (local - arrivalLocal) / span,
				operation: step.operation,
			}
			: {
				action: step.action === "process" || step.action === "succeed" || step.action === "fail" ? step.action : "receive",
				role: "destination",
				phase: "outcome",
				intensity: 1,
				operation: step.operation,
			};
	}

	let message: PlaybackMessage | null = null;
	const route = routes.get(step.connectionId);
	if (!reducedMotion && route && local <= arrivalLocal) {
		const progress = arrivalLocal === 0 ? 1 : local / arrivalLocal;
		message = {
			connectionId: step.connectionId,
			progress,
			point: sampleCubicBezier(route.start, route.cp1, route.cp2, route.end, progress),
		};
	}
	return { ...base, message, reactions };
}

/** The step whose window contains `timeMs` (before the end of the Walkthrough). */
function activeStep(timeline: PlaybackTimeline, timeMs: number): PlaybackStep {
	let found = timeline.steps[0]!;
	for (const candidate of timeline.steps) {
		if (candidate.startMs <= timeMs) found = candidate;
	}
	return found;
}

/**
 * Transport state on a Walkthrough clock. `startedAtMs` is the wall-clock time
 * the current run began; the clock reads `offsetMs` plus elapsed time at `speed`
 * while playing. Every function takes `nowMs`, so a controlled clock can drive it.
 */
export type PlaybackTransport = {
	playing: boolean;
	offsetMs: number;
	startedAtMs: number;
	speed: PlaybackSpeed;
};

export function createPlaybackTransport(speed: PlaybackSpeed = 1): PlaybackTransport {
	return { playing: false, offsetMs: 0, startedAtMs: 0, speed };
}

export function transportTimeMs(transport: PlaybackTransport, nowMs: number, totalMs: number): number {
	const elapsed = transport.playing ? Math.max(0, nowMs - transport.startedAtMs) * transport.speed : 0;
	return Math.max(0, Math.min(totalMs, transport.offsetMs + elapsed));
}

/** Playing stops at the end of the Walkthrough. The clock never reads past it. */
export function isTransportPlaying(transport: PlaybackTransport, nowMs: number, totalMs: number): boolean {
	return transport.playing && transportTimeMs(transport, nowMs, totalMs) < totalMs;
}

/** Starts or resumes playback. From the end, playback starts again from the beginning. */
export function playTransport(transport: PlaybackTransport, nowMs: number, totalMs: number): PlaybackTransport {
	const time = transportTimeMs(transport, nowMs, totalMs);
	return { ...transport, playing: true, offsetMs: time >= totalMs ? 0 : time, startedAtMs: nowMs };
}

export function pauseTransport(transport: PlaybackTransport, nowMs: number, totalMs: number): PlaybackTransport {
	return { ...transport, playing: false, offsetMs: transportTimeMs(transport, nowMs, totalMs), startedAtMs: nowMs };
}

/** Moves the clock without changing whether playback is running. */
export function seekTransport(transport: PlaybackTransport, timeMs: number, nowMs: number, totalMs: number): PlaybackTransport {
	return { ...transport, offsetMs: Math.max(0, Math.min(totalMs, timeMs)), startedAtMs: nowMs };
}

/** Changes speed from the current position, so the clock does not jump. */
export function setTransportSpeed(transport: PlaybackTransport, speed: PlaybackSpeed, nowMs: number, totalMs: number): PlaybackTransport {
	return { ...transport, offsetMs: transportTimeMs(transport, nowMs, totalMs), startedAtMs: nowMs, speed };
}

/** The start time of a step, clamped to the Walkthrough's steps. */
export function stepStartMs(timeline: PlaybackTimeline, stepIndex: number): number {
	const index = Math.max(0, Math.min(timeline.steps.length - 1, stepIndex));
	return timeline.steps[index]!.startMs;
}

/**
 * Identifies what the playback clock is showing. Playback is stopped whenever
 * this key changes: any structural System design change (Components, Services,
 * ownership, Groups and their membership, database Design links, Connections,
 * and their endpoints) or any change to the Walkthrough itself. Layout,
 * viewport, sizes, and names do not change it.
 */
export function walkthroughPlaybackKey(walkthrough: Walkthrough, design: SystemDesign): string {
	return JSON.stringify({
		walkthrough,
		services: design.services.map((service) => service.id),
		groups: design.groups.map((group) => [group.id, group.memberIds]),
		components: design.components.map((component) => [component.id, component.serviceId, component.designId ?? null]),
		connections: design.connections.map((connection) => [connection.id, connection.sourceId, connection.targetId]),
	});
}
