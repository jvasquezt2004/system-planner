import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesignColumn, DesignTable } from "../shared/design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

async function openTestWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-undo-redo-"));
	temporaryDirectories.push(directory);
	const databasePath = join(directory, "designs.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	openWorkspaces.push(workspace);
	return { workspace, databasePath };
}

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function requireTable(tables: DesignTable[] | undefined, name: string): DesignTable {
	const table = tables?.find((candidate) => candidate.name === name);
	if (!table) throw new Error(`Expected table ${name}.`);
	return table;
}

function requireColumn(table: DesignTable, name: string): DesignColumn {
	const column = table.columns.find((candidate) => candidate.name === name);
	if (!column) throw new Error(`Expected column ${name}.`);
	return column;
}

describe("session undo and redo", () => {
	test("reverses and reapplies a structured default, saves the branch, and forgets history on reopen", async () => {
		const { workspace, databasePath } = await openTestWorkspace();
		await workspace.createProject({ name: "Publishing" });
		const addedTable = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" });
		const authors = requireTable(addedTable.design?.tables, "Authors");
		const addedColumn = await workspace.addColumn({ designId: workspace.getState().activeDesignId!, tableId: authors.id, name: "pen_name", type: "text" });
		const column = requireColumn(requireTable(addedColumn.design?.tables, "Authors"), "pen_name");
		const defaulted = await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: authors.id,
			columnId: column.id,
			changes: { default: { kind: "literal", literalType: "text", value: "Writer" } },
		});

		expect(defaulted.undoRedo).toEqual({ canUndo: true, canRedo: false });
		expect(defaulted.sql.status).toBe("current");
		expect(defaulted.sandbox.status).toBe("applied");
		if (defaulted.sandbox.status !== "applied") throw new Error("Expected an applied sandbox.");
		expect(requireColumn(requireTable(defaulted.design?.tables, "Authors"), "pen_name").default).toEqual({
			kind: "literal",
			literalType: "text",
			value: "Writer",
		});
		expect(defaulted.sandbox.tables[0].columns.find((candidate) => candidate.name === "pen_name")?.defaultExpression).toContain("Writer");

		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.revision).toBe(defaulted.revision + 1);
		expect(undone.save.status).toBe("saved");
		expect(undone.undoRedo).toEqual({ canUndo: true, canRedo: true });
		expect(requireColumn(requireTable(undone.design?.tables, "Authors"), "pen_name").default).toEqual({ kind: "none" });
		expect(undone.sql).toMatchObject({ status: "current", revision: undone.revision });
		expect(undone.sandbox).toMatchObject({ status: "applied", revision: undone.revision });

		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(redone.revision).toBe(undone.revision + 1);
		expect(redone.undoRedo).toEqual({ canUndo: true, canRedo: false });
		expect(requireColumn(requireTable(redone.design?.tables, "Authors"), "pen_name").default).toEqual({
			kind: "literal",
			literalType: "text",
			value: "Writer",
		});
		expect(redone.sandbox).toMatchObject({ status: "applied", revision: redone.revision });

		const branched = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		const branchColumn = requireColumn(requireTable(branched.design?.tables, "Authors"), "pen_name");
		const newEdit = await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: authors.id,
			columnId: branchColumn.id,
			changes: { default: { kind: "literal", literalType: "text", value: "Editor" } },
		});
		expect(newEdit.undoRedo).toEqual({ canUndo: true, canRedo: false });
		const noRedo = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(noRedo.revision).toBe(newEdit.revision);
		expect(requireColumn(requireTable(noRedo.design?.tables, "Authors"), "pen_name").default).toEqual({
			kind: "literal",
			literalType: "text",
			value: "Editor",
		});

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await createDesignWorkspace({ databasePath });
		openWorkspaces.push(reopened);
		expect(reopened.getState().design?.tables).toEqual(newEdit.design?.tables);
		expect(reopened.getState().undoRedo).toEqual({ canUndo: false, canRedo: false });
		expect(reopened.getState().save.status).toBe("saved");
		expect(reopened.getState().sandbox.status).toBe("applied");
	}, 60_000);
	test("treats a card move as one layout-only undoable change", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Layout" });
		const created = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const books = requireTable(created.design?.tables, "Books");
		const originalSandbox = created.sandbox;

		const moved = await workspace.moveTable({ designId: workspace.getState().activeDesignId!,
			tableId: books.id,
			position: { x: 280, y: 190 },
		});
		expect(requireTable(moved.design?.tables, "Books").position).toEqual({
			x: 280,
			y: 190,
		});
		expect(moved.revision).toBe(created.revision);
		expect(moved.sql).toEqual(created.sql);
		expect(moved.sandbox).toEqual(originalSandbox);
		expect(moved.undoRedo).toEqual({ canUndo: true, canRedo: false });

		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(requireTable(undone.design?.tables, "Books").position).toEqual(books.position);
		expect(undone.revision).toBe(created.revision);
		expect(undone.save.status).toBe("saved");
		expect(undone.sql).toEqual(created.sql);
		expect(undone.sandbox).toEqual(originalSandbox);
		expect(undone.undoRedo).toEqual({ canUndo: true, canRedo: true });

		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(requireTable(redone.design?.tables, "Books").position).toEqual({
			x: 280,
			y: 190,
		});
		expect(redone.revision).toBe(created.revision);
		expect(redone.sql).toEqual(created.sql);
		expect(redone.sandbox).toEqual(originalSandbox);
	}, 60_000);
	test("undoes a design edit without restoring an earlier viewport", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Undo with navigation" });
		const authors = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" })).design?.tables,
			"Authors",
		);
		const addedColumn = await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: authors.id,
			name: "pen_name",
			type: "text",
		});
		const column = requireColumn(
			requireTable(addedColumn.design?.tables, "Authors"),
			"pen_name",
		);
		const edited = await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: authors.id,
			columnId: column.id,
			changes: {
				default: { kind: "literal", literalType: "text", value: "Writer" },
			},
		});
		const viewport = { x: 180, y: 120, zoom: 1.25 };

		const navigated = await workspace.setViewport({ ...viewport, designId: workspace.getState().activeDesignId! });
		expect(navigated.design?.viewport).toEqual(viewport);
		expect(navigated.undoRedo).toEqual(edited.undoRedo);

		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(
			requireColumn(requireTable(undone.design?.tables, "Authors"), "pen_name").default,
		).toEqual({ kind: "none" });
		expect(undone.design?.viewport).toEqual(viewport);
		expect(undone.undoRedo).toEqual({ canUndo: true, canRedo: true });
		expect(undone.sandbox.status).toBe("applied");
	}, 120_000);
	test("keeps redo available when navigating after undo", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Redo with navigation" });
		const authors = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" })).design?.tables,
			"Authors",
		);
		const addedColumn = await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: authors.id,
			name: "pen_name",
			type: "text",
		});
		const column = requireColumn(
			requireTable(addedColumn.design?.tables, "Authors"),
			"pen_name",
		);
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: authors.id,
			columnId: column.id,
			changes: {
				default: { kind: "literal", literalType: "text", value: "Writer" },
			},
		});
		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.undoRedo).toEqual({ canUndo: true, canRedo: true });
		const viewport = { x: -150, y: 75, zoom: 1.4 };

		const navigated = await workspace.setViewport({ ...viewport, designId: workspace.getState().activeDesignId! });
		expect(navigated.design?.viewport).toEqual(viewport);
		expect(navigated.undoRedo).toEqual({ canUndo: true, canRedo: true });

		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(
			requireColumn(requireTable(redone.design?.tables, "Authors"), "pen_name").default,
		).toEqual({
			kind: "literal",
			literalType: "text",
			value: "Writer",
		});
		expect(redone.design?.viewport).toEqual(viewport);
		expect(redone.undoRedo).toEqual({ canUndo: true, canRedo: false });
	}, 120_000);
	test("restores each direct relationship with its generated column and database constraints", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Relationships" });
		const authors = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" })).design?.tables, "Authors");
		const books = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" })).design?.tables, "Books");
		const oneToMany = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-many",
		});
		const authorRelationship = oneToMany.design?.relationships[0];
		if (!authorRelationship) throw new Error("Expected the one-to-many relationship.");
		const authorForeignKey = requireTable(oneToMany.design?.tables, "Books").columns.find(
			(column) => column.id === authorRelationship.referencingColumnId,
		);
		if (!authorForeignKey) throw new Error("Expected the generated author reference.");
		expect(oneToMany.sandbox).toMatchObject({
			status: "applied",
			relationships: [{ referencingTable: "Books", referencedTable: "Authors" }],
		});

		const withoutAuthorLink = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(withoutAuthorLink.design?.relationships).toEqual([]);
		expect(requireTable(withoutAuthorLink.design?.tables, "Books").columns).not.toContainEqual(
			expect.objectContaining({ id: authorForeignKey.id }),
		);
		expect(withoutAuthorLink.sandbox).toMatchObject({ status: "applied", relationships: [] });

		const restoredAuthorLink = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(restoredAuthorLink.design?.relationships).toEqual([authorRelationship]);
		expect(requireTable(restoredAuthorLink.design?.tables, "Books").columns).toContainEqual(
			authorForeignKey,
		);
		expect(restoredAuthorLink.sandbox).toMatchObject({
			status: "applied",
			relationships: [{ referencingTable: "Books", referencedTable: "Authors" }],
		});

		const users = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Users" })).design?.tables, "Users");
		const profiles = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Profiles" })).design?.tables, "Profiles");
		const oneToOne = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: profiles.id,
			referencedTableId: users.id,
			cardinality: "one-to-one",
		});
		const profileRelationship = oneToOne.design?.relationships.find(
			(relationship) => relationship.cardinality === "one-to-one",
		);
		if (!profileRelationship) throw new Error("Expected the one-to-one relationship.");
		expect(oneToOne.sandbox).toMatchObject({
			status: "applied",
			relationships: [
				{ referencingTable: "Books", referencedTable: "Authors" },
				{ referencingTable: "Profiles", referencedTable: "Users" },
			],
		});
		if (oneToOne.sandbox.status !== "applied") throw new Error("Expected an applied sandbox.");
		expect(
			oneToOne.sandbox.tables
				.find((table) => table.name === "Profiles")
				?.columns.find((column) => column.name === "user_id"),
		).toMatchObject({ unique: true, nullable: false });

		const withoutProfileLink = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(withoutProfileLink.design?.relationships).toEqual([authorRelationship]);
		expect(requireTable(withoutProfileLink.design?.tables, "Profiles").columns).not.toContainEqual(
			expect.objectContaining({ id: profileRelationship.referencingColumnId }),
		);
		expect(withoutProfileLink.sandbox).toMatchObject({
			status: "applied",
			relationships: [{ referencingTable: "Books", referencedTable: "Authors" }],
		});

		const restoredProfileLink = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(restoredProfileLink.design?.relationships).toContainEqual(profileRelationship);
		expect(restoredProfileLink.sandbox).toMatchObject({
			status: "applied",
			relationships: [
				{ referencingTable: "Books", referencedTable: "Authors" },
				{ referencingTable: "Profiles", referencedTable: "Users" },
			],
		});
		if (restoredProfileLink.sandbox.status !== "applied") throw new Error("Expected an applied sandbox.");
		expect(
			restoredProfileLink.sandbox.tables
				.find((table) => table.name === "Profiles")
				?.columns.find((column) => column.name === "user_id"),
		).toMatchObject({ unique: true, nullable: false });
	}, 120_000);
	test("undoes and redoes relationship removals while preserving columns and junctions", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Relationship removal" });
		const authors = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" })).design?.tables,
			"Authors",
		);
		const books = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" })).design?.tables,
			"Books",
		);
		const linked = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-many",
		});
		const authorRelationship = linked.design?.relationships[0];
		if (!authorRelationship || !linked.design) {
			throw new Error("Expected the Authors/Books relationship.");
		}
		const authorForeignKey = requireColumn(
			requireTable(linked.design.tables, "Books"),
			"author_id",
		);

		const students = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" })).design?.tables,
			"Students",
		);
		const courses = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Courses" })).design?.tables,
			"Courses",
		);
		const withJunction = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: students.id,
			referencedTableId: courses.id,
			cardinality: "many-to-many",
			junctionPosition: { x: 220, y: 340 },
		});
		const association = withJunction.design?.manyToManyRelationships[0];
		if (!association || !withJunction.design) {
			throw new Error("Expected the Students/Courses association.");
		}
		const junction = requireTable(withJunction.design.tables, "StudentsCourses");
		const junctionRelationships = [
			{ referencingTable: "StudentsCourses", referencedTable: "Courses" },
			{ referencingTable: "StudentsCourses", referencedTable: "Students" },
		];

		const withoutDirect = await workspace.removeRelationship({ designId: workspace.getState().activeDesignId!,
			relationshipId: authorRelationship.id,
		});
		expect(withoutDirect.design?.relationships).toEqual(
			withJunction.design.relationships.filter(
				(relationship) => relationship.id !== authorRelationship.id,
			),
		);
		expect(withoutDirect.design?.manyToManyRelationships).toEqual([association]);
		expect(requireTable(withoutDirect.design?.tables, "Books").columns).toContainEqual(
			authorForeignKey,
		);
		expect(requireTable(withoutDirect.design?.tables, "StudentsCourses")).toEqual(junction);
		expect(withoutDirect.sandbox).toMatchObject({
			status: "applied",
			relationships: junctionRelationships,
		});

		const restoredDirect = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(restoredDirect.design).toEqual(withJunction.design);
		if (restoredDirect.sandbox.status !== "applied") {
			throw new Error("Expected an applied sandbox.");
		}
		expect(restoredDirect.sandbox.relationships).toHaveLength(3);
		expect(restoredDirect.sandbox.relationships).toContainEqual(
			expect.objectContaining({
				referencingTable: "Books",
				referencedTable: "Authors",
			}),
		);

		const removedDirectAgain = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(removedDirectAgain.design).toEqual(withoutDirect.design);
		expect(removedDirectAgain.sandbox).toMatchObject({
			status: "applied",
			relationships: junctionRelationships,
		});

		const withoutJunctionRelationship = await workspace.removeRelationship({ designId: workspace.getState().activeDesignId!,
			relationshipId: association.leftRelationshipId,
		});
		expect(withoutJunctionRelationship.design?.relationships).toEqual([]);
		expect(withoutJunctionRelationship.design?.manyToManyRelationships).toEqual([]);
		expect(
			requireTable(withoutJunctionRelationship.design?.tables, "StudentsCourses").columns,
		).toEqual(junction.columns);
		if (withoutJunctionRelationship.sandbox.status !== "applied") {
			throw new Error("Expected an applied sandbox.");
		}
		expect(withoutJunctionRelationship.sandbox.relationships).toEqual([]);
		expect(
			withoutJunctionRelationship.sandbox.tables
				.find((table) => table.name === "StudentsCourses")
				?.columns.map((column) => column.name),
		).toEqual(["id", "student_id", "course_id"]);

		const restoredJunctionRelationship = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(restoredJunctionRelationship.design?.relationships).toEqual(
			withoutDirect.design?.relationships,
		);
		expect(restoredJunctionRelationship.design?.manyToManyRelationships).toEqual([
			association,
		]);
		expect(restoredJunctionRelationship.design?.tables).toContainEqual(junction);
		expect(restoredJunctionRelationship.sandbox).toMatchObject({
			status: "applied",
			relationships: junctionRelationships,
		});

		const removedJunctionRelationshipAgain = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(removedJunctionRelationshipAgain.design).toEqual(
			withoutJunctionRelationship.design,
		);
		expect(removedJunctionRelationshipAgain.design?.tables).toContainEqual(junction);
		expect(removedJunctionRelationshipAgain.sandbox).toMatchObject({
			status: "applied",
			relationships: [],
		});
	}, 120_000);
	test("undoes and redoes many-to-many junction creation as one complete association", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		const students = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" })).design?.tables, "Students");
		const courses = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Courses" })).design?.tables, "Courses");
		const created = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: students.id,
			referencedTableId: courses.id,
			cardinality: "many-to-many",
			junctionPosition: { x: 220, y: 340 },
		});
		const association = created.design?.manyToManyRelationships[0];
		if (!association) throw new Error("Expected the many-to-many association.");
		const junction = requireTable(created.design?.tables, "StudentsCourses");
		const childRelationships = created.design?.relationships.filter(
			(relationship) => relationship.referencingTableId === junction.id,
		);
		expect(childRelationships).toHaveLength(2);
		expect(created.undoRedo).toEqual({ canUndo: true, canRedo: false });
		expect(created.sandbox).toMatchObject({
			status: "applied",
			relationships: [
				{ referencingTable: "StudentsCourses", referencedTable: "Courses" },
				{ referencingTable: "StudentsCourses", referencedTable: "Students" },
			],
		});

		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undone.design?.tables.map((table) => table.id)).toEqual([students.id, courses.id]);
		expect(undone.design?.relationships).toEqual([]);
		expect(undone.design?.manyToManyRelationships).toEqual([]);
		expect(undone.sandbox).toMatchObject({ status: "applied", relationships: [] });
		if (undone.sandbox.status !== "applied") throw new Error("Expected an applied sandbox.");
		expect(undone.sandbox.tables.map((table) => table.name).sort()).toEqual(["Courses", "Students"]);

		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(redone.design?.tables).toContainEqual(junction);
		expect(redone.design?.manyToManyRelationships).toEqual([association]);
		expect(redone.design?.relationships).toEqual(created.design?.relationships);
		expect(redone.sandbox).toMatchObject({
			status: "applied",
			relationships: [
				{ referencingTable: "StudentsCourses", referencedTable: "Courses" },
				{ referencingTable: "StudentsCourses", referencedTable: "Students" },
			],
		});
		if (redone.sandbox.status !== "applied") throw new Error("Expected an applied sandbox.");
		const appliedJunction = redone.sandbox.tables.find((table) => table.name === "StudentsCourses");
		expect(appliedJunction?.columns).toMatchObject([
			{ name: "id", primaryKey: true, isIdentity: true },
			{ name: "student_id", nullable: false, unique: false },
			{ name: "course_id", nullable: false, unique: false },
		]);
	}, 120_000);
	test("undoes and redoes a confirmed dependency deletion without altering unrelated design", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Recovery" });
		const authors = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" })).design?.tables, "Authors");
		const books = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" })).design?.tables, "Books");
		const reviews = requireTable((await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Reviews" })).design?.tables, "Reviews");
		const related = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-many",
		});
		const originalDesign = related.design;
		const relationship = originalDesign?.relationships[0];
		if (!originalDesign || !relationship) throw new Error("Expected a related design.");
		const authorForeignKey = requireTable(originalDesign.tables, "Books").columns.find(
			(column) => column.id === relationship.referencingColumnId,
		);
		if (!authorForeignKey) throw new Error("Expected the generated author reference.");

		await expect(workspace.removeTable({ designId: workspace.getState().activeDesignId!, tableId: authors.id })).rejects.toThrow(
			/Confirm the removal/,
		);
		expect(workspace.getState().design).toEqual(originalDesign);
		expect(workspace.getState().undoRedo).toEqual({ canUndo: true, canRedo: false });

		const deleted = await workspace.removeTable({ designId: workspace.getState().activeDesignId!, tableId: authors.id, confirmed: true });
		expect(deleted.design?.tables.map((table) => table.name)).toEqual(["Books", "Reviews"]);
		expect(deleted.design?.relationships).toEqual([]);
		expect(requireTable(deleted.design?.tables, "Books").columns).toContainEqual(authorForeignKey);
		expect(requireTable(deleted.design?.tables, "Reviews")).toEqual(reviews);
		expect(deleted.sandbox).toMatchObject({ status: "applied", relationships: [] });

		const restored = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(restored.design).toEqual(originalDesign);
		expect(restored.sandbox).toMatchObject({
			status: "applied",
			relationships: [{ referencingTable: "Books", referencedTable: "Authors" }],
		});
		expect(restored.undoRedo).toEqual({ canUndo: true, canRedo: true });

		const removedAgain = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(removedAgain.design?.tables.map((table) => table.name)).toEqual(["Books", "Reviews"]);
		expect(removedAgain.design?.relationships).toEqual([]);
		expect(requireTable(removedAgain.design?.tables, "Books").columns).toContainEqual(authorForeignKey);
		expect(requireTable(removedAgain.design?.tables, "Reviews")).toEqual(reviews);
		expect(removedAgain.sandbox).toMatchObject({ status: "applied", relationships: [] });
	}, 120_000);
	test("undoes and redoes table renames through the current SQL and sandbox", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Names" });
		const added = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" });
		const books = requireTable(added.design?.tables, "Books");
		const renamed = await workspace.renameTable({ designId: workspace.getState().activeDesignId!, tableId: books.id, name: "Volumes" });
		expect(requireTable(renamed.design?.tables, "Volumes").id).toBe(books.id);
		expect(renamed.sql).toMatchObject({ status: "current", revision: renamed.revision });
		expect(renamed.sandbox).toMatchObject({
			status: "applied",
			tables: [{ name: "Volumes" }],
		});

		const undone = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(requireTable(undone.design?.tables, "Books").id).toBe(books.id);
		expect(undone.sql).toMatchObject({ status: "current", revision: undone.revision });
		expect(undone.sandbox).toMatchObject({
			status: "applied",
			tables: [{ name: "Books" }],
		});

		const redone = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(requireTable(redone.design?.tables, "Volumes").id).toBe(books.id);
		expect(redone.sql).toMatchObject({ status: "current", revision: redone.revision });
		expect(redone.sandbox).toMatchObject({
			status: "applied",
			tables: [{ name: "Volumes" }],
		});
	}, 120_000);
	test("keeps undo and redo stacks isolated when switching projects", async () => {
		const { workspace } = await openTestWorkspace();
		const alpha = await workspace.createProject({ name: "Alpha" });
		const alphaId = alpha.project?.id;
		if (!alphaId) throw new Error("Expected Alpha to be open.");
		const alphaEdit = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Alpha table" });
		const alphaTable = requireTable(alphaEdit.design?.tables, "Alpha table");

		const beta = await workspace.createProject({ name: "Beta" });
		const betaId = beta.project?.id;
		if (!betaId) throw new Error("Expected Beta to be open.");
		expect(beta.undoRedo).toEqual({ canUndo: false, canRedo: false });
		const betaEdit = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Beta table" });
		const betaTable = requireTable(betaEdit.design?.tables, "Beta table");
		const undoneBeta = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undoneBeta.design?.tables).toEqual([]);
		expect(undoneBeta.undoRedo).toEqual({ canUndo: false, canRedo: true });

		const openedAlpha = await workspace.openProject({ projectId: alphaId });
		expect(openedAlpha.design?.tables).toContainEqual(alphaTable);
		expect(openedAlpha.undoRedo).toEqual({ canUndo: true, canRedo: false });
		const undoneAlpha = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(undoneAlpha.design?.tables).toEqual([]);
		expect(undoneAlpha.undoRedo).toEqual({ canUndo: false, canRedo: true });

		const openedBeta = await workspace.openProject({ projectId: betaId });
		expect(openedBeta.design?.tables).toEqual([]);
		expect(openedBeta.undoRedo).toEqual({ canUndo: false, canRedo: true });
		const redoneBeta = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(redoneBeta.design?.tables).toContainEqual(betaTable);
		expect(redoneBeta.undoRedo).toEqual({ canUndo: true, canRedo: false });
	}, 120_000);
	test("undoes and redoes a confirmed relationship-column deletion", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Column recovery" });
		const authors = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Authors" })).design?.tables,
			"Authors",
		);
		const books = requireTable(
			(await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Books" })).design?.tables,
			"Books",
		);
		const related = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: books.id,
			referencedTableId: authors.id,
			cardinality: "one-to-many",
		});
		const originalDesign = related.design;
		const relationship = originalDesign?.relationships[0];
		if (!originalDesign || !relationship) throw new Error("Expected a relationship.");
		const authorForeignKey = requireTable(originalDesign.tables, "Books").columns.find(
			(column) => column.id === relationship.referencingColumnId,
		);
		if (!authorForeignKey) throw new Error("Expected the generated author reference.");
		const target = {
			designId: workspace.getState().activeDesignId!,
			tableId: books.id,
			columnId: authorForeignKey.id,
		};

		await expect(workspace.removeColumn(target)).rejects.toThrow(/Confirm the removal/);
		expect(workspace.getState().design).toEqual(originalDesign);

		const deleted = await workspace.removeColumn({ ...target, confirmed: true });
		expect(deleted.design?.tables.map((table) => table.id)).toEqual([authors.id, books.id]);
		expect(deleted.design?.relationships).toEqual([]);
		expect(requireTable(deleted.design?.tables, "Books").columns).not.toContainEqual(
			authorForeignKey,
		);
		expect(deleted.sandbox).toMatchObject({ status: "applied", relationships: [] });

		const restored = await workspace.undo({ designId: workspace.getState().activeDesignId! });
		expect(restored.design).toEqual(originalDesign);
		expect(restored.sandbox).toMatchObject({
			status: "applied",
			relationships: [{ referencingTable: "Books", referencedTable: "Authors" }],
		});

		const removedAgain = await workspace.redo({ designId: workspace.getState().activeDesignId! });
		expect(removedAgain.design?.relationships).toEqual([]);
		expect(requireTable(removedAgain.design?.tables, "Books").columns).not.toContainEqual(
			authorForeignKey,
		);
		expect(removedAgain.sandbox).toMatchObject({ status: "applied", relationships: [] });
	}, 120_000);
});
