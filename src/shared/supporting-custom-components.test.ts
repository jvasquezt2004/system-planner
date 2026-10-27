import { describe, expect, test } from "bun:test";
import { computeConnectionPath, type ProofRect } from "./architecture-proof";
import {
	CATALOG_KINDS,
	COMPONENT_CATALOG,
	CUSTOM_ICONS,
	CUSTOM_KINDS,
	SUPPORTING_KINDS,
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
	systemDesignContent,
	updateSystemComponent,
	type SystemDesign,
} from "./system-design";
import { addWalkthrough, addWalkthroughStep, updateWalkthroughStep, WALKTHROUGH_ACTIONS, type Walkthrough } from "./walkthrough";
import { compileWalkthroughPlayback, deriveWalkthroughFrame, type PlaybackRoute, type PlaybackTimeline } from "./walkthrough-playback";

const SUPPORTING_AND_CUSTOM: readonly CatalogKind[] = [...SUPPORTING_KINDS, ...CUSTOM_KINDS];

const DEFAULT_NAMES: Record<CatalogKind, string> = {
	identity_provider: "Identity provider",
	secrets_store: "Secrets store",
	configuration: "Configuration",
	observability: "Observability",
	custom: "Custom",
} as Record<CatalogKind, string>;

/** A Person calling each supporting or Custom Component, so every kind has an inbound Connection. */
function supportingDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemComponent(design, { id: "client", kind: "person", name: "Client", position: { x: 0, y: 0 } });
	for (const [index, kind] of SUPPORTING_AND_CUSTOM.entries()) {
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
		routes.set(connection.id, { segments: [route] });
	}
	return routes;
}

function playableTimeline(design: SystemDesign, walkthrough: Walkthrough): PlaybackTimeline {
	const result = compileWalkthroughPlayback(walkthrough, design);
	if (!result.ok) throw new Error(`Expected a playable Walkthrough: ${result.problems.join("; ")}`);
	return result.timeline;
}

describe("supporting and Custom catalog kinds", () => {
	test("registers the four supporting kinds in their own family and the Custom kind last, each with its label, default name, artwork, and reaction preset", () => {
		expect([...SUPPORTING_KINDS]).toEqual(["identity_provider", "secrets_store", "configuration", "observability"]);
		expect([...CUSTOM_KINDS]).toEqual(["custom"]);
		expect(CATALOG_KINDS.slice(-5)).toEqual(["identity_provider", "secrets_store", "configuration", "observability", "custom"]);
		expect(COMPONENT_CATALOG.filter((entry) => entry.family === "supporting").map((entry) => entry.kind)).toEqual([...SUPPORTING_KINDS]);
		expect(COMPONENT_CATALOG.filter((entry) => entry.family === "custom").map((entry) => entry.kind)).toEqual([...CUSTOM_KINDS]);
		for (const kind of SUPPORTING_AND_CUSTOM) {
			const entry = COMPONENT_CATALOG.find((candidate) => candidate.kind === kind)!;
			expect(entry.label).toBe(componentKindLabel(kind));
			expect(entry.defaultName).toBe(DEFAULT_NAMES[kind]);
			expect(componentDefaultNameStem(kind)).toBe(DEFAULT_NAMES[kind]);
			expect(entry.artwork).toBe(kind);
			expect(KIND_REACTION_PRESETS[kind]).toBe(entry.reactions);
			expect(reactionPresetFor(kind).kind).toBe(kind);
		}
	});

	test("every catalog kind is a selectable Component kind, and the generic Component remains the only other kind", () => {
		expect([...SYSTEM_COMPONENT_KINDS]).toEqual(["generic", ...CATALOG_KINDS]);
		expect(new Set(CATALOG_KINDS).size).toBe(28);
	});

	test("each supporting kind suggests its optional annotations, named as the catalog describes them", () => {
		expect(descriptorKeysFor("identity_provider")).toEqual(["Authentication method", "Issuer"]);
		expect(descriptorKeysFor("secrets_store")).toEqual(["Secret references", "Consuming roles"]);
		expect(descriptorKeysFor("configuration")).toEqual(["Configuration scope", "Consumers"]);
		expect(descriptorKeysFor("observability")).toEqual(["Signals", "Alert purpose"]);
		expect(descriptorKeysFor("custom")).toEqual(["Purpose"]);
	});

	test("operation presets cover authenticate/issue token/deny, retrieve/deny, fetch/deliver update, and record/alert", () => {
		expect(operationPresetFor("identity_provider", "authenticate")?.label).toBe("Authenticate");
		expect(operationPresetFor("identity_provider", "Issue-token")?.label).toBe("Issue token");
		expect(operationPresetFor("identity_provider", "deny")?.label).toBe("Deny");
		expect(operationPresetFor("secrets_store", "retrieve")?.label).toBe("Retrieve");
		expect(operationPresetFor("secrets_store", "Deny")?.label).toBe("Deny");
		expect(operationPresetFor("configuration", "fetch")?.label).toBe("Fetch");
		expect(operationPresetFor("configuration", "deliver update")?.id).toBe("deliver-update");
		expect(operationPresetFor("observability", "record")?.label).toBe("Record");
		expect(operationPresetFor("observability", "alert")?.label).toBe("Alert");
	});

	test("an operation names only its own kind's presets, and the Custom kind has none", () => {
		expect(operationPresetFor("identity_provider", "retrieve")).toBeUndefined();
		expect(operationPresetFor("secrets_store", "authenticate")).toBeUndefined();
		expect(operationPresetFor("observability", "fetch")).toBeUndefined();
		expect(operationPresetFor("custom", "deny")).toBeUndefined();
	});

	test("every kind has wording for all five shared actions, and an authentication deny or secret retrieval names its destination reaction", () => {
		for (const kind of SUPPORTING_AND_CUSTOM) {
			for (const action of WALKTHROUGH_ACTIONS) {
				expect(reactionLabel(kind, action).length).toBeGreaterThan(0);
			}
		}
		expect(reactionText("identity_provider", "fail", "deny", "destination")).toBe("Deny");
		expect(reactionText("identity_provider", "receive", "authenticate", "destination")).toBe("Authenticate");
		expect(reactionText("secrets_store", "succeed", "retrieve", "destination")).toBe("Retrieve");
		expect(reactionText("configuration", "receive", "deliver-update", "destination")).toBe("Deliver update");
		expect(reactionText("observability", "receive", "alert", "destination")).toBe("Alert");
		expect(reactionText("identity_provider", "send", "deny", "sender")).toBe(reactionLabel("identity_provider", "send"));
		expect(reactionLabel("secrets_store", "fail")).toBe("Denied");
		expect(reactionLabel("custom", "succeed")).toBe("Succeeded");
		expect(reactionText("custom", "send", "deny", "destination")).toBe(reactionLabel("custom", "send"));
	});
});

