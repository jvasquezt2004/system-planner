import { describe, expect, test } from "bun:test";
import {
	CATALOG_KINDS,
	CLIENT_TRAFFIC_KINDS,
	COMPONENT_CATALOG,
	catalogEntryFor,
	componentKindLabel,
	descriptorKeysFor,
	descriptorValue,
	mergeFreeProperties,
	normalizeOperationKey,
	operationPresetFor,
	withDescriptorValue,
} from "./component-catalog";
import { KIND_REACTION_PRESETS } from "./component-reactions";
import { WALKTHROUGH_ACTIONS } from "./walkthrough";

describe("client and traffic catalog registry", () => {
	test("registers the nine agreed client and traffic kinds, then the five compute kinds, each once, with its own artwork and reaction preset", () => {
		expect([...CLIENT_TRAFFIC_KINDS]).toEqual([
			"person",
			"browser",
			"mobile_app",
			"external_system",
			"dns",
			"cdn",
			"load_balancer",
			"api_gateway",
			"proxy",
		]);
		expect(COMPONENT_CATALOG.map((entry) => entry.kind)).toEqual([...CATALOG_KINDS]);
		expect(new Set(CATALOG_KINDS).size).toBe(CATALOG_KINDS.length);
		for (const entry of COMPONENT_CATALOG) {
			expect(entry.artwork).toBe(entry.kind);
			expect(entry.label.length).toBeGreaterThan(0);
			expect(entry.reactions.kind).toBe(entry.kind);
			expect(KIND_REACTION_PRESETS[entry.kind]).toBe(entry.reactions);
			for (const action of WALKTHROUGH_ACTIONS) expect(entry.reactions.labels[action].length).toBeGreaterThan(0);
		}
	});

	test("labels match the agreed catalog names, and the original kinds keep their labels", () => {
		expect(COMPONENT_CATALOG.map((entry) => entry.label)).toEqual([
			"Person",
			"Browser",
			"Mobile app",
			"External system",
			"DNS",
			"CDN",
			"Load balancer",
			"API gateway",
			"Proxy",
			"Application",
			"API",
			"Worker",
			"Scheduled job",
			"Serverless handler",
		]);
		expect(componentKindLabel("database")).toBe("Database");
		expect(componentKindLabel("generic")).toBe("Component");
		expect(componentKindLabel("cdn")).toBe("CDN");
		expect(componentKindLabel("not-a-kind")).toBe("Component");
	});

	test("optional descriptors follow the agreed annotations and never require a vendor", () => {
		expect(descriptorKeysFor("dns")).toEqual(["Zone", "Record description"]);
		expect(descriptorKeysFor("api_gateway")).toEqual(["Routes", "Protocols", "Authentication"]);
		expect(descriptorKeysFor("person")).toEqual(["Role", "Intention"]);
		expect(descriptorKeysFor("generic")).toEqual([]);
		for (const entry of COMPONENT_CATALOG) {
			expect(entry.descriptors.length).toBeGreaterThan(0);
			for (const descriptor of entry.descriptors) expect(descriptor.placeholder).not.toMatch(/required/i);
		}
	});

	test("default names come from the catalog entry", () => {
		expect(catalogEntryFor("load_balancer")?.defaultName).toBe("Load balancer");
		expect(catalogEntryFor("generic")).toBeUndefined();
	});
});

describe("descriptor values", () => {
	test("reads a descriptor value, or an empty string when unset", () => {
		const properties = [{ key: "Zone", value: "example.com" }];
		expect(descriptorValue(properties, "Zone")).toBe("example.com");
		expect(descriptorValue(properties, "Cache policy")).toBe("");
	});

	test("setting a value replaces it in place, appends a new one, and a blank value removes it", () => {
		const start = [{ key: "Zone", value: "a" }, { key: "Role", value: "b" }];
		expect(withDescriptorValue(start, "Zone", "example.com")).toEqual([{ key: "Zone", value: "example.com" }, { key: "Role", value: "b" }]);
		expect(withDescriptorValue(start, "Targets", "pool")).toEqual([...start, { key: "Targets", value: "pool" }]);
		expect(withDescriptorValue(start, "Zone", "   ")).toEqual([{ key: "Role", value: "b" }]);
	});

	test("a Component's free-form rows never drop its descriptor values, and a free row wins over a descriptor with the same key", () => {
		const current = [
			{ key: "Zone", value: "example.com" },
			{ key: "Team", value: "payments" },
		];
		expect(mergeFreeProperties(current, "dns", [{ key: "Team", value: "identity" }])).toEqual([
			{ key: "Zone", value: "example.com" },
			{ key: "Team", value: "identity" },
		]);
		expect(mergeFreeProperties(current, "generic", [])).toEqual([]);
		expect(mergeFreeProperties(current, "dns", [{ key: "Zone", value: "other.test" }])).toEqual([{ key: "Zone", value: "other.test" }]);
	});
});

describe("operation presets", () => {
	test("normalizes case, spaces, underscores, and dashes so authored text finds the preset", () => {
		expect(normalizeOperationKey(" Cache_Hit ")).toBe("cache-hit");
		expect(operationPresetFor("cdn", "cache hit")?.id).toBe("cache-hit");
		expect(operationPresetFor("cdn", "CACHE-HIT")?.id).toBe("cache-hit");
		expect(operationPresetFor("cdn", "Cache miss")?.id).toBe("cache-miss");
		expect(operationPresetFor("api_gateway", "rate limited")?.id).toBe("rate-limited");
	});

	test("an operation names only the presets of its own kind, and free text without a preset matches nothing", () => {
		expect(operationPresetFor("dns", "cache hit")).toBeUndefined();
		expect(operationPresetFor("cdn", "enqueue")).toBeUndefined();
		expect(operationPresetFor("cdn", undefined)).toBeUndefined();
		expect(operationPresetFor("cdn", "   ")).toBeUndefined();
	});

	test("rejection and rate limiting exist on the API gateway, and the proxy and load balancer forward", () => {
		expect(operationPresetFor("api_gateway", "Rejected")?.label).toBe("Rejected");
		expect(operationPresetFor("proxy", "forward")?.label).toBe("Forward");
		expect(operationPresetFor("load_balancer", "forward")?.label).toBe("Forward");
	});
});
