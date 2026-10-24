
import type { Scenario, ScenarioRun } from "./design";
export const SCENARIO_RUN_TIMEOUT_MS = 30_000;

export type RunAllResult = { scenario: Scenario; run: ScenarioRun };

/** Runs a stable project snapshot one Scenario at a time, stopping on cancellation. */
export async function runAllScenarios(
	scenarios: readonly Scenario[],
	runScenario: (scenario: Scenario) => Promise<ScenarioRun | null>,
	isCurrent: () => boolean,
): Promise<RunAllResult[]> {
	const results: RunAllResult[] = [];
	for (const scenario of scenarios) {
		if (!isCurrent()) break;
		const run = await runScenario(scenario);
		if (!isCurrent() || !run) break;
		results.push({ scenario, run });
		if (run.status === "running" || (run.status === "errored" && run.reason === "stopped")) break;
	}
	return results;
}
