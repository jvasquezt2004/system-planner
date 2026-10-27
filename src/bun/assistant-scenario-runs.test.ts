import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { Scenario, ScenarioRun } from "../shared/design";
import type { AssistantRuntime, AssistantRuntimeOptions } from "./assistant-runtime";
import { createAssistantScenarioRunBridge } from "../mainview/assistant-scenario-run-bridge";
import { createScenarioRunDriver, type ScenarioRunDriver } from "../mainview/scenario-run-driver";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace } from "./workspace";
import type { DesignWorkspace } from "./workspace";

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];
const runtimes: AssistantRuntime[] = [];
const drivers: ScenarioRunDriver[] = [];

afterEach(async () => {
	for (const driver of drivers.splice(0)) driver.dispose();
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type SetupOptions = Pick<AssistantRuntimeOptions, "scenarioRunTimeoutMs" | "runScenario"> & {
	runScenarioFactory?: (workspace: DesignWorkspace, driver: ScenarioRunDriver) => AssistantRuntimeOptions["runScenario"];
	onDriverQueued?: (scenario: Scenario | (() => Scenario | null)) => void;
};
async function setup(sources: string[], options: SetupOptions = {}) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-scenario-runs-"));
	directories.push(directory);
	const databasePath = join(directory, "project.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	const opened = await workspace.createProject({ name: "Assistant scenario runs" });
	if (!opened.project || !opened.activeDesignId) throw new Error("Expected the project and its active Design to be open.");
	const tableState = await workspace.addTable({ name: "Books" });
	const table = tableState.design?.tables[0];
	if (!table) throw new Error("Expected Books table.");
	await workspace.addColumn({ tableId: table.id, name: "title", type: "text" });
	const scenarios: Scenario[] = [];
	for (let index = 0; index < sources.length; index += 1) {
		const created = await workspace.createScenario({ name: `Scenario ${index + 1}` });
		const item = created.scenarios[created.scenarios.length - 1];
		if (!item) throw new Error("Expected the saved Scenario.");
		const updated = await workspace.updateScenarioSource({ scenarioId: item.id, source: sources[index] ?? "" });
		scenarios.push(updated.scenarios.find(({ id }) => id === item.id) ?? item);
	}
	const driver = createScenarioRunDriver({
		workspace,
		createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
		createEdgeWorker: () => new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" }),
		timeoutMs: 30_000,
		onQueued: options.onDriverQueued,
	});
	drivers.push(driver);
	const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
	const models = createModels();
	models.setProvider(scripted.provider);
	const requests: string[] = [];
	const runtime = createAssistantRuntime({
		databasePath,
		workspace,
		models,
		getApiKey: async () => "test-api-key",
		streamFn: (model, context, streamOptions) => {
			requests.push(JSON.stringify({ context, options: streamOptions }));
			return models.streamSimple(model, context, streamOptions);
		},
		scenarioRunTimeoutMs: options.scenarioRunTimeoutMs,
		runScenario: options.runScenario ?? options.runScenarioFactory?.(workspace, driver) ?? (async (projectId, designId, scenario, signal) => {
			const state = workspace.getState();
			if (state.project?.id !== projectId || state.activeDesignId !== designId) throw new Error("Bound project or Design changed.");
			return driver.runQueued({ ...scenario, designId }, { signal });
		}),
	});
	runtimes.push(runtime);
	return { databasePath, workspace, scenarios, scripted, runtime, projectId: opened.project.id, designId: opened.activeDesignId, requests, driver };
}

type CompactRun = { scenario: string; status: string; stale: boolean; failedExpectations: unknown[]; console: string[]; requestLog: unknown[]; grids: unknown[] };

function runDetails(runtime: ReturnType<typeof createAssistantRuntime>, conversationId: string) {
	const results = runtime.loadConversation(conversationId)?.messages.filter(({ role }) => role === "toolResult") ?? [];
	const runs: CompactRun[][] = [];
	for (const message of results) {
		const payload = message.payload;
		if (!payload || typeof payload !== "object" || !("details" in payload)) continue;
		const details = payload.details;
		if (details && typeof details === "object" && "runs" in details && Array.isArray(details.runs)) {
			runs.push(details.runs as CompactRun[]);
		}
	}
	return runs;
}

describe("Assistant Scenario runs", () => {
	test("runs an ordinary Scenario and returns compact live results to the model", async () => {
		const consoleSource = Array.from({ length: 25 }, (_, index) => `console.log(${JSON.stringify(`line-${index + 1}`)});`).join("\n");
		const { workspace, scenarios, scripted, runtime, projectId, requests } = await setup([
			`${consoleSource}\nconst inserted = await supabase.from("Books").insert([{ title: "Book 1" }, { title: "Book 2" }, { title: "Book 3" }, { title: "Book 4" }, { title: "Book 5" }]).select("*");\nexpect(inserted).returnsDataEqual([{ id: 1, title: "wrong title" }]);`,
		]);
		const conversation = runtime.createConversation(projectId);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("run_scenarios", { mode: "one", scenarioId: scenarios[0]!.id })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The Scenario failed because its expected title was incorrect.")]),
		]);
		await runtime.sendMessage(conversation.id, "Run Scenario 1 and inspect the result.", "scripted-model");

		const run = workspace.getState().scenarioRuns[scenarios[0]!.id];
		expect(run).toMatchObject({ status: "failed", stale: false });
		expect(run?.expectations).toEqual([expect.objectContaining({ passed: false })]);
		expect(run?.requests).toHaveLength(1);
		expect(run?.grids.find(({ table }) => table === "Books")?.rows).toEqual([
			{ id: 1, title: "Book 1" },
			{ id: 2, title: "Book 2" },
			{ id: 3, title: "Book 3" },
			{ id: 4, title: "Book 4" },
			{ id: 5, title: "Book 5" },
		]);
		const result = runDetails(runtime, conversation.id)[0]![0]!;
		expect(result).toMatchObject({ status: "failed", scenario: "Scenario 1", stale: false });
		expect(result.failedExpectations).toHaveLength(1);
		expect(result.console).toEqual(Array.from({ length: 20 }, (_, index) => `line-${index + 6}`));
		expect(result.requestLog).toEqual([{ request: "POST Books (201)", count: 1 }]);
		expect(result.grids).toEqual([expect.objectContaining({
			table: "Books",
			rowCount: 5,
			capturedRows: 5,
			rows: [{ id: 1, title: "Book 1" }, { id: 2, title: "Book 2" }, { id: 3, title: "Book 3" }],
		})]);
		expect(scripted.state.callCount).toBe(3);
		expect(requests[1]).toContain("line-6");
		expect(requests[1]).not.toContain("line-5");
		expect(requests[1]).toContain("Book 3");
		expect(requests[1]).not.toContain("Book 4");
		expect(requests[1]).not.toContain("Book 5");
		expect(requests[2]).toContain("capturedRows");
		expect(requests[2]).toContain("failedExpectationCount");
	});
	test("keeps a scripted Scenario run bound to the invocation Design across navigation", async () => {
		const requestStarted = Promise.withResolvers<{ projectId: string; designId: string }>();
		const finishRun = Promise.withResolvers<null>();
		const { workspace, scenarios, scripted, runtime, projectId, designId } = await setup(
			['console.log("must not run against the next Design");'],
			{
				runScenario: async (boundProjectId, boundDesignId) => {
					requestStarted.resolve({ projectId: boundProjectId, designId: boundDesignId });
					return finishRun.promise;
				},
			},
		);
		const conversation = runtime.createConversation(projectId);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("run_scenarios", { mode: "one", scenarioId: scenarios[0]!.id })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The run could not be accepted after navigation.")]),
		]);
		const turn = runtime.sendMessage(conversation.id, "Run the saved Scenario.", "scripted-model");
		const invokedTarget = await requestStarted.promise;
		expect(invokedTarget).toEqual({ projectId, designId });

		const other = await workspace.createProject({ name: "Other Design" });
		if (!other.project) throw new Error("Expected the other project to be open.");
		finishRun.resolve(null);
		await turn;

		expect(workspace.getState().project?.id).toBe(other.project.id);
		expect(workspace.getState().scenarioRuns).toEqual({});
		const toolResult = runtime.loadConversation(conversation.id)?.messages.find(({ role }) => role === "toolResult");
		expect(JSON.stringify(toolResult?.payload)).toContain("changed while the Scenario run was in progress");
	});

	test("finishes the Assistant turn when the view never reports a run", async () => {
		const timeoutMessage = "The view did not report the Scenario run result in time.";
		const requestStarted = Promise.withResolvers<void>();
		const { scenarios, scripted, runtime, projectId, requests } = await setup(
			['console.log("timeout scenario");'],
			{
				scenarioRunTimeoutMs: 20,
				runScenario: async (_projectId, _designId, _scenario, _signal, timeoutMs) => {
					requestStarted.resolve();
					const { promise, reject } = Promise.withResolvers<null>();
					setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
					return promise;
				},
			},
		);
		const conversation = runtime.createConversation(projectId);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("run_scenarios", { mode: "one", scenarioId: scenarios[0]!.id })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The view did not return the Scenario result.")]),
		]);
		vi.useFakeTimers();
		try {
			const turn = runtime.sendMessage(conversation.id, "Run the Scenario.", "scripted-model");
			await requestStarted.promise;
			vi.advanceTimersByTime(20);
			await turn;
			expect(scripted.state.callCount).toBe(2);
			expect(requests[1]).toContain(timeoutMessage);
		} finally {
			vi.useRealTimers();
		}
	});

	test("stops an active Assistant Scenario through the view bridge and reports stopped", async () => {
		const { workspace, scenarios, scripted, runtime, projectId } = await setup(["while (true) {}",], {
			runScenarioFactory: (boundWorkspace, driver) => {
				const pending = new Map<string, { resolve: (run: ScenarioRun | null) => void; reject: (cause: unknown) => void }>();
				const bridge = createAssistantScenarioRunBridge({
					driver,
					getWorkspaceState: () => boundWorkspace.getState(),
					complete: (requestId, run, error) => {
						const completion = pending.get(requestId);
						if (!completion) return;
						pending.delete(requestId);
						if (error) completion.reject(new Error(error));
						else completion.resolve(run);
					},
				});
				return (boundProjectId, designId, scenario, signal) => {
					const requestId = crypto.randomUUID();
					const { promise, resolve, reject } = Promise.withResolvers<ScenarioRun | null>();
					pending.set(requestId, { resolve, reject });
					const onAbort = () => {
						bridge.cancel(requestId);
						const error = new Error("Scenario run was stopped.");
						error.name = "AbortError";
						reject(error);
					};
					bridge.request({ requestId, projectId: boundProjectId, designId, scenario });
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
					return promise.then(
						(run) => {
							signal?.removeEventListener("abort", onAbort);
							return run;
						},
						(cause: unknown) => {
							signal?.removeEventListener("abort", onAbort);
							throw cause;
						},
					);
				};
			},
		});
		const conversation = runtime.createConversation(projectId);
		const started = Promise.withResolvers<void>();
		const stopped = Promise.withResolvers<void>();
		const unsubscribe = workspace.subscribe((state) => {
			const run = state.scenarioRuns[scenarios[0]!.id];
			if (run?.status === "running") started.resolve();
			if (run?.status === "errored" && run.reason === "stopped") stopped.resolve();
		});
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("run_scenarios", { mode: "one", scenarioId: scenarios[0]!.id })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Scenario stopped.")]),
		]);
		try {
			const turn = runtime.sendMessage(conversation.id, "Run and stop the Scenario.", "scripted-model");
			await started.promise;
			runtime.stop(conversation.id);
			await turn;
			await stopped.promise;
		} finally {
			unsubscribe();
		}

		expect(runDetails(runtime, conversation.id)[0]![0]).toMatchObject({ scenario: "Scenario 1", status: "stopped" });
		expect(workspace.getState().scenarioRuns[scenarios[0]!.id]).toMatchObject({ status: "errored", reason: "stopped" });
	});

	test("queues an Assistant request behind an active manual run and preserves run staleness", async () => {
		const assistantQueued = Promise.withResolvers<void>();
		const { workspace, scenarios, scripted, runtime, projectId, driver } = await setup([
			"while (true) {}",
			'console.log("queued run completed");',
		], {
			onDriverQueued: () => assistantQueued.resolve(),
		});
		const activeStarted = Promise.withResolvers<string>();
		const unsubscribe = workspace.subscribe((state) => {
			const run = state.scenarioRuns[scenarios[0]!.id];
			if (run?.status === "running") activeStarted.resolve(run.id);
		});
		const manualRun = driver.run(scenarios[0]!);
		const conversation = runtime.createConversation(projectId);
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("run_scenarios", { mode: "one", scenarioId: scenarios[1]!.id })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("The queued Scenario completed.")]),
		]);
		try {
			const runId = await activeStarted.promise;
			const assistantTurn = runtime.sendMessage(conversation.id, "Run Scenario 2.", "scripted-model");
			await assistantQueued.promise;
			expect(driver.getQueueLength()).toBe(1);
			await driver.stop(runId);
			await manualRun;
			await assistantTurn;
		} finally {
			unsubscribe();
		}
		expect(workspace.getState().scenarioRuns[scenarios[0]!.id]).toMatchObject({ status: "errored", reason: "stopped" });
		expect(workspace.getState().scenarioRuns[scenarios[1]!.id]).toMatchObject({ status: "passed", console: ["queued run completed"] });
		expect(runDetails(runtime, conversation.id)[0]![0]).toMatchObject({ status: "passed", scenario: "Scenario 2" });
		const design = workspace.getState().design;
		const table = design?.tables[0];
		if (!table) throw new Error("Expected Books table.");
		await workspace.addColumn({ tableId: table.id, name: "subtitle", type: "text" });
		expect(workspace.getState().scenarioRuns[scenarios[1]!.id]?.stale).toBe(true);
	}, 60_000);


	test("runs all saved Scenarios in order and reports Stop distinctly", async () => {
		const { workspace, scenarios, scripted, runtime, projectId } = await setup([
			'console.log("first");',
			'while (true) {}',
			'console.log("must not execute");',
		]);
		const conversation = runtime.createConversation(projectId);
		let stopped = false;
		const unsubscribe = workspace.subscribe((state) => {
			const running = state.scenarioRuns[scenarios[1]!.id];
			if (!stopped && running?.status === "running") {
				stopped = true;
				void drivers[0]!.stop(running.id);
			}
		});
		scripted.setResponses([
			fauxAssistantMessage([fauxToolCall("run_scenarios", { mode: "all" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Stopped the remaining runs.")]),
		]);
		try {
			await runtime.sendMessage(conversation.id, "Run all Scenarios.", "scripted-model");
		} finally {
			unsubscribe();
		}
		const runs = runDetails(runtime, conversation.id)[0]!;
		expect(runs.map(({ status, scenario }) => [scenario, status])).toEqual([
			["Scenario 1", "passed"],
			["Scenario 2", "stopped"],
		]);
		expect(workspace.getState().scenarioRuns[scenarios[2]!.id]).toBeUndefined();
		expect(workspace.getState().scenarioRuns[scenarios[1]!.id]).toMatchObject({ status: "errored", reason: "stopped" });
	});
});
