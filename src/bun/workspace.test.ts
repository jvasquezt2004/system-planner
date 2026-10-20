import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMN_TYPE_DEFINITIONS } from "../shared/column-types";
import type { Design, DesignColumn, DesignTable } from "../shared/design";
import { createPGliteSandbox, type SchemaSandbox } from "./sandbox";
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
	delayForDocumentRevision: (documentRevision: number) => number,
): DesignStore {
	const store = openDesignStore(databasePath);
	return {
		...store,
		async saveDesign(projectId, design, save) {
			await delay(delayForDocumentRevision(save.documentRevision));
			store.saveDesign(projectId, design, save);
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
		expect(created.design).toEqual({
			tables: [],
			viewport: { x: 0, y: 0, zoom: 1 },
		});
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
						primaryKey: true,
						unique: false,
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
					saveDesign(projectId, design, save) {
						if (failNextSave) {
							failNextSave = false;
							throw new Error("disk full");
						}
						store.saveDesign(projectId, design, save);
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
					async saveDesign(projectId, design, save) {
						if (gateNextSave) {
							gateNextSave = false;
							await firstSaveGate;
						}
						realStore.saveDesign(projectId, design, save);
					},
				};
			},
		});

		const alpha = await workspace.createProject({ name: "Alpha" });
		const alphaSave = workspace.addTable({ name: "Alpha table" });

		await workspace.createProject({ name: "Beta" });
		const betaState = await workspace.addTable({ name: "Beta table" });
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

	test("adds a table at the requested canvas position with the default key", async () => {
		const { workspace } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		const state = await workspace.addTable({
			name: "Books",
			position: { x: 320, y: 180 },
		});

		const table = state.design?.tables[0];
		if (!table) throw new Error("Expected a table.");
		expect(table.position).toEqual({ x: 320, y: 180 });
		expect(table.columns).toHaveLength(1);
		expect(table.columns[0]).toMatchObject({
			name: "id",
			type: "bigint",
			primaryKey: true,
			identity: true,
		});
	});

	test("renames a table without changing its identity and regenerates the schema", async () => {
		const { workspace } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		const withTable = await workspace.addTable({ name: "Books" });
		const table = requireTable(withTable.design?.tables[0]);

		const state = await workspace.renameTable({ tableId: table.id, name: "Volumes" });

		expect(state.design?.tables).toHaveLength(1);
		expect(state.design?.tables[0]).toMatchObject({ id: table.id, name: "Volumes" });
		expect(state.design?.tables[0].position).toEqual(table.position);
		expect(state.revision).toBe(3);
		expect(state.save).toMatchObject({ status: "saved", revision: 3 });
		expect(state.sql.status).toBe("current");
		if (state.sql.status !== "current") {
			throw new Error("Expected current SQL after the rename.");
		}
		expect(state.sql.sql).toContain('CREATE TABLE "Volumes"');
		expect(state.sql.sql).not.toContain('CREATE TABLE "Books"');
		expect(state.sandbox.status).toBe("applied");
		if (state.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the renamed table.");
		}
		expect(state.sandbox.tables.map((applied) => applied.name)).toEqual(["Volumes"]);
	});

	test("saves a rename that makes the draft temporarily invalid without dropping the sandbox", async () => {
		const { workspace } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		await workspace.addTable({ name: "Authors" });
		const added = await workspace.addTable({ name: "Books" });
		const books = requireTable(added.design?.tables[1]);

		const state = await workspace.renameTable({ tableId: books.id, name: "Authors" });

		expect(state.save).toMatchObject({ status: "saved", revision: 4 });
		expect(state.design?.tables.map((table) => table.name)).toEqual(["Authors", "Authors"]);
		expect(state.sql.status).toBe("stale");
		if (state.sql.status !== "stale") {
			throw new Error("Expected the SQL preview to be out of date.");
		}
		expect(state.sql.errors.join(" ")).toContain("used more than once");
		expect(state.sandbox).toMatchObject({ status: "applied", revision: 3 });
	});

	test(
		"removes one table without removing unrelated tables",
		async () => {
			const { workspace, databasePath } = await openTestWorkspace();

			await workspace.createProject({ name: "Library" });
			await workspace.addTable({ name: "Authors" });
			const added = await workspace.addTable({ name: "Books" });
			const authors = requireTable(added.design?.tables[0]);
			const books = requireTable(added.design?.tables[1]);
			const withReviews = await workspace.addTable({ name: "Reviews" });
			const reviews = requireTable(withReviews.design?.tables[2]);

			const state = await workspace.removeTable({ tableId: books.id });

			expect(state.design?.tables.map((table) => table.id)).toEqual([
				authors.id,
				reviews.id,
			]);
			expect(state.design?.tables.map((table) => table.name)).toEqual(["Authors", "Reviews"]);
			expect(state.revision).toBe(5);
			expect(state.save).toMatchObject({ status: "saved", revision: 5 });
			expect(state.sql.status).toBe("current");
			if (state.sql.status !== "current") {
				throw new Error("Expected current SQL after the removal.");
			}
			expect(state.sql.sql).toContain('CREATE TABLE "Authors"');
			expect(state.sql.sql).toContain('CREATE TABLE "Reviews"');
			expect(state.sql.sql).not.toContain('CREATE TABLE "Books"');
			expect(state.sandbox.status).toBe("applied");
			if (state.sandbox.status !== "applied") {
				throw new Error("Expected the sandbox to accept the remaining tables.");
			}
			expect(state.sandbox.tables.map((applied) => applied.name)).toEqual([
				"Authors",
				"Reviews",
			]);

			await closeTestWorkspace(workspace);
			const reopened = await reopenTestWorkspace(databasePath);
			expect(reopened.getState().design?.tables.map((table) => table.name)).toEqual([
				"Authors",
				"Reviews",
			]);
			expect(reopened.getState().revision).toBe(5);
		},
		20_000,
	);

	test("reports a removal that targets no table and leaves the design unchanged", async () => {
		const { workspace } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		const state = await workspace.addTable({ name: "Books" });

		await expect(workspace.removeTable({ tableId: "missing" })).rejects.toThrow(
			"That table could not be found.",
		);
		expect(workspace.getState().design).toEqual(state.design);
		expect(workspace.getState().revision).toBe(2);
	});

	test("adds, edits, and removes columns with stable identities and persisted properties", async () => {
		const { workspace, databasePath } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		const withTable = await workspace.addTable({ name: "Books" });
		const table = requireTable(withTable.design?.tables[0]);
		const key = requireColumn(table, 0);

		const withColumn = await workspace.addColumn({ tableId: table.id });
		const column = requireColumn(requireTable(withColumn.design?.tables[0]), 1);
		expect(column).toMatchObject({
			name: "column",
			type: "text",
			nullable: true,
			primaryKey: false,
			unique: false,
			identity: false,
			notes: "",
		});
		expect(column.id).not.toBe(key.id);
		expect(withColumn.revision).toBe(3);
		expect(withColumn.save).toMatchObject({ status: "saved", revision: 3 });

		const edited = await workspace.updateColumn({
			tableId: table.id,
			columnId: column.id,
			changes: {
				name: "isbn",
				type: "text",
				nullable: false,
				unique: true,
				notes: "  International Standard Book Number  ",
			},
		});
		const editedColumn = requireColumn(requireTable(edited.design?.tables[0]), 1);
		expect(editedColumn).toEqual({
			...column,
			name: "isbn",
			nullable: false,
			unique: true,
			notes: "International Standard Book Number",
		});
		expect(editedColumn.id).toBe(column.id);
		expect(requireTable(edited.design?.tables[0]).id).toBe(table.id);
		expect(edited.revision).toBe(4);
		expect(edited.save).toMatchObject({ status: "saved", revision: 4 });
		expect(edited.sql.status).toBe("current");
		if (edited.sql.status !== "current") {
			throw new Error("Expected current SQL after the column edit.");
		}
		expect(edited.sql.sql).toContain('"isbn" text NOT NULL UNIQUE');
		expect(edited.sandbox.status).toBe("applied");
		if (edited.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the edited column.");
		}
		expect(edited.sandbox.tables[0].columns[1]).toEqual({
			name: "isbn",
			dataType: "text",
			isIdentity: false,
			nullable: false,
			primaryKey: false,
			unique: true,
		});

		await closeTestWorkspace(workspace);
		const reopened = await reopenTestWorkspace(databasePath);
		const reopenedColumn = requireColumn(
			requireTable(reopened.getState().design?.tables[0]),
			1,
		);
		expect(reopenedColumn).toEqual(editedColumn);

		// A rename keeps the column identity and its metadata intact.
		const renamed = await reopened.updateColumn({
			tableId: table.id,
			columnId: column.id,
			changes: { name: "isbn_13" },
		});
		const renamedColumn = requireColumn(requireTable(renamed.design?.tables[0]), 1);
		expect(renamedColumn).toEqual({
			...editedColumn,
			name: "isbn_13",
		});
		expect(renamed.revision).toBe(5);
		if (renamed.sql.status !== "current") {
			throw new Error("Expected current SQL after the column rename.");
		}
		expect(renamed.sql.sql).toContain('"isbn_13" text NOT NULL UNIQUE');

		const removed = await reopened.removeColumn({
			tableId: table.id,
			columnId: column.id,
		});
		expect(requireTable(removed.design?.tables[0]).columns.map((item) => item.name)).toEqual([
			"id",
		]);
		expect(removed.revision).toBe(6);
		expect(removed.sql.status).toBe("current");
		expect(removed.sandbox.status).toBe("applied");

		await expect(
			reopened.removeColumn({ tableId: table.id, columnId: column.id }),
		).rejects.toThrow("That column could not be found.");
	}, 30_000);

	test(
		"supports every registered common PostgreSQL type consistently in SQL and the sandbox",
		async () => {
			const { workspace } = await openTestWorkspace();

			await workspace.createProject({ name: "Types" });
			const withTable = await workspace.addTable({ name: "Samples" });
			const table = requireTable(withTable.design?.tables[0]);

			// Independent knowledge of what PostgreSQL reports for each type.
			const catalogDataTypes: Record<string, string> = {
				bigint: "bigint",
				integer: "integer",
				smallint: "smallint",
				text: "text",
				uuid: "uuid",
				boolean: "boolean",
				numeric: "numeric",
				date: "date",
				timestamptz: "timestamp with time zone",
				jsonb: "jsonb",
			};

			let state = withTable;
			for (const definition of COLUMN_TYPE_DEFINITIONS) {
				state = await workspace.addColumn({
					tableId: table.id,
					name: `sample_${definition.type}`,
					type: definition.type,
				});
			}

			expect(Object.keys(catalogDataTypes).sort()).toEqual(
				COLUMN_TYPE_DEFINITIONS.map((definition) => definition.type).sort(),
			);
			expect(state.sql.status).toBe("current");
			if (state.sql.status !== "current") {
				throw new Error(`Expected current SQL, received ${state.sql.status}.`);
			}
			for (const definition of COLUMN_TYPE_DEFINITIONS) {
				expect(state.sql.sql).toContain(
					`"sample_${definition.type}" ${definition.type}`,
				);
			}

			expect(state.sandbox.status).toBe("applied");
			if (state.sandbox.status !== "applied") {
				throw new Error("Expected the sandbox to accept every supported type.");
			}
			const applied = state.sandbox.tables[0].columns;
			for (const definition of COLUMN_TYPE_DEFINITIONS) {
				const appliedColumn = applied.find(
					(candidate) => candidate.name === `sample_${definition.type}`,
				);
				expect(appliedColumn?.dataType).toBe(catalogDataTypes[definition.type]);
			}
		},
		90_000,
	);

	test("moves the single-column primary key and keeps a cleared key as an incomplete draft", async () => {
		const { workspace, databasePath } = await openTestWorkspace();

		await workspace.createProject({ name: "Keys" });
		const withTable = await workspace.addTable({ name: "Accounts" });
		const table = requireTable(withTable.design?.tables[0]);
		const idColumn = requireColumn(table, 0);

		const withCode = await workspace.addColumn({
			tableId: table.id,
			name: "code",
			type: "text",
		});
		const codeColumn = requireColumn(requireTable(withCode.design?.tables[0]), 1);

		const keyed = await workspace.updateColumn({
			tableId: table.id,
			columnId: codeColumn.id,
			changes: { primaryKey: true, nullable: false },
		});
		const keyedTable = requireTable(keyed.design?.tables[0]);
		expect(requireColumn(keyedTable, 0)).toMatchObject({
			id: idColumn.id,
			primaryKey: false,
			identity: true,
		});
		expect(requireColumn(keyedTable, 1)).toMatchObject({
			id: codeColumn.id,
			primaryKey: true,
			nullable: false,
		});
		expect(keyed.revision).toBe(4);
		if (keyed.sql.status !== "current") {
			throw new Error("Expected current SQL after moving the key.");
		}
		expect(keyed.sql.sql).toContain('PRIMARY KEY ("code")');
		expect(keyed.sandbox.status).toBe("applied");
		if (keyed.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the moved key.");
		}
		expect(
			keyed.sandbox.tables[0].columns.map((column) => ({
				name: column.name,
				primaryKey: column.primaryKey,
			})),
		).toEqual([
			{ name: "id", primaryKey: false },
			{ name: "code", primaryKey: true },
		]);

		const cleared = await workspace.updateColumn({
			tableId: table.id,
			columnId: codeColumn.id,
			changes: { primaryKey: false },
		});
		expect(cleared.revision).toBe(5);
		expect(cleared.save).toMatchObject({ status: "saved", revision: 5 });
		expect(requireColumn(requireTable(cleared.design?.tables[0]), 1).primaryKey).toBe(false);
		expect(cleared.sql.status).toBe("stale");
		if (cleared.sql.status !== "stale") {
			throw new Error("Expected the SQL preview to be out of date without a key.");
		}
		expect(cleared.sql.errors.join(" ")).toContain("exactly one primary key column");
		expect(cleared.sandbox).toMatchObject({ status: "applied", revision: 4 });

		const contradictory = await workspace.updateColumn({
			tableId: table.id,
			columnId: codeColumn.id,
			changes: { primaryKey: true, nullable: true },
		});
		expect(contradictory.save).toMatchObject({ status: "saved", revision: 6 });
		expect(contradictory.sql.status).toBe("stale");
		if (contradictory.sql.status !== "stale") {
			throw new Error("Expected a nullable key to block SQL generation.");
		}
		expect(contradictory.sql.errors.join(" ")).toContain("must be required");

		await closeTestWorkspace(workspace);
		const reopened = await reopenTestWorkspace(databasePath);
		expect(
			requireColumn(requireTable(reopened.getState().design?.tables[0]), 1),
		).toMatchObject({ primaryKey: true, nullable: true });
		expect(reopened.getState().save).toMatchObject({ status: "saved", revision: 6 });
		expect(reopened.getState().sql.status).toBe("empty");
	}, 30_000);

	test("saves column notes without advancing the schema revision or rebuilding the sandbox", async () => {
		const applies: string[] = [];
		const { workspace, databasePath } = await openTestWorkspace({
			createSandbox: () => countingSandbox(applies),
		});

		await workspace.createProject({ name: "Notes" });
		const withTable = await workspace.addTable({ name: "Books" });
		const table = requireTable(withTable.design?.tables[0]);
		const withColumn = await workspace.addColumn({
			tableId: table.id,
			name: "summary",
		});
		const column = requireColumn(requireTable(withColumn.design?.tables[0]), 1);
		const before = workspace.getState();
		const appliesAfterEdit = applies.length;

		const noted = await workspace.updateColumn({
			tableId: table.id,
			columnId: column.id,
			changes: { notes: "Short description of the book" },
		});
		expect(requireColumn(requireTable(noted.design?.tables[0]), 1).notes).toBe(
			"Short description of the book",
		);
		expect(noted.revision).toBe(before.revision);
		expect(noted.sql).toEqual(before.sql);
		expect(noted.sandbox).toEqual(before.sandbox);
		expect(noted.save).toMatchObject({ status: "saved", revision: before.revision });
		expect(applies).toHaveLength(appliesAfterEdit);

		await closeTestWorkspace(workspace);
		const reopened = await reopenTestWorkspace(databasePath);
		const reopenedState = reopened.getState();
		expect(reopenedState.revision).toBe(before.revision);
		expect(
			requireColumn(requireTable(reopenedState.design?.tables[0]), 1).notes,
		).toBe("Short description of the book");
	}, 30_000);

	test("clears identity when a column type leaves the integer family", async () => {
		const { workspace } = await openTestWorkspace();

		await workspace.createProject({ name: "Keys" });
		const withTable = await workspace.addTable({ name: "Books" });
		const table = requireTable(withTable.design?.tables[0]);
		const idColumn = requireColumn(table, 0);

		const integerKey = await workspace.updateColumn({
			tableId: table.id,
			columnId: idColumn.id,
			changes: { type: "integer" },
		});
		expect(requireColumn(requireTable(integerKey.design?.tables[0]), 0)).toMatchObject({
			type: "integer",
			identity: true,
		});

		const uuidKey = await workspace.updateColumn({
			tableId: table.id,
			columnId: idColumn.id,
			changes: { type: "uuid" },
		});
		expect(requireColumn(requireTable(uuidKey.design?.tables[0]), 0)).toMatchObject({
			type: "uuid",
			identity: false,
			primaryKey: true,
			nullable: false,
		});
		expect(uuidKey.sql.status).toBe("current");
		if (uuidKey.sql.status !== "current") {
			throw new Error("Expected current SQL after changing the key type.");
		}
		expect(uuidKey.sql.sql).toContain('"id" uuid NOT NULL');
		expect(uuidKey.sql.sql).not.toContain("GENERATED ALWAYS AS IDENTITY");
		expect(uuidKey.sandbox.status).toBe("applied");
		if (uuidKey.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the UUID key.");
		}
		expect(uuidKey.sandbox.tables[0].columns[0]).toEqual({
			name: "id",
			dataType: "uuid",
			isIdentity: false,
			nullable: false,
			primaryKey: true,
			unique: false,
		});
	}, 30_000);

	test(
		"generates keys, uniqueness, and nullability that a real sandbox enforces",
		async () => {
			const { workspace } = await openTestWorkspace();

			await workspace.createProject({ name: "Constraints" });
			const withTable = await workspace.addTable({ name: "Books" });
			const table = requireTable(withTable.design?.tables[0]);
			const withIsbn = await workspace.addColumn({
				tableId: table.id,
				name: "isbn",
				type: "text",
			});
			const isbn = requireColumn(requireTable(withIsbn.design?.tables[0]), 1);
			await workspace.addColumn({ tableId: table.id, name: "subtitle", type: "text" });
			const state = await workspace.updateColumn({
				tableId: table.id,
				columnId: isbn.id,
				changes: { nullable: false, unique: true },
			});

			expect(state.sandbox.status).toBe("applied");
			if (state.sandbox.status !== "applied") {
				throw new Error("Expected the sandbox to accept the schema.");
			}
			expect(
				state.sandbox.tables[0].columns.map((column) => ({
					name: column.name,
					nullable: column.nullable,
					primaryKey: column.primaryKey,
					unique: column.unique,
				})),
			).toEqual([
				{ name: "id", nullable: false, primaryKey: true, unique: false },
				{ name: "isbn", nullable: false, primaryKey: false, unique: true },
				{ name: "subtitle", nullable: true, primaryKey: false, unique: false },
			]);

			if (state.sql.status !== "current") {
				throw new Error("Expected current SQL for the constraint check.");
			}
			const database = new PGlite();
			try {
				await database.exec(state.sql.sql);
				await database.exec(`INSERT INTO "Books" ("isbn") VALUES ('978-1')`);
				await database.exec(
					`INSERT INTO "Books" ("isbn", "subtitle") VALUES ('978-2', 'A subtitle')`,
				);
				await expect(
					database.exec(`INSERT INTO "Books" ("isbn") VALUES ('978-1')`),
				).rejects.toThrow();
				await expect(
					database.exec(`INSERT INTO "Books" ("subtitle") VALUES ('missing isbn')`),
				).rejects.toThrow();
				await database.exec(`INSERT INTO "Books" ("isbn") VALUES ('978-3')`);
				await database.exec(
					`INSERT INTO "Books" ("id", "isbn") OVERRIDING SYSTEM VALUE VALUES (10, '978-4')`,
				);
				await expect(
					database.exec(
						`INSERT INTO "Books" ("id", "isbn") OVERRIDING SYSTEM VALUE VALUES (10, '978-5')`,
					),
				).rejects.toThrow();
			} finally {
				await database.close();
			}
		},
		30_000,
	);

	test("moves a card without advancing the schema revision or rebuilding the sandbox", async () => {
		const applies: string[] = [];
		const { workspace } = await openTestWorkspace({
			createSandbox: () => countingSandbox(applies),
		});

		await workspace.createProject({ name: "Library" });
		const before = await workspace.addTable({ name: "Books" });
		const table = requireTable(before.design?.tables[0]);
		const appliesAfterAdd = applies.length;

		const moved = await workspace.moveTable({
			tableId: table.id,
			position: { x: 640, y: 360 },
		});

		expect(moved.design?.tables[0]).toMatchObject({
			id: table.id,
			position: { x: 640, y: 360 },
		});
		expect(moved.revision).toBe(before.revision);
		expect(moved.sql).toEqual(before.sql);
		expect(moved.sandbox).toEqual(before.sandbox);
		expect(moved.save).toMatchObject({ status: "saved", revision: before.revision });
		expect(applies).toHaveLength(appliesAfterAdd);
	});

	test("restores card positions and the canvas viewport when reopening a project", async () => {
		const { workspace, databasePath } = await openTestWorkspace();

		await workspace.createProject({ name: "Library" });
		await workspace.addTable({ name: "Authors" });
		const added = await workspace.addTable({ name: "Books" });
		const books = requireTable(added.design?.tables[1]);

		const moved = await workspace.moveTable({
			tableId: books.id,
			position: { x: 700, y: 420 },
		});
		expect(moved.revision).toBe(3);

		const panned = await workspace.setViewport({ x: -160, y: 90, zoom: 1.4 });
		expect(panned.design?.viewport).toEqual({ x: -160, y: 90, zoom: 1.4 });
		expect(panned.revision).toBe(3);

		await closeTestWorkspace(workspace);
		const reopened = await reopenTestWorkspace(databasePath);
		const state = reopened.getState();

		expect(state.revision).toBe(3);
		expect(state.design?.viewport).toEqual({ x: -160, y: 90, zoom: 1.4 });
		expect(state.design?.tables.map((table) => table.name)).toEqual(["Authors", "Books"]);
		expect(state.design?.tables[1].position).toEqual({ x: 700, y: 420 });
	});

	test("keeps layout saves newer than delayed structural saves", async () => {
		const { workspace, databasePath } = await openTestWorkspace({
			openStore: (path) =>
				createDelayedStore(path, (documentRevision) =>
					documentRevision === 2 ? 80 : 0,
				),
		});

		await workspace.createProject({ name: "Library" });
		const pending = workspace.addTable({ name: "Books" });
		const table = requireTable(workspace.getState().design?.tables[0]);

		// The layout save lands before the older structural save completes.
		const moved = await workspace.moveTable({
			tableId: table.id,
			position: { x: 512, y: 256 },
		});
		expect(moved.design?.tables[0].position).toEqual({ x: 512, y: 256 });
		await pending;
		await closeTestWorkspace(workspace);

		const reopened = await reopenTestWorkspace(databasePath);
		expect(reopened.getState().design?.tables[0]).toMatchObject({
			id: table.id,
			name: "Books",
			position: { x: 512, y: 256 },
		});
	});
});

function requireTable(table: DesignTable | undefined): DesignTable {
	if (!table) throw new Error("Expected the workspace to expose a table.");
	return table;
}

function requireColumn(table: DesignTable, index: number): DesignColumn {
	const column = table.columns[index];
	if (!column) throw new Error(`Expected column ${index} to exist.`);
	return column;
}

/** Wraps the real sandbox to record each rebuild attempt. */
function countingSandbox(applies: string[]): SchemaSandbox {
	const sandbox = createPGliteSandbox();
	return {
		apply(sql) {
			applies.push(sql);
			return sandbox.apply(sql);
		},
		dispose() {
			return sandbox.dispose();
		},
	};
}
