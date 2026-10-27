import { describe, expect, test } from "bun:test";
import { computeConnectionPath, type ProofRect } from "./architecture-proof";
import {
	COMPUTE_KINDS,
	COMPONENT_CATALOG,
	componentDefaultNameStem,
	componentKindLabel,
	descriptorKeysFor,
	operationPresetFor,
	type ComputeKind,
} from "./component-catalog";
import { KIND_REACTION_PRESETS, reactionLabel, reactionPresetFor, reactionText } from "./component-reactions";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	normalizeSystemDesign,
	updateSystemComponent,
	type SystemDesign,
} from "./system-design";
import { addWalkthrough, addWalkthroughStep, updateWalkthroughStep, WALKTHROUGH_ACTIONS, type Walkthrough } from "./walkthrough";
import { compileWalkthroughPlayback, deriveWalkthroughFrame, type PlaybackRoute, type PlaybackTimeline } from "./walkthrough-playback";

const DEFAULT_NAMES: Record<ComputeKind, string> = {
	application: "Application",
	api: "API",
	worker: "Worker",
	scheduled_job: "Scheduled job",
	serverless_handler: "Serverless handler",
};

/** A Person calling each compute Component, so every kind has an inbound Connection. */
function computeDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", kind: "person", name: "Client", position: { x: 0, y: 0 } });
	for (const [index, kind] of COMPUTE_KINDS.entries()) {
		design = addSystemComponent(design, { id: kind, kind, position: { x: 320, y: index * 160 } });
		design = addSystemConnection(design, { id: `to-${kind}`, sourceId: "client", targetId: kind, label: "Calls" });
	}
	return design;
}

function routesFor(design: SystemDesign): Map<string, PlaybackRoute> {
	const rects = new Map<string, ProofRect>(
		design.components.map((component) => [component.id, { x: component.position.x, y: component.position.y, width: 180, height: 84 }]),
	);
	const routes = new Map<string, PlaybackRoute>();
	for (const connection of design.connections) {
		const route = computeConnectionPath(rects.get(connection.sourceId)!, rects.get(connection.targetId)!, 0);
		routes.set(connection.id, { segments: [route] });
	}
	return routes;
}

function playableTimeline(design: SystemDesign, walkthrough: Walkthrough): PlaybackTimeline {
	const result = compileWalkthroughPlayback(walkthrough, design);
	if (!result.ok) throw new Error(`Expected a playable Walkthrough: ${result.problems.join("; ")}`);
	return result.timeline;
}

describe("compute catalog kinds", () => {
	test("registers the five compute kinds in one family, each with its own label, default name, artwork, and reaction preset", () => {
		expect([...COMPUTE_KINDS]).toEqual(["application", "api", "worker", "scheduled_job", "serverless_handler"]);
		expect(COMPONENT_CATALOG.filter((entry) => entry.family === "compute").map((entry) => entry.kind)).toEqual([...COMPUTE_KINDS]);
		for (const kind of COMPUTE_KINDS) {
			const entry = COMPONENT_CATALOG.find((candidate) => candidate.kind === kind)!;
			expect(entry.label).toBe(componentKindLabel(kind));
			expect(entry.defaultName).toBe(DEFAULT_NAMES[kind]);
			expect(componentDefaultNameStem(kind)).toBe(DEFAULT_NAMES[kind]);
			expect(entry.artwork).toBe(kind);
			expect(KIND_REACTION_PRESETS[kind]).toBe(entry.reactions);
			expect(reactionPresetFor(kind).kind).toBe(kind);
		}
	});

	test("each compute kind suggests only optional descriptive annotations, named as the catalog describes them", () => {
		expect(descriptorKeysFor("application")).toEqual(["Responsibility"]);
		expect(descriptorKeysFor("api")).toEqual(["Operations", "Protocols"]);
		expect(descriptorKeysFor("worker")).toEqual(["Job type"]);
		expect(descriptorKeysFor("scheduled_job")).toEqual(["Schedule description", "Job type"]);
		expect(descriptorKeysFor("serverless_handler")).toEqual(["Trigger", "Runtime description"]);
	});

	test("operation presets exist only where a step can name a visible outcome", () => {
		expect(operationPresetFor("api", "Error response")?.id).toBe("error-response");
		expect(operationPresetFor("api", "respond")?.label).toBe("Respond");
		expect(operationPresetFor("worker", "retry")?.label).toBe("Retry");
		expect(operationPresetFor("application", "retry")).toBeUndefined();
		expect(operationPresetFor("serverless_handler", "respond")).toBeUndefined();
	});

	test("every compute kind has wording for all five shared actions, distinct from the generic wording", () => {
		for (const kind of COMPUTE_KINDS) {
			for (const action of WALKTHROUGH_ACTIONS) {
				expect(reactionLabel(kind, action).length).toBeGreaterThan(0);
			}
		}
		expect(reactionLabel("serverless_handler", "receive")).toBe("Activated");
		expect(reactionLabel("serverless_handler", "succeed")).toBe("Returned");
		expect(reactionLabel("scheduled_job", "receive")).toBe("Triggered");
	});
});

