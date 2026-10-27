import { describe, expect, test } from "bun:test";
import { computeConnectionPath, type ProofRect } from "./architecture-proof";
import {
	CATALOG_KINDS,
	COMPONENT_CATALOG,
	DATA_KINDS,
	MESSAGING_KINDS,
	componentDefaultNameStem,
	componentKindLabel,
	descriptorKeysFor,
	operationPresetFor,
	type CatalogKind,
} from "./component-catalog";
import { KIND_REACTION_PRESETS, reactionLabel, reactionPresetFor, reactionText } from "./component-reactions";
import {
	SYSTEM_COMPONENT_KINDS,
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	normalizeSystemDesign,
	updateSystemComponent,
	type SystemDesign,
} from "./system-design";
import { addWalkthrough, addWalkthroughStep, updateWalkthroughStep, WALKTHROUGH_ACTIONS, type Walkthrough } from "./walkthrough";
import { compileWalkthroughPlayback, deriveWalkthroughFrame, type PlaybackRoute, type PlaybackTimeline } from "./walkthrough-playback";

const DATA_AND_MESSAGING: readonly CatalogKind[] = [...DATA_KINDS, ...MESSAGING_KINDS];

const DEFAULT_NAMES: Record<CatalogKind, string> = {
	database: "Database",
	cache: "Cache",
	object_storage_bucket: "Object-storage bucket",
	file_storage: "File storage",
	search_index: "Search index",
	queue: "Queue",
	topic: "Topic",
	event_bus: "Event bus",
	event_stream: "Event stream",
} as Record<CatalogKind, string>;

/** A Person calling each data or messaging Component, so every kind has an inbound Connection. */
function dataDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", kind: "person", name: "Client", position: { x: 0, y: 0 } });
	for (const [index, kind] of DATA_AND_MESSAGING.entries()) {
		design = addSystemComponent(design, { id: kind, kind, position: { x: 320, y: index * 120 } });
		design = addSystemConnection(design, { id: `to-${kind}`, sourceId: "client", targetId: kind, label: "Uses" });
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
		routes.set(connection.id, { start: route.start, cp1: route.cp1, cp2: route.cp2, end: route.end });
	}
	return routes;
}

function playableTimeline(design: SystemDesign, walkthrough: Walkthrough): PlaybackTimeline {
	const result = compileWalkthroughPlayback(walkthrough, design);
	if (!result.ok) throw new Error(`Expected a playable Walkthrough: ${result.problems.join("; ")}`);
	return result.timeline;
}

