import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design } from "../shared/design";
import type { SchemaSandbox } from "./sandbox";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

async function openTestWorkspace(options: { createSandbox?: () => SchemaSandbox } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-workspace-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "designs.sqlite");
	const workspace = await createDesignWorkspace({ databasePath, ...options });
	openWorkspaces.push(workspace);
	return { workspace, databasePath };
}

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) {
		await workspace.close();
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("design workspace", () => {
	test("creates a named project, adds a default-id table, and validates the generated schema in the sandbox", async () => {
		const { workspace } = await openTestWorkspace();

		const created = await workspace.createProject({ name: "Library" });
		expect(created.project?.name).toBe("Library");
		expect(created.design).toEqual({ tables: [] });
		expect(created.save.status).toBe("saved");
		expect(created.sql.status).toBe("empty");

		const withTable = await workspace.addTable({ name: "Books" });
		const tables = withTable.design?.tables ?? [];
		expect(tables).toHaveLength(1);
		expect(tables[0].name).toBe("Books");
		expect(tables[0].columns).toHaveLength(1);
		expect(tables[0].columns[0]).toMatchObject({
			name: "id",
			type: "bigint",
			primaryKey: true,
			identity: true,
			nullable: false,
		});

		expect(withTable.save.status).toBe("saved");
		expect(withTable.sql.status).toBe("current");
		expect(withTable.sql.status === "current" ? withTable.sql.sql : "").toContain(
			'CREATE TABLE "Books"',
		);
		expect(withTable.sandbox.status).toBe("applied");
		if (withTable.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the generated schema.");
		}
		expect(withTable.sandbox.tables).toEqual([
			{
				name: "Books",
				columns: [
					{
						name: "id",
						dataType: "bigint",
						isIdentity: true,
						nullable: false,
					},
				],
			},
		]);
	});

	test("autosaves and restores the same project and table with a fresh workspace", async () => {
		const { workspace, databasePath } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		await workspace.addTable({ name: "Books" });
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await createDesignWorkspace({ databasePath });
		openWorkspaces.push(reopened);

		const state = reopened.getState();
		expect(state.project?.name).toBe("Library");
		expect(state.design?.tables.map((table) => table.name)).toEqual(["Books"]);
		expect(state.revision).toBeGreaterThan(0);
		expect(state.save.status).toBe("saved");
		expect(state.sql.status).toBe("current");
		expect(state.sandbox.status).toBe("applied");
	});

	test("keeps the saved design when the sandbox cannot apply the preview", async () => {
		const failingSandbox = () => {
			let disposed = false;
			return {
				async apply(): Promise<never> {
					throw new Error("PGlite runtime unavailable");
				},
				async dispose() {
					disposed = true;
				},
				get disposed() {
					return disposed;
				},
			} as SchemaSandbox & { disposed: boolean };
		};

		const { workspace, databasePath } = await openTestWorkspace({
			createSandbox: failingSandbox,
		});

		await workspace.createProject({ name: "Library" });
		const state = await workspace.addTable({ name: "Books" });

		expect(state.save.status).toBe("saved");
		expect(state.design?.tables.map((table) => table.name)).toEqual(["Books"]);
		expect(state.sandbox.status).toBe("failed");
		if (state.sandbox.status === "failed") {
			expect(state.sandbox.error).toContain("PGlite runtime unavailable");
		}

		const persistedDesign = await workspace.getState();
		expect(persistedDesign.design).toEqual(state.design);
		expect(databasePath.endsWith("designs.sqlite")).toBe(true);
	});

	test("persists table structure and revision changes across workspace instances", async () => {
		const { workspace, databasePath } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		await workspace.addTable({ name: "Authors" });
		const expected: Design | null = workspace.getState().design;
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await createDesignWorkspace({ databasePath });
		openWorkspaces.push(reopened);

		expect(reopened.getState().design).toEqual(expected);
	});
});
