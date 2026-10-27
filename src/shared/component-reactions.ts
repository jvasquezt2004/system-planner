import type { WalkthroughAction } from "./walkthrough";

/**
 * Registry contract for how a Component reacts during Walkthrough playback.
 * Every kind shares the five actions; a preset only chooses the words shown for
 * each action on that kind, so artwork and labels can vary without changing the
 * authored timeline. Kinds with no preset use the generic reactions.
 *
 * Kind-specific presets (#136–#139) register an entry in `KIND_REACTION_PRESETS`
 * keyed by the kind's identifier. Playback reads presets only through
 * `reactionPresetFor`.
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

/** Kind-specific presets. Empty until a kind earns its own artwork and wording. */
export const KIND_REACTION_PRESETS: Readonly<Record<string, ComponentReactionPreset | undefined>> = {};

/** The preset for a kind, falling back to the generic reactions. */
export function reactionPresetFor(kind: string): ComponentReactionPreset {
	return KIND_REACTION_PRESETS[kind] ?? GENERIC_REACTION_PRESET;
}

/** The visible label for one action on one kind. */
export function reactionLabel(kind: string, action: WalkthroughAction): string {
	return reactionPresetFor(kind).labels[action];
}