describe("compute Components in the System design", () => {
	test("each kind is created with its default name, edited with its descriptors, and connected", () => {
		let design = computeDesign();
		for (const kind of COMPUTE_KINDS) {
			expect(design.components.find((component) => component.id === kind)?.name).toBe(DEFAULT_NAMES[kind]);
		}

		for (const kind of COMPUTE_KINDS) {
			const properties = descriptorKeysFor(kind).map((key) => ({ key, value: `${key} for ${kind}` }));
			design = updateSystemComponent(design, kind, { technology: "Bun", properties });
		}
		const api = design.components.find((component) => component.id === "api")!;
		expect(api).toMatchObject({
			kind: "api",
			technology: "Bun",
			properties: [
				{ key: "Operations", value: "Operations for api" },
				{ key: "Protocols", value: "Protocols for api" },
			],
		});
		expect(design.connections.filter((connection) => connection.sourceId === "client")).toHaveLength(COMPUTE_KINDS.length);
	});

	test("save and reopen keep every compute kind, its properties, and its connections", () => {
		let design = computeDesign();
		for (const kind of COMPUTE_KINDS) {
			design = updateSystemComponent(design, kind, {
				properties: descriptorKeysFor(kind).map((key) => ({ key, value: `${key} text` })),
			});
		}
		const reopened = normalizeSystemDesign(JSON.parse(JSON.stringify(design)));
		expect(reopened.components.map((component) => component.kind)).toEqual(["person", ...COMPUTE_KINDS]);
		expect(reopened.components).toEqual(design.components);
		expect(reopened.connections).toEqual(design.connections);
	});

	test("scheduling and runtime annotations stay descriptive: a serverless handler links no database Design and adds no Edge function", () => {
		const design = computeDesign();
		expect(Object.keys(design).sort()).toEqual(Object.keys(createEmptySystemDesign()).sort());

		const serverless = updateSystemComponent(design, "serverless_handler", {
			properties: [
				{ key: "Trigger", value: "HTTP request" },
				{ key: "Runtime description", value: "Node.js function" },
			],
		});
		expect(serverless.components.find((component) => component.id === "serverless_handler")?.designId).toBeUndefined();
		expect(() => updateSystemComponent(serverless, "serverless_handler", { designId: "design-1" })).toThrow();
		expect(() => updateSystemComponent(serverless, "scheduled_job", { designId: "design-1" })).toThrow();
	});
});

describe("compute Components in Walkthrough playback", () => {
	test("each compute kind reacts on the shared timeline, and reduced motion holds the same steps at full intensity", () => {
		const design = computeDesign();
		const routes = routesFor(design);
		for (const kind of COMPUTE_KINDS) {
			let walkthroughs = addWalkthrough([], { id: "run" });
			walkthroughs = addWalkthroughStep(walkthroughs, "run", { id: "s1", connectionId: `to-${kind}` }, design);
			walkthroughs = updateWalkthroughStep(walkthroughs, "run", "s1", { durationMs: 1000, action: "succeed" });
			const timeline = playableTimeline(design, walkthroughs[0]!);
			const arrival = timeline.steps[0]!.arrivalMs;

			const motion = deriveWalkthroughFrame(timeline, routes, arrival + 1);
			expect(motion.reactions[kind]).toMatchObject({ role: "destination", phase: "arrive" });
			expect(motion.reactions[kind]!.intensity).toBeLessThan(1);

			const still = deriveWalkthroughFrame(timeline, routes, arrival + 1, { reducedMotion: true });
			expect(still.reactions[kind]).toMatchObject({ role: "destination", phase: "arrive", intensity: 1 });

			const outcome = deriveWalkthroughFrame(timeline, routes, 900, { reducedMotion: true });
			expect(reactionText(kind, outcome.reactions[kind]!.action, undefined, "destination")).toBe(reactionLabel(kind, "succeed"));
		}
	});

	test("a Worker's retry operation names its destination reaction, and the sender keeps its own wording", () => {
		const design = computeDesign();
		let walkthroughs = addWalkthrough([], { id: "retry" });
		walkthroughs = addWalkthroughStep(walkthroughs, "retry", { id: "s1", connectionId: "to-worker" }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "retry", "s1", { durationMs: 1000, action: "fail", operation: "retry" });
		const timeline = playableTimeline(design, walkthroughs[0]!);
		const frame = deriveWalkthroughFrame(timeline, routesFor(design), 900, { reducedMotion: true });

		expect(reactionText("worker", frame.reactions.worker!.action, frame.reactions.worker!.operation, "destination")).toBe("Retry");
		expect(reactionText("person", "send", "retry", "sender")).toBe(reactionLabel("person", "send"));
	});
});
