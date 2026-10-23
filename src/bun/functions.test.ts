import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

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
		await workspace.addTable({ name: "Books" });
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
		const added = await workspace.updateFunctions({ functions: [fn] });
		expect(added.revision).toBeGreaterThan(1);
		expect(added.sandbox.status).toBe("applied");
		const undone = await workspace.undo();
		expect(undone.design?.functions ?? []).toEqual([]);
		const redone = await workspace.redo();
		expect(redone.design?.functions?.[0]).toMatchObject(fn);
		const rejected = await workspace.updateFunctions({ functions: [{ ...fn, body: "SELECT (" }] });
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
		const withTable = await workspace.addTable({ name: "Books" });
		const table = withTable.design!.tables[0]!;
		const withFunction = await workspace.updateFunctions({ functions: [{
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
		const removed = await workspace.removeTable({ tableId: table.id });
		expect(removed.design?.tables).toEqual([]);
		expect(removed.design?.functions?.[0]?.name).toBe("book_count");
		expect(removed.sql.status).toBe("stale");
		if (removed.sql.status !== "stale") throw new Error("Expected the blocked SQL preview.");
		expect(removed.sql.errors).toContainEqual(expect.stringContaining("depends on a table"));
	}, 60_000);
});
