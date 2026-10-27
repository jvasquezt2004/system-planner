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
import { ReactionRing, ReactionTag, WalkthroughMessageDot } from "./walkthrough-playback-svg";

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
});