describe("data and messaging catalog kinds", () => {
	test("registers the nine agreed kinds in two families, each with its own label, default name, artwork, and reaction preset", () => {
		expect([...DATA_KINDS]).toEqual(["database", "cache", "object_storage_bucket", "file_storage", "search_index"]);
		expect([...MESSAGING_KINDS]).toEqual(["queue", "topic", "event_bus", "event_stream"]);
		expect(COMPONENT_CATALOG.filter((entry) => entry.family === "data").map((entry) => entry.kind)).toEqual([...DATA_KINDS]);
		expect(COMPONENT_CATALOG.filter((entry) => entry.family === "messaging").map((entry) => entry.kind)).toEqual([...MESSAGING_KINDS]);
		for (const kind of DATA_AND_MESSAGING) {
			const entry = COMPONENT_CATALOG.find((candidate) => candidate.kind === kind)!;
			expect(entry.label).toBe(componentKindLabel(kind));
			expect(entry.defaultName).toBe(DEFAULT_NAMES[kind]);
			expect(componentDefaultNameStem(kind)).toBe(DEFAULT_NAMES[kind]);
			expect(entry.artwork).toBe(kind);
			expect(KIND_REACTION_PRESETS[kind]).toBe(entry.reactions);
			expect(reactionPresetFor(kind).kind).toBe(kind);
		}
	});

	test("the Database kind keeps its place among the catalog kinds and remains a selectable Component kind", () => {
		expect(CATALOG_KINDS).toContain("database");
		expect(new Set(SYSTEM_COMPONENT_KINDS).size).toBe(SYSTEM_COMPONENT_KINDS.length);
		expect(SYSTEM_COMPONENT_KINDS.filter((kind) => kind === "database")).toHaveLength(1);
	});

	test("each kind suggests only optional descriptive annotations, named as the catalog describes them", () => {
		expect(descriptorKeysFor("database")).toEqual(["Engine", "Database kind"]);
		expect(descriptorKeysFor("cache")).toEqual(["Engine", "Key description", "Expiry policy"]);
		expect(descriptorKeysFor("object_storage_bucket")).toEqual(["Object purpose", "Prefix", "Lifecycle description"]);
		expect(descriptorKeysFor("file_storage")).toEqual(["Volume", "Mount", "Protocol"]);
		expect(descriptorKeysFor("search_index")).toEqual(["Indexed subject", "Indexing approach"]);
		expect(descriptorKeysFor("queue")).toEqual(["Message type", "Delivery and retry"]);
		expect(descriptorKeysFor("topic")).toEqual(["Event type", "Subscriber description"]);
		expect(descriptorKeysFor("event_bus")).toEqual(["Event types", "Routing description"]);
		expect(descriptorKeysFor("event_stream")).toEqual(["Event type", "Partition and retention"]);
	});

	test("operation presets cover read/write, hit/miss, upload/download/delete, enqueue/release/acknowledge, publish/deliver, and append/consume", () => {
		expect(operationPresetFor("database", "read")?.label).toBe("Read");
		expect(operationPresetFor("file_storage", "Write")?.id).toBe("write");
		expect(operationPresetFor("cache", "Hit")?.id).toBe("hit");
		expect(operationPresetFor("cache", "miss")?.label).toBe("Miss");
		expect(operationPresetFor("object_storage_bucket", "upload")?.label).toBe("Upload");
		expect(operationPresetFor("object_storage_bucket", "download")?.label).toBe("Download");
		expect(operationPresetFor("object_storage_bucket", "delete")?.label).toBe("Delete");
		expect(operationPresetFor("queue", "enqueue")?.label).toBe("Enqueue");
		expect(operationPresetFor("queue", "release")?.label).toBe("Release");
		expect(operationPresetFor("queue", "acknowledge")?.label).toBe("Acknowledge");
		expect(operationPresetFor("topic", "publish")?.label).toBe("Publish");
		expect(operationPresetFor("topic", "deliver")?.label).toBe("Deliver");
		expect(operationPresetFor("event_stream", "append")?.label).toBe("Append");
		expect(operationPresetFor("event_stream", "consume")?.label).toBe("Consume");
	});

	test("an operation names only its own kind's presets, so a bucket's upload is not a queue's", () => {
		expect(operationPresetFor("queue", "upload")).toBeUndefined();
		expect(operationPresetFor("object_storage_bucket", "enqueue")).toBeUndefined();
		expect(operationPresetFor("topic", "append")).toBeUndefined();
	});

	test("every kind has wording for all five shared actions, and reception words differ from the generic wording", () => {
		for (const kind of DATA_AND_MESSAGING) {
			for (const action of WALKTHROUGH_ACTIONS) {
				expect(reactionLabel(kind, action).length).toBeGreaterThan(0);
			}
		}
		expect(reactionLabel("object_storage_bucket", "receive")).toBe("Receives");
		expect(reactionLabel("queue", "receive")).toBe("Received");
		expect(reactionText("queue", "succeed", "acknowledge", "destination")).toBe("Acknowledge");
		expect(reactionText("object_storage_bucket", "receive", "upload", "destination")).toBe("Upload");
		expect(reactionText("queue", "send", "enqueue", "sender")).toBe(reactionLabel("queue", "send"));
	});
});

