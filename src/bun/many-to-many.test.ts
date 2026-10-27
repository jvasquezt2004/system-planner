import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ColumnChanges,
	Design,
	DesignTable,
	WorkspaceState,
} from "../shared/design";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

async function openTestWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-many-to-many-"));
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

function requireDesign(state: WorkspaceState): Design {
	if (!state.design) throw new Error("Expected an open design.");
	return state.design;
}

function requireTable(design: Design, name: string): DesignTable {
	const table = design.tables.find((candidate) => candidate.name === name);
	if (!table) throw new Error(`Expected a table named ${name}.`);
	return table;
}

async function createStudentsCoursesAssociation(workspace: DesignWorkspace) {
	await workspace.createProject({ name: "School" });
	const studentsState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" });
	const students = requireTable(requireDesign(studentsState), "Students");
	const coursesState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Courses" });
	const courses = requireTable(requireDesign(coursesState), "Courses");
	const related = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
		referencingTableId: students.id,
		referencedTableId: courses.id,
		cardinality: "many-to-many",
	});
	const design = requireDesign(related);
	const association = design.manyToManyRelationships[0];
	if (!association) throw new Error("Expected a stored many-to-many association.");
	const junction = requireTable(design, "StudentsCourses");
	return { students, courses, junction, association, design };
}

