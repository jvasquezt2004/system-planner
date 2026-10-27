import { sampleCubicBezier, type ProofPoint } from "./architecture-proof";
import { findSystemConnection, type SystemDesign } from "./system-design";
import {
	findSystemEndpoint,
	walkthroughSteps,
	walkthroughStepStatus,
	type Walkthrough,
	type WalkthroughAction,
	type WalkthroughBlock,
} from "./walkthrough";

/**
 * Deterministic playback of a saved Walkthrough (ADR-0010). The block tree is
 * expanded once into a flat timeline on one authored clock: a sequence advances
 * after its blocks, a parallel block starts every branch together and ends with
 * its longest branch, and a repeat block plays its body `count` times in order.
 * Each frame is derived from elapsed time `t` and the current route geometry,
 * never from callbacks that already fired. A seek, a pause, a speed change, or a
 * geometry change therefore yields the same state for the same `t`.
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
/** Bounds the timeline after repeat blocks are expanded, so playback work stays finite. */
export const PLAYBACK_STEP_LIMIT = 500;
export const PLAYBACK_SPEEDS = [0.5, 1, 2] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type PlaybackStep = {
	/** Position in the timeline, ordered by start time. A step can appear more than once when a repeat block plays it again. */
	index: number;
	/** The authored step this occurrence plays. */
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
	/** Which pass of the innermost enclosing repeat block this occurrence belongs to, when there is one. */
	repetition?: { iteration: number; count: number };
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
	/** The step that leads the frame: the latest-started step still running, used for captions and camera follow. */
	stepIndex: number;
	step: PlaybackStep;
	/** Progress through the leading step, from 0 to 1. */
	stepProgress: number;
	/** Indexes of every step running at this time. Parallel branches can run together. */
	activeStepIndexes: number[];
	/** The travelling messages of the running steps, in timeline order. Empty when reduced motion is on or once they arrive. */
	messages: PlaybackMessage[];
	/**
	 * Reactions keyed by endpoint id (Component or Service). When several running
	 * steps react at one endpoint, the strongest phase wins (outcome, then arrival,
	 * then departure), and among equals the later-starting step.
	 */
	reactions: Record<string, PlaybackReaction>;
	highlight: { connectionId: string; endpointIds: string[] };
};

const PHASE_RANK: Record<PlaybackReaction["phase"], number> = { depart: 0, arrive: 1, outcome: 2 };

/**
 * Turns a Walkthrough into a timeline when every authored step still plays a
 * Connection with its recorded endpoints. Dangling, redirected, or endpoint-less
 * steps are reported so the designer can repair them before playback starts.
 */
