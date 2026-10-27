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
		createEdgeWorker: () => new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" }),
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
				expect(run.designId).toBe(scenario.designId);
				expect(typeof run.scenarioRevision).toBe("number");
				expect(workspace.getState().scenarioRuns[scenario.id]).toMatchObject({
					id: run.id,
					designId: scenario.designId,
					status: run.status,
					scenarioRevision: run.scenarioRevision,
				});
				expect(run.requests[0]?.result).toEqual([]);
			}
			expect(results[1]?.run.expectations[0]?.passed).toBe(false);
			expect(results[2]?.run.reason).toBe("exception");
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("scenario invokes a saved Edge function that writes with service role and returns the result", async () => {
		const { workspace, scenarios } = await fixture([
			'const result = await supabase.functions.invoke("add-book", { body: { title: "from edge" } }); expect(result).returnsDataEqual({ id: 1, title: "from edge" });',
		]);
		const created = await workspace.createEdgeFunction({ name: "add-book" });
		const edgeFunction = created.edgeFunctions.find(({ name }) => name === "add-book");
		if (!edgeFunction) throw new Error("Expected the saved Edge function.");
		await workspace.updateEdgeFunctionSource({
			edgeFunctionId: edgeFunction.id,
			source: `import { createClient } from "jsr:@supabase/supabase-js@2";
Deno.serve(async (request) => {
	const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
	const { title } = await request.json();
	const { data, error } = await client.from("Books").insert({ title }).select("*").single();
	if (error) return Response.json({ error: error.message }, { status: 500 });
	console.log("created", data.title);
	return Response.json(data);
});`,
		});
		const driver = driverFor(workspace);
		try {
			const run = await driver.run(scenarios[0]!);
			expect(run?.status).toBe("passed");
			expect(run?.requests).toEqual([
				expect.objectContaining({
					method: "POST",
					table: "Books",
					identity: expect.objectContaining({ role: "service_role" }),
					invocationRef: expect.stringContaining("add-book"),
				}),
				expect.objectContaining({
					method: "INVOKE",
					table: "functions/add-book",
					invocation: expect.objectContaining({ functionName: "add-book", status: 200, response: { id: 1, title: "from edge" } }),
				}),
			]);
			expect(run?.console).toContain("[add-book] created from edge");
			expect(run?.grids.find(({ table }) => table === "Books")?.rows).toEqual([{ id: 1, title: "from edge" }]);
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("forwards caller Authorization through the Edge function to caller-scoped clients under RLS", async () => {
		const { workspace, scenarios } = await fixture([
			`const missingHeader = await asUser("11111111-1111-4111-8111-111111111111").functions.invoke("without-forwarding");
const one = await asUser("11111111-1111-4111-8111-111111111111").functions.invoke("visible-books");
const two = await asUser("22222222-2222-4222-8222-222222222222").functions.invoke("visible-books");
const anon = await supabase.functions.invoke("visible-books");
const service = await asServiceRole().functions.invoke("visible-books");
expect(missingHeader).returnsDataEqual([]);
expect(one).returnsDataEqual(["first user's book"]);
expect(two).returnsDataEqual(["second user's book"]);
expect(anon).returnsDataEqual([]);
expect(service).returnsDataEqual(["first user's book", "second user's book"]);`,
		]);
		const table = workspace.getState().design?.tables[0];
		if (!table) throw new Error("Expected Books table.");
		await workspace.addColumn({ tableId: table.id, name: "owner_id", type: "uuid" });
		await workspace.updatePolicies({
			tableId: table.id,
			rowLevelSecurity: true,
			policies: [{
				id: "owners-read",
				name: "owners_read",
				command: "SELECT",
				roles: ["authenticated"],
				mode: "permissive",
				using: "owner_id = auth.uid()",
				withCheck: "",
			}],
		});
		for (const [name, forwardAuthorization] of [["visible-books", true], ["without-forwarding", false]] as const) {
			const created = await workspace.createEdgeFunction({ name });
			const edgeFunction = created.edgeFunctions.find((candidate) => candidate.name === name);
			if (!edgeFunction) throw new Error(`Expected saved Edge function ${name}.`);
			await workspace.updateEdgeFunctionSource({
				edgeFunctionId: edgeFunction.id,
				source: `import { createClient } from "jsr:@supabase/supabase-js@2";
Deno.serve(async (request) => {
	const client = createClient(
		Deno.env.get("SUPABASE_URL")!,
		Deno.env.get("SUPABASE_ANON_KEY")!,
		${forwardAuthorization ? `{
			global: { headers: { Authorization: request.headers.get("Authorization")! } },
		}` : "{}"},
	);
	const { data, error } = await client.from("Books").select("title").order("title");
	if (error) throw new Error(error.message);
	return Response.json(data.map(({ title }) => title));
});`,
			});
		}
		const seed = `await asServiceRole().from("Books").insert([
			{ title: "first user's book", owner_id: "11111111-1111-4111-8111-111111111111" },
			{ title: "second user's book", owner_id: "22222222-2222-4222-8222-222222222222" },
		]);`;
		const savedScenario = await workspace.updateScenarioSource({
			scenarioId: scenarios[0]!.id,
			source: `${seed}\n${scenarios[0]!.source}`,
		});
		const currentScenario = savedScenario.scenarios.find(({ id }) => id === scenarios[0]!.id);
		if (!currentScenario) throw new Error("Expected the saved Scenario.");
		const driver = driverFor(workspace);
		try {
			const run = await driver.run(currentScenario);
			expect(run?.status).toBe("passed");
			expect(run?.requests.filter(({ method }) => method === "INVOKE")).toHaveLength(5);
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("returns FunctionsHttpError responses for handler, serve, unknown-name, and nested invocation failures", async () => {
		const { workspace, scenarios } = await fixture([
			`for (const [name, message] of [["throws", "handler exploded"], ["no-serve", "Edge function did not call Deno.serve()."], ["missing", "Edge function not found: missing"], ["nested", "Nested Edge function invocation is not supported."]]) {
	const result = await supabase.functions.invoke(name);
	if (result.error?.name !== "FunctionsHttpError") throw new Error(\`Expected FunctionsHttpError for \${name}.\`);
	const body = await result.error.context.json();
	if (result.error.context.status !== (name === "missing" ? 404 : 500) || body.error !== message) {
		throw new Error(\`Unexpected \${name} response: \${result.error.context.status} \${body.error}\`);
	}
	expect(result).fails();
}`,
		]);
		for (const [name, source] of [
			["throws", `Deno.serve(() => { throw new Error("handler exploded"); });`],
			["no-serve", `console.log("no handler");`],
			["nested", `import { createClient } from "jsr:@supabase/supabase-js@2";
Deno.serve(async () => {
	const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
	await client.functions.invoke("nested");
	return Response.json({ ok: true });
});`],
		] as const) {
			const created = await workspace.createEdgeFunction({ name });
			const edgeFunction = created.edgeFunctions.find((candidate) => candidate.name === name);
			if (!edgeFunction) throw new Error(`Expected saved Edge function ${name}.`);
			await workspace.updateEdgeFunctionSource({ edgeFunctionId: edgeFunction.id, source });
		}
		const driver = driverFor(workspace);
		try {
			const run = await driver.run(scenarios[0]!);
			expect(run?.status).toBe("passed");
			expect(run?.requests.filter(({ method }) => method === "INVOKE").map(({ status, result }) => ({ status, result }))).toEqual([
				{ status: 500, result: { error: "handler exploded" } },
				{ status: 500, result: { error: "Edge function did not call Deno.serve()." } },
				{ status: 404, result: { error: "Edge function not found: missing" } },
				{ status: 500, result: { error: "Nested Edge function invocation is not supported." } },
			]);
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("supported supabase-js import forms resolve and unsupported imports are refused before handler execution", async () => {
		const imports = [
			["jsr-form", "jsr:@supabase/supabase-js@2"],
			["npm-form", "npm:@supabase/supabase-js@2"],
			["esm-form", "https://esm.sh/@supabase/supabase-js@2"],
			["bare-form", "@supabase/supabase-js"],
		] as const;
		const { workspace, scenarios } = await fixture([
			'for (const name of ["jsr-form", "npm-form", "esm-form", "bare-form"]) { const result = await supabase.functions.invoke(name); expect(result).returnsDataEqual({ name }); } const network = await supabase.functions.invoke("network-check"); expect(network).returnsDataEqual({ fetch: "undefined", WebSocket: "undefined", XMLHttpRequest: "undefined" }); const refused = await supabase.functions.invoke("bad-import"); expect(refused).fails();',
		]);
		for (const [name, specifier] of imports) {
			const created = await workspace.createEdgeFunction({ name });
			const edgeFunction = created.edgeFunctions.find((candidate) => candidate.name === name);
			if (!edgeFunction) throw new Error(`Expected saved Edge function ${name}.`);
			await workspace.updateEdgeFunctionSource({
				edgeFunctionId: edgeFunction.id,
				source: `import { createClient } from "${specifier}"; Deno.serve(() => Response.json({ name: "${name}" }));`,
			});
		}
		const network = await workspace.createEdgeFunction({ name: "network-check" });
		const networkFunction = network.edgeFunctions.find(({ name }) => name === "network-check");
		if (!networkFunction) throw new Error("Expected saved Edge function network-check.");
		await workspace.updateEdgeFunctionSource({
			edgeFunctionId: networkFunction.id,
			source: `Deno.serve(() => Response.json({ fetch: typeof fetch, WebSocket: typeof WebSocket, XMLHttpRequest: typeof XMLHttpRequest }));`,
		});
		const bad = await workspace.createEdgeFunction({ name: "bad-import" });
		const badFunction = bad.edgeFunctions.find(({ name }) => name === "bad-import");
		if (!badFunction) throw new Error("Expected saved Edge function bad-import.");
		await workspace.updateEdgeFunctionSource({
			edgeFunctionId: badFunction.id,
			source: `import "node:fs"; console.log("must not execute"); Deno.serve(() => Response.json({ ok: true }));`,
		});
		const driver = driverFor(workspace);
		try {
			const run = await driver.run(scenarios[0]!);
			expect(run?.status).toBe("passed");
			expect(run?.requests.filter(({ method }) => method === "INVOKE")).toHaveLength(6);
			expect(JSON.stringify(run?.requests.find(({ table }) => table === "functions/bad-import")?.result)).toContain("Runtime import is not supported: node:fs");
			expect(run?.console).not.toContain("[bad-import] must not execute");
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("Stop during an Edge function invocation terminates its worker and errors the run", async () => {
		const { workspace, scenarios } = await fixture([
			'await supabase.functions.invoke("wait-forever");',
		]);
		const created = await workspace.createEdgeFunction({ name: "wait-forever" });
		const edgeFunction = created.edgeFunctions.find(({ name }) => name === "wait-forever");
		if (!edgeFunction) throw new Error("Expected saved Edge function.");
		await workspace.updateEdgeFunctionSource({
			edgeFunctionId: edgeFunction.id,
			source: `import { createClient } from "jsr:@supabase/supabase-js@2";
Deno.serve(async () => {
	const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
	await client.from("Books").select("*");
	await new Promise(() => {});
	return Response.json({ ok: true });
});`,
		});
		let edgeWorkerTerminated = false;
		const driver = createScenarioRunDriver({
			workspace,
			createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
			createEdgeWorker: () => {
				const worker = new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" });
				const terminate = worker.terminate.bind(worker);
				worker.terminate = () => {
					edgeWorkerTerminated = true;
					terminate();
				};
				return worker;
			},
			timeoutMs: 30_000,
		});
		const requestSeen = Promise.withResolvers<void>();
		const unsubscribe = workspace.subscribe((state) => {
			if (state.scenarioRuns[scenarios[0]!.id]?.requests.some(({ invocationRef }) => invocationRef)) requestSeen.resolve();
		});
		try {
			const pending = driver.run(scenarios[0]!);
			await requestSeen.promise;
			const running = workspace.getState().scenarioRuns[scenarios[0]!.id];
			if (!running) throw new Error("Expected the running Scenario.");
			await driver.stop(running.id);
			expect(await pending).toMatchObject({ status: "errored", reason: "stopped" });
			expect(edgeWorkerTerminated).toBe(true);
		} finally {
			unsubscribe();
			driver.dispose();
		}
	}, 60_000);

	test("run timeout during an Edge function invocation terminates its worker", async () => {
		const { workspace, scenarios } = await fixture([
			'await supabase.functions.invoke("wait-forever");',
		]);
		const created = await workspace.createEdgeFunction({ name: "wait-forever" });
		const edgeFunction = created.edgeFunctions.find(({ name }) => name === "wait-forever");
		if (!edgeFunction) throw new Error("Expected saved Edge function.");
		await workspace.updateEdgeFunctionSource({
			edgeFunctionId: edgeFunction.id,
			source: `Deno.serve(async () => {
	await new Promise(() => {});
	return Response.json({ ok: true });
});`,
		});
		let edgeWorkerTerminated = false;
		const driver = createScenarioRunDriver({
			workspace,
			createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
			createEdgeWorker: () => {
				const worker = new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" });
				const terminate = worker.terminate.bind(worker);
				worker.terminate = () => {
					edgeWorkerTerminated = true;
					terminate();
				};
				return worker;
			},
			timeoutMs: 2_000,
		});
		try {
			expect(await driver.run(scenarios[0]!)).toMatchObject({ status: "errored", reason: "timed out" });
			expect(edgeWorkerTerminated).toBe(true);
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
			createEdgeWorker: () => new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" }),
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

	test("runQueued returns a cancelled run without retrying the Scenario", async () => {
		const { workspace, scenarios } = await fixture(["console.log(\"must not run\");"]);
		let token = 0;
		let beginCount = 0;
		const driver = createScenarioRunDriver({
			workspace: {
				beginScenarioRun: async (action) => {
					beginCount += 1;
					const begun = await workspace.beginScenarioRun(action);
					token += 1;
					return begun;
				},
				handleSandboxApiRequest: (action) => workspace.handleSandboxApiRequest(action),
				finishScenarioRun: (action) => workspace.finishScenarioRun(action),
			},
			createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
			createEdgeWorker: () => new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" }),
			timeoutMs: 30_000,
			getToken: () => token,
		});
		try {
			expect(await driver.runQueued(scenarios[0]!)).toBeNull();
			expect(beginCount).toBe(1);
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("runQueued tracks queue length and fires onQueued while waiting behind an active run", async () => {
		const { workspace, scenarios } = await fixture([
			"while (true) {}",
			'console.log("queued run completed");',
		]);
		let queuedEventFired = false;
		const driver = createScenarioRunDriver({
			workspace,
			createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
			createEdgeWorker: () => new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" }),
			timeoutMs: 30_000,
			onQueued: () => {
				queuedEventFired = true;
			},
		});
		const activeStarted = Promise.withResolvers<string>();
		const unsubscribe = workspace.subscribe((state) => {
			const run = state.scenarioRuns[scenarios[0]!.id];
			if (run?.status === "running") activeStarted.resolve(run.id);
		});
		try {
			const activeRun = driver.run(scenarios[0]!);
			const runId = await activeStarted.promise;
			expect(driver.getQueueLength()).toBe(0);
			const queuedRun = driver.runQueued(scenarios[1]!);
			expect(queuedEventFired).toBe(true);
			expect(driver.getQueueLength()).toBe(1);
			await driver.stop(runId);
			await activeRun;
			const queuedResult = await queuedRun;
			expect(driver.getQueueLength()).toBe(0);
			expect(queuedResult).toMatchObject({ status: "passed", console: ["queued run completed"] });
		} finally {
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
