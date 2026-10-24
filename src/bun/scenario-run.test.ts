import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceState } from "../shared/design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { createScenarioRunDriver } from "../mainview/scenario-run-driver";

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

function scenarioDriverFor(workspace: DesignWorkspace) {
	return createScenarioRunDriver({
		workspace,
		createWorker: () => new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" }),
		createEdgeWorker: () => new Worker(new URL("../mainview/edge-function-worker.ts", import.meta.url), { type: "module" }),
		timeoutMs: 30_000,
	});
}

function requireState(state: WorkspaceState) {
	if (!state.sandbox || state.sandbox.status !== "applied") throw new Error("Expected an applied design revision.");
	return state.sandbox;
}

function clientFor(
	workspace: DesignWorkspace,
	runId: string,
	options: { responses?: Response[]; stripSelect?: boolean; offset?: number; identity?: Record<string, unknown> } = {},
) {
	const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (options.stripSelect) url.searchParams.delete("select");
		if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
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
		const httpResponse = new Response(JSON.stringify(response.body), { status: response.status, headers: response.headers });
		options.responses?.push(httpResponse.clone());
		return httpResponse;
	};
	const identity = options.identity ?? { role: "anon" };
	const payload = Buffer.from(JSON.stringify(identity)).toString("base64url");
	return createClient("http://scenario.local", "local-anon-key", {
		auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
		global: {
			fetch: transport as typeof fetch,
			headers: { Authorization: `Bearer local.${payload}.signature` },
		},
	});
}

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Scenario runs", () => {
	test("unknown tables return PostgREST PGRST205 errors and fuzzy-match hints", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		await workspace.addTable({ name: "Customers" });
		await workspace.addTable({ name: "projects" });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);

		const missing = await supabase.from("missing_table").select("*");
		expect(missing.status).toBe(404);
		expect(missing.error).toMatchObject({
			code: "PGRST205",
			message: "Could not find the table 'public.missing_table' in the schema cache",
			details: null,
			hint: null,
		});

		const customerCaseMiss = await supabase.from("customers").select("*");
		expect(customerCaseMiss.status).toBe(404);
		expect(customerCaseMiss.error).toMatchObject({
			code: "PGRST205",
			message: "Could not find the table 'public.customers' in the schema cache",
			details: null,
			hint: "Perhaps you meant the table 'public.Customers'",
		});

		for (const name of ["projectx", "projecxx"]) {
			const nearMiss = await supabase.from(name).select("*");
			expect(nearMiss.status).toBe(404);
			expect(nearMiss.error).toMatchObject({
				code: "PGRST205",
				message: `Could not find the table 'public.${name}' in the schema cache`,
				details: null,
				hint: "Perhaps you meant the table 'public.projects'",
			});
		}

		const distantMiss = await supabase.from("projxxxx").select("*");
		expect(distantMiss.status).toBe(404);
		expect(distantMiss.error).toMatchObject({
			code: "PGRST205",
			message: "Could not find the table 'public.projxxxx' in the schema cache",
			details: null,
			hint: null,
		});
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 30_000);
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
	test("BEFORE and AFTER Triggers change inserted records through the real supabase-js client", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		if (!books) throw new Error("Expected Books table.");
		const title = books.columns.find((column) => column.name === "title");
		if (!title) throw new Error("Expected the Books title column.");
		const auditState = await workspace.addTable({ name: "Audit" });
		const audit = auditState.design?.tables.find((table) => table.name === "Audit");
		if (!audit) throw new Error("Expected Audit table.");
		await workspace.addColumn({ tableId: audit.id, name: "message", type: "text" });
		const withFunctions = await workspace.updateFunctions({ functions: [
			{
				id: "normalise-title", name: "normalise_title", arguments: [], returnType: "trigger",
				returnsSet: false, language: "plpgsql", volatility: "volatile", security: "invoker",
				body: "BEGIN NEW.title := upper(NEW.title); RETURN NEW; END;",
			},
			{
				id: "audit-title", name: "audit_title", arguments: [], returnType: "trigger",
				returnsSet: false, language: "plpgsql", volatility: "volatile", security: "invoker",
				body: 'BEGIN INSERT INTO "Audit" (message) VALUES (NEW.title); RETURN NEW; END;',
			},
		] });
		expect(withFunctions.sandbox.status).toBe("applied");
		await workspace.updateTriggers({ triggers: [
			{ id: "normalise-before-insert", name: "normalise_before_insert", tableId: books.id, timing: "BEFORE", events: [{ event: "INSERT" }], level: "ROW", functionId: "normalise-title", when: "" },
			{ id: "audit-after-insert", name: "audit_after_insert", tableId: books.id, timing: "AFTER", events: [{ event: "INSERT" }], level: "ROW", functionId: "audit-title", when: "" },
			{ id: "audit-title-update", name: "audit_title_update", tableId: books.id, timing: "AFTER", events: [{ event: "UPDATE", columnIds: [title.id] }], level: "ROW", functionId: "audit-title", when: "" },
		] });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const inserted = await supabase.from("Books").insert({ title: "draft" }).select("*");
		expect(inserted.error).toBeNull();
		expect(inserted.data).toEqual([{ id: 1, title: "DRAFT" }]);
		const updated = await supabase.from("Books").update({ title: "updated" }).eq("id", 1);
		expect(updated.error).toBeNull();
		const auditRows = await supabase.from("Audit").select("*");
		expect(auditRows.error).toBeNull();
		expect(auditRows.data).toEqual([{ id: 1, message: "DRAFT" }, { id: 2, message: "updated" }]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("the real supabase-js client performs bulk insert, filtered update, upsert, and delete", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		const idColumn = books?.columns.find((column) => column.name === "id");
		if (!books || !idColumn) throw new Error("Expected Books primary key.");
		await workspace.updateColumn({ tableId: books.id, columnId: idColumn.id, changes: { identity: false } });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);

		const inserted = await supabase.from("Books").insert([
			{ id: 1, title: "First" },
			{ id: 2, title: "Second" },
		]).select("id,title");
		const rolledBack = await supabase.from("Books").insert([
			{ id: 3, title: "Must roll back" },
			{ id: 4, title: null },
		]).select("*");
		expect(rolledBack.error?.code).toBe("23502");
		const afterRollback = await supabase.from("Books").select("id").eq("id", 3);
		expect(afterRollback.data).toEqual([]);
		expect(inserted.error).toBeNull();
		expect(inserted.data).toEqual([{ id: 1, title: "First" }, { id: 2, title: "Second" }]);

		const updated = await supabase.from("Books").update({ title: "Changed" }).eq("id", 2).select("title");
		expect(updated.error).toBeNull();
		expect(updated.data).toEqual([{ title: "Changed" }]);

		const upserted = await supabase.from("Books").upsert({ id: 2, title: "Merged" }, { onConflict: "id" }).select("*");
		expect(upserted.error).toBeNull();
		expect(upserted.data).toEqual([{ id: 2, title: "Merged" }]);

		const deleted = await supabase.from("Books").delete().eq("id", 1).select("*");
		expect(deleted.error).toBeNull();
		expect(deleted.data).toEqual([{ id: 1, title: "First" }]);
		const remaining = await supabase.from("Books").select("id,title");
		expect(remaining.data).toEqual([{ id: 2, title: "Merged" }]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("write status codes match minimal and representation responses through supabase-js", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);

		const insertedMinimal = await supabase.from("Books").insert({ title: "Minimal insert" });
		expect(insertedMinimal.error).toBeNull();
		expect(insertedMinimal.status).toBe(201);

		const insertedRepresentation = await supabase.from("Books").insert({ title: "Representation insert" }).select("*");
		expect(insertedRepresentation.error).toBeNull();
		expect(insertedRepresentation.status).toBe(201);

		const updatedMinimal = await supabase.from("Books").update({ title: "Minimal update" }).eq("id", 1);
		expect(updatedMinimal.error).toBeNull();
		expect(updatedMinimal.status).toBe(204);

		const updatedRepresentation = await supabase.from("Books").update({ title: "Representation update" }).eq("id", 2).select("*");
		expect(updatedRepresentation.error).toBeNull();
		expect(updatedRepresentation.status).toBe(200);

		const deletedMinimal = await supabase.from("Books").delete().eq("id", 1);
		expect(deletedMinimal.error).toBeNull();
		expect(deletedMinimal.status).toBe(204);

		const deletedRepresentation = await supabase.from("Books").delete().eq("id", 2).select("*");
		expect(deletedRepresentation.error).toBeNull();
		expect(deletedRepresentation.status).toBe(200);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("single and maybeSingle shape write representations and reject the wrong cardinality", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);

		const inserted = await supabase.from("Books").insert({ title: "One" }).select("*").single();
		expect(inserted.error).toBeNull();
		expect(inserted.data).toEqual({ id: 1, title: "One" });
		await supabase.from("Books").insert({ title: "Two" });

		const absent = await supabase.from("Books").update({ title: "Absent" }).eq("id", 99).select("*").maybeSingle();
		expect(absent.error).toBeNull();
		expect(absent.data).toBeNull();

		const updated = await supabase.from("Books").update({ title: "Updated" }).eq("id", 1).select("*").single();
		expect(updated.error).toBeNull();
		expect(updated.data).toEqual({ id: 1, title: "Updated" });
		const upserted = await supabase.from("Books").upsert({ title: "Upserted" }).select("*").single();
		expect(upserted.error).toBeNull();
		expect(upserted.data).toEqual({ id: 3, title: "Upserted" });
		const deleted = await supabase.from("Books").delete().eq("id", 1).select("*").single();
		expect(deleted.error).toBeNull();
		expect(deleted.data).toEqual({ id: 1, title: "Updated" });
		const absentDelete = await supabase.from("Books").delete().eq("id", 99).select("*").maybeSingle();
		expect(absentDelete.error).toBeNull();
		expect(absentDelete.data).toBeNull();
		const multiple = await supabase.from("Books").update({ title: "Many" }).in("id", [2, 3]).select("*").single();
		expect(multiple.error?.code).toBe("PGRST116");
		expect(multiple.status).toBe(406);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("quoted identifiers select columns and embed related resources with spaces and capitals", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		if (!books) throw new Error("Expected Books table.");
		await workspace.renameTable({ tableId: books.id, name: "Table test 1" });
		const renamed = workspace.getState().design?.tables.find((table) => table.name === "Table test 1");
		const nameColumn = renamed?.columns.find((column) => column.name === "title");
		if (!renamed || !nameColumn) throw new Error("Expected renamed table and column.");
		await workspace.updateColumn({ tableId: renamed.id, columnId: nameColumn.id, changes: { name: "Name" } });
		const childState = await workspace.addTable({ name: "test 2" });
		const child = childState.design?.tables.find((table) => table.name === "test 2");
		if (!child) throw new Error("Expected test 2 table.");
		await workspace.addRelationship({ referencingTableId: child.id, referencedTableId: renamed.id });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const parent = await supabase.from("Table test 1").insert({ Name: "Parent" }).select('"Name"').single();
		const childRecord = await supabase.from("test 2").insert({ table_test_1_id: 1 }).select("*").single();
		expect(parent.data).toEqual({ Name: "Parent" });
		expect(childRecord.error).toBeNull();
		const embeddedChild = await supabase.from("Table test 1").select('"Name", "test 2"(*)');
		expect(embeddedChild.error).toBeNull();
		expect(embeddedChild.data).toEqual([{ Name: "Parent", "test 2": [{ id: 1, table_test_1_id: 1 }] }]);
		const embeddedParent = await supabase.from("test 2").select('*, "Table test 1"(*)');
		expect(embeddedParent.error).toBeNull();
		expect(embeddedParent.data).toEqual([{ id: 1, table_test_1_id: 1, "Table test 1": { id: 1, Name: "Parent" } }]);
		const hintedChild = await supabase.from("Table test 1").select('"Name", "test 2"!"table_test_1_id"(*)');
		expect(hintedChild.error).toBeNull();
		expect(hintedChild.data).toEqual([{ Name: "Parent", "test 2": [{ id: 1, table_test_1_id: 1 }] }]);
		const hintedParent = await supabase.from("test 2").select('*, "Table test 1"!"table_test_1_id"(*)');
		expect(hintedParent.error).toBeNull();
		expect(hintedParent.data).toEqual([{ id: 1, table_test_1_id: 1, "Table test 1": { id: 1, Name: "Parent" } }]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("empty inserts use database defaults for one row and bulk rows", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		await workspace.addTable({ name: "DefaultRows" });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const one = await supabase.from("DefaultRows").insert({}).select("*").single();
		expect(one.error).toBeNull();
		expect(one.data).toEqual({ id: 1 });
		const many = await supabase.from("DefaultRows").insert([{}, {}]).select("*");
		expect(many.error).toBeNull();
		expect(many.data).toEqual([{ id: 2 }, { id: 3 }]);
		const required = await supabase.from("Books").insert({}).select("*");
		expect(required.error?.code).toBe("23502");
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("PostgreSQL SQLSTATE statuses follow the PostgREST v14 mapping through supabase-js", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		if (!books) throw new Error("Expected Books table.");
		await workspace.updateFunctions({ functions: [{
			id: "raise-status", name: "raise_status", arguments: [], returnType: "trigger", returnsSet: false,
			language: "plpgsql", volatility: "volatile", security: "invoker",
			body: "BEGIN RAISE EXCEPTION 'forced status' USING ERRCODE = NEW.title; END;",
		}] });
		await workspace.updateTriggers({ triggers: [{
			id: "raise-status-before-insert", name: "raise_status_before_insert", tableId: books.id, timing: "BEFORE",
			events: [{ event: "INSERT" }], level: "ROW", functionId: "raise-status", when: "",
		}] });
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const cases: [string, number][] = [
			["22P02", 400], ["42601", 400], ["42P01", 404], ["42883", 404], ["23000", 400],
			["23503", 409], ["23505", 409], ["23502", 400], ["23514", 400],
			["P0001", 400], ["25006", 405],
		];
		for (const [code, status] of cases) {
			const result = await clientFor(workspace, runId).from("Books").insert({ title: code });
			expect([code, result.status]).toEqual([code, status]);
			expect(result.error?.code).toBe(code);
		}
		const anon = await clientFor(workspace, runId).from("Books").insert({ title: "42501" });
		const authenticated = await clientFor(workspace, runId, { identity: { role: "authenticated", userId: "u1" } }).from("Books").insert({ title: "42501" });
		expect(anon.status).toBe(401);
		expect(authenticated.status).toBe(403);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("write representations match read serialization for PostgreSQL value types", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const table = workspace.getState().design?.tables.find((item) => item.name === "Books");
		if (!table) throw new Error("Expected Books table.");
		for (const [name, type] of [
			["recorded_at", "timestamptz"],
			["amount", "numeric"],
			["sequence", "bigint"],
			["payload", "jsonb"],
			["event_date", "date"],
		] as const) {
			await workspace.addColumn({ tableId: table.id, name, type });
		}
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const values = {
			title: "Serialized",
			recorded_at: "2025-01-02T03:04:05.123456Z",
			amount: "123456789012345.6789",
			sequence: "9007199254740993",
			payload: { nested: [1, "value"] },
			event_date: "2025-01-02",
		};
		const inserted = await supabase.from("Books").insert(values).select("*");
		expect(inserted.error).toBeNull();
		if (!inserted.data?.length) throw new Error("Expected inserted representation.");
		const selected = await supabase.from("Books").select("*").eq("id", inserted.data[0]!.id);
		expect(selected.error).toBeNull();
		expect(inserted.data!).toEqual(selected.data!);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("bulk inserts honor defaultToNull for heterogeneous record keys", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const itemsState = await workspace.addTable({ name: "Items" });
		const items = itemsState.design?.tables.find((table) => table.name === "Items");
		if (!items) throw new Error("Expected Items table.");
		const addedA = await workspace.addColumn({ tableId: items.id, name: "a", type: "text" });
		const columnA = addedA.design?.tables.find((table) => table.id === items.id)?.columns.find((column) => column.name === "a");
		const addedB = await workspace.addColumn({ tableId: items.id, name: "b", type: "text" });
		const columnB = addedB.design?.tables.find((table) => table.id === items.id)?.columns.find((column) => column.name === "b");
		if (!columnA || !columnB) throw new Error("Expected heterogeneous payload columns.");
		await workspace.updateColumn({
			tableId: items.id,
			columnId: columnA.id,
			changes: { default: { kind: "literal", literalType: "text", value: "default-a" } },
		});
		await workspace.updateColumn({
			tableId: items.id,
			columnId: columnB.id,
			changes: { default: { kind: "literal", literalType: "text", value: "default-b" } },
		});
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const useDefaults = await supabase.from("Items").insert([{ a: "first" }, { b: "second" }], { defaultToNull: false }).select("a,b");
		expect(useDefaults.error).toBeNull();
		expect(useDefaults.data).toEqual([{ a: "first", b: "default-b" }, { a: "default-a", b: "second" }]);
		const useNulls = await supabase.from("Items").insert([{ a: "third" }, { b: "fourth" }]).select("a,b");
		expect(useNulls.error).toBeNull();
		expect(useNulls.data).toEqual([{ a: "third", b: null }, { a: null, b: "fourth" }]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("the real supabase-js client reports foreign-key, one-to-one, and NO ACTION violations", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-relational-writes-"));
		directories.push(directory);
		const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Relationship writes" });
		const authorsState = await workspace.addTable({ name: "Authors" });
		const booksState = await workspace.addTable({ name: "Books" });
		const authors = authorsState.design?.tables.find((table) => table.name === "Authors");
		const books = booksState.design?.tables.find((table) => table.name === "Books");
		if (!authors || !books) throw new Error("Expected relationship tables.");
		const authorIdColumn = authors.columns.find((column) => column.name === "id");
		const bookIdColumn = books.columns.find((column) => column.name === "id");
		if (!authorIdColumn || !bookIdColumn) throw new Error("Expected primary-key columns.");
		await workspace.updateColumn({ tableId: authors.id, columnId: authorIdColumn.id, changes: { identity: false } });
		await workspace.updateColumn({ tableId: books.id, columnId: bookIdColumn.id, changes: { identity: false } });
		const relationshipState = await workspace.addRelationship({
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-one",
		});
		const relationship = relationshipState.design?.relationships[0];
		if (!relationship) throw new Error("Expected one-to-one relationship.");
		const authorId = relationshipState.design?.tables.find((table) => table.id === books.id)?.columns
			.find((column) => column.id === relationship.referencingColumnId)?.name;
		if (!authorId) throw new Error("Expected relationship-owned foreign key column.");
		const scenario = await workspace.createScenario({ name: "Relationship violations" });
		const run = await workspace.beginScenarioRun({ scenarioId: scenario.scenarios[0]!.id });
		const supabase = clientFor(workspace, run.runId);
		const author = await supabase.from("Authors").insert({ id: 1 }).select("id").single();
		expect(author.error).toBeNull();
		const orphan = await supabase.from("Books").insert({ id: 1, [authorId]: 999 }).select("*");
		expect(orphan.error).toMatchObject({ code: "23503" });
		const firstBook = await supabase.from("Books").insert({ id: 1, [authorId]: 1 }).select("*");
		expect(firstBook.error).toBeNull();
		const duplicatePair = await supabase.from("Books").insert({ id: 2, [authorId]: 1 }).select("*");
		const withAuthor = await supabase.from("Books").select(`id,Authors!${authorId}!inner(id)`).eq("id", 1).single();
		expect(withAuthor.error).toBeNull();
		expect(JSON.stringify(withAuthor.data)).toBe('{"id":1,"Authors":{"id":1}}');
		const updatedWithAuthor = await supabase.from("Books").update({ [authorId]: 1 }).eq("id", 1).select("id,Authors(id)");
		expect(updatedWithAuthor.error).toBeNull();
		expect(JSON.stringify(updatedWithAuthor.data)).toBe('[{"id":1,"Authors":{"id":1}}]');
		expect(duplicatePair.error).toMatchObject({ code: "23505" });
		const referencedDelete = await supabase.from("Authors").delete().eq("id", 1).select("*");
		expect(referencedDelete.error).toMatchObject({ code: "23503" });
		await workspace.finishScenarioRun({ runId: run.runId, status: "passed", console: [] });
	}, 60_000);
	test("the real supabase-js client embeds filtered and limited one-to-many resources", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		const authorsState = await workspace.addTable({ name: "Authors" });
		const authors = authorsState.design?.tables.find((table) => table.name === "Authors");
		if (!books || !authors) throw new Error("Expected Authors and Books tables.");
		await workspace.addColumn({ tableId: authors.id, name: "name", type: "text" });
		const relationState = await workspace.addRelationship({
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-many",
		});
		const relationship = relationState.design?.relationships[0];
		const authorColumn = relationState.design?.tables.find((table) => table.id === books.id)?.columns
			.find((column) => column.id === relationship?.referencingColumnId)?.name;
		if (!relationship || !authorColumn) throw new Error("Expected a foreign-key column.");
		const run = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, run.runId);
		const authorInsert = await supabase.from("Authors").insert([{ name: "First" }, { name: "Second" }]);
		const bookInsert = await supabase.from("Books").insert([
			{ title: "First", [authorColumn]: 1 },
			{ title: "Second", [authorColumn]: 1 },
			{ title: "Third", [authorColumn]: 1 },
		]);
		expect(authorInsert.error).toBeNull();
		expect(bookInsert.error).toBeNull();
		const result = await supabase.from("Authors")
			.select("id,Books(id,title)")
			.filter("Books.title", "eq", "Second")
			.order("title", { referencedTable: "Books", ascending: false })
			.limit(1, { referencedTable: "Books" })
			.order("id")
			.eq("id", 1)
			.single();
		expect(result.error).toBeNull();
		expect(JSON.stringify(result.data)).toBe('{"id":1,"Books":[{"id":2,"title":"Second"}]}');
		const inner = await supabase.from("Authors").select("id,Books!inner(id)").order("id");
		expect(JSON.stringify(inner.data)).toBe('[{"id":1,"Books":[{"id":1},{"id":2},{"id":3}]}]');
		const counted = await supabase.from("Authors").select("id,Books(id)", { count: "exact" }).order("id");
		expect(counted.error).toBeNull();
		expect(counted.count).toBe(2);
		expect(counted.data?.[0]?.Books).toHaveLength(3);
		const innerCounted = await supabase.from("Authors").select("id,Books!inner(id)", { count: "exact" });
		expect(innerCounted.error).toBeNull();
		expect(innerCounted.count).toBe(1);
	}, 60_000);
	test("the real supabase-js client embeds visible many-to-many related records", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((item) => item.name === "Books");
		const catalogState = await workspace.addTable({ name: "Catalog" });
		const catalog = catalogState.design?.tables.find((item) => item.name === "Catalog");
		if (!books || !catalog) throw new Error("Expected endpoint tables.");
		await workspace.addColumn({ tableId: catalog.id, name: "name", type: "text" });
		const relationState = await workspace.addRelationship({
			referencingTableId: books.id,
			referencedTableId: catalog.id,
			cardinality: "many-to-many",
		});
		const association = relationState.design?.manyToManyRelationships[0];
		const junction = relationState.design?.tables.find((table) => table.id === association?.junctionTableId);
		if (!association || !junction) throw new Error("Expected a visible junction table.");
		const junctionColumns = relationState.design!.relationships
			.filter((relationship) => relationship.referencingTableId === junction.id)
			.map((relationship) => junction.columns.find((column) => column.id === relationship.referencingColumnId)?.name);
		if (junctionColumns.length !== 2 || junctionColumns.some((column) => !column)) {
			throw new Error("Expected junction endpoint columns.");
		}
		expect(junction.name).toBe("BooksCatalog");
		expect(junctionColumns).toEqual(["book_id", "catalog_id"]);
		const run = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, run.runId);
		const book = await supabase.from("Books").insert({ title: "Related" }).select("id").single();
		const item = await supabase.from("Catalog").insert({ name: "Reference" }).select("id").single();
		if (!book.data || !item.data) throw new Error("Expected endpoint records.");
		const linked = await supabase.from("BooksCatalog").insert({ book_id: 1, catalog_id: 1 });
		expect(linked.error).toBeNull();
		const embedded = await supabase.from("Books").select("id,Catalog(id,name)").eq("id", 1).single();
		expect(embedded.error).toBeNull();
		expect(JSON.stringify(embedded.data)).toBe('{"id":1,"Catalog":[{"id":1,"name":"Reference"}]}');
		const inner = await supabase.from("Books").select("id,Catalog!inner(id)").eq("id", 1).single();
		expect(JSON.stringify(inner.data)).toBe('{"id":1,"Catalog":[{"id":1}]}');
		await workspace.finishScenarioRun({ runId: run.runId, status: "passed", console: [] });
	}, 60_000);
	test("ambiguous embeds return the PostgREST PGRST201 response and foreign-key hints resolve it", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		const authorsState = await workspace.addTable({ name: "Authors" });
		const authors = authorsState.design?.tables.find((table) => table.name === "Authors");
		if (!books || !authors) throw new Error("Expected Authors and Books tables.");
		await workspace.addRelationship({ referencingTableId: books.id, referencedTableId: authors.id });
		await workspace.addRelationship({ referencingTableId: books.id, referencedTableId: authors.id });
		const run = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, run.runId);
		const ambiguous = await supabase.from("Books").select("id,Authors(id)");
		expect(ambiguous.error?.code).toBe("PGRST201");
		expect(ambiguous.status).toBe(300);
		expect(Array.isArray(ambiguous.error?.details)).toBe(true);
		const disambiguated = await supabase.from("Books").select("id,Authors!Books_author_id_fkey(id)");
		expect(disambiguated.error).toBeNull();
		expect(disambiguated.data).toEqual([]);
		await workspace.finishScenarioRun({ runId: run.runId, status: "passed", console: [] });
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
		const unsupported = await firstClient.from("Books").select("*").filter("id", "fts", "temporary");
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
	test("RLS policies filter rows by auth.uid(), reject other owners, and service_role bypasses RLS", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		if (!books) throw new Error("Expected Books table.");
		await workspace.addColumn({ tableId: books.id, name: "owner_id", type: "uuid" });
		const enabled = await workspace.updatePolicies({
			tableId: books.id,
			rowLevelSecurity: true,
			policies: [{
				id: "owner-policy",
				name: "owner_access",
				command: "ALL",
				roles: ["authenticated"],
				mode: "permissive",
				using: "owner_id = auth.uid()",
				withCheck: "owner_id = auth.uid()",
			}],
		});
		expect(enabled.sandbox.status).toBe("applied");
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const alice = clientFor(workspace, runId, { identity: { role: "authenticated", sub: "11111111-1111-4111-8111-111111111111" } });
		const bob = clientFor(workspace, runId, { identity: { role: "authenticated", sub: "22222222-2222-4222-8222-222222222222" } });
		const service = clientFor(workspace, runId, { identity: { role: "service_role" } });
		const inserted = await alice.from("Books").insert({
			title: "Alice's book",
			owner_id: "11111111-1111-4111-8111-111111111111",
		}).select("*");
		expect(inserted.error).toBeNull();
		expect((await alice.from("Books").select("*")).data).toHaveLength(1);
		expect((await bob.from("Books").select("*")).data).toEqual([]);
		const refused = await bob.from("Books").insert({
			title: "Not Bob's",
			owner_id: "11111111-1111-4111-8111-111111111111",
		}).select("*");
		expect(refused.error?.code).toBe("42501");
		expect((await service.from("Books").select("*")).data).toHaveLength(1);
		const anonymous = clientFor(workspace, runId);
		expect((await anonymous.from("Books").select("*")).data).toEqual([]);
		const deniedAnonInsert = await anonymous.from("Books").insert({
			title: "Anonymous",
			owner_id: "11111111-1111-4111-8111-111111111111",
		}).select("*");
		expect(deniedAnonInsert.error?.code).toBe("42501");
		expect(workspace.getState().scenarioRuns[scenarioId]?.requests.map((entry) => entry.identity.role))
			.toEqual(["authenticated", "authenticated", "authenticated", "authenticated", "service_role", "anon", "anon"]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("policies are inert until row-level security is enabled", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const table = workspace.getState().design?.tables.find((candidate) => candidate.name === "Books");
		if (!table) throw new Error("Expected Books table.");
		await workspace.updatePolicies({
			tableId: table.id,
			rowLevelSecurity: false,
			policies: [{
				id: "deny-everything", name: "deny_everything", command: "ALL", roles: ["anon"],
				mode: "permissive", using: "false", withCheck: "false",
			}],
		});
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const anonymous = clientFor(workspace, runId);
		const inserted = await anonymous.from("Books").insert({ title: "Still public" }).select("*");
		expect(inserted.error).toBeNull();
		expect(inserted.data).toEqual([{ id: 1, title: "Still public" }]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
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

	test("expectations report every outcome, fail the run when unmet, and keep exceptions errored", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const driver = scenarioDriverFor(workspace);
		const runScenario = async (source: string) => {
			const result = await driver.run({ id: scenarioId, name: "Expectation fixture", source });
			if (!result) throw new Error("Expected the Scenario run to finish.");
			return { result, run: workspace.getState().scenarioRuns[scenarioId] };
		};
		try {
			const met = await runScenario(`
				const inserted = await supabase.from("Books").insert({ title: "expected" }).select("*");
				expect(inserted).succeeds();
				expect(inserted).returnsDataEqual([{ id: 1, title: "expected" }]);
				const rejected = await supabase.from("Books").insert({ title: null }).select("*");
				expect(rejected).fails("23502");
			`);
			expect(met.result).toMatchObject({ status: "passed", expectations: [{ passed: true }, { passed: true }, { passed: true }] });
			expect(met.run?.status).toBe("passed");

			const unmet = await runScenario(`
				const result = await supabase.from("Books").insert({ title: "actual" }).select("*");
				expect(result).fails("23505");
				expect(result).returnsDataEqual([]);
			`);
			expect(unmet.result).toMatchObject({ status: "failed", expectations: [{ passed: false }, { passed: false }] });
			expect(unmet.run).toMatchObject({ status: "failed", expectations: [{ passed: false }, { passed: false }] });

			const exception = await runScenario(`throw new Error("scenario broke");`);
			expect(exception.result.status).toBe("errored");
			expect(exception.run?.status).toBe("errored");
			const invalidInputs = await runScenario(`
				const pending = supabase.from("Books").insert({ title: "must not execute" });
				expect(pending).succeeds();
				expect(pending).fails("23502");
				expect(pending).returnsDataEqual([]);
				expect(null).succeeds();
				expect(undefined).fails();
				expect(42).returnsDataEqual(42);
			`);
			expect(invalidInputs.result).toMatchObject({
				status: "failed",
				expectations: [
					{ passed: false, message: "expect() received a pending request; await it first" },
					{ passed: false, message: "expect() received a pending request; await it first" },
					{ passed: false, message: "expect() received a pending request; await it first" },
					{ passed: false, message: "expect() requires an awaited request result" },
					{ passed: false, message: "expect() requires an awaited request result" },
					{ passed: false, message: "expect() requires an awaited request result" },
				],
			});
			expect(invalidInputs.run).toMatchObject({ status: "failed", expectations: expect.any(Array) });
		} finally {
			driver.dispose();
		}
	}, 30_000);
	test("identity clients retain runner lockdown, expectations, and public grants", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const driver = scenarioDriverFor(workspace);
		try {
			const result = await driver.run({
				id: scenarioId,
				name: "Identity clients",
				source: `
					console.log(typeof fetch, typeof WebSocket, typeof expect);
					const anonymous = await supabase.from("Books").insert({ title: "anonymous" }).select("*");
					expect(anonymous).succeeds();
					const member = await asUser("9f8c5c8b-5e8d-4bb9-8e0d-a8f8a3fb8e14", { app_metadata: { plan: "pro" } })
						.from("Books").insert({ title: "member" }).select("*");
					expect(member).succeeds();
					const privileged = await asServiceRole().from("Books").insert({ title: "service" }).select("*");
					expect(privileged).succeeds();
					console.log(typeof fetch, typeof WebSocket);
				`,
			});
			expect(result).toMatchObject({
				status: "passed",
				console: ["undefined undefined function", "undefined undefined"],
				expectations: [{ passed: true }, { passed: true }, { passed: true }],
			});
			const identities = workspace.getState().scenarioRuns[scenarioId]?.requests.map(({ identity }) => identity);
			expect(identities).toEqual([
				{ role: "anon", claims: { role: "anon" } },
				{
					role: "authenticated",
					userId: "9f8c5c8b-5e8d-4bb9-8e0d-a8f8a3fb8e14",
					claims: {
						app_metadata: { plan: "pro" },
						role: "authenticated",
						sub: "9f8c5c8b-5e8d-4bb9-8e0d-a8f8a3fb8e14",
						user_id: "9f8c5c8b-5e8d-4bb9-8e0d-a8f8a3fb8e14",
					},
				},
				{ role: "service_role", claims: { role: "service_role" } },
			]);
		} finally {
			driver.dispose();
		}
	}, 60_000);


	test("scenario source executes inside a real Worker and transports requests through the workspace", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const driver = scenarioDriverFor(workspace);
		try {
			const result = await driver.run({
				id: scenarioId,
				name: "Worker transport",
				source: 'const label: string = "worker"; const result = await supabase.from("Books").insert({ title: "from worker" }).select("*"); console.log(label, result.data);',
			});
			expect(result).toMatchObject({
				status: "passed",
				console: ['worker [{"id":1,"title":"from worker"}]'],
				requests: [{ method: "POST" }],
			});
			expect(workspace.getState().scenarioRuns[scenarioId]?.requests).toHaveLength(1);
		} finally {
			driver.dispose();
		}
	}, 60_000);
	test("the runner permits type-only imports and removes worker network primitives", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const worker = new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" });
		const { promise, resolve, reject } = Promise.withResolvers<{ status: string; console: string[] }>();
		const timeout = setTimeout(() => reject(new Error("Scenario Worker did not finish")), 10_000);
		worker.onerror = (event) => reject(new Error(event.message));
		worker.onmessage = ({ data }: MessageEvent) => {
			if (data.type === "finished") resolve(data);
		};
		worker.postMessage({
			type: "start",
			runId,
			source: 'import type { Missing } from "missing-package"; console.log(typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof importScripts);',
		});
		try {
			expect(await promise).toMatchObject({ status: "passed", console: ["undefined undefined undefined undefined"] });
		} finally {
			clearTimeout(timeout);
			worker.terminate();
			await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
		}
	}, 60_000);

	test("the runner refuses runtime imports before executing scenario code", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const worker = new Worker(new URL("../mainview/scenario-worker.ts", import.meta.url), { type: "module" });
		const { promise, resolve, reject } = Promise.withResolvers<{ status: string; reason: string; console: string[] }>();
		const timeout = setTimeout(() => reject(new Error("Scenario Worker did not finish")), 10_000);
		worker.onerror = (event) => reject(new Error(event.message));
		worker.onmessage = ({ data }: MessageEvent) => {
			if (data.type === "finished") resolve(data);
		};
		worker.postMessage({
			type: "start",
			runId,
			source: 'import { something } from "missing-package"; console.log("must not execute");',
		});
		try {
			expect(await promise).toMatchObject({
				status: "errored",
				reason: "exception",
				console: ["Scenarios may only import types; runtime imports are not supported."],
			});
		} finally {
			clearTimeout(timeout);
			worker.terminate();
			await workspace.finishScenarioRun({ runId, status: "errored", reason: "exception", console: [] });
		}
	}, 60_000);

	test("core reads project columns, apply PostgREST filters and sorting, and paginate", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const responses: Response[] = [];
		const supabase = clientFor(workspace, runId, { responses });
		await supabase.from("Books").insert({ title: "Alpha" }).select("*");
		await supabase.from("Books").insert({ title: "Beta" }).select("*");
		await supabase.from("Books").insert({ title: "Alpine" }).select("*");
		await supabase.from("Books").insert({ title: "Gamma" }).select("*");

		const projected = await supabase.from("Books").select("title").eq("id", 1);
		expect(projected.data).toEqual([{ title: "Alpha" }]);
		const compound = await supabase.from("Books").select("*")
			.gte("id", 2).lte("id", 4).neq("title", "Gamma").order("id", { ascending: false });
		expect(compound.data).toEqual([{ id: 3, title: "Alpine" }, { id: 2, title: "Beta" }]);
		const alternatives = await supabase.from("Books").select("*").or("title.eq.Alpha,title.eq.Gamma").order("id");
		expect(alternatives.data).toEqual([{ id: 1, title: "Alpha" }, { id: 4, title: "Gamma" }]);
		const matched = await supabase.from("Books").select("*").like("title", "Al%").order("id").range(1, 1);
		expect(matched.data).toEqual([{ id: 3, title: "Alpine" }]);
		expect(matched.count).toBeNull();
		expect(matched).toMatchObject({ error: null, status: 200 });
		const limited = await supabase.from("Books").select("*").order("id").limit(2);
		expect(limited.data).toEqual([{ id: 1, title: "Alpha" }, { id: 2, title: "Beta" }]);
		expect(limited.status).toBe(200);
		const supabaseWithOffset = clientFor(workspace, runId, { offset: 1 });
		const offset = await supabaseWithOffset.from("Books").select("*").order("id").limit(1);
		expect(offset.data).toEqual([{ id: 2, title: "Beta" }]);
		expect(offset.status).toBe(200);
		const emptyPage = await supabase.from("Books").select("*").eq("id", 99).range(0, 1);
		expect(emptyPage.data).toEqual([]);
		expect(emptyPage.status).toBe(200);
		expect(responses[responses.length - 1]?.headers.get("content-range")).toBe("*/*");
		const likeWildcard = await supabase.from("Books").select("title").like("title", "Al*").order("id");
		expect(likeWildcard.data).toEqual([{ title: "Alpha" }, { title: "Alpine" }]);
		const ilikeWildcard = await supabase.from("Books").select("title").ilike("title", "al*").order("id");
		expect(ilikeWildcard.data).toEqual([{ title: "Alpha" }, { title: "Alpine" }]);
		const clientWithoutSelect = clientFor(workspace, runId, { stripSelect: true });
		const implicitAllColumns = await clientWithoutSelect.from("Books").select("*").order("id");
		expect(implicitAllColumns.data).toEqual([
			{ id: 1, title: "Alpha" }, { id: 2, title: "Beta" }, { id: 3, title: "Alpine" }, { id: 4, title: "Gamma" },
		]);
		const comparative = await supabase.from("Books").select("*").gt("id", 1).lt("id", 4).order("id");
		expect(comparative.data).toEqual([{ id: 2, title: "Beta" }, { id: 3, title: "Alpine" }]);
		const included = await supabase.from("Books").select("*").in("id", [1, 3]).order("id");
		expect(included.data).toEqual([{ id: 1, title: "Alpha" }, { id: 3, title: "Alpine" }]);
		const omitted = await supabase.from("Books").select("*").not("id", "eq", 1).order("id").limit(2);
		expect(omitted.data).toEqual([{ id: 2, title: "Beta" }, { id: 3, title: "Alpine" }]);
		const insensitive = await supabase.from("Books").select("*").ilike("title", "al%");
		expect(insensitive.data).toEqual([{ id: 1, title: "Alpha" }, { id: 3, title: "Alpine" }]);
		const nulls = await supabase.from("Books").select("*").is("title", null);
		expect(nulls.data).toEqual([]);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
		expect(workspace.getState().scenarioRuns[scenarioId]?.requests[7]?.status).toBe(200);
	}, 30_000);

	test("single and maybeSingle return object responses with PostgREST cardinality errors", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		await supabase.from("Books").insert({ title: "Only" }).select("*");
		const one = await supabase.from("Books").select("id,title").eq("id", 1).single();
		expect(one.data).toEqual({ id: 1, title: "Only" });
		const absent = await supabase.from("Books").select("*").eq("id", 99).maybeSingle();
		expect(absent.data).toBeNull();
		expect(absent.error).toBeNull();
		const absentSingle = await supabase.from("Books").select("*").eq("id", 99).single();
		expect(absentSingle.error?.code).toBe("PGRST116");
		expect(absentSingle.status).toBe(406);
		await supabase.from("Books").insert({ title: "Second" }).select("*");
		const multiple = await supabase.from("Books").select("*").order("id").single();
		expect(multiple.error?.code).toBe("PGRST116");
		expect(multiple.status).toBe(406);
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
		expect(workspace.getState().scenarioRuns[scenarioId]?.requests.slice(1).map((request) => request.status)).toEqual([200, 200, 406, 201, 406]);
	}, 30_000);

	test("unsupported read projections are refused and missing embeds return PGRST200", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const [embedding, alias, jsonPath] = await Promise.all([
			supabase.from("Books").select("Authors(*)"),
			supabase.from("Books").select("label:title"),
			supabase.from("Books").select("metadata->name"),
		]);
		expect(embedding.error?.code).toBe("PGRST200");
		expect(embedding.status).toBe(400);
		expect(embedding.error?.hint).toContain("foreign key relationship");
		for (const result of [alias, jsonPath]) {
			expect(result.error?.code).toBe("PGRST_SANDBOX_UNSUPPORTED");
			expect(result.error?.message).toContain("not supported by the sandbox");
		}
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 30_000);
	test("exact counts include filtered totals across pagination, HEAD, empty results, writes, and RLS", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const table = workspace.getState().design?.tables.find((item) => item.name === "Books");
		if (!table) throw new Error("Expected Books table.");
		await workspace.addColumn({ tableId: table.id, name: "owner_id", type: "uuid" });
		await workspace.updatePolicies({
			tableId: table.id,
			rowLevelSecurity: true,
			policies: [{
				id: "own-books", name: "own_books", command: "ALL", roles: ["authenticated"],
				mode: "permissive", using: "owner_id = auth.uid()", withCheck: "owner_id = auth.uid()",
			}],
		});
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const aliceId = "11111111-1111-4111-8111-111111111111";
		const alice = clientFor(workspace, runId, { identity: { role: "authenticated", sub: aliceId } });
		const inserted = await alice.from("Books").insert([
			{ title: "One", owner_id: aliceId },
			{ title: "Two", owner_id: aliceId },
		]).select("*");
		expect(inserted.error).toBeNull();
		const filtered = await alice.from("Books").select("*", { count: "exact" }).eq("owner_id", aliceId);
		expect(filtered.count).toBe(2);
		expect(filtered.data).toHaveLength(2);
		expect(filtered.status).toBe(200);

		const ranged = await alice.from("Books").select("*", { count: "exact" }).eq("owner_id", aliceId).order("id").range(1, 1);
		expect(ranged.data).toEqual([{ id: 2, title: "Two", owner_id: aliceId }]);
		expect(ranged.count).toBe(2);
		expect(ranged.status).toBe(206);

		const limited = await alice.from("Books").select("*", { count: "exact" }).eq("owner_id", aliceId).order("id").limit(1);
		expect(limited.data).toEqual([{ id: 1, title: "One", owner_id: aliceId }]);
		expect(limited.count).toBe(2);
		expect(limited.status).toBe(206);

		const head = await alice.from("Books").select("*", { count: "exact", head: true }).eq("owner_id", aliceId);
		expect(head.data).toBeNull();
		expect(head.count).toBe(2);
		expect(head.status).toBe(200);

		const emptyResponses: Response[] = [];
		const emptyClient = clientFor(workspace, runId, { responses: emptyResponses, identity: { role: "authenticated", sub: aliceId } });
		const empty = await emptyClient.from("Books").select("*", { count: "exact" }).eq("owner_id", "22222222-2222-4222-8222-222222222222");
		expect(empty.data).toEqual([]);
		expect(empty.count).toBe(0);
		expect(emptyResponses[0]?.headers.get("content-range")).toBe("*/0");
		const anonymous = clientFor(workspace, runId);
		const hidden = await anonymous.from("Books").select("*", { count: "exact" });
		expect(hidden.data).toEqual([]);
		expect(hidden.count).toBe(0);
		expect(empty.status).toBe(200);

		const writeResponses: Response[] = [];
		const countedWriter = clientFor(workspace, runId, { responses: writeResponses, identity: { role: "authenticated", sub: aliceId } });
		const write = await countedWriter.from("Books").update({ title: "Changed" }, { count: "exact" }).eq("owner_id", aliceId);
		expect(write.count).toBe(2);
		expect(write.status).toBe(204);
		expect(writeResponses[0]?.headers.get("content-range")).toBe("*/2");
		const rangeResponses: Response[] = [];
		const capture = clientFor(workspace, runId, { responses: rangeResponses, identity: { role: "authenticated", sub: aliceId } });
		await capture.from("Books").select("*", { count: "exact" }).eq("owner_id", aliceId).range(1, 1);
		expect(rangeResponses[0]?.headers.get("content-range")).toBe("1-1/2");
		const deleted = await countedWriter.from("Books").delete({ count: "exact" }).eq("owner_id", aliceId);
		expect(deleted.count).toBe(2);
		expect(deleted.status).toBe(204);
		expect(writeResponses[1]?.headers.get("content-range")).toBe("*/2");
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("real supabase-js calls Functions with named arguments, composite and set results, and request identity", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const configured = await workspace.updateFunctions({ functions: [
			{ id: "sum-ints", name: "sum_ints", arguments: [{ name: "a", type: "integer" }, { name: "b", type: "integer" }], returnType: "integer", returnsSet: false, language: "sql", volatility: "immutable", security: "invoker", body: "SELECT a + b" },
			{ id: "who-am-i", name: "who_am_i", arguments: [], returnType: "uuid", returnsSet: false, language: "sql", volatility: "stable", security: "invoker", body: "SELECT auth.uid()" },
			{ id: "get-book", name: "get_book", arguments: [{ name: "book_id", type: "integer" }], returnType: "Books", returnsSet: false, language: "sql", volatility: "stable", security: "invoker", body: 'SELECT * FROM "Books" WHERE id = book_id' },
			{ id: "list-books", name: "list_books", arguments: [], returnType: "Books", returnsSet: true, language: "sql", volatility: "stable", security: "invoker", body: 'SELECT * FROM "Books" ORDER BY id' },
			{ id: "table-rows", name: "table_rows", arguments: [], returnType: "TABLE (id bigint, label text)", returnsSet: true, language: "sql", volatility: "stable", security: "invoker", body: "SELECT 7::bigint, 'row'::text" },
			{ id: "mark-run", name: "mark_run", arguments: [], returnType: "void", returnsSet: false, language: "plpgsql", volatility: "volatile", security: "invoker", body: "BEGIN RETURN; END;" },
		] });
		expect(configured.revision).toBeGreaterThan(1);
		expect(configured.sandbox.status).toBe("applied");
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		await supabase.from("Books").insert({ title: "A" }).select("*");
		const sum = await supabase.rpc("sum_ints", { a: 20, b: 22 });
		expect(sum.error).toBeNull();
		expect(sum.data).toBe(42);
		const stableGet = await supabase.rpc("sum_ints", { a: 1, b: 2 }, { get: true });
		expect(stableGet.data).toBe(3);
		const get = await supabase.rpc("get_book", { book_id: 1 });
		expect(get.error).toBeNull();
		expect(get.data).toEqual({ id: 1, title: "A" });
		const list = await supabase.rpc("list_books");
		expect(list.error).toBeNull();
		expect(list.data).toEqual([{ id: 1, title: "A" }]);
		const tableRows = await supabase.rpc("table_rows");
		expect(tableRows.error).toBeNull();
		expect(tableRows.data).toEqual([{ id: 7, label: "row" }]);
		const voidResult = await supabase.rpc("mark_run");
		expect(voidResult.error).toBeNull();
		expect(voidResult.data).toBeNull();
		const identity = clientFor(workspace, runId, { identity: { role: "authenticated", sub: "10e4c1e5-1fed-49c4-8a06-71e25b160782" } });
		const userId = await identity.rpc("who_am_i");
		expect(userId.error).toBeNull();
		expect(userId.data).toBe("10e4c1e5-1fed-49c4-8a06-71e25b160782");
		const unknown = await supabase.rpc("missing_function");
		expect(unknown.error?.code).toBe("PGRST202");
		const requests = workspace.getState().scenarioRuns[scenarioId]?.requests ?? [];
		expect(requests[requests.length - 1]).toMatchObject({
			table: "rpc/missing_function",
			status: 404,
			result: { code: "PGRST202" },
		});
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
	test("RPC composite and set results serialize embedded resources like table reads", async () => {
		const { workspace, scenarioId } = await openWorkspace();
		const books = workspace.getState().design?.tables.find((table) => table.name === "Books");
		const authorsState = await workspace.addTable({ name: "Authors" });
		const authors = authorsState.design?.tables.find((table) => table.name === "Authors");
		if (!books || !authors) throw new Error("Expected Authors and Books tables.");
		const authorPrimaryKey = authors.columns.find((column) => column.name === "id");
		if (!authorPrimaryKey) throw new Error("Expected the Authors primary key.");
		await workspace.updateColumn({ tableId: authors.id, columnId: authorPrimaryKey.id, changes: { identity: false } });
		const relationshipState = await workspace.addRelationship({
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-one",
		});
		const relationship = relationshipState.design?.relationships[0];
		if (!relationship) throw new Error("Expected the Books-to-Authors relationship.");
		const authorColumn = relationshipState.design?.tables.find((table) => table.id === books.id)?.columns
			.find((column) => column.id === relationship.referencingColumnId);
		if (!authorColumn) throw new Error("Expected the relationship-owned author column.");
		const configured = await workspace.updateFunctions({ functions: [
			{
				id: "book-by-id",
				name: "book_by_id",
				arguments: [{ name: "book_id", type: "integer" }],
				returnType: "Books",
				returnsSet: false,
				language: "sql",
				volatility: "stable",
				security: "invoker",
				body: 'SELECT * FROM "Books" WHERE id = book_id',
			},
			{
				id: "books-with-authors",
				name: "books_with_authors",
				arguments: [],
				returnType: "Books",
				returnsSet: true,
				language: "sql",
				volatility: "stable",
				security: "invoker",
				body: 'SELECT * FROM "Books"',
			},
		] });
		expect(configured.sandbox.status).toBe("applied");
		const { runId } = await workspace.beginScenarioRun({ scenarioId });
		const supabase = clientFor(workspace, runId);
		const author = await supabase.from("Authors").insert({ id: 1 }).select("id");
		expect(author.error).toBeNull();
		expect(author.data).toEqual([{ id: 1 }]);
		const book = await supabase.from("Books").insert({
			title: "RPC embedding",
			[authorColumn.name]: 1,
		}).select("id");
		expect(book.error).toBeNull();
		expect(book.data).toEqual([{ id: 1 }]);
		const single = await supabase.rpc("book_by_id", { book_id: 1 }).select("id,Authors(id)");
		expect(single.error).toBeNull();
		expect(JSON.stringify(single.data)).toBe('{"id":1,"Authors":{"id":1}}');
		const set = await supabase.rpc("books_with_authors").select("id,Authors(id)");
		expect(set.error).toBeNull();
		expect(JSON.stringify(set.data)).toBe('[{"id":1,"Authors":{"id":1}}]');
		const unsupportedFilter = await supabase.rpc("books_with_authors", {}, { get: true }).eq("id", 1);
		expect(unsupportedFilter.error?.code).toBe("PGRST_SANDBOX_UNSUPPORTED");
		await workspace.finishScenarioRun({ runId, status: "passed", console: [] });
	}, 60_000);
});