describe("supporting and Custom Components in the System design", () => {
	test("each kind is created with its default name, edited with its descriptors, and connected", () => {
		let design = supportingDesign();
		for (const kind of SUPPORTING_AND_CUSTOM) {
			expect(design.components.find((component) => component.id === kind)?.name).toBe(DEFAULT_NAMES[kind]);
		}
		for (const kind of SUPPORTING_AND_CUSTOM) {
			const properties = descriptorKeysFor(kind).map((key) => ({ key, value: `${key} for ${kind}` }));
			design = updateSystemComponent(design, kind, { technology: "Descriptive", properties });
		}
		expect(design.components.find((component) => component.id === "identity_provider")).toMatchObject({
			kind: "identity_provider",
			technology: "Descriptive",
			properties: [
				{ key: "Authentication method", value: "Authentication method for identity_provider" },
				{ key: "Issuer", value: "Issuer for identity_provider" },
			],
		});
		expect(design.connections.filter((connection) => connection.sourceId === "client")).toHaveLength(SUPPORTING_AND_CUSTOM.length);
	});

	test("optional annotations stay optional: a supporting kind is valid with no technology, description, or properties", () => {
		const design = addSystemComponent(createEmptySystemDesign(), { id: "vault", kind: "secrets_store", position: { x: 0, y: 0 } });
		expect(design.components[0]).toEqual({
			id: "vault",
			kind: "secrets_store",
			name: "Secrets store",
			properties: [],
			position: { x: 0, y: 0 },
			serviceId: null,
		});
	});

	test("save and reopen keep every supporting and Custom kind, its properties, its icon, and its connections", () => {
		let design = supportingDesign();
		for (const kind of SUPPORTING_AND_CUSTOM) {
			design = updateSystemComponent(design, kind, {
				properties: descriptorKeysFor(kind).map((key) => ({ key, value: `${key} text` })),
			});
		}
		design = updateSystemComponent(design, "custom", { icon: "hexagon" });
		const reopened = normalizeSystemDesign(JSON.parse(JSON.stringify(design)));
		expect(reopened.components.map((component) => component.kind)).toEqual(["person", ...SUPPORTING_AND_CUSTOM]);
		expect(reopened.components).toEqual(design.components);
		expect(reopened.connections).toEqual(design.connections);
		expect(reopened.components.find((component) => component.id === "custom")?.icon).toBe("hexagon");
	});

	test("the shared content that Undo restores carries each Custom Component's chosen icon", () => {
		let design = supportingDesign();
		design = updateSystemComponent(design, "custom", { icon: "cloud" });
		const content = systemDesignContent(design);
		expect(content.components.find((component) => component.id === "custom")?.icon).toBe("cloud");
	});

	test("a Custom Component chooses one supported icon or shape, and the rectangle is the default", () => {
		let design = supportingDesign();
		expect(design.components.find((component) => component.id === "custom")?.icon).toBeUndefined();
		expect([...CUSTOM_ICONS]).toEqual(["rectangle", "hexagon", "diamond", "cylinder", "cloud", "document", "gear"]);
		for (const icon of CUSTOM_ICONS) {
			design = updateSystemComponent(design, "custom", { icon });
			expect(design.components.find((component) => component.id === "custom")?.icon).toBe(icon);
		}
		expect(() => updateSystemComponent(design, "custom", { icon: "star" as never })).toThrow();
	});

	test("only a Custom Component may choose an icon or shape, so a supporting kind refuses one", () => {
		const design = supportingDesign();
		expect(() => updateSystemComponent(design, "observability", { icon: "gear" })).toThrow();
		expect(() => addSystemComponent(design, { id: "gear", kind: "worker", icon: "gear", position: { x: 0, y: 0 } })).toThrow();
		expect(() => addSystemComponent(design, { id: "gear", kind: "custom", icon: "gear", position: { x: 0, y: 0 } })).not.toThrow();
	});

	test("changing a Custom Component to another kind drops its icon, and changing back starts with the rectangle", () => {
		let design = supportingDesign();
		design = updateSystemComponent(design, "custom", { icon: "diamond" });
		design = updateSystemComponent(design, "custom", { kind: "configuration" });
		expect(design.components.find((component) => component.id === "custom")).toMatchObject({ kind: "configuration" });
		expect(design.components.find((component) => component.id === "custom")).not.toHaveProperty("icon");
		design = updateSystemComponent(design, "custom", { kind: "custom" });
		expect(design.components.find((component) => component.id === "custom")?.icon).toBeUndefined();
	});

	test("a saved Custom Component with an unsupported icon is refused on reopen", () => {
		const saved = JSON.parse(JSON.stringify(supportingDesign()));
		saved.components.find((component: { id: string }) => component.id === "custom").icon = "star";
		expect(() => normalizeSystemDesign(saved)).toThrow();
	});

	test("a Custom Component's own descriptive properties are free-form, and the Purpose annotation is suggested", () => {
		let design = supportingDesign();
		design = updateSystemComponent(design, "custom", {
			properties: [
				{ key: "Purpose", value: "Loyalty points calculator" },
				{ key: "Owner team", value: "Growth" },
			],
		});
		expect(design.components.find((component) => component.id === "custom")?.properties).toEqual([
			{ key: "Purpose", value: "Loyalty points calculator" },
			{ key: "Owner team", value: "Growth" },
		]);
	});
});

