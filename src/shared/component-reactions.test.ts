import { describe, expect, test } from "bun:test";
import {
	GENERIC_REACTION_PRESET,
	KIND_REACTION_PRESETS,
	reactionLabel,
	reactionPresetFor,
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
