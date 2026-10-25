import { describe, expect, test } from "bun:test";
import { createScenarioExpect, type ScenarioExpectationResult } from "./scenario-runtime";

describe("scenario-runtime expectation chaining", () => {
	test("expect().succeeds().returnsDataEqual() chains and records two expectation results", () => {
		const recorded: ScenarioExpectationResult[] = [];
		const record = (description: string, passed: boolean, message: string) => {
			recorded.push({ description, passed, message });
		};

		const expectScenario = createScenarioExpect(record);
		const result = {
			data: [{ id: 1, name: "Alice" }],
			error: null,
		};

		const expectation = expectScenario(result).succeeds().returnsDataEqual([{ id: 1, name: "Alice" }]);

		expect(expectation).toBeDefined();
		expect(recorded).toHaveLength(2);
		expect(recorded[0]).toEqual({
			description: "request succeeds",
			passed: true,
			message: "Request succeeded.",
		});
		expect(recorded[1]).toEqual({
			description: "request returns expected data",
			passed: true,
			message: "Returned data matched.",
		});
	});

	test("expect().fails().returnsDataEqual() chains and records two expectation results on failure", () => {
		const recorded: ScenarioExpectationResult[] = [];
		const record = (description: string, passed: boolean, message: string) => {
			recorded.push({ description, passed, message });
		};

		const expectScenario = createScenarioExpect(record);
		const result = {
			data: null,
			error: { code: "23505", message: "duplicate key value" },
		};

		expectScenario(result).fails("23505").returnsDataEqual(null);

		expect(recorded).toHaveLength(2);
		expect(recorded[0]).toEqual({
			description: "request fails with 23505",
			passed: true,
			message: "Request failed with 23505.",
		});
		expect(recorded[1]).toEqual({
			description: "request returns expected data",
			passed: true,
			message: "Returned data matched.",
		});
	});

	test("invalid un-awaited promise input does not throw on chained calls and records failed expectations", () => {
		const recorded: ScenarioExpectationResult[] = [];
		const record = (description: string, passed: boolean, message: string) => {
			recorded.push({ description, passed, message });
		};

		const expectScenario = createScenarioExpect(record);
		const pendingPromise = Promise.resolve({ data: [] });

		expectScenario(pendingPromise).succeeds().returnsDataEqual([]);

		expect(recorded).toHaveLength(2);
		expect(recorded[0].passed).toBe(false);
		expect(recorded[0].message).toContain("expect() received a pending request; await it first");
		expect(recorded[1].passed).toBe(false);
		expect(recorded[1].message).toContain("expect() received a pending request; await it first");
	});
});
