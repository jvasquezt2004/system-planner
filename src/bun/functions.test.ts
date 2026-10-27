import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { generateDesignSql } from "./sql";

const workspaces: DesignWorkspace[] = [];
const directories: string[] = [];

async function openWorkspace(databasePath?: string) {
	const directory = databasePath ? null : mkdtempSync(join(tmpdir(), "db-planner-functions-"));
	const path = databasePath ?? join(directory!, "design.sqlite");
	if (directory) directories.push(directory);
	const workspace = await createDesignWorkspace({ databasePath: path });
	workspaces.push(workspace);
	return workspace;
}

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project Functions", () => {
	test("Function edits are structural, undoable, persisted, and rejected bodies keep the draft", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-functions-persist-"));
		directories.push(directory);
		const path = join(directory, "design.sqlite");
		const workspace = await openWorkspace(path);
		await workspace.createProject({ name: "Function project" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const fn = {
			id: "book-count",
			name: "book_count",
			arguments: [],
			returnType: "integer",
			returnsSet: false,
			language: "sql" as const,
			volatility: "stable" as const,
			security: "invoker" as const,
			body: 'SELECT count(*)::integer FROM "Books"',
		};
		const added = await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [fn] });
		expect(added.revision).toBeGreaterThan(1);
		expect(added.sandbox.status).toBe("applied");
		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.design?.functions ?? []).toEqual([]);
		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(redone.design?.functions?.[0]).toMatchObject(fn);
		const rejected = await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [{ ...fn, body: "SELECT (" }] });
		expect(rejected.design?.functions?.[0]?.body).toBe("SELECT (");
		expect(rejected.sandbox).toMatchObject({ status: "failed", failure: "sql-rejected" });
		await workspace.close();
		workspaces.splice(workspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(path);
		expect(reopened.getState().design?.functions?.[0]?.body).toBe("SELECT (");
		expect(reopened.getState().sandbox.status).toBe("failed");
	}, 60_000);
	test("removing a referenced table does not silently apply a broken Function draft", async () => {
		const workspace = await openWorkspace();
		await workspace.createProject({ name: "Function dependency" });
		const withTable = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const table = withTable.design!.tables[0]!;
		const withFunction = await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [{
			id: "book-count",
			name: "book_count",
			arguments: [],
			returnType: "Books",
			returnsSet: false,
			language: "sql",
			volatility: "stable",
			security: "invoker",
			body: 'SELECT NULL::"Books"',
		}] });
		expect(withFunction.sandbox.status).toBe("applied");
		const removed = await workspace.removeTable({ designId: workspace.getState().activeDesignId!, tableId: table.id });
		expect(removed.design?.tables).toEqual([]);
		expect(removed.design?.functions?.[0]?.name).toBe("book_count");
		expect(removed.sql.status).toBe("stale");
		if (removed.sql.status !== "stale") throw new Error("Expected the blocked SQL preview.");
		expect(removed.sql.errors).toContainEqual(expect.stringContaining("depends on a table"));
	}, 60_000);
	test("Triggers are structural, undoable, persisted, rejected drafts are retained, and dependencies require confirmation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-triggers-"));
		directories.push(directory);
		const path = join(directory, "design.sqlite");
		let workspace = await openWorkspace(path);
		await workspace.createProject({ name: "Trigger project" });
		const withTable = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const table = withTable.design!.tables[0]!;
		const withFunction = await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [{
			id: "set-title", name: "set_title", arguments: [], returnType: "trigger", returnsSet: false,
			language: "plpgsql", volatility: "volatile", security: "invoker",
			body: "BEGIN RETURN NEW; END;",
		}] });
		expect(withFunction.sandbox.status).toBe("applied");
		const trigger = {
			id: "before-insert", name: "before_insert", tableId: table.id, timing: "BEFORE" as const,
			events: [{ event: "INSERT" as const }], level: "ROW" as const, functionId: "set-title", when: "",
		};
		const applied = await workspace.updateTriggers({ designId: workspace.getState().activeDesignId!, triggers: [trigger] });
		expect(applied.sandbox.status).toBe("applied");
		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.design?.triggers ?? []).toEqual([]);
		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(redone.design?.triggers).toEqual([trigger]);
		await workspace.close();
		workspaces.splice(workspaces.indexOf(workspace), 1);
		workspace = await openWorkspace(path);
		expect(workspace.getState().design?.triggers).toEqual([trigger]);
		const rejected = await workspace.updateTriggers({ designId: workspace.getState().activeDesignId!, triggers: [{ ...trigger, when: "missing_column > 0" }] });
		expect(rejected.design?.triggers?.[0]?.when).toBe("missing_column > 0");
		expect(rejected.sandbox).toMatchObject({ status: "failed", failure: "sql-rejected" });
		expect(workspace.describeRemoval({ designId: workspace.getState().activeDesignId!, kind: "table", tableId: table.id }).triggers).toEqual([
			{ triggerId: trigger.id, name: trigger.name, table: "Books" },
		]);
		await expect(workspace.removeTable({ designId: workspace.getState().activeDesignId!, tableId: table.id })).rejects.toThrow(/trigger before_insert/);
		expect(workspace.describeRemoval({ designId: workspace.getState().activeDesignId!, kind: "function", functionId: "set-title" }).triggers).toEqual([
			{ triggerId: trigger.id, name: trigger.name, table: "Books" },
		]);
		await expect(workspace.removeFunction({ designId: workspace.getState().activeDesignId!, functionId: "set-title" })).rejects.toThrow(/trigger before_insert/);
		const removed = await workspace.removeFunction({ designId: workspace.getState().activeDesignId!, functionId: "set-title", confirmed: true });
		expect(removed.design?.triggers).toEqual([]);
		expect(removed.design?.functions).toEqual([]);
		await workspace.close();
		workspaces.splice(workspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(path);
		expect(reopened.getState().design?.triggers).toEqual([]);
	}, 60_000);
	test("confirmed table removal removes its dependent Trigger, and undo restores valid SQL", async () => {
		const workspace = await openWorkspace();
		await workspace.createProject({ name: "Table trigger removal" });
		const withTable = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const table = withTable.design!.tables[0]!;
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" });
		await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [{
			id: "table-handler", name: "table_handler", arguments: [], returnType: "trigger", returnsSet: false,
			language: "plpgsql", volatility: "volatile", security: "invoker", body: "BEGIN RETURN NEW; END;",
		}] });
		const trigger = {
			id: "table-trigger", name: "books_insert", tableId: table.id, timing: "AFTER" as const,
			events: [{ event: "INSERT" as const }], level: "ROW" as const, functionId: "table-handler", when: "",
		};
		await workspace.updateTriggers({ designId: workspace.getState().activeDesignId!, triggers: [trigger] });
		expect(workspace.describeRemoval({ designId: workspace.getState().activeDesignId!, kind: "table", tableId: table.id }).triggers).toEqual([
			{ triggerId: trigger.id, name: trigger.name, table: "Books" },
		]);
		const removed = await workspace.removeTable({ designId: workspace.getState().activeDesignId!, tableId: table.id, confirmed: true });
		expect(removed.design?.triggers).toEqual([]);
		expect(removed.sql).toMatchObject({ status: "current" });
		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.design?.triggers).toEqual([trigger]);
		expect(undone.sql.status).toBe("current");
	}, 60_000);

	test("confirmed column removal drops an empty UPDATE OF filter and undo restores it", async () => {
		const workspace = await openWorkspace();
		await workspace.createProject({ name: "Column trigger removal" });
		const withTable = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const table = withTable.design!.tables[0]!;
		const withColumn = await workspace.addColumn({ designId: workspace.getState().activeDesignId!, tableId: table.id, name: "title", type: "text" });
		const title = withColumn.design!.tables[0]!.columns.find((column) => column.name === "title")!;
		await workspace.updateFunctions({ designId: workspace.getState().activeDesignId!, functions: [{
			id: "column-handler", name: "column_handler", arguments: [], returnType: "trigger", returnsSet: false,
			language: "plpgsql", volatility: "volatile", security: "invoker", body: "BEGIN RETURN NEW; END;",
		}] });
		const trigger = {
			id: "column-trigger", name: "books_title_update", tableId: table.id, timing: "AFTER" as const,
			events: [{ event: "UPDATE" as const, columnIds: [title.id] }], level: "ROW" as const,
			functionId: "column-handler", when: "",
		};
		await workspace.updateTriggers({ designId: workspace.getState().activeDesignId!, triggers: [trigger] });
		const invalidDesign = {
			...workspace.getState().design!,
			triggers: [{ ...trigger, events: [{ event: "UPDATE" as const, columnIds: ["missing-column"] }] }],
		};
		const invalidSql = generateDesignSql(invalidDesign);
		expect(invalidSql).toMatchObject({ ok: false });
		if (invalidSql.ok) throw new Error("Expected SQL validation to reject the missing trigger column.");
		expect(invalidSql.errors).toContainEqual(expect.stringContaining('Trigger "books_title_update" references a column'));
		expect(workspace.describeRemoval({ designId: workspace.getState().activeDesignId!, kind: "column", tableId: table.id, columnId: title.id }).triggers).toEqual([
			{ triggerId: trigger.id, name: trigger.name, table: "Books" },
		]);
		const removed = await workspace.removeColumn({ designId: workspace.getState().activeDesignId!, tableId: table.id, columnId: title.id, confirmed: true });
		expect(removed.design?.triggers?.[0]?.events).toEqual([{ event: "UPDATE" }]);
		expect(removed.sql.status).toBe("current");
		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.design?.triggers).toEqual([trigger]);
		expect(undone.sql.status).toBe("current");
	}, 60_000);
});
