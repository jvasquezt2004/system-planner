import { useEffect, useMemo, useState } from "react";
import type { SystemDesign } from "../shared/system-design";
import type { Walkthrough } from "../shared/walkthrough";
import {
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
	type PlaybackFrame,
	type PlaybackRoute,
	type PlaybackSpeed,
	type PlaybackTimeline,
	type PlaybackTransport,
} from "../shared/walkthrough-playback";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

export type ActivePlayback = {
	frame: PlaybackFrame;
	playing: boolean;
	speed: PlaybackSpeed;
};

/** What the Walkthrough editor and the overview need: controls, and the frame while the clock is in use. */
export type WalkthroughPlaybackControls = {
	/** Why playback cannot start. Empty when the Walkthrough can play. */
	problems: string[];
	timeline: PlaybackTimeline | null;
	/** Set while the clock is running or paused mid-way. Null while the Walkthrough is only edited. */
	active: ActivePlayback | null;
	play: () => void;
	pause: () => void;
	restart: () => void;
	previous: () => void;
	next: () => void;
	seekStep: (index: number) => void;
	/** Moves the clock to any time on the Walkthrough, keeping whether it is playing. */
	seekTime: (timeMs: number) => void;
	setSpeed: (speed: PlaybackSpeed) => void;
};

/** The clock belongs to one Walkthrough and to the content it was started on. */
type Session = { walkthroughId: string; key: string; transport: PlaybackTransport };

function readReducedMotion(): boolean {
	try {
		return typeof window !== "undefined" && typeof window.matchMedia === "function"
			&& window.matchMedia(REDUCED_MOTION_QUERY).matches;
	} catch {
		return false;
	}
}

/** Tracks `prefers-reduced-motion`, which replaces the moving message with static highlights. */
export function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(readReducedMotion);
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
		const query = window.matchMedia(REDUCED_MOTION_QUERY);
		const update = () => setReduced(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return reduced;
}

/**
 * Plays the selected Walkthrough on one clock. The clock stops, and reads from
 * the start again, whenever the Walkthrough or the structure it plays changes.
 * Pan, zoom, and layout are not part of that key, so they never stop playback.
 */
export function useWalkthroughPlayback({
	walkthrough,
	design,
	routes,
	reducedMotion,
}: {
	walkthrough: Walkthrough | null;
	design: SystemDesign | null;
	routes: ReadonlyMap<string, PlaybackRoute>;
	reducedMotion: boolean;
}): WalkthroughPlaybackControls {
	const [session, setSession] = useState<Session | null>(null);
	const [clockMs, setClockMs] = useState(0);

	const compiled = useMemo(
		() => (walkthrough && design ? compileWalkthroughPlayback(walkthrough, design) : null),
		[walkthrough, design],
	);
	const timeline = compiled?.ok ? compiled.timeline : null;
	const problems = compiled && !compiled.ok ? compiled.problems : [];
	const key = useMemo(
		() => (walkthrough && design ? walkthroughPlaybackKey(walkthrough, design) : null),
		[walkthrough, design],
	);

	const valid = session !== null && walkthrough !== null && timeline !== null
		&& session.walkthroughId === walkthrough.id && session.key === key;
	const transport = valid ? session.transport : createPlaybackTransport(session?.transport.speed ?? 1);
	const totalMs = timeline?.totalMs ?? 0;
	const playing = valid && isTransportPlaying(transport, clockMs, totalMs);

	// While the clock runs, re-read it on each animation frame. The loop stops as
	// soon as playback pauses or reaches the end, so an idle view stays calm.
	useEffect(() => {
		if (!playing) return;
		let handle = 0;
		const tick = () => {
			setClockMs(performance.now());
			handle = requestAnimationFrame(tick);
		};
		handle = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(handle);
	}, [playing]);

	const frame = valid && timeline
		? deriveWalkthroughFrame(timeline, routes, transportTimeMs(transport, clockMs, totalMs), { reducedMotion })
		: null;

	/** Applies one change to the clock at the current wall-clock time. */
	function change(next: (current: PlaybackTransport, nowMs: number, total: number) => PlaybackTransport) {
		if (!walkthrough || !timeline || key === null) return;
		const now = performance.now();
		const current = valid ? transport : createPlaybackTransport(session?.transport.speed ?? 1);
		setSession({ walkthroughId: walkthrough.id, key, transport: next(current, now, timeline.totalMs) });
		setClockMs(now);
	}

	const currentIndex = frame?.stepIndex ?? 0;
	const stepCount = timeline?.steps.length ?? 0;

	return {
		problems,
		timeline,
		active: frame ? { frame, playing, speed: transport.speed } : null,
		play: () => change((current, now, total) => playTransport(current, now, total)),
		pause: () => {
			if (valid) change((current, now, total) => pauseTransport(current, now, total));
		},
		restart: () => change((current, now, total) => seekTransport(current, 0, now, total)),
		previous: () => {
			if (timeline) change((current, now, total) => seekTransport(current, stepStartMs(timeline, currentIndex - 1), now, total));
		},
		next: () => {
			if (!timeline) return;
			change((current, now, total) => {
				const target = currentIndex + 1 >= stepCount ? total : stepStartMs(timeline, currentIndex + 1);
				return seekTransport(current, target, now, total);
			});
		},
		seekStep: (index) => {
			if (timeline) change((current, now, total) => seekTransport(current, stepStartMs(timeline, index), now, total));
		},
		seekTime: (timeMs) => change((current, now, total) => seekTransport(current, timeMs, now, total)),
		setSpeed: (speed) => change((current, now, total) => setTransportSpeed(current, speed, now, total)),
	};
}
