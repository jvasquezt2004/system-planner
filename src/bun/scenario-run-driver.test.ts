import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../shared/design";
import { runAllScenarios } from "../shared/run-all";
import { createScenarioRunDriver } from "../mainview/scenario-run-driver";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const workspaces: DesignWorkspace[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture(sources: string[]) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-run-driver-"));
	directories.push(directory);
	const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
	workspaces.push(workspace);
	await workspace.createProject({ name: "Run driver fixture" });
	const added = await workspace.addTable({ name: "Books" });
	const table = added.design?.tables[0];
	if (!table) throw new Error("Expected Books table.");
	await workspace.addColumn({ tableId: table.id, name: "title", type: "text" });
	const scenarios: Scenario[] = [];
	for (let index = 0; index < sources.length; index += 1) {
		const created = await workspace.createScenario({ name: `Scenario ${index + 1}` });
		const scenario = created.scenarios[created.scenarios.length - 1];
		if (!scenario) throw new Error("Expected saved Scenario.");
		const updated = await workspace.updateScenarioSource({ scenarioId: scenario.id, source: sources[index] ?? "" });
		scenarios.push(updated.scenarios.find(({ id }) => id === scenario.id) ?? scenario);
	}
	return { workspace, scenarios };
}

function driverFor(workspace: DesignWorkspace, timeoutMs = 30_000) {
	return createScenarioRunDriver({
		workspace,
		createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
		timeoutMs,
	});
}

describe("Scenario run driver", () => {
	test("Run all uses the real workspace and Worker, reports outcomes, and gives every Scenario an empty Sandbox", async () => {
		const { workspace, scenarios } = await fixture([
			'const before = await supabase.from("Books").select("*"); expect(before).returnsDataEqual([]); const added = await supabase.from("Books").insert({ title: "first" }).select("*"); expect(added).succeeds();',
			'const before = await supabase.from("Books").select("*"); expect(before).returnsDataEqual([{ id: 10, title: "unexpected" }]); await supabase.from("Books").insert({ title: "second" }).select("*");',
			'const before = await supabase.from("Books").select("*"); expect(before).returnsDataEqual([]); throw new Error("unexpected failure");',
		]);
		const driver = driverFor(workspace);
		try {
			const results = await runAllScenarios(scenarios, (scenario) => driver.run(scenario), () => true);
			expect(results.map(({ run }) => run.status)).toEqual(["passed", "failed", "errored"]);
			for (const { scenario, run } of results) {
				expect(workspace.getState().scenarioRuns[scenario.id]).toMatchObject({ id: run.id, status: run.status });
				expect(run.requests[0]?.result).toEqual([]);
			}
			expect(results[1]?.run.expectations[0]?.passed).toBe(false);
			expect(results[2]?.run.reason).toBe("exception");
		} finally {
			driver.dispose();
		}
	}, 60_000);

	test("Stop during Run all completes only the current Scenario", async () => {
		const { workspace, scenarios } = await fixture([
			'await supabase.from("Books").select("*"); while (true) {}',
			'console.log("must not start");',
			'console.log("must not start");',
		]);
		const driver = driverFor(workspace);
		const stopper = workspace.subscribe((state) => {
			const active = Object.values(state.scenarioRuns).find(
				(run) => run?.status === "running" && run.requests.length > 0,
			);
			if (active) void driver.stop(active.id);
		});
		try {
			const results = await runAllScenarios(scenarios, (scenario) => driver.run(scenario), () => true);
			expect(results).toHaveLength(1);
			expect(results[0]?.run).toMatchObject({ status: "errored", reason: "stopped" });
			expect(workspace.getState().scenarioRuns[scenarios[1]?.id ?? ""] ?? null).toBeNull();
			expect(workspace.getState().scenarioRuns[scenarios[2]?.id ?? ""] ?? null).toBeNull();
		} finally {
			stopper();
			driver.dispose();
		}
	}, 60_000);

	test("superseding the current project resolves its Scenario run as null", async () => {
		const { workspace, scenarios } = await fixture([
			'await supabase.from("Books").select("*"); while (true) {}',
		]);
		let projectGeneration = 0;
		const driver = createScenarioRunDriver({
			workspace,
			createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
			timeoutMs: 30_000,
			getToken: () => projectGeneration,
		});
		const initialProjectId = workspace.getState().project?.id;
		const requestSeen = Promise.withResolvers<void>();
		const requestUnsubscribe = workspace.subscribe((state) => {
			if (state.scenarioRuns[scenarios[0]!.id]?.requests.length) requestSeen.resolve();
		});
		const unsubscribe = workspace.subscribe((state) => {
			if (state.project?.id !== initialProjectId) {
				projectGeneration += 1;
				driver.cancel();
			}
		});
		try {
			const pending = driver.run(scenarios[0]!);
			await requestSeen.promise;
			await workspace.createProject({ name: "Replacement project" });
			expect(await pending).toBeNull();
		} finally {
			requestUnsubscribe();
			unsubscribe();
			driver.dispose();
		}
	}, 60_000);

	test("timeout finishes the run as errored and releases its Sandbox", async () => {
		const { workspace, scenarios } = await fixture(["while (true) {}"]);
		const driver = driverFor(workspace, 30);
		try {
			const result = await driver.run(scenarios[0]!);
			expect(result).toMatchObject({ status: "errored", reason: "timed out" });
			const next = await workspace.beginScenarioRun({ scenarioId: scenarios[0]!.id });
			await workspace.finishScenarioRun({ runId: next.runId, status: "passed", console: [] });
		} finally {
			driver.dispose();
		}
	}, 60_000);
});
