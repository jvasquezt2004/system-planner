import { describe, expect, test } from "bun:test";
import type { Scenario, ScenarioRun } from "../shared/design";
import { runAllScenarios } from "../shared/run-all";

const scenarios: Scenario[] = [
	{ id: "one", name: "One", source: "" },
	{ id: "two", name: "Two", source: "" },
	{ id: "three", name: "Three", source: "" },
];

function run(id: string, status: ScenarioRun["status"], reason?: ScenarioRun["reason"]): ScenarioRun {
	return { id, status, reason, revision: 1, edgeFunctionRevision: 1, stale: false, requests: [], console: [], grids: [], expectations: [] };
}

describe("Run all coordination", () => {
	test("awaits each completed run before beginning the next and preserves outcomes", async () => {
		const events: string[] = [];
		const results = await runAllScenarios(scenarios, async (scenario) => {
			events.push(`start:${scenario.id}`);
			await Promise.resolve();
			events.push(`finish:${scenario.id}`);
			return run(scenario.id, scenario.id === "two" ? "failed" : "passed");
		}, () => true);

		expect(events).toEqual(["start:one", "finish:one", "start:two", "finish:two", "start:three", "finish:three"]);
		expect(results.map(({ run: result }) => result.status)).toEqual(["passed", "failed", "passed"]);
	});

	test("does not start remaining Scenarios after Stop or project change", async () => {
		const stopped = await runAllScenarios(scenarios, async (scenario) => run(scenario.id, "errored", "stopped"), () => true);
		expect(stopped.map(({ scenario }) => scenario.id)).toEqual(["one"]);

		let current = true;
		const switched = await runAllScenarios(scenarios, async (scenario) => {
			current = false;
			return run(scenario.id, "passed");
		}, () => current);
		expect(switched).toEqual([]);
	});
});