export function compileWalkthroughPlayback(walkthrough: Walkthrough, design: SystemDesign): PlaybackCompileResult {
	const authored = walkthroughSteps(walkthrough);
	if (authored.length === 0) {
		return { ok: false, problems: ["Add at least one step before playing this Walkthrough."] };
	}
	const problems: string[] = [];
	authored.forEach((step, index) => {
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

	const occurrences = countOccurrences(walkthrough.blocks);
	if (occurrences > PLAYBACK_STEP_LIMIT) {
		return {
			ok: false,
			problems: [`Repeated blocks play ${occurrences} steps, more than the ${PLAYBACK_STEP_LIMIT} playback allows. Lower a repeat count.`],
		};
	}

	const drafts: Omit<PlaybackStep, "index">[] = [];
	const totalMs = expandBlocks(walkthrough.blocks, 0, drafts, design);
	// Parallel branches are expanded one after another, so order by start time; the sort is stable.
	drafts.sort((a, b) => a.startMs - b.startMs);
	return {
		ok: true,
		timeline: { walkthroughId: walkthrough.id, totalMs, steps: drafts.map((step, index) => ({ ...step, index })) },
	};
}

/** Appends the occurrences of `blocks` starting at `startMs`, and returns when they end. */
function expandBlocks(
	blocks: WalkthroughBlock[],
	startMs: number,
	out: Omit<PlaybackStep, "index">[],
	design: SystemDesign,
	repetition?: PlaybackStep["repetition"],
): number {
	let cursor = startMs;
	for (const block of blocks) {
		if (block.kind === "step") {
			const step = block.step;
			const connection = findSystemConnection(design, step.connectionId)!;
			const durationMs = step.durationMs ?? PLAYBACK_DEFAULT_STEP_MS;
			const travelPercent = step.travelPercent ?? PLAYBACK_DEFAULT_TRAVEL_PERCENT;
			out.push({
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
				repetition,
				startMs: cursor,
				durationMs,
				arrivalMs: cursor + Math.round(durationMs * (travelPercent / 100)),
				endMs: cursor + durationMs,
			});
			cursor += durationMs;
		} else if (block.kind === "parallel") {
			const ends = block.branches.map((branch) => expandBlocks(branch, cursor, out, design, repetition));
			cursor = Math.max(cursor, ...ends);
		} else {
			for (let iteration = 1; iteration <= block.count; iteration += 1) {
				cursor = expandBlocks(block.body, cursor, out, design, { iteration, count: block.count });
			}
		}
	}
	return cursor;
}

/** How many step occurrences the blocks play once repeats are expanded. */
function countOccurrences(blocks: WalkthroughBlock[]): number {
	return blocks.reduce((total, block) => {
		if (block.kind === "step") return total + 1;
		if (block.kind === "parallel") return total + block.branches.reduce((sum, branch) => sum + countOccurrences(branch), 0);
		return total + block.count * countOccurrences(block.body);
	}, 0);
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
	if (complete) {
		return {
			timeMs: clamped,
			totalMs: timeline.totalMs,
			complete,
			stepIndex: last.index,
			step: last,
			stepProgress: 1,
			activeStepIndexes: [],
			messages: [],
			reactions: {},
			highlight: { connectionId: last.connectionId, endpointIds: [last.sourceId, last.targetId] },
		};
	}

	const active = timeline.steps.filter((step) => step.startMs <= clamped && clamped < step.endMs);
	// The leading step is the latest-started one still running; ties go to the later timeline entry.
	const leading = active.reduce<PlaybackStep>((best, step) => (step.startMs >= best.startMs ? step : best), active[0] ?? last);
	const reactions: Record<string, PlaybackReaction> = {};
	const messages: PlaybackMessage[] = [];

	for (const step of active) {
		const local = clamped - step.startMs;
		const arrivalLocal = step.arrivalMs - step.startMs;
		const departing = local < arrivalLocal;
		const candidates: [string, PlaybackReaction][] = [];
		if (departing) {
			candidates.push([step.sourceId, {
				action: "send",
				role: "sender",
				phase: "depart",
				intensity: reducedMotion ? 1 : 1 - local / arrivalLocal,
			}]);
		} else {
			const holdEndLocal = arrivalLocal + Math.round((step.durationMs - arrivalLocal) * PLAYBACK_ARRIVAL_HOLD_FRACTION);
			const span = Math.max(1, holdEndLocal - arrivalLocal);
			candidates.push(local < holdEndLocal
				? [step.targetId, {
					action: "receive",
					role: "destination",
					phase: "arrive",
					intensity: reducedMotion ? 1 : (local - arrivalLocal) / span,
					operation: step.operation,
				}]
				: [step.targetId, {
					action: step.action === "process" || step.action === "succeed" || step.action === "fail" ? step.action : "receive",
					role: "destination",
					phase: "outcome",
					intensity: 1,
					operation: step.operation,
				}]);
		}
		for (const [endpointId, reaction] of candidates) {
			const existing = reactions[endpointId];
			if (!existing || PHASE_RANK[reaction.phase] >= PHASE_RANK[existing.phase]) reactions[endpointId] = reaction;
		}

		const route = routes.get(step.connectionId);
		if (!reducedMotion && route && local <= arrivalLocal) {
			const progress = arrivalLocal === 0 ? 1 : local / arrivalLocal;
			messages.push({
				connectionId: step.connectionId,
				progress,
				point: sampleCubicBezier(route.start, route.cp1, route.cp2, route.end, progress),
			});
		}
	}

	return {
		timeMs: clamped,
		totalMs: timeline.totalMs,
		complete,
		stepIndex: leading.index,
		step: leading,
		stepProgress: Math.min(1, (clamped - leading.startMs) / leading.durationMs),
		activeStepIndexes: active.map((step) => step.index),
		messages,
		reactions,
		highlight: { connectionId: leading.connectionId, endpointIds: [leading.sourceId, leading.targetId] },
	};
}

/**
 * The start of the step before the one at `timeMs` on the clock: the latest start
 * earlier than the leading step's start, or 0. Steps that start together count as one.
 */
export function previousStepStartMs(timeline: PlaybackTimeline, timeMs: number): number {
	const current = leadingStartMs(timeline, timeMs);
	let target = 0;
	for (const step of timeline.steps) {
		if (step.startMs < current && step.startMs > target) target = step.startMs;
	}
	return target;
}

/** The start of the next step after the one at `timeMs`, or the end of the Walkthrough when none follows. */
export function nextStepStartMs(timeline: PlaybackTimeline, timeMs: number): number {
	const current = leadingStartMs(timeline, timeMs);
	let target = timeline.totalMs;
	for (const step of timeline.steps) {
		if (step.startMs > current && step.startMs < target) target = step.startMs;
	}
	return target;
}

/** The start of the step leading at `timeMs`: the latest-started step running then, or the last step once finished. */
function leadingStartMs(timeline: PlaybackTimeline, timeMs: number): number {
	const last = timeline.steps[timeline.steps.length - 1];
	if (!last) return 0;
	if (timeMs >= timeline.totalMs) return last.startMs;
	let start = timeline.steps[0]!.startMs;
	for (const step of timeline.steps) {
		if (step.startMs <= timeMs && timeMs < step.endMs && step.startMs >= start) start = step.startMs;
	}
	return start;
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
