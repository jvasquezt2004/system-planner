import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeConnectionPath, type ProofRect } from "../shared/architecture-proof";
import { reactionLabel } from "../shared/component-reactions";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	type SystemDesign,
} from "../shared/system-design";
import {
	addWalkthrough,
	addWalkthroughStep,
	updateWalkthroughStep,
} from "../shared/walkthrough";
import {
	compileWalkthroughPlayback,
	deriveWalkthroughFrame,
	type PlaybackRoute,
	type PlaybackTimeline,
} from "../shared/walkthrough-playback";
import { ReactionRing, ReactionTag, ReceptionItem, WalkthroughMessageDot } from "./walkthrough-playback-svg";

function design(): SystemDesign {
	let next = createEmptySystemDesign();
	next = addSystemComponent(next, { id: "client", name: "Client", position: { x: 0, y: 0 } });
	next = addSystemComponent(next, { id: "queue", name: "Queue", position: { x: 640, y: 0 } });
	return addSystemConnection(next, { id: "enqueue", sourceId: "client", targetId: "queue", label: "Enqueue" });
}

function timelineAndRoutes(durationMs: number, action: "send" | "fail" = "send"): { timeline: PlaybackTimeline; routes: Map<string, PlaybackRoute> } {
	const current = design();
	let walkthroughs = addWalkthrough([], { id: "w" });
	walkthroughs = addWalkthroughStep(walkthroughs, "w", { id: "s1", connectionId: "enqueue" }, current);
	walkthroughs = updateWalkthroughStep(walkthroughs, "w", "s1", { durationMs, action });
	const result = compileWalkthroughPlayback(walkthroughs[0]!, current);
	if (!result.ok) throw new Error(result.problems.join("; "));

	const rects = new Map<string, ProofRect>(current.components.map((component) => [
		component.id,
		{ x: component.position.x, y: component.position.y, width: 180, height: 84 },
	]));
	const route = computeConnectionPath(rects.get("client")!, rects.get("queue")!, 0);
	return {
		timeline: result.timeline,
		routes: new Map([["enqueue", { start: route.start, cp1: route.cp1, cp2: route.cp2, end: route.end }]]),
	};
}

function svg(children: ReactNode): string {
	return renderToStaticMarkup(<svg>{children}</svg>);
}

