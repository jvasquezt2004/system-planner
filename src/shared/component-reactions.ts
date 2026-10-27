import { COMPONENT_CATALOG, operationPresetFor } from "./component-catalog";
import type { WalkthroughAction } from "./walkthrough";

/**
 * Registry contract for how a Component reacts during Walkthrough playback.
 * Every kind shares the five actions; a preset only chooses the words shown for
 * each action on that kind, so artwork and labels can vary without changing the
 * authored timeline. Kinds with no preset use the generic reactions.
 *
 * Catalog kinds register their preset in `component-catalog.ts`; this module
 * collects them into `KIND_REACTION_PRESETS`. Playback reads presets only through
 * `reactionPresetFor`, and an operation preset may replace the wording of the
 * destination's reaction (for example "Cache hit" on a CDN).
 */
export type ComponentReactionPreset = {
	/** The kind this preset applies to, such as "generic", "database", or a catalog kind. */
	kind: string;
	/** Visible wording for each shared action on this kind. */
	labels: Record<WalkthroughAction, string>;
};

export const GENERIC_REACTION_PRESET: ComponentReactionPreset = {
	kind: "generic",
	labels: {
		send: "Sends",
		receive: "Receives",
		process: "Processing",
		succeed: "Succeeded",
		fail: "Failed",
	},
};

/** Kind-specific presets, collected from the catalog registry. */
export const KIND_REACTION_PRESETS: Readonly<Record<string, ComponentReactionPreset | undefined>> = Object.fromEntries(
	COMPONENT_CATALOG.map((entry) => [entry.kind, entry.reactions]),
);

/** The preset for a kind, falling back to the generic reactions. */
export function reactionPresetFor(kind: string): ComponentReactionPreset {
	return KIND_REACTION_PRESETS[kind] ?? GENERIC_REACTION_PRESET;
}

/** The visible label for one action on one kind. */
export function reactionLabel(kind: string, action: WalkthroughAction): string {
	return reactionPresetFor(kind).labels[action];
}

/**
 * The visible text for a reaction. A destination reaction shows the step's
 * operation when it names one of the kind's operation presets; otherwise the
 * action's wording applies.
 */
export function reactionText(kind: string, action: WalkthroughAction, operation?: string, role: "sender" | "destination" = "destination"): string {
	if (role === "destination") {
		const preset = operationPresetFor(kind, operation);
		if (preset) return preset.label;
	}
	return reactionLabel(kind, action);
}