describe("data and messaging Components in the System design", () => {
	test("each kind is created with its default name, edited with its descriptors, and connected", () => {
		let design = dataDesign();
		for (const kind of DATA_AND_MESSAGING) {
			expect(design.components.find((component) => component.id === kind)?.name).toBe(DEFAULT_NAMES[kind]);
		}
		for (const kind of DATA_AND_MESSAGING) {
			const properties = descriptorKeysFor(kind).map((key) => ({ key, value: `${key} for ${kind}` }));
			design = updateSystemComponent(design, kind, { technology: "Descriptive", properties });
		}
		expect(design.components.find((component) => component.id === "queue")).toMatchObject({
			kind: "queue",
			technology: "Descriptive",
			properties: [
				{ key: "Message type", value: "Message type for queue" },
				{ key: "Delivery and retry", value: "Delivery and retry for queue" },
			],
		});
		expect(design.connections.filter((connection) => connection.sourceId === "client")).toHaveLength(DATA_AND_MESSAGING.length);
	});

	test("save and reopen keep every kind, its properties, and its connections", () => {
		let design = dataDesign();
		for (const kind of DATA_AND_MESSAGING) {
			design = updateSystemComponent(design, kind, {
				properties: descriptorKeysFor(kind).map((key) => ({ key, value: `${key} text` })),
			});
		}
		const reopened = normalizeSystemDesign(JSON.parse(JSON.stringify(design)));
		expect(reopened.components.map((component) => component.kind)).toEqual(["person", ...DATA_AND_MESSAGING]);
		expect(reopened.components).toEqual(design.components);
		expect(reopened.connections).toEqual(design.connections);
	});

	test("the Database kind still links a database Design, and only a Database may link one", () => {
		let design = dataDesign();
		design = updateSystemComponent(design, "database", { designId: "design-orders" });
		expect(design.components.find((component) => component.id === "database")?.designId).toBe("design-orders");
		expect(() => updateSystemComponent(design, "cache", { designId: "design-orders" })).toThrow();
		expect(() => updateSystemComponent(design, "database", { kind: "queue" })).toThrow();
	});

	test("descriptors stay descriptive: a bucket or stream never links a database Design or runs anything", () => {
		const design = dataDesign();
		for (const kind of ["object_storage_bucket", "event_stream", "queue"] as const) {
			expect(() => updateSystemComponent(design, kind, { designId: "design-1" })).toThrow();
		}
		expect(Object.keys(design).sort()).toEqual(Object.keys(createEmptySystemDesign()).sort());
	});
});

describe("data and messaging Components in Walkthrough playback", () => {
	test("each kind reacts on the shared timeline, and reduced motion holds the same steps at full intensity", () => {
		const design = dataDesign();
		const routes = routesFor(design);
		for (const kind of DATA_AND_MESSAGING) {
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

	test("a queue's acknowledge and a bucket's upload name their destination reaction, and the sender keeps its own wording", () => {
		const design = dataDesign();
		let walkthroughs = addWalkthrough([], { id: "ack" });
		walkthroughs = addWalkthroughStep(walkthroughs, "ack", { id: "s1", connectionId: "to-queue" }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "ack", "s1", { durationMs: 1000, action: "succeed", operation: "acknowledge" });
		walkthroughs = addWalkthroughStep(walkthroughs, "ack", { id: "s2", connectionId: "to-object_storage_bucket" }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "ack", "s2", { durationMs: 1000, action: "receive", operation: "upload" });
		const timeline = playableTimeline(design, walkthroughs[0]!);
		const routes = routesFor(design);

		const acked = deriveWalkthroughFrame(timeline, routes, 900, { reducedMotion: true });
		expect(reactionText("queue", acked.reactions.queue!.action, acked.reactions.queue!.operation, "destination")).toBe("Acknowledge");

		const uploaded = deriveWalkthroughFrame(timeline, routes, 1900, { reducedMotion: true });
		expect(reactionText("object_storage_bucket", uploaded.reactions.object_storage_bucket!.action, uploaded.reactions.object_storage_bucket!.operation, "destination")).toBe("Upload");
		expect(reactionText("object_storage_bucket", "send", "upload", "sender")).toBe(reactionLabel("object_storage_bucket", "send"));
	});
});