describe("walkthrough SVG playback", () => {
	test("the message dot is drawn at the point the frame derives from the route, at that authored time", () => {
		const { timeline, routes } = timelineAndRoutes(1000);
		const frame = deriveWalkthroughFrame(timeline, routes, 300);
		expect(frame.messages[0]).not.toBeNull();
		const html = svg(<WalkthroughMessageDot message={frame.messages[0]!} />);
		expect(html).toContain(`cx="${frame.messages[0]!.point.x}"`);
		expect(html).toContain(`cy="${frame.messages[0]!.point.y}"`);
		expect(html).toContain('data-connection-id="enqueue"');
	});

	test("the dot moves along the route as time advances and is not drawn once the message has arrived", () => {
		const { timeline, routes } = timelineAndRoutes(1000);
		const early = deriveWalkthroughFrame(timeline, routes, 100).messages[0]!;
		const later = deriveWalkthroughFrame(timeline, routes, 400).messages[0]!;
		expect(later.progress).toBeGreaterThan(early.progress);
		expect(later.point.x).toBeGreaterThan(early.point.x);

		const arrived = deriveWalkthroughFrame(timeline, routes, timeline.steps[0]!.arrivalMs + 1);
		expect(arrived.messages).toEqual([]);
	});

	test("reactions render as a ring at the frame's intensity with the preset's label", () => {
		const { timeline, routes } = timelineAndRoutes(1000, "fail");
		// Late in the step, after the arrival hold, the destination shows the step's own outcome.
		const frame = deriveWalkthroughFrame(timeline, routes, timeline.steps[0]!.endMs - 100);
		const reaction = frame.reactions.queue!;
		expect(reaction).toEqual(expect.objectContaining({ action: "fail", phase: "outcome", intensity: 1 }));

		const html = svg(
			<>
				<ReactionRing reaction={reaction} width={180} height={84} radius={14} />
				<ReactionTag reaction={reaction} kind="generic" x={0} y={-12} />
			</>,
		);
		expect(html).toContain('stroke-opacity="1"');
		expect(html).toContain(`data-action="fail"`);
		expect(html).toContain(reactionLabel("generic", "fail").toUpperCase());
	});

	test("a reaction's ring fades with its intensity during the arrival phase", () => {
		const { timeline, routes } = timelineAndRoutes(1000);
		const arrival = timeline.steps[0]!.arrivalMs;
		const frame = deriveWalkthroughFrame(timeline, routes, arrival + 20);
		const reaction = frame.reactions.queue!;
		expect(reaction.phase).toBe("arrive");
		expect(reaction.intensity).toBeGreaterThan(0);
		expect(reaction.intensity).toBeLessThan(1);
		const html = svg(<ReactionRing reaction={reaction} width={180} height={84} radius={14} />);
		expect(html).toContain(`stroke-opacity="${reaction.intensity}"`);
	});

	test("a compute destination shows its operation preset, and its shared action wording otherwise", () => {
		const retried = { action: "fail", role: "destination", phase: "outcome", intensity: 1, operation: "retry" } as const;
		expect(svg(<ReactionTag reaction={retried} kind="worker" x={0} y={-12} />)).toContain(">RETRY<");
		const returned = { action: "succeed", role: "destination", phase: "outcome", intensity: 1 } as const;
		expect(svg(<ReactionTag reaction={returned} kind="serverless_handler" x={0} y={-12} />)).toContain(">RETURNED<");
	});

	test("a catalog destination names its operation preset, while the sender keeps the action wording", () => {
		const destination = { action: "receive", role: "destination", phase: "arrive", intensity: 1, operation: "cache hit" } as const;
		const cacheHit = svg(<ReactionTag reaction={destination} kind="cdn" x={0} y={-12} />);
		expect(cacheHit).toContain(">CACHE HIT<");
		expect(cacheHit).toContain('data-action="receive"');

		const sender = svg(<ReactionTag reaction={{ ...destination, action: "send", role: "sender", phase: "depart", operation: undefined }} kind="cdn" x={0} y={-12} />);
		expect(sender).toContain(">REQUESTS<");
	});

	test("a bucket or queue takes its item in on arrival, and the item rests in place at full intensity under reduced motion", () => {
		const { timeline, routes } = timelineAndRoutes(1000);
		const arrival = timeline.steps[0]!.arrivalMs;
		const entering = deriveWalkthroughFrame(timeline, routes, arrival + 20).reactions.queue!;
		expect(entering).toMatchObject({ phase: "arrive" });

		const entry = svg(<ReceptionItem reaction={entering} kind="queue" width={180} height={84} />);
		expect(entry).toContain('data-testid="reception-item"');
		expect(entry).toContain(`opacity="${entering.intensity}"`);
		expect(entry).toContain(`x="${168 + (1 - entering.intensity) * 26}"`);

		const rest = deriveWalkthroughFrame(timeline, routes, arrival + 20, { reducedMotion: true }).reactions.queue!;
		expect(svg(<ReceptionItem reaction={rest} kind="queue" width={180} height={84} />)).toContain('x="168"');
	});

	test("the item leaves a bucket or queue on departure, and holds no item during the outcome", () => {
		const departing = { action: "send", role: "sender", phase: "depart", intensity: 0.25 } as const;
		const leaving = svg(<ReceptionItem reaction={departing} kind="object_storage_bucket" width={180} height={84} />);
		expect(leaving).toContain('data-phase="depart"');
		expect(leaving).toContain(`x="${168 + 0.75 * 26}"`);

		const outcome = { action: "succeed", role: "destination", phase: "outcome", intensity: 1 } as const;
		expect(svg(<ReceptionItem reaction={outcome} kind="queue" width={180} height={84} />)).toBe("<svg></svg>");
	});

	test("kinds other than a bucket or queue draw no reception item", () => {
		const arriving = { action: "receive", role: "destination", phase: "arrive", intensity: 0.5 } as const;
		expect(svg(<ReceptionItem reaction={arriving} kind="cache" width={180} height={84} />)).toBe("<svg></svg>");
		expect(svg(<ReceptionItem reaction={arriving} kind="cdn" width={180} height={84} />)).toBe("<svg></svg>");
	});
});