describe("many-to-many relationships", () => {
	test("creates a visible junction with required references and rejects duplicate pairs in PostgreSQL", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		const withStudents = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" });
		const students = requireTable(requireDesign(withStudents), "Students");
		const withCourses = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Courses" });
		const courses = requireTable(requireDesign(withCourses), "Courses");
		const courseId = courses.columns.find((column) => column.primaryKey);
		if (!courseId) throw new Error("Expected a Courses primary key.");
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: courses.id,
			columnId: courseId.id,
			changes: { type: "uuid" },
		});

		const courseIds = {
			first: "00000000-0000-0000-0000-000000000001",
			second: "00000000-0000-0000-0000-000000000002",
			missing: "00000000-0000-0000-0000-000000000099",
			updated: "00000000-0000-0000-0000-000000000003",
		};

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: students.id,
			referencedTableId: courses.id,
			cardinality: "many-to-many",
			junctionPosition: { x: 180, y: 320 },
		});
		const design = requireDesign(state);
		expect(design.tables).toHaveLength(3);
		const junction = design.tables.find((table) => table.id !== students.id && table.id !== courses.id);
		if (!junction) throw new Error("Expected a visible junction table.");
		expect(junction.name).toBe("StudentsCourses");
		expect(junction.position).toEqual({ x: 180, y: 320 });
		expect(junction.columns).toMatchObject([
			{ name: "id", type: "bigint", primaryKey: true, identity: true, nullable: false },
			{ name: "student_id", type: "bigint", primaryKey: false, identity: false, nullable: false },
			{ name: "course_id", type: "uuid", primaryKey: false, identity: false, nullable: false },
		]);
		expect(design.relationships).toHaveLength(2);
		for (const relationship of design.relationships) {
			expect(relationship.referencingTableId).toBe(junction.id);
			expect(relationship.cardinality).toBe("one-to-many");
		}

		if (state.sql.status !== "current") throw new Error("Expected current SQL.");
		const sql = state.sql.sql;
		expect(sql).toContain('REFERENCES "Students" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION');
		expect(sql).toContain('REFERENCES "Courses" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION');
		expect(sql).toContain('UNIQUE ("student_id", "course_id")');
		expect(state.sandbox.status).toBe("applied");
		if (state.sandbox.status !== "applied") throw new Error("Expected an applied sandbox.");
		expect(state.sandbox.tables.map((table) => table.name)).toContain("StudentsCourses");
		const appliedJunction = state.sandbox.tables.find((table) => table.name === junction.name);
		if (!appliedJunction) throw new Error("Expected the junction in the sandbox catalog.");
		expect(appliedJunction.columns).toMatchObject([
			{ name: "id", primaryKey: true, isIdentity: true, nullable: false },
			{ name: "student_id", primaryKey: false, isIdentity: false, nullable: false, unique: false },
			{ name: "course_id", primaryKey: false, isIdentity: false, nullable: false, unique: false },
		]);
		expect(state.sandbox.relationships).toHaveLength(2);
		expect(state.sandbox.relationships.map((relationship) => [
			relationship.referencingTable,
			relationship.referencedTable,
			relationship.updateRule,
			relationship.deleteRule,
		])).toEqual([
			["StudentsCourses", "Courses", "NO ACTION", "NO ACTION"],
			["StudentsCourses", "Students", "NO ACTION", "NO ACTION"],
		]);

		const database = new PGlite();
		try {
			await database.exec(sql);
			await database.exec('INSERT INTO "Students" DEFAULT VALUES; INSERT INTO "Students" DEFAULT VALUES;');
			await database.exec(`
				INSERT INTO "Courses" ("id")
				VALUES ('${courseIds.first}'), ('${courseIds.second}');
			`);
			await database.exec(`
				INSERT INTO "StudentsCourses" ("student_id", "course_id")
				VALUES
					(1, '${courseIds.first}'),
					(1, '${courseIds.second}'),
					(2, '${courseIds.first}');
			`);
			await expect(
				database.exec(`
					INSERT INTO "StudentsCourses" ("student_id", "course_id")
					VALUES (1, '${courseIds.first}');
				`),
			).rejects.toThrow(/unique|duplicate key/i);
			await expect(
				database.exec(`
					INSERT INTO "StudentsCourses" ("student_id", "course_id")
					VALUES (NULL, '${courseIds.first}');
				`),
			).rejects.toThrow(/null value|not-null/i);
			await expect(
				database.exec(`
					INSERT INTO "StudentsCourses" ("student_id", "course_id")
					VALUES (1, NULL);
				`),
			).rejects.toThrow(/null value|not-null/i);
			await expect(
				database.exec(`
					INSERT INTO "StudentsCourses" ("student_id", "course_id")
					VALUES (1, '${courseIds.missing}');
				`),
			).rejects.toThrow(/foreign key/i);
			await expect(database.exec('DELETE FROM "Students" WHERE "id" = 1')).rejects.toThrow(/foreign key/i);
			await expect(
				database.exec(`
					UPDATE "Courses"
					SET "id" = '${courseIds.updated}'
					WHERE "id" = '${courseIds.first}';
				`),
			).rejects.toThrow(/foreign key/i);
		} finally {
			await database.close();
		}
	}, 60_000);

	test("persists an editable junction and relationship identities through renames and reopen", async () => {
		const { workspace, databasePath } = await openTestWorkspace();
		const { students, courses, junction, association } =
			await createStudentsCoursesAssociation(workspace);
		const studentReference = junction.columns.find(
			(column) => column.name === "student_id",
		);
		const courseReference = junction.columns.find(
			(column) => column.name === "course_id",
		);
		if (!studentReference || !courseReference) {
			throw new Error("Expected both generated endpoint references.");
		}

		await workspace.renameTable({ designId: workspace.getState().activeDesignId!, tableId: junction.id, name: "Enrollments" });
		await workspace.renameTable({ designId: workspace.getState().activeDesignId!, tableId: students.id, name: "Learners" });
		await workspace.renameTable({ designId: workspace.getState().activeDesignId!, tableId: courses.id, name: "Classes" });
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			columnId: studentReference.id,
			changes: { name: "learner_id" },
		});
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			columnId: courseReference.id,
			changes: { name: "class_id" },
		});
		await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			name: "grade",
			type: "text",
		});
		const grade = requireTable(requireDesign(workspace.getState()), "Enrollments").columns.find(
			(column) => column.name === "grade",
		);
		if (!grade) throw new Error("Expected the editable association field.");
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			columnId: grade.id,
			changes: { name: "letter_grade" },
		});

		await workspace.moveTable({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			position: { x: 720, y: 520 },
		});
		const edited = requireDesign(workspace.getState());
		const editedAssociation = edited.manyToManyRelationships[0];
		expect(editedAssociation).toEqual(association);
		expect(edited.tables.map((table) => table.name)).toEqual([
			"Learners",
			"Classes",
			"Enrollments",
		]);
		expect(requireTable(edited, "Enrollments").columns.map((column) => column.name)).toEqual([
			"id",
			"learner_id",
			"class_id",
			"letter_grade",
		]);
		expect(requireTable(edited, "Enrollments").position).toEqual({ x: 720, y: 520 });
		const relationshipIds = edited.relationships.map((relationship) => relationship.id);

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await createDesignWorkspace({ databasePath });
		openWorkspaces.push(reopened);

		const reopenedState = reopened.getState();
		const reopenedDesign = requireDesign(reopenedState);
		expect(reopenedDesign.manyToManyRelationships).toEqual([association]);
		expect(reopenedDesign.relationships.map((relationship) => relationship.id)).toEqual(
			relationshipIds,
		);
		expect(requireTable(reopenedDesign, "Enrollments").columns.map((column) => column.name)).toEqual([
			"id",
			"learner_id",
			"class_id",
			"letter_grade",
		]);
		expect(requireTable(reopenedDesign, "Enrollments").position).toEqual({
			x: 720,
			y: 520,
		});
		if (reopenedState.sql.status !== "current") throw new Error("Expected current SQL after reopen.");
		expect(reopenedState.sql.sql).toContain('REFERENCES "Learners" ("id")');
		expect(reopenedState.sql.sql).toContain('REFERENCES "Classes" ("id")');
		expect(reopenedState.sql.sql).toContain('UNIQUE ("learner_id", "class_id")');
		expect(reopenedState.sandbox.status).toBe("applied");
	}, 60_000);

	test("warns about endpoint deletion and preserves the junction when the relationship is confirmed", async () => {
		const { workspace } = await openTestWorkspace();
		const { students, junction } =
			await createStudentsCoursesAssociation(workspace);
		await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			name: "enrolled_at",
			type: "date",
		});

		const beforeCancellation = requireDesign(workspace.getState());
		const plan = workspace.describeRemoval({ designId: workspace.getState().activeDesignId!, kind: "table", tableId: students.id });
		expect(plan.relationships).toHaveLength(1);
		expect(plan.relationships[0]).toMatchObject({
			cardinality: "many-to-many",
			referencingTable: "Students",
			referencedTable: "Courses",
			junctionTable: "StudentsCourses",
		});
		await expect(workspace.removeTable({ designId: workspace.getState().activeDesignId!, tableId: students.id })).rejects.toThrow(
			/StudentsCourses/,
		);
		expect(requireDesign(workspace.getState())).toEqual(beforeCancellation);

		const removed = await workspace.removeTable({ designId: workspace.getState().activeDesignId!,
			tableId: students.id,
			confirmed: true,
		});
		const remaining = requireDesign(removed);
		expect(remaining.tables.map((table) => table.name)).toEqual([
			"Courses",
			"StudentsCourses",
		]);
		expect(remaining.manyToManyRelationships).toEqual([]);
		expect(remaining.relationships).toEqual([]);
		expect(requireTable(remaining, "StudentsCourses").columns.map((column) => column.name)).toEqual([
			"id",
			"student_id",
			"course_id",
			"enrolled_at",
		]);
		if (removed.sql.status !== "current") throw new Error("Expected SQL after endpoint deletion.");
		expect(removed.sql.sql).not.toContain("FOREIGN KEY");
		expect(removed.sql.sql).not.toContain("pair_key");
	}, 60_000);

	test("removes both owned references but keeps the editable junction and its columns", async () => {
		const { workspace } = await openTestWorkspace();
		const { association, junction } =
			await createStudentsCoursesAssociation(workspace);
		await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			name: "grade",
			type: "text",
		});

		const removed = await workspace.removeRelationship({ designId: workspace.getState().activeDesignId!,
			relationshipId: association.leftRelationshipId,
		});
		const remaining = requireDesign(removed);
		expect(remaining.tables.map((table) => table.name)).toEqual([
			"Students",
			"Courses",
			"StudentsCourses",
		]);
		expect(remaining.relationships).toEqual([]);
		expect(remaining.manyToManyRelationships).toEqual([]);
		expect(requireTable(remaining, "StudentsCourses").columns.map((column) => column.name)).toEqual([
			"id",
			"student_id",
			"course_id",
			"grade",
		]);
		if (removed.sql.status !== "current") throw new Error("Expected current SQL after removal.");
		expect(removed.sql.sql).not.toContain("FOREIGN KEY");
		expect(removed.sql.sql).not.toContain("pair_key");
		if (removed.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept the retained junction.");
		}
		expect(removed.sandbox.relationships).toEqual([]);

		const database = new PGlite();
		try {
			await database.exec(removed.sql.sql);
			await database.exec(
				'INSERT INTO "StudentsCourses" ("student_id", "course_id") VALUES (1, 1), (1, 1)',
			);
		} finally {
			await database.close();
		}
	}, 60_000);

	test("keeps generated many-to-many references required", async () => {
		const { workspace } = await openTestWorkspace();
		const { association, junction, design } =
			await createStudentsCoursesAssociation(workspace);
		const studentReference = junction.columns.find(
			(column) => column.name === "student_id",
		);
		if (!studentReference) throw new Error("Expected the student reference.");

		const protectedChanges: ColumnChanges[] = [
			{ nullable: true },
			{ unique: true },
			{ primaryKey: true },
			{ identity: true },
			{
				default: {
					kind: "literal",
					literalType: "integer",
					value: "1",
				},
			},
		];
		for (const changes of protectedChanges) {
			await expect(
				workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
					tableId: junction.id,
					columnId: studentReference.id,
					changes,
				}),
			).rejects.toThrow(/many-to-many/i);
			expect(requireDesign(workspace.getState())).toEqual(design);
		}
		await expect(
			workspace.updateRelationship({ designId: workspace.getState().activeDesignId!,
				relationshipId: association.leftRelationshipId,
				required: false,
			}),
		).rejects.toThrow(/many-to-many.*required/i);
		expect(requireDesign(workspace.getState())).toEqual(design);
	}, 60_000);

	test("uses distinct PostgreSQL identifiers for a long generated junction", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "Long names" });
		const leftName = `${"L".repeat(59)}éé`;
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: leftName });
		const left = requireTable(requireDesign(leftState), leftName);
		const rightName = `${"R".repeat(59)}水a`;
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: rightName });
		const right = requireTable(requireDesign(rightState), rightName);

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const design = requireDesign(state);
		const junction = design.tables.find(
			(table) => table.id !== left.id && table.id !== right.id,
		);
		if (!junction) throw new Error("Expected a generated junction table.");
		const encoder = new TextEncoder();
		const byteLength = (value: string) => encoder.encode(value).length;
		expect(byteLength(junction.name)).toBeLessThanOrEqual(63);
		expect(junction.columns.every((column) => byteLength(column.name) <= 63)).toBe(true);
		if (state.sql.status !== "current") throw new Error("Expected current SQL.");
		expect(state.sandbox.status).toBe("applied");
		if (state.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to apply bounded identifiers.");
		}
		const appliedJunction = state.sandbox.tables.find(
			(table) => table.name === junction.name,
		);
		if (!appliedJunction) throw new Error("Expected the named junction in the catalog.");
		expect(appliedJunction.columns.map((column) => column.name)).toEqual(
			junction.columns.map((column) => column.name),
		);
		const foreignKeyNames = state.sandbox.relationships.map(
			(relationship) => relationship.name,
		);
		expect(foreignKeyNames).toHaveLength(2);
		expect(new Set(foreignKeyNames).size).toBe(2);
		expect(foreignKeyNames.every((name) => byteLength(name) <= 63)).toBe(true);

		const database = new PGlite();
		try {
			await database.exec(state.sql.sql);
			const constraints = await database.query<{ constraint_name: string }>(`
				SELECT constraint_name
				FROM information_schema.table_constraints
				WHERE table_schema = 'public'
					AND table_name = '${junction.name}'
					AND constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
			`);
			const constraintNames = constraints.rows.map((row) => row.constraint_name);
			expect(constraintNames).toHaveLength(4);
			expect(new Set(constraintNames).size).toBe(4);
			expect(constraintNames.every((name) => byteLength(name) <= 63)).toBe(true);
		} finally {
			await database.close();
		}
	}, 60_000);

	test("allocates a distinct pair constraint beside an editable unique pair field", async () => {
		const { workspace } = await openTestWorkspace();
		const { junction } = await createStudentsCoursesAssociation(workspace);
		const added = await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			name: "pair",
			type: "text",
		});
		const pairField = requireTable(requireDesign(added), "StudentsCourses").columns.find(
			(column) => column.name === "pair",
		);
		if (!pairField) throw new Error("Expected the editable pair field.");
		const state = await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: junction.id,
			columnId: pairField.id,
			changes: { unique: true },
		});
		if (state.sql.status !== "current") throw new Error("Expected current SQL.");
		expect(state.sandbox.status).toBe("applied");
		if (state.sandbox.status !== "applied") {
			throw new Error("Expected the sandbox to accept both unique constraints.");
		}

		const database = new PGlite();
		try {
			await database.exec(state.sql.sql);
			const constraints = await database.query<{ constraint_name: string }>(`
				SELECT constraint_name
				FROM information_schema.table_constraints
				WHERE table_schema = 'public'
					AND table_name = 'StudentsCourses'
					AND constraint_type = 'UNIQUE'
			`);
			const uniqueNames = constraints.rows.map((row) => row.constraint_name);
			expect(uniqueNames).toContain("StudentsCourses_pair_key");
			expect(uniqueNames).toContain("StudentsCourses_pair_key_2");
			expect(new Set(uniqueNames).size).toBe(uniqueNames.length);
		} finally {
			await database.close();
		}
	}, 60_000);

	test("avoids PostgreSQL index names when choosing a junction table name", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" });
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students_" });
		const left = requireTable(requireDesign(leftState), "Students_");
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "pkey" });
		const right = requireTable(requireDesign(rightState), "pkey");

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const junction = requireTable(requireDesign(state), "Students_pkey_2");
		expect(junction.name).toBe("Students_pkey_2");
		expect(state.sandbox.status).toBe("applied");
	}, 60_000);

	test("allocates pair index names across tables", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students_" });
		const left = requireTable(requireDesign(leftState), "Students_");
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Courses" });
		const right = requireTable(requireDesign(rightState), "Courses");
		const otherState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" });
		const other = requireTable(requireDesign(otherState), "Students");
		const columnState = await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: other.id,
			name: "Courses_pair",
			type: "text",
		});
		const pairColumn = requireTable(requireDesign(columnState), "Students").columns.find(
			(column) => column.name === "Courses_pair",
		);
		if (!pairColumn) throw new Error("Expected the other table's unique field.");
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: other.id,
			columnId: pairColumn.id,
			changes: { unique: true },
		});

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const junction = requireTable(requireDesign(state), "Students_Courses");
		if (state.sql.status !== "current") throw new Error("Expected current SQL.");
		expect(state.sql.sql).toContain(
			'ADD CONSTRAINT "Students_Courses_pair_key_2" UNIQUE',
		);
		expect(state.sandbox.status).toBe("applied");
		if (state.sandbox.status !== "applied") {
			throw new Error("Expected schema-wide index names to apply.");
		}
		expect(junction.name).toBe("Students_Courses");
	}, 60_000);

	test("avoids identity sequence names when choosing a junction table", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students" });
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "Students_id_" });
		const left = requireTable(requireDesign(leftState), "Students_id_");
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "seq" });
		const right = requireTable(requireDesign(rightState), "seq");

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const junction = requireTable(requireDesign(state), "Students_id_seq_2");
		expect(junction.name).toBe("Students_id_seq_2");
		expect(state.sandbox.status).toBe("applied");
	}, 60_000);

	test("uses PostgreSQL's suffix-preserving primary-key index name", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "A".repeat(60) });
		const leftName = "A".repeat(58);
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: leftName });
		const left = requireTable(requireDesign(leftState), leftName);
		const rightName = "_pkey";
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: rightName });
		const right = requireTable(requireDesign(rightState), rightName);
		expect(rightState.sandbox.status).toBe("applied");

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const design = requireDesign(state);
		const association = design.manyToManyRelationships[0];
		if (!association) throw new Error("Expected the many-to-many association.");
		const junction = design.tables.find(
			(table) => table.id === association.junctionTableId,
		);
		if (!junction) throw new Error("Expected the junction table.");
		expect(junction.name).not.toBe(`${"A".repeat(58)}_pkey`);
		expect(state.sandbox.status).toBe("applied");
	}, 60_000);

	test("uses PostgreSQL's suffix-preserving unique-index name", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		const otherName = "A".repeat(60);
		const otherState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: otherName });
		const other = requireTable(requireDesign(otherState), otherName);
		const columnState = await workspace.addColumn({ designId: workspace.getState().activeDesignId!,
			tableId: other.id,
			name: "B",
			type: "text",
		});
		const uniqueColumn = requireTable(requireDesign(columnState), otherName).columns.find(
			(column) => column.name === "B",
		);
		if (!uniqueColumn) throw new Error("Expected the unique field.");
		await workspace.updateColumn({ designId: workspace.getState().activeDesignId!,
			tableId: other.id,
			columnId: uniqueColumn.id,
			changes: { unique: true },
		});

		const leftName = `${"A".repeat(57)}_B_`;
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: leftName });
		const left = requireTable(requireDesign(leftState), leftName);
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "key" });
		const right = requireTable(requireDesign(rightState), "key");
		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const design = requireDesign(state);
		const association = design.manyToManyRelationships[0];
		if (!association) throw new Error("Expected the many-to-many association.");
		const junction = design.tables.find(
			(table) => table.id === association.junctionTableId,
		);
		if (!junction) throw new Error("Expected the junction table.");
		expect(junction.name).not.toBe(`${"A".repeat(57)}_B_key`);
		expect(state.sandbox.status).toBe("applied");
	}, 60_000);

	test("accounts for PostgreSQL's auto-suffixed index names", async () => {
		const { workspace } = await openTestWorkspace();
		await workspace.createProject({ name: "School" });
		await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "foo_pkey" });
		const fooState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "foo" });
		const foo = requireTable(requireDesign(fooState), "foo");
		const leftState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "foo_" });
		const left = requireTable(requireDesign(leftState), "foo_");
		const rightState = await workspace.addTable({ designId: workspace.getState().activeDesignId!, name: "pkey1" });
		const right = requireTable(requireDesign(rightState), "pkey1");

		const state = await workspace.addRelationship({ designId: workspace.getState().activeDesignId!,
			referencingTableId: left.id,
			referencedTableId: right.id,
			cardinality: "many-to-many",
		});
		const junction = requireTable(requireDesign(state), "foo_pkey1_2");
		expect(junction.name).toBe("foo_pkey1_2");
		expect(state.sandbox.status).toBe("applied");
		expect(foo.name).toBe("foo");
	}, 60_000);

});