describe("supporting and Custom Components in Walkthrough playback", () => {
	test("each kind reacts on the shared timeline, and reduced motion holds the same steps at full intensity", () => {
		const design = supportingDesign();
		const routes = routesFor(design);
		for (const kind of SUPPORTING_AND_CUSTOM) {
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

	test("an authentication deny and a secret retrieval name their destination reactions, and the sender keeps its own wording", () => {
		const design = supportingDesign();
		let walkthroughs = addWalkthrough([], { id: "auth" });
		walkthroughs = addWalkthroughStep(walkthroughs, "auth", { id: "s1", connectionId: "to-identity_provider" }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "auth", "s1", { durationMs: 1000, action: "fail", operation: "deny" });
		walkthroughs = addWalkthroughStep(walkthroughs, "auth", { id: "s2", connectionId: "to-secrets_store" }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "auth", "s2", { durationMs: 1000, action: "succeed", operation: "retrieve" });
		const timeline = playableTimeline(design, walkthroughs[0]!);
		const routes = routesFor(design);

		const denied = deriveWalkthroughFrame(timeline, routes, 900, { reducedMotion: true });
		expect(reactionText("identity_provider", denied.reactions.identity_provider!.action, denied.reactions.identity_provider!.operation, "destination")).toBe("Deny");

		const retrieved = deriveWalkthroughFrame(timeline, routes, 1900, { reducedMotion: true });
		expect(reactionText("secrets_store", retrieved.reactions.secrets_store!.action, retrieved.reactions.secrets_store!.operation, "destination")).toBe("Retrieve");
		expect(reactionText("secrets_store", "send", "retrieve", "sender")).toBe(reactionLabel("secrets_store", "send"));
	});

	test("a Custom Component uses the shared send, receive, process, succeed, and fail presets", () => {
		const design = supportingDesign();
		const routes = routesFor(design);
		let walkthroughs = addWalkthrough([], { id: "custom" });
		walkthroughs = addWalkthroughStep(walkthroughs, "custom", { id: "s1", connectionId: "to-custom" }, design);
		walkthroughs = updateWalkthroughStep(walkthroughs, "custom", "s1", { durationMs: 1000, action: "fail" });
		const timeline = playableTimeline(design, walkthroughs[0]!);
		const failed = deriveWalkthroughFrame(timeline, routes, 900, { reducedMotion: true });
		expect(reactionLabel("custom", failed.reactions.custom!.action)).toBe("Failed");
		expect(failed.reactions.custom).toMatchObject({ role: "destination", phase: "outcome", intensity: 1 });
	});
});
