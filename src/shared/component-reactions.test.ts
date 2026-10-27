import { describe, expect, test } from "bun:test";
import {
	GENERIC_REACTION_PRESET,
	KIND_REACTION_PRESETS,
	reactionLabel,
	reactionPresetFor,
	reactionText,
} from "./component-reactions";
import { WALKTHROUGH_ACTIONS } from "./walkthrough";

describe("component reaction registry", () => {
	test("every shared action has a visible label on the generic preset", () => {
		for (const action of WALKTHROUGH_ACTIONS) {
			expect(GENERIC_REACTION_PRESET.labels[action].length).toBeGreaterThan(0);
		}
	});

	test("a kind without its own preset reacts with the generic wording", () => {
		expect(KIND_REACTION_PRESETS.queue).toBeUndefined();
		expect(reactionPresetFor("queue")).toBe(GENERIC_REACTION_PRESET);
		expect(reactionLabel("queue", "fail")).toBe(GENERIC_REACTION_PRESET.labels.fail);
	});
});

describe("client and traffic reaction presets", () => {
	test("each catalog kind has its own wording for the five shared actions", () => {
		for (const kind of ["person", "browser", "mobile_app", "external_system", "dns", "cdn", "load_balancer", "api_gateway", "proxy"]) {
			expect(reactionPresetFor(kind).kind).toBe(kind);
			expect(reactionPresetFor(kind)).not.toBe(GENERIC_REACTION_PRESET);
		}
	});

	test("a destination's operation names the reaction when it matches the kind's preset", () => {
		expect(reactionText("cdn", "receive", "cache hit", "destination")).toBe("Cache hit");
		expect(reactionText("cdn", "process", "Cache-Miss", "destination")).toBe("Cache miss");
		expect(reactionText("api_gateway", "fail", "rate_limited", "destination")).toBe("Rate limited");
	});

	test("a sender, an unmatched operation, or a kind without operations keeps the action wording", () => {
		expect(reactionText("cdn", "send", "cache hit", "sender")).toBe(reactionLabel("cdn", "send"));
		expect(reactionText("cdn", "receive", "enqueue", "destination")).toBe(reactionLabel("cdn", "receive"));
		expect(reactionText("browser", "receive", "cache hit", "destination")).toBe(reactionLabel("browser", "receive"));
		expect(reactionText("queue", "fail", undefined)).toBe(GENERIC_REACTION_PRESET.labels.fail);
	});
});
