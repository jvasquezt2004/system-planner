import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceState } from "../shared/design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const workspaces: DesignWorkspace[] = [];
const directories: string[] = [];

async function openWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-scenario-run-"));
	directories.push(directory);
	const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
	workspaces.push(workspace);
	await workspace.createProject({ name: "Scenario fixture" });
	const withTable = await workspace.addTable({ name: "Books" });
	const table = withTable.design?.tables[0];
	if (!table) throw new Error("Expected Books table.");
	const title = await workspace.addColumn({ tableId: table.id, name: "title", type: "text" });
	const column = title.design?.tables[0].columns.find((item) => item.name === "title");
	if (!column) throw new Error("Expected title column.");
	await workspace.updateColumn({ tableId: table.id, columnId: column.id, changes: { nullable: false } });
	const scenario = await workspace.createScenario({ name: "Insert and select" });
	return { workspace, scenarioId: scenario.scenarios[0].id };
}

function requireState(state: WorkspaceState) {
	if (!state.sandbox || state.sandbox.status !== "applied") throw new Error("Expected an applied design revision.");
	return state.sandbox;
}

function clientFor(workspace: DesignWorkspace, runId: string) {
	const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries());
		const response = await workspace.handleSandboxApiRequest({
			runId,
			request: {
				method: init?.method ?? (input instanceof Request ? input.method : "GET"),
				path: url.pathname,
				query: url.search.slice(1),
				headers,
				body: init?.body ? String(init.body) : null,
			},
		});
		return new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
	};
	return createClient("http://scenario.local", "local-anon-key", {
		auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
		global: { fetch: transport as typeof fetch },
	});
}

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Scenario runs", () => {
	test("the real supabase-js client inserts, selects by eq, and receives PostgreSQL SQLSTATE errors", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		requireState(workspace.getState());
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);

		const inserted = await supabase.from("Books").insert({ title: "The Left Hand of Darkness" }).select("*");
		expect(inserted.error).toBeNull();
		expect(inserted.data).toEqual([{ id: 1, title: "The Left Hand of Darkness" }]);
		const selected = await supabase.from("Books").select("*").eq("id", 1);
		expect(selected.error).toBeNull();
		expect(selected.data).toEqual(inserted.data);
		const invalid = await supabase.from("Books").insert({ title: null }).select("*");
		expect(invalid.error?.code).toBe("23502");
		expect(workspace.getState().scenarioRuns[scenarioId]?.requests.map(({ order }) => order)).toEqual([1, 2, 3]);
		expect(workspace.getState().scenarioRuns[scenarioId]?.requests[2]).toMatchObject({ status: 400, result: { code: "23502" } });
		await workspace.finishScenarioRun({ runId, status: "passed", console: ["inserted one record"] });
		expect(workspace.getState().scenarioRuns[scenarioId]).toMatchObject({ status: "passed", console: ["inserted one record"] });
	}, 60_000);
	test("finishing captures every table in primary-key order with a 500-row cap and total", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		await workspace.addTable({ name: "EmptyRecords" });
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		const idColumn = books?.columns.find((column) => column.name === "id");
		if (!books || !idColumn) throw new Error("Expected Books primary key.");
		await workspace.updateColumn({ tableId: books.id, columnId: idColumn.id, changes: { identity: false } });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		for (let id = 501; id >= 1; id -= 1) {
			const inserted = await supabase.from("Books").insert({ id, title: `Book ${id}` }).select("*");
			expect(inserted.error).toBeNull();
		}

		const finished = await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
		const result = finished.scenarioRuns[scenarioId];
		expect(result?.grids).toHaveLength(2);
		expect(result?.grids?.[0]).toMatchObject({
			table: "Books",
			columns: ["id", "title"],
			total: 501,
		});
		expect(result?.grids?.[0]?.rows.slice(0, 2)).toEqual([
			{ id: 1, title: "Book 1" },
			{ id: 2, title: "Book 2" },
		]);
		expect(result?.grids?.[0]?.rows).toHaveLength(500);
		expect(result?.grids?.[0]?.rows[499]).toEqual({ id: 500, title: "Book 500" });
	}, 60_000);

	test("unsupported filters fail loudly and consecutive runs start with empty records", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const first = await workspace.beginScenarioRun({ scenarioId });
		const firstClient = clientFor(workspace, first.runId);
		const unsupported = await firstClient.from("Books").select("*").order("id");
		expect(unsupported.error?.code).toBe("PGRST_SANDBOX_UNSUPPORTED");
		await firstClient.from("Books").insert({ title: "temporary" }).select("*");
		await workspace.finishScenarioRun({ runId: first.runId, status: "passed", console: [] });

		const second = await workspace.beginScenarioRun({ scenarioId });
		const secondClient = clientFor(workspace, second.runId);
		const empty = await secondClient.from("Books").select("*").eq("id", 1);
		expect(empty.error).toBeNull();
		expect(empty.data).toEqual([]);
		expect(second.state.scenarioRuns[scenarioId]?.revision).toBe(first.state.scenarioRuns[scenarioId]?.revision);
		await workspace.finishScenarioRun({ runId: second.runId, status: "passed", console: [] });
	}, 60_000);
	test("runs require an applied revision, reject overlap, and turn stale as the draft advances", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-unapplied-scenario-"));
		directories.push(directory);
		const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Unapplied fixture" });
		const scenario = await workspace.createScenario({ name: "First" });
		await expect(workspace.beginScenarioRun({ scenarioId: scenario.scenarios[0].id })).rejects.toThrow("Apply a valid design revision");

		await workspace.addTable({ name: "Books" });
		const first = await workspace.beginScenarioRun({ scenarioId: scenario.scenarios[0].id });
		await expect(workspace.beginScenarioRun({ scenarioId: scenario.scenarios[0].id })).rejects.toThrow("already active");
		const laterDraft = await workspace.addTable({ name: "Authors" });
		expect(laterDraft.scenarioRuns[scenario.scenarios[0].id]?.stale).toBe(true);
		await workspace.finishScenarioRun({ runId: first.runId, status: "passed", console: [] });
	}, 60_000);

	test("scenario source executes inside a real Worker and transports requests through the workspace", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const worker = new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" });
		const { promise, resolve, reject } = Promise.withResolvers<{ status: string; console: string[] }>();
		const timeout = setTimeout(() => reject(new Error("Scenario Worker did not finish")), 10_000);
		worker.onerror = (event) => reject(new Error(event.message));
		worker.onmessage = async ({ data }: MessageEvent) => {
			if (data.type === "request") {
				const response = await workspace.handleSandboxApiRequest({ runId, request: data.request });
				worker.postMessage({ type: "response", requestId: data.requestId, response });
			} else if (data.type === "finished") resolve(data);
		};
		worker.postMessage({ type: "start", runId, source: 'const label: string = "worker"; const result = await supabase.from("Books").insert({ title: "from worker" }).select("*"); console.log(label, result.data);' });
		try {
			const result = await promise;
			expect(result).toMatchObject({ status: "passed", console: ['worker [{"id":1,"title":"from worker"}]'] });
			expect(workspace.getState().scenarioRuns[scenarioId]?.requests).toHaveLength(1);
		} finally {
			clearTimeout(timeout);
			worker.terminate();
			await workspace.finishScenarioRun({ runId, status: "passed", console: ["worker completed"] });
		}
		}, 60_000);
});
