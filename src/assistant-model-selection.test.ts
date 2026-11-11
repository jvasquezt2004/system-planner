import { describe, expect, test } from "bun:test";
import { pickUsableModel, type UsableModelCandidate } from "./assistant-model-selection";

describe("pickUsableModel", () => {
	const sampleModels: UsableModelCandidate[] = [
		{ id: "gpt-5.6-luna", connectionId: "conn-chatgpt" },
		{ id: "gpt-6-luna", connectionId: "conn-chatgpt" },
		{ id: "claude-sonnet-4-6", connectionId: "conn-anthropic", isDefault: true },
	];

	test("stale model: returns the model if usable, falls back if stale", () => {
		// When the model is in the loaded list for its connection, it is returned directly
		const usable = pickUsableModel(sampleModels, "conn-chatgpt", "gpt-6-luna");
		expect(usable).toEqual({ id: "gpt-6-luna", connectionId: "conn-chatgpt" });

		// When the model is NOT in the loaded list for that connection (stale), it falls back
		const staleFallback = pickUsableModel(sampleModels, "conn-chatgpt", "gpt-4");
		// Falls back to the default model when default is present
		expect(staleFallback).toEqual({ id: "claude-sonnet-4-6", connectionId: "conn-anthropic", isDefault: true });
	});

	test("default present: picks the isDefault model when current selection is stale or absent", () => {
		const modelsWithDefault: UsableModelCandidate[] = [
			{ id: "model-a", connectionId: "conn-1" },
			{ id: "model-b", connectionId: "conn-1", isDefault: true },
			{ id: "model-c", connectionId: "conn-2" },
		];

		// Stale model on conn-1
		const fromStale = pickUsableModel(modelsWithDefault, "conn-1", "non-existent");
		expect(fromStale).toEqual({ id: "model-b", connectionId: "conn-1", isDefault: true });

		// Initial default when selection is null
		const fromNull = pickUsableModel(modelsWithDefault, null, null);
		expect(fromNull).toEqual({ id: "model-b", connectionId: "conn-1", isDefault: true });
	});

	test("default missing: falls back to the first of that connection, else the first overall", () => {
		const modelsWithoutDefault: UsableModelCandidate[] = [
			{ id: "claude-haiku", connectionId: "conn-anthropic" },
			{ id: "gpt-5.6-luna", connectionId: "conn-chatgpt" },
			{ id: "gpt-6-luna", connectionId: "conn-chatgpt" },
		];

		// Stale model on conn-chatgpt: falls back to the first of conn-chatgpt
		const firstOfConn = pickUsableModel(modelsWithoutDefault, "conn-chatgpt", "gpt-4");
		expect(firstOfConn).toEqual({ id: "gpt-5.6-luna", connectionId: "conn-chatgpt" });

		// Stale model on a removed connection: falls back to the first overall
		const firstOverall = pickUsableModel(modelsWithoutDefault, "conn-removed", "gpt-4");
		expect(firstOverall).toEqual({ id: "claude-haiku", connectionId: "conn-anthropic" });

		// No connection specified and no default: falls back to the first overall
		const noConn = pickUsableModel(modelsWithoutDefault, null, "stale-model");
		expect(noConn).toEqual({ id: "claude-haiku", connectionId: "conn-anthropic" });
	});

	test("no models: returns null when the candidate list is empty", () => {
		expect(pickUsableModel([], "conn-1", "gpt-4")).toBeNull();
		expect(pickUsableModel([])).toBeNull();
	});
});
