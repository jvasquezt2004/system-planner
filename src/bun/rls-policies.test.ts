import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesignStore } from "./store";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const workspaces: DesignWorkspace[] = [];
const directories: string[] = [];

async function openWorkspace(databasePath?: string) {
	const directory = databasePath ? null : mkdtempSync(join(tmpdir(), "db-planner-rls-"));
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

describe("row-level security policies", () => {
	test("policy edits are structural, undoable, persisted, and rejected SQL keeps the draft", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-rls-edit-"));
		directories.push(directory);
		const databasePath = join(directory, "design.sqlite");
		const workspace = await openWorkspace(databasePath);
		await workspace.createProject({ name: "Private library" });
		const created = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const table = created.design?.tables[0];
		if (!table) throw new Error("Expected Books table.");
		expect(table.rowLevelSecurity).toBe(false);
		expect(table.policies).toEqual([]);

		const applied = await workspace.updatePolicies({
			designId: workspace.getState().activeDesignId!,
			tableId: table.id,
			rowLevelSecurity: true,
			policies: [{
				id: "visible-policy", name: "read_books", command: "SELECT", roles: ["anon"],
				mode: "permissive", using: "true", withCheck: "",
			}],
		});
		expect(applied.revision).toBe(created.revision + 1);
		if (applied.sandbox.status !== "applied") throw new Error("Expected applied RLS SQL.");
		expect(applied.sandbox.sql).toContain("ALTER TABLE \"Books\" ENABLE ROW LEVEL SECURITY;");
		expect(applied.sandbox.sql).toContain("CREATE POLICY \"read_books\"");

		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.design?.tables[0].rowLevelSecurity).toBe(false);
		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(redone.design?.tables[0].policies?.[0]?.name).toBe("read_books");

		const rejected = await workspace.updatePolicies({
			designId: workspace.getState().activeDesignId!,
			tableId: table.id,
			rowLevelSecurity: true,
			policies: [{
				id: "invalid-policy", name: "broken_policy", command: "SELECT", roles: ["anon"],
				mode: "permissive", using: "missing_column = true", withCheck: "",
			}],
		});
		expect(rejected.design?.tables[0].policies?.[0]?.name).toBe("broken_policy");
		expect(rejected.sandbox).toMatchObject({ status: "failed", failure: "sql-rejected" });
		if (rejected.sandbox.status !== "failed") throw new Error("Expected the policy SQL to be rejected.");
		expect(rejected.sandbox.error).toContain("missing_column");
		await workspace.close();
		workspaces.splice(workspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(databasePath);
		expect(reopened.getState().design?.tables[0].policies?.[0]?.name).toBe("broken_policy");
		expect(reopened.getState().sandbox.status).toBe("failed");
	}, 60_000);

	test("old design documents normalize row-level security off", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-rls-legacy-"));
		directories.push(directory);
		const databasePath = join(directory, "design.sqlite");
		const first = await openWorkspace(databasePath);
		const created = await first.createProject({ name: "Legacy" });
		const designId = created.activeDesignId!;
		const added = await first.addTable({ designId, name: "Records" });
		const design = structuredClone(added.design!);
		delete design.tables[0].rowLevelSecurity;
		delete design.tables[0].policies;
		await first.close();
		workspaces.splice(workspaces.indexOf(first), 1);
		const store = openDesignStore(databasePath);
		store.saveDesign(created.project!.id, design, {
			revision: added.revision,
			documentRevision: added.revision + 1,
			savedAt: Date.now(),
		}, designId);
		store.close();
		const reopened = await openWorkspace(databasePath);
		expect(reopened.getState().design?.tables[0].rowLevelSecurity).toBe(false);
		expect(reopened.getState().design?.tables[0].policies).toEqual([]);
	});
});
