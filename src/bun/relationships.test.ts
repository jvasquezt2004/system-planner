import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
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
	const directory = mkdtempSync(join(tmpdir(), "db-planner-relationships-"));
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
});

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

function requireAppliedSandbox(state: WorkspaceState) {
	if (state.sandbox.status !== "applied") {
		throw new Error(`Expected an applied sandbox, received ${state.sandbox.status}.`);
	}
	return state.sandbox;
}

function requireAppliedTable(
	state: WorkspaceState,
	name: string,
): SandboxAppliedTable {
	const table = requireAppliedSandbox(state).tables.find(
		(candidate) => candidate.name === name,
	);
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

describe("one-to-many relationships", () => {
	test("relates two tables and creates a foreign key a real database enforces", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});

		expect(requireDesign(related).relationships).toHaveLength(1);
		const relationship = requireDesign(related).relationships[0];
		expect(relationship).toMatchObject({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});

		const books = requireTable(requireDesign(related), "Books");
		const authors = requireTable(requireDesign(related), "Authors");
		const authorId = books.columns.find(
			(column) => column.id === relationship.referencingColumnId,
		);
		if (!authorId) throw new Error("Expected the relationship to own a book column.");
		// The generated column copies the key's type, never its identity or default.
		expect(authorId).toMatchObject({
			name: "author_id",
			type: "bigint",
			nullable: false,
			primaryKey: false,
			unique: false,
			identity: false,
		});
		expect(authorId.default).toEqual({ kind: "none" });

		expect(related.save).toMatchObject({ status: "saved" });
		const sql = requireCurrentSql(related);
		expect(sql).toContain('FOREIGN KEY ("author_id") REFERENCES "Authors" ("id")');
		expect(sql).toContain("ON UPDATE NO ACTION ON DELETE NO ACTION");

		const applied = requireAppliedSandbox(related);
		expect(applied.relationships).toHaveLength(1);
		expect(applied.relationships[0]).toMatchObject({
			referencingTable: "Books",
			referencingColumn: "author_id",
			referencedTable: "Authors",
			referencedColumn: "id",
			updateRule: "NO ACTION",
			deleteRule: "NO ACTION",
		});
		expect(
			requireAppliedTable(related, "Books").columns.find(
				(column) => column.name === "author_id",
			),
		).toMatchObject({
			dataType: "bigint",
			isIdentity: false,
			defaultExpression: null,
			nullable: false,
		});

		const database = new PGlite();
		try {
			await database.exec(sql);
			// A required reference cannot be absent, and it must name a real row.
			await expect(
				database.exec(`INSERT INTO "Books" DEFAULT VALUES`),
			).rejects.toThrow(/null value|not-null/);
			await expect(
				database.exec(`INSERT INTO "Books" ("author_id") VALUES (99)`),
			).rejects.toThrow(/foreign key/);

			await database.exec(`INSERT INTO "Authors" DEFAULT VALUES`);
			await database.exec(`INSERT INTO "Books" ("author_id") VALUES (1)`);

			// NO ACTION refuses to orphan a referencing record.
			await expect(database.exec(`DELETE FROM "Authors" WHERE "id" = 1`)).rejects.toThrow(
				/foreign key/,
			);

			await database.exec(`DELETE FROM "Books"`);
			await database.exec(`DELETE FROM "Authors" WHERE "id" = 1`);
			const remaining = await database.query<{ count: number }>(
				`SELECT COUNT(*)::int AS count FROM "Authors"`,
			);
			expect(remaining.rows[0].count).toBe(0);
		} finally {
			await database.close();
		}

		expect(authors.columns.map((column) => column.name)).toEqual(["id"]);
	}, 60_000);

	test("never overwrites an existing column when the generated name is taken", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Publishing" });
		const withAuthors = await workspace.addTable({ name: "Authors" });
		const authorsTable = requireTable(requireDesign(withAuthors), "Authors");
		const withBooks = await workspace.addTable({ name: "Books" });
		const booksTable = requireTable(requireDesign(withBooks), "Books");
		const withExisting = await workspace.addColumn({
			tableId: booksTable.id,
			name: "author_id",
			type: "text",
		});
		const existing = requireColumn(
			requireTable(requireDesign(withExisting), "Books"),
			"author_id",
		);

		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});

		const books = requireTable(requireDesign(related), "Books");
		// The existing column keeps its identity, type, and nullability.
		expect(books.columns.find((column) => column.id === existing.id)).toEqual(existing);
		const generated = requireColumn(books, "author_id_2");
		expect(generated).toMatchObject({ type: "bigint", nullable: false });
		expect(requireDesign(related).relationships[0].referencingColumnId).toBe(generated.id);

		const sql = requireCurrentSql(related);
		expect(sql).toContain('FOREIGN KEY ("author_id_2") REFERENCES "Authors" ("id")');
		expect(sql).toContain('"author_id" text');
	}, 60_000);

	test("names the generated column after a referenced table that is already singular", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "University" });
		const withCampus = await workspace.addTable({ name: "Campus" });
		const campusTable = requireTable(requireDesign(withCampus), "Campus");
		const withStudents = await workspace.addTable({ name: "Students" });
		const studentsTable = requireTable(requireDesign(withStudents), "Students");

		const related = await workspace.addRelationship({
			referencingTableId: studentsTable.id,
			referencedTableId: campusTable.id,
		});

		requireColumn(requireTable(requireDesign(related), "Students"), "campus_id");
		expect(requireCurrentSql(related)).toContain(
			'FOREIGN KEY ("campus_id") REFERENCES "Campus" ("id")',
		);
	}, 60_000);

	test("keeps references required by default and lets the designer make one optional", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Offices" });
		const withCountries = await workspace.addTable({ name: "Countries" });
		const countriesTable = requireTable(requireDesign(withCountries), "Countries");
		// A text key without identity, so updating a referenced key is observable.
		await workspace.updateColumn({
			tableId: countriesTable.id,
			columnId: requireColumn(countriesTable, "id").id,
			changes: { name: "code", type: "text", nullable: false },
		});
		const withOffices = await workspace.addTable({ name: "Offices" });
		const officesTable = requireTable(requireDesign(withOffices), "Offices");

		let state = await workspace.addRelationship({
			referencingTableId: officesTable.id,
			referencedTableId: countriesTable.id,
		});
		const relationship = requireRelationship(state, requireDesign(state).relationships[0].id);
		const countryCode = requireColumn(
			requireTable(requireDesign(state), "Offices"),
			"country_code",
		);
		expect(countryCode).toMatchObject({ type: "text", nullable: false });
		expect(countryCode.id).toBe(relationship.referencingColumnId);

		const requiredSql = requireCurrentSql(state);
		expect(requiredSql).toContain('"country_code" text NOT NULL');

		const database = new PGlite();
		try {
			await database.exec(requiredSql);
			await database.exec(`INSERT INTO "Countries" ("code") VALUES ('ES')`);
			await database.exec(`INSERT INTO "Offices" ("country_code") VALUES ('ES')`);
			// NO ACTION on updates refuses to orphan the referencing office.
			await expect(
				database.exec(`UPDATE "Countries" SET "code" = 'FR' WHERE "code" = 'ES'`),
			).rejects.toThrow(/foreign key/);
			// A required reference cannot be absent.
			await expect(
				database.exec(`INSERT INTO "Offices" ("country_code") VALUES (NULL)`),
			).rejects.toThrow(/null value|not-null/);
		} finally {
			await database.close();
		}

		// Turning Required off makes the relationship-owned column nullable.
		const optional = await workspace.updateRelationship({
			relationshipId: relationship.id,
			required: false,
		});
		expect(
			requireColumn(requireTable(requireDesign(optional), "Offices"), "country_code"),
		).toMatchObject({ nullable: true });
		const optionalSql = requireCurrentSql(optional);
		expect(optionalSql).toContain('"country_code" text,');
		expect(optionalSql).not.toContain('"country_code" text NOT NULL');
		expect(
			requireAppliedTable(optional, "Offices").columns.find(
				(column) => column.name === "country_code",
			)?.nullable,
		).toBe(true);

		// An optional reference permits absence without requiring a parent child.
		const optionalDatabase = new PGlite();
		try {
			await optionalDatabase.exec(optionalSql);
			await optionalDatabase.exec(`INSERT INTO "Offices" DEFAULT VALUES`);
			await optionalDatabase.exec(`INSERT INTO "Countries" ("code") VALUES ('ES')`);
			const rows = await optionalDatabase.query<{ country_code: string | null }>(
				`SELECT "country_code" FROM "Offices"`,
			);
			expect(rows.rows).toEqual([{ country_code: null }]);
			await expect(
				optionalDatabase.exec(`INSERT INTO "Offices" ("country_code") VALUES ('XX')`),
			).rejects.toThrow(/foreign key/);
		} finally {
			await optionalDatabase.close();
		}

		// The column editor and the relationship control express one setting.
		const nullableFromColumnEditor = await workspace.updateColumn({
			tableId: officesTable.id,
			columnId: countryCode.id,
			changes: { nullable: false },
		});
		expect(requireCurrentSql(nullableFromColumnEditor)).toContain(
			'"country_code" text NOT NULL',
		);
		const requiredAgain = await workspace.updateRelationship({
			relationshipId: relationship.id,
			required: true,
		});
		expect(
			requireColumn(requireTable(requireDesign(requiredAgain), "Offices"), "country_code")
				.nullable,
		).toBe(false);
	}, 60_000);

	test("keeps separate author and editor references distinct across renames and reopening", async () => {
		const { workspace, databasePath } = await openTestWorkspace();
		await workspace.createProject({ name: "Editing" });
		const withAuthors = await workspace.addTable({ name: "Authors" });
		const authorsTable = requireTable(requireDesign(withAuthors), "Authors");
		const withBooks = await workspace.addTable({ name: "Books" });
		const booksTable = requireTable(requireDesign(withBooks), "Books");

		const firstRelationship = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const secondRelationship = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});

		const relationships = requireDesign(secondRelationship).relationships;
		expect(relationships).toHaveLength(2);
		const authorReference = relationships[0];
		const editorReference = relationships[1];
		expect(authorReference.id).not.toBe(editorReference.id);
		expect(requireRelationship(firstRelationship, authorReference.id)).toEqual({
			...authorReference,
		});

		// Two references between the same tables own distinct columns.
		const booksAfterRelating = requireTable(requireDesign(secondRelationship), "Books");
		const authorColumn = booksAfterRelating.columns.find(
			(column) => column.id === authorReference.referencingColumnId,
		);
		const editorColumn = booksAfterRelating.columns.find(
			(column) => column.id === editorReference.referencingColumnId,
		);
		if (!authorColumn || !editorColumn) throw new Error("Expected both foreign-key columns.");
		expect([authorColumn.name, editorColumn.name]).toEqual(["author_id", "author_id_2"]);

		const renamedColumn = await workspace.updateColumn({
			tableId: booksTable.id,
			columnId: editorColumn.id,
			changes: { name: "editor_id" },
		});
		expect(requireDesign(renamedColumn).relationships).toHaveLength(2);
		expect(
			requireDesign(renamedColumn).relationships[1].referencingColumnId,
		).toBe(editorColumn.id);
		const renamedAuthor = await workspace.renameTable({
			tableId: authorsTable.id,
			name: "Writers",
		});
		expect(requireDesign(renamedAuthor).relationships).toHaveLength(2);
		const renamedTables = await workspace.renameTable({
			tableId: booksTable.id,
			name: "Novels",
		});

		const renamed = requireDesign(renamedTables);
		expect(renamed.relationships.map((relationship) => relationship.id)).toEqual([
			authorReference.id,
			editorReference.id,
		]);
		const novels = requireTable(renamed, "Novels");
		expect(
			novels.columns.map((column) => [column.id, column.name]).filter(([id]) =>
				[id === authorColumn.id, id === editorColumn.id].some(Boolean),
			),
		).toEqual([
			[authorColumn.id, "author_id"],
			[editorColumn.id, "editor_id"],
		]);
		const renamedSql = requireCurrentSql(renamedTables);
		expect(renamedSql).toContain('FOREIGN KEY ("author_id") REFERENCES "Writers" ("id")');
		expect(renamedSql).toContain('FOREIGN KEY ("editor_id") REFERENCES "Writers" ("id")');
		expect(requireAppliedSandbox(renamedTables).relationships).toHaveLength(2);
		expect(
			requireAppliedSandbox(renamedTables).relationships.map(
				(relationship) => relationship.referencingColumn,
			),
		).toEqual(["author_id", "editor_id"]);

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await reopenTestWorkspace(databasePath);
		const restored = requireDesign(reopened.getState());
		expect(restored.relationships).toEqual(renamed.relationships);
		expect(requireCurrentSql(reopened.getState())).toBe(renamedSql);
		const restoredRelationship = requireRelationship(reopened.getState(), editorReference.id);
		expect(restoredRelationship.referencingColumnId).toBe(editorColumn.id);
		expect(requireAppliedSandbox(reopened.getState()).relationships).toHaveLength(2);
	}, 90_000);

	test("removes a relationship constraint while retaining its underlying columns", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);
		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const relationship = requireDesign(related).relationships[0];
		const fkColumnId = relationship.referencingColumnId;

		const removed = await workspace.removeRelationship({ relationshipId: relationship.id });
		expect(requireDesign(removed).relationships).toEqual([]);
		const books = requireTable(requireDesign(removed), "Books");
		expect(books.columns.map((column) => column.id)).toContain(fkColumnId);
		expect(requireCurrentSql(removed)).not.toContain("FOREIGN KEY");
		expect(requireAppliedSandbox(removed).relationships).toEqual([]);
		const maintainedColumns = requireAppliedTable(removed, "Books").columns.map(
			(column) => column.name,
		);
		expect(maintainedColumns).toEqual(["id", "author_id"]);
	}, 60_000);

	test("reports incompatible key edits instead of silently disconnecting the relationship", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);
		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const relationship = requireDesign(related).relationships[0];
		const appliedRevision =
			related.sandbox.status === "applied" ? related.sandbox.revision : 0;

		const mismatched = await workspace.updateColumn({
			tableId: booksTable.id,
			columnId: relationship.referencingColumnId,
			changes: { type: "text" },
		});
		expect(mismatched.save).toMatchObject({ status: "saved" });
		expect(requireDesign(mismatched).relationships).toEqual([relationship]);
		expect(mismatched.sql.status).toBe("stale");
		if (mismatched.sql.status !== "stale") {
			throw new Error("Expected the mismatched key to block SQL generation.");
		}
		expect(mismatched.sql.errors.join(" ")).toContain("needs matching types");
		expect(mismatched.sandbox).toMatchObject({
			status: "applied",
			revision: appliedRevision,
		});

		// Returning the key to the referenced type makes the same link valid again.
		for (const type of ["text", "bigint"] as const) {
			const retyped = await workspace.updateColumn({
				tableId: booksTable.id,
				columnId: relationship.referencingColumnId,
				changes: { type },
			});
			expect(requireDesign(retyped).relationships).toEqual([relationship]);
			if (type === "bigint") {
				expect(retyped.sql.status).toBe("current");
				expect(retyped.sandbox.status).toBe("applied");
			}
		}
	}, 60_000);

	test("lists affected relationships before deleting a referenced table", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);
		await workspace.addTable({ name: "Genres" });
		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const relationship = requireDesign(related).relationships[0];
		const revision = related.revision;

		const plan = workspace.describeRemoval({ kind: "table", tableId: authorsTable.id });
		expect(plan.target).toBe("Authors");
		expect(plan.relationships).toEqual([
			{
				relationshipId: relationship.id,
				cardinality: "one-to-many",
				referencingTable: "Books",
				referencingColumn: "author_id",
				referencedTable: "Authors",
				referencedColumn: "id",
				constraints: ["foreign-key"],
			},
		]);

		// Cancelling - simply not confirming - leaves the design untouched.
		await expect(workspace.removeTable({ tableId: authorsTable.id })).rejects.toThrow(
			/confirm/i,
		);
		expect(workspace.getState().revision).toBe(revision);
		expect(requireDesign(workspace.getState()).relationships).toEqual([relationship]);
		expect(workspace.getState().project?.name).toBe("Publishing");

		const removed = await workspace.removeTable({
			tableId: authorsTable.id,
			confirmed: true,
		});
		const remaining = requireDesign(removed).tables.map((table) => table.name).sort();
		expect(remaining).toEqual(["Books", "Genres"]);
		expect(requireDesign(removed).relationships).toEqual([]);
		// The generated column survives its relationship; unrelated tables stay.
		expect(requireTable(requireDesign(removed), "Books").columns.map((column) => column.name)).toEqual(
			["id", "author_id"],
		);
		expect(requireCurrentSql(removed)).not.toContain("FOREIGN KEY");
		expect(requireAppliedSandbox(removed).relationships).toEqual([]);
	}, 60_000);

	test("lists affected relationships before deleting a participating column", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);
		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const relationship = requireDesign(related).relationships[0];
		const referencedKey = requireColumn(requireTable(requireDesign(related), "Authors"), "id");
		await workspace.addColumn({ tableId: authorsTable.id, name: "name", type: "text" });

		const referencedPlan = workspace.describeRemoval({
			kind: "column",
			tableId: authorsTable.id,
			columnId: referencedKey.id,
		});
		expect(referencedPlan.target).toBe("Authors.id");
		expect(referencedPlan.relationships.map((entry) => entry.relationshipId)).toEqual([
			relationship.id,
		]);

		const revision = workspace.getState().revision;
		await expect(
			workspace.removeColumn({
				tableId: authorsTable.id,
				columnId: referencedKey.id,
			}),
		).rejects.toThrow(/confirm/i);
		expect(workspace.getState().revision).toBe(revision);

		const removedKey = await workspace.removeColumn({
			tableId: authorsTable.id,
			columnId: referencedKey.id,
			confirmed: true,
		});
		expect(requireDesign(removedKey).relationships).toEqual([]);
		expect(requireTable(requireDesign(removedKey), "Authors").columns.map((c) => c.name)).toEqual([
			"name",
		]);
		// The referencing side keeps its column when the relationship goes.
		expect(requireTable(requireDesign(removedKey), "Books").columns.map((c) => c.name)).toEqual([
			"id",
			"author_id",
		]);

		const referencingPlan = workspace.describeRemoval({
			kind: "column",
			tableId: booksTable.id,
			columnId: relationship.referencingColumnId,
		});
		expect(referencingPlan.relationships).toEqual([]);
	}, 60_000);

	test("requires a single primary key on the referenced table", async () => {
		const { workspace } = await openTestWorkspace();
		const { authorsTable, booksTable } = await addAuthorsAndBooks(workspace);

		const withoutKey = await workspace.updateColumn({
			tableId: authorsTable.id,
			columnId: requireColumn(authorsTable, "id").id,
			changes: { primaryKey: false },
		});
		expect(withoutKey.sql.status).toBe("stale");
		const revision = withoutKey.revision;

		await expect(
			workspace.addRelationship({
				referencingTableId: booksTable.id,
				referencedTableId: authorsTable.id,
			}),
		).rejects.toThrow(/primary key/i);
		expect(workspace.getState().revision).toBe(revision);
		expect(requireDesign(workspace.getState()).relationships).toEqual([]);
		expect(requireTable(requireDesign(workspace.getState()), "Books").columns).toHaveLength(1);

		// An existing relationship stays visible as a validation error.
		const restored = await workspace.updateColumn({
			tableId: authorsTable.id,
			columnId: requireColumn(authorsTable, "id").id,
			changes: { primaryKey: true },
		});
		expect(restored.sql.status).toBe("current");
		const related = await workspace.addRelationship({
			referencingTableId: booksTable.id,
			referencedTableId: authorsTable.id,
		});
		const relationship = requireDesign(related).relationships[0];
		const demoted = await workspace.updateColumn({
			tableId: authorsTable.id,
			columnId: requireColumn(requireTable(requireDesign(related), "Authors"), "id").id,
			changes: { primaryKey: false },
		});
		expect(requireDesign(demoted).relationships).toEqual([relationship]);
		expect(demoted.sql.status).toBe("stale");
		if (demoted.sql.status !== "stale") {
			throw new Error("Expected the missing key to block SQL generation.");
		}
		expect(demoted.sql.errors.join(" ")).toContain(
			'needs "Authors" to have exactly one primary key column',
		);
	}, 60_000);
});
