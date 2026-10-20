import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design } from "../shared/design";
import type { SchemaSandbox } from "./sandbox";
import { openDesignStore, type DesignStore } from "./store";
import {
	createDesignWorkspace,
	type DesignWorkspace,
	type DesignWorkspaceOptions,
} from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

type TestWorkspaceOptions = Pick<DesignWorkspaceOptions, "createSandbox" | "openStore">;

async function openTestWorkspace(options: TestWorkspaceOptions = {}) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-workspace-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "designs.sqlite");
	const workspace = await createDesignWorkspace({ databasePath, ...options });
	openWorkspaces.push(workspace);
	return { workspace, databasePath };
}

async function reopenTestWorkspace(
	databasePath: string,
	options: TestWorkspaceOptions = {},
) {
	const workspace = await createDesignWorkspace({ databasePath, ...options });
	openWorkspaces.push(workspace);
	return workspace;
}

async function closeTestWorkspace(workspace: DesignWorkspace) {
	await workspace.close();
	const index = openWorkspaces.indexOf(workspace);
	if (index >= 0) openWorkspaces.splice(index, 1);
}

function delay(milliseconds: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/** Real SQLite, with save completion timing controlled by the test. */
function createDelayedStore(
	databasePath: string,
	delayForRevision: (revision: number) => number,
): DesignStore {
	const store = openDesignStore(databasePath);
	return {
		...store,
		async saveDesign(projectId, design, revision, savedAt) {
			await delay(delayForRevision(revision));
			store.saveDesign(projectId, design, revision, savedAt);
		},
	};
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

	test("lists, opens, and switches between independent projects without leaking design state", async () => {
		const { workspace } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		await workspace.addTable({ name: "Books" });
		await workspace.createProject({ name: "School" });
		const state = await workspace.addTable({ name: "Students" });

		expect(state.projects.map((project) => project.name).sort()).toEqual(["Library", "School"]);
		const library = state.projects.find((project) => project.name === "Library");
		const school = state.projects.find((project) => project.name === "School");
		if (!library || !school) throw new Error("Expected both projects to be listed.");

		const libraryState = await workspace.openProject({ projectId: library.id });
		expect(libraryState.project?.name).toBe("Library");
		expect(libraryState.design?.tables.map((table) => table.name)).toEqual(["Books"]);
		expect(libraryState.revision).toBe(2);

		const schoolState = await workspace.openProject({ projectId: school.id });
		expect(schoolState.project?.name).toBe("School");
		expect(schoolState.design?.tables.map((table) => table.name)).toEqual(["Students"]);
		expect(schoolState.revision).toBe(2);
	});

	test("autosaves an incomplete, semantically invalid draft and restores it in a fresh workspace", async () => {
		const { workspace, databasePath } = await openTestWorkspace();

		await workspace.createProject({ name: "Unfinished" });
		await workspace.addTable({ name: "Books" });
		const invalidDraft = await workspace.addTable({ name: "Books" });

		expect(invalidDraft.design?.tables.map((table) => table.name)).toEqual([
			"Books",
			"Books",
		]);
		expect(invalidDraft.save).toMatchObject({ status: "saved", revision: 3 });
		expect(invalidDraft.sql.status).toBe("stale");

		await closeTestWorkspace(workspace);
		const reopened = await reopenTestWorkspace(databasePath);

		const reopenedState = reopened.getState();
		expect(reopenedState.project?.name).toBe("Unfinished");
		expect(reopenedState.design?.tables.map((table) => table.name)).toEqual([
			"Books",
			"Books",
		]);
		expect(reopenedState.save).toMatchObject({ status: "saved", revision: 3 });
	});

	test("applies rapid edits immediately and never lets a late older save replace the latest design", async () => {
		// Revision 2 finishes after 3 and 4, so completion order is inverted.
		const { workspace, databasePath } = await openTestWorkspace({
			openStore: (path) =>
				createDelayedStore(path, (revision) => (revision === 2 ? 80 : 0)),
		});

		await workspace.createProject({ name: "Rapid" });

		const first = workspace.addTable({ name: "One" });
		const second = workspace.addTable({ name: "Two" });
		const third = workspace.addTable({ name: "Three" });

		expect(workspace.getState().save).toEqual({ status: "saving", revision: 4 });
		await Promise.all([first, second, third]);

		const state = workspace.getState();
		expect(state.design?.tables.map((table) => table.name)).toEqual([
			"One",
			"Two",
			"Three",
		]);
		expect(state.revision).toBe(4);
		expect(state.save).toMatchObject({ status: "saved", revision: 4 });

		await closeTestWorkspace(workspace);
		const reopened = await reopenTestWorkspace(databasePath);
		expect(reopened.getState().design?.tables.map((table) => table.name)).toEqual([
			"One",
			"Two",
			"Three",
		]);
	});

	test("keeps the in-memory draft and reports a storage failure that a later edit clears", async () => {
		let failNextSave = true;
		const { workspace } = await openTestWorkspace({
			openStore: (path) => {
				const store = openDesignStore(path);
				return {
					...store,
					saveDesign(projectId, design, revision, savedAt) {
						if (failNextSave) {
							failNextSave = false;
							throw new Error("disk full");
						}
						store.saveDesign(projectId, design, revision, savedAt);
					},
				};
			},
		});

		await workspace.createProject({ name: "Fragile" });
		const failed = await workspace.addTable({ name: "One" });

		expect(failed.save.status).toBe("failed");
		if (failed.save.status === "failed") {
			expect(failed.save.error).toContain("disk full");
		}
		expect(failed.design?.tables.map((table) => table.name)).toEqual(["One"]);

		const recovered = await workspace.addTable({ name: "Two" });
		expect(recovered.save).toMatchObject({ status: "saved", revision: 3 });
		expect(recovered.design?.tables.map((table) => table.name)).toEqual(["One", "Two"]);
	});

	test("ignores an in-flight save from the previous project after switching", async () => {
		const store = openDesignStore;
		let releaseFirstSave = () => {};
		const firstSaveGate = new Promise<void>((resolve) => {
			releaseFirstSave = resolve;
		});
		let gateNextSave = true;

		const { workspace } = await openTestWorkspace({
			openStore: (path) => {
				const realStore = store(path);
				return {
					...realStore,
					async saveDesign(projectId, design, revision, savedAt) {
						if (gateNextSave) {
							gateNextSave = false;
							await firstSaveGate;
						}
						realStore.saveDesign(projectId, design, revision, savedAt);
					},
				};
			},
		});

		const alpha = await workspace.createProject({ name: "Alpha" });
		const alphaSave = workspace.addTable({ name: "Alpha table" });

		await workspace.createProject({ name: "Beta" });		const betaState = await workspace.addTable({ name: "Beta table" });
		expect(betaState.project?.name).toBe("Beta");

		releaseFirstSave();
		await alphaSave;

		const state = workspace.getState();
		expect(state.project?.name).toBe("Beta");
		expect(state.design?.tables.map((table) => table.name)).toEqual(["Beta table"]);
		expect(state.save).toMatchObject({ status: "saved", revision: 2 });

		if (!alpha.project) throw new Error("Expected Alpha to be created.");
		const alphaState = await workspace.openProject({ projectId: alpha.project.id });
		expect(alphaState.design?.tables.map((table) => table.name)).toEqual(["Alpha table"]);
	});
});
