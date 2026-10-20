import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AffectedRelationship,
	Design,
	DesignColumn,
	DesignRelationship,
	DesignTable,
	SandboxAppliedTable,
	WorkspaceState,
} from "../shared/design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

async function openTestWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-one-to-one-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "designs.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	openWorkspaces.push(workspace);
	return { workspace, databasePath };
}

async function reopenTestWorkspace(databasePath: string) {
	const workspace = await createDesignWorkspace({ databasePath });
	openWorkspaces.push(workspace);
	return workspace;
}

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) {
		await workspace.close();
	}
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
}, 30_000);

function requireDesign(state: WorkspaceState): Design {
	if (!state.design) throw new Error("Expected an open design.");
	return state.design;
}

function requireTable(design: Design, name: string): DesignTable {
	const table = design.tables.find((candidate) => candidate.name === name);
	if (!table) throw new Error(`Expected a table named ${name}.`);
	return table;
}

function requireColumn(table: DesignTable, name: string): DesignColumn {
	const column = table.columns.find((candidate) => candidate.name === name);
	if (!column) throw new Error(`Expected a column named ${name}.`);
	return column;
}

function requireCurrentSql(state: WorkspaceState): string {
	if (state.sql.status !== "current") {
		throw new Error(`Expected current SQL, received ${state.sql.status}.`);
	}
	return state.sql.sql;
}

function requireAppliedTable(state: WorkspaceState, name: string): SandboxAppliedTable {
	if (state.sandbox.status !== "applied") {
		throw new Error(`Expected an applied sandbox, received ${state.sandbox.status}.`);
	}
	const table = state.sandbox.tables.find((candidate) => candidate.name === name);
	if (!table) throw new Error(`Expected the sandbox to contain ${name}.`);
	return table;
}

function requireRelationship(
	state: WorkspaceState,
	relationshipId: string,
): DesignRelationship {
	const relationship = requireDesign(state).relationships.find(
		(candidate) => candidate.id === relationshipId,
	);
	if (!relationship) throw new Error(`Expected relationship ${relationshipId}.`);
	return relationship;
}

async function addAuthorsAndBooks(workspace: DesignWorkspace) {
	await workspace.createProject({ name: "Publishing" });
	const withAuthors = await workspace.addTable({ name: "Authors" });
	const withBooks = await workspace.addTable({ name: "Books" });
	return {
		authorsTable: requireTable(requireDesign(withAuthors), "Authors"),
		booksTable: requireTable(requireDesign(withBooks), "Books"),
	};
}

describe("one-to-one relationships", () => {
	test("creates a one-to-one relationship with a foreign key and uniqueness a real database enforces", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
			cardinality: "one-to-one",
		});

		const relationship = requireDesign(related).relationships[0];
		expect(relationship).toMatchObject({
			cardinality: "one-to-one",
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const books = requireTable(requireDesign(related), "Books");
		const authorId = books.columns.find(
			(column) => column.id === relationship.referencingColumnId,
		);
		if (!authorId) throw new Error("Expected the relationship to own a book column.");
		// Uniqueness belongs to the relationship, not to the column's own setting.
		expect(authorId).toMatchObject({
			name: "author_id",
			type: "bigint",
			nullable: false,
			primaryKey: false,
			unique: false,
		});

		expect(related.save).toMatchObject({ status: "saved" });
		const sql = requireCurrentSql(related);
		expect(sql).toContain(
			'ADD CONSTRAINT "Books_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "Authors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;',
		);
		expect(sql).toContain(
			'ADD CONSTRAINT "Books_author_id_key" UNIQUE ("author_id");',
		);

		const booksColumn = requireAppliedTable(related, "Books").columns.find(
			(column) => column.name === "author_id",
		);
		expect(booksColumn).toMatchObject({ nullable: false, unique: true });
		if (related.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the one-to-one design.");
		}
		expect(related.sandbox.relationships[0]).toMatchObject({
			referencingTable: "Books",
			referencingColumn: "author_id",
			referencedTable: "Authors",
			referencedColumn: "id",
			updateRule: "NO ACTION",
			deleteRule: "NO ACTION",
		});

		const database = new PGlite();
		try {
			await database.exec(sql);
			await database.exec(`INSERT INTO "Authors" DEFAULT VALUES`);
			// The referenced side may have no matching record at all.
			await database.exec(`INSERT INTO "Authors" DEFAULT VALUES`);
			await database.exec(`INSERT INTO "Books" ("author_id") VALUES (1)`);
			// A second referencing record may not name the same referenced record.
			await expect(
				database.exec(`INSERT INTO "Books" ("author_id") VALUES (1)`),
			).rejects.toThrow(/unique|duplicate key/);
			// A required one-to-one reference cannot be absent.
			await expect(
				database.exec(`INSERT INTO "Books" DEFAULT VALUES`),
			).rejects.toThrow(/null value|not-null/);
			// It must name a real referenced record.
			await expect(
				database.exec(`INSERT INTO "Books" ("author_id") VALUES (99)`),
			).rejects.toThrow(/foreign key/);

			// Neither the UI nor the schema requires every referenced record to
			// participate: a second author simply has no book.
			const unmatched = await database.query<{ count: number }>(
				`SELECT COUNT(*)::int AS count FROM "Authors" author
				 WHERE NOT EXISTS (SELECT 1 FROM "Books" book WHERE book."author_id" = author."id")`,
			);
			expect(unmatched.rows[0].count).toBe(1);
		} finally {
			await database.close();
		}
	}, 60_000);

	test("keeps an optional one-to-one reference absent without allowing a second match", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
			cardinality: "one-to-one",
		});
		const relationship = requireDesign(related).relationships[0];
		expect(requireCurrentSql(related)).toContain('"author_id" bigint NOT NULL');

		const optional = await workspace.updateRelationship({
			relationshipId: relationship.id,
			required: false,
		});
		expect(
			requireColumn(requireTable(requireDesign(optional), "Books"), "author_id"),
		).toMatchObject({ nullable: true, unique: false });
		expect(requireRelationship(optional, relationship.id)).toMatchObject({
			cardinality: "one-to-one",
		});
		const optionalSql = requireCurrentSql(optional);
		expect(optionalSql).toContain('"author_id" bigint,');
		expect(optionalSql).toContain(
			'ADD CONSTRAINT "Books_author_id_key" UNIQUE ("author_id");',
		);
		expect(
			requireAppliedTable(optional, "Books").columns.find(
				(column) => column.name === "author_id",
			),
		).toMatchObject({ nullable: true, unique: true });

		const database = new PGlite();
		try {
			await database.exec(optionalSql);
			await database.exec(`INSERT INTO "Authors" DEFAULT VALUES`);
			// Absence is allowed, and it may repeat: PostgreSQL treats NULLs as
			// distinct values under a unique constraint.
			await database.exec(`INSERT INTO "Books" DEFAULT VALUES`);
			await database.exec(`INSERT INTO "Books" DEFAULT VALUES`);
			await database.exec(`INSERT INTO "Books" ("author_id") VALUES (1)`);
			await expect(
				database.exec(`INSERT INTO "Books" ("author_id") VALUES (1)`),
			).rejects.toThrow(/unique|duplicate key/);
			const rows = await database.query<{ count: number }>(
				`SELECT COUNT(*)::int AS count FROM "Books" WHERE "author_id" IS NULL`,
			);
			expect(rows.rows[0].count).toBe(2);
		} finally {
			await database.close();
		}

		// The column editor and the relationship control still express one setting.
		const requiredAgain = await workspace.updateRelationship({
			relationshipId: relationship.id,
			required: true,
		});
		expect(
			requireColumn(requireTable(requireDesign(requiredAgain), "Books"), "author_id")
				.nullable,
		).toBe(false);
	}, 60_000);

	test("converts an existing one-to-many relationship to one-to-one and back", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const relationship = requireDesign(related).relationships[0];
		expect(relationship.cardinality).toBe("one-to-many");
		expect(requireCurrentSql(related)).not.toContain("UNIQUE (\"author_id\")");

		const oneToOne = await workspace.updateRelationship({
			relationshipId: relationship.id,
			cardinality: "one-to-one",
		});
		expect(requireRelationship(oneToOne, relationship.id).cardinality).toBe("one-to-one");
		expect(requireCurrentSql(oneToOne)).toContain(
			'ADD CONSTRAINT "Books_author_id_key" UNIQUE ("author_id");',
		);
		expect(
			requireAppliedTable(oneToOne, "Books").columns.find(
				(column) => column.name === "author_id",
			)?.unique,
		).toBe(true);

		const manyAgain = await workspace.updateRelationship({
			relationshipId: relationship.id,
			cardinality: "one-to-many",
		});
		expect(requireRelationship(manyAgain, relationship.id).cardinality).toBe(
			"one-to-many",
		);
		expect(requireCurrentSql(manyAgain)).not.toContain("UNIQUE (\"author_id\")");
		expect(
			requireAppliedTable(manyAgain, "Books").columns.find(
				(column) => column.name === "author_id",
			)?.unique,
		).toBe(false);

		await expect(
			workspace.updateRelationship({
				relationshipId: relationship.id,
				cardinality: "one-to-zero" as never,
			}),
		).rejects.toThrow(/cardinality/i);
	}, 60_000);

	test("preserves one-to-one ownership through renames and reopening", async () => {
		const { workspace, databasePath } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
			cardinality: "one-to-one",
		});
		const relationship = requireDesign(related).relationships[0];

		const renamedColumn = await workspace.updateColumn({
			tableId: booksTable.id,
			columnId: relationship.referencingColumnId,
			changes: { name: "writer_id" },
		});
		expect(requireDesign(renamedColumn).relationships).toEqual([
			{ ...relationship, cardinality: "one-to-one" },
		]);
		const renamedTable = await workspace.renameTable({
			tableId: authorsTable.id,
			name: "Writers",
		});

		const renamed = requireDesign(renamedTable);
		expect(renamed.relationships).toEqual([{ ...relationship, cardinality: "one-to-one" }]);
		const renamedSql = requireCurrentSql(renamedTable);
		expect(renamedSql).toContain(
			'ADD CONSTRAINT "Books_writer_id_fkey" FOREIGN KEY ("writer_id") REFERENCES "Writers" ("id")',
		);
		expect(renamedSql).toContain(
			'ADD CONSTRAINT "Books_writer_id_key" UNIQUE ("writer_id");',
		);
		expect(
			requireAppliedTable(renamedTable, "Books").columns.find(
				(column) => column.name === "writer_id",
			)?.unique,
		).toBe(true);

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await reopenTestWorkspace(databasePath);
		const restored = requireDesign(reopened.getState());
		expect(restored.relationships).toEqual([{ ...relationship, cardinality: "one-to-one" }]);
		expect(requireCurrentSql(reopened.getState())).toBe(renamedSql);
		// The reopened workspace kept uniqueness on the referencing column only.
		expect(
			requireAppliedTable(reopened.getState(), "Books").columns.find(
				(column) => column.name === "writer_id",
			),
		).toMatchObject({ unique: true });
		expect(
			requireAppliedTable(reopened.getState(), "Writers").columns.find(
				(column) => column.name === "id",
			),
		).toMatchObject({ primaryKey: true, nullable: false });
	}, 90_000);

	test("removes only relationship-owned constraints and keeps independent column settings", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
			cardinality: "one-to-one",
		});
		const relationship = requireDesign(related).relationships[0];

		const removed = await workspace.removeRelationship({ relationshipId: relationship.id });
		expect(requireDesign(removed).relationships).toEqual([]);
		expect(
			requireTable(requireDesign(removed), "Books").columns.map((column) => column.name),
		).toEqual(["id", "author_id"]);
		const removedSql = requireCurrentSql(removed);
		expect(removedSql).not.toContain("FOREIGN KEY");
		expect(removedSql).not.toContain('UNIQUE ("author_id")');
		expect(
			requireAppliedTable(removed, "Books").columns.find(
				(column) => column.name === "author_id",
			)?.unique,
		).toBe(false);

		// An independently configured unique column keeps its constraint.
		const withOwnUniqueColumn = await workspace.updateColumn({
			tableId: booksTable.id,
			columnId: relationship.referencingColumnId,
			changes: { unique: true },
		});
		const withUniqueSql = requireCurrentSql(withOwnUniqueColumn);
		expect(withUniqueSql).toContain('"author_id" bigint NOT NULL UNIQUE');
		// The relationship no longer needs to contribute uniqueness.
		expect(withUniqueSql).not.toContain("Books_author_id_key");
		const linkedAgain = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
			cardinality: "one-to-one",
		});
		const secondRelationship = requireDesign(linkedAgain).relationships[0];
		expect(requireCurrentSql(linkedAgain)).not.toContain("Books_author_id_key");
		expect(
			requireAppliedTable(linkedAgain, "Books").columns.find(
				(column) => column.name === "author_id_2",
			)?.unique,
		).toBe(true);

		const removedAgain = await workspace.removeRelationship({
			relationshipId: secondRelationship.id,
		});
		const keptSql = requireCurrentSql(removedAgain);
		expect(keptSql).not.toContain("FOREIGN KEY");
		// Only the independent column setting remains.
		expect(keptSql).toContain('"author_id" bigint NOT NULL UNIQUE');
		expect(keptSql).not.toContain('"author_id_2" bigint NOT NULL UNIQUE');
		expect(
			requireAppliedTable(removedAgain, "Books").columns.find(
				(column) => column.name === "author_id",
			)?.unique,
		).toBe(true);
	}, 60_000);

	test("extends deletion safeguards to the one-to-one uniqueness constraint", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);
		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
			cardinality: "one-to-one",
		});
		const relationship = requireDesign(related).relationships[0];

		const expectedAffected: AffectedRelationship = {
			relationshipId: relationship.id,
			cardinality: "one-to-one",
			referencingTable: "Books",
			referencingColumn: "author_id",
			referencedTable: "Authors",
			referencedColumn: "id",
			constraints: ["foreign-key", "unique"],
		};
		const tablePlan = workspace.describeRemoval({
			kind: "table",
			tableId: authorsTable.id,
		});
		expect(tablePlan.target).toBe("Authors");
		expect(tablePlan.relationships).toEqual([expectedAffected]);
		const columnPlan = workspace.describeRemoval({
			kind: "column",
			tableId: booksTable.id,
			columnId: relationship.referencingColumnId,
		});
		expect(columnPlan.relationships).toEqual([expectedAffected]);

		// Cancelling leaves both constraints and columns untouched.
		const revision = related.revision;
		await expect(
			workspace.removeTable({ tableId: authorsTable.id }),
		).rejects.toThrow(/confirm/i);
		expect(workspace.getState().revision).toBe(revision);
		expect(requireDesign(workspace.getState()).relationships).toEqual([relationship]);

		// A confirmed removal drops the relationship-owned constraints only; the
		// referencing column survives without uniqueness.
		const removedTable = await workspace.removeTable({
			tableId: authorsTable.id,
			confirmed: true,
		});
		expect(requireDesign(removedTable).relationships).toEqual([]);
		expect(
			requireTable(requireDesign(removedTable), "Books").columns.map(
				(column) => column.name,
			),
		).toEqual(["id", "author_id"]);
		const removedSql = requireCurrentSql(removedTable);
		expect(removedSql).not.toContain("FOREIGN KEY");
		expect(removedSql).not.toContain('UNIQUE ("author_id")');
		expect(
			requireAppliedTable(removedTable, "Books").columns.find(
				(column) => column.name === "author_id",
			)?.unique,
		).toBe(false);

		// A column whose uniqueness is configured independently is not part of the
		// relationship, and its constraint survives relationship removal.
		const withIndependentUnique = await workspace.updateColumn({
			tableId: booksTable.id,
			columnId: requireColumn(requireTable(requireDesign(removedTable), "Books"), "author_id")
				.id,
			changes: { unique: true },
		});
		expect(requireCurrentSql(withIndependentUnique)).toContain(
			'"author_id" bigint NOT NULL UNIQUE',
		);

		const people = await workspace.addTable({ name: "People" });
		const peopleTable = requireTable(requireDesign(people), "People");
		const linkedPeople = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: peopleTable.id,
			cardinality: "one-to-one",
		});
		const peopleRelationship = requireDesign(linkedPeople).relationships[0];
		expect(
			workspace.describeRemoval({ kind: "table", tableId: peopleTable.id })
				.relationships,
		).toEqual([
			{
				relationshipId: peopleRelationship.id,
				cardinality: "one-to-one",
				referencingTable: "Books",
				referencingColumn: "people_id",
				referencedColumn: "id",
				referencedTable: "People",
				constraints: ["foreign-key", "unique"],
			},
		]);

		const independentRemove = await workspace.removeTable({
			tableId: peopleTable.id,
			confirmed: true,
		});
		const independentSql = requireCurrentSql(independentRemove);
		expect(independentSql).not.toContain("FOREIGN KEY");
		expect(independentSql).toContain('"author_id" bigint NOT NULL UNIQUE');
	}, 60_000);
});
