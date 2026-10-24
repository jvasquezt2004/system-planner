import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignWorkspace } from "./workspace";
import { applyAssistantDdl } from "./assistant-ddl";

const directories: string[] = [];
const workspaces: Awaited<ReturnType<typeof createDesignWorkspace>>[] = [];
afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function openWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "assistant-ddl-"));
	directories.push(directory);
	const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
	workspaces.push(workspace);
	await workspace.createProject({ name: "DDL test" });
	return workspace;
}

describe("assistant DDL translator", () => {
	test("plans all statements before applying any when later DDL is unsupported", async () => {
		const workspace = await openWorkspace();
		const before = workspace.getState();
		await expect(applyAssistantDdl(workspace, "CREATE TABLE users (id uuid PRIMARY KEY); CREATE VIEW active_users AS SELECT id FROM users;")).rejects.toThrow("Unsupported assistant DDL: ViewStmt");
		expect(workspace.getState().design).toEqual(before.design);
	});

	test("keeps a column identity through ALTER TABLE rename", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE users (id uuid PRIMARY KEY, name text);");
		const initial = workspace.getState().design?.tables.find(({ name }) => name === "users");
		if (!initial) throw new Error("Expected users table.");
		const columnId = initial.columns.find(({ name }) => name === "name")!.id;
		await applyAssistantDdl(workspace, "ALTER TABLE users RENAME COLUMN name TO display_name;");
		const updated = workspace.getState().design?.tables.find(({ name }) => name === "users");
		if (!updated) throw new Error("Expected renamed users table.");
		expect(updated.columns.find(({ name }) => name === "display_name")?.id).toBe(columnId);
	});

	test("normalizes PostgreSQL built-in type aliases and modifiers", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY, handle varchar(64), score numeric(8, 2));");
		const design = workspace.getState().design;
		if (!design?.tables[0]) throw new Error("Expected users table.");
		const columns = design.tables[0].columns;
		expect(columns.map(({ type, typeParameters }) => ({ type, typeParameters }))).toEqual([
			{ type: "integer", typeParameters: undefined },
			{ type: "varchar", typeParameters: { length: 64 } },
			{ type: "numeric", typeParameters: { precision: 8, scale: 2 } },
		]);
	});

	test("infers reference cardinality and junction associations without moving existing cards", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TABLE students (id integer PRIMARY KEY);
			CREATE TABLE courses (id integer PRIMARY KEY);
			CREATE TABLE enrollments (
				id integer PRIMARY KEY,
				student_id integer NOT NULL REFERENCES students(id),
				course_id integer NOT NULL REFERENCES courses(id),
				UNIQUE (student_id, course_id)
			);
			CREATE TABLE users (id integer PRIMARY KEY);
			CREATE TABLE posts (id integer PRIMARY KEY, author_id integer NOT NULL REFERENCES users(id));
			CREATE TABLE profiles (id integer PRIMARY KEY, user_id integer NOT NULL UNIQUE REFERENCES users(id));
		`);
		const design = workspace.getState().design!;
		const students = design.tables.find(({ name }) => name === "students")!;
		const courses = design.tables.find(({ name }) => name === "courses")!;
		const enrollments = design.tables.find(({ name }) => name === "enrollments")!;
		const posts = design.tables.find(({ name }) => name === "posts")!;
		const profiles = design.tables.find(({ name }) => name === "profiles")!;
		expect(enrollments.position).toEqual({ x: students.position.x + 300, y: students.position.y });
		expect(design.relationships.find(({ referencingTableId }) => referencingTableId === posts.id)?.cardinality).toBe("one-to-many");
		expect(design.relationships.find(({ referencingTableId }) => referencingTableId === profiles.id)?.cardinality).toBe("one-to-one");
		expect(design.manyToManyRelationships.some(({ junctionTableId }) => junctionTableId === enrollments.id)).toBe(true);
		expect(workspace.getState().design?.tables.find(({ name }) => name === "students")?.position).toEqual(students.position);
		expect(courses.name).toBe("courses");
	});

	test("returns confirmation instead of applying a drop with dependent relationships", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, author_id integer REFERENCES users(id));");
		const before = workspace.getState().design;
		const result = await applyAssistantDdl(workspace, "DROP TABLE users;");
		expect(result.status).toBe("confirmation-required");
		expect(workspace.getState().design).toEqual(before);
	});

	test("translates supported enums, defaults, indexes, routines, policies, and comments", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TYPE visibility AS ENUM ('public', 'private');
			CREATE TABLE documents (
				id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
				visibility visibility NOT NULL DEFAULT 'private',
				title varchar(40) DEFAULT 'Untitled',
				created_at timestamptz DEFAULT now()
			);
			CREATE INDEX documents_visibility_idx ON documents (visibility);
			CREATE OR REPLACE FUNCTION touch_doc() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN NEW.created_at = now(); RETURN NEW; END;
			$$;
			CREATE TRIGGER documents_touch BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION touch_doc();
			ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
			CREATE POLICY documents_public ON documents FOR SELECT TO anon USING (visibility = 'public');
			COMMENT ON COLUMN documents.title IS 'Document title';
		`);
		const design = workspace.getState().design!;
		const documents = design.tables.find(({ name }) => name === "documents")!;
		expect((design.enumTypes ?? []).map(({ name, labels }) => ({ name, labels }))).toEqual([{ name: "visibility", labels: ["public", "private"] }]);
		expect(documents.columns.find(({ name }) => name === "id")?.identity).toBe(true);
		expect(documents.columns.find(({ name }) => name === "created_at")?.default).toEqual({ kind: "currentTimestamp" });
		expect(documents.columns.find(({ name }) => name === "title")?.notes).toBe("Document title");
		expect(documents.indexes?.map(({ name }) => name)).toEqual(["documents_visibility_idx"]);
		expect(documents.rowLevelSecurity).toBe(true);
		expect(documents.policies?.map(({ name, roles }) => ({ name, roles }))).toEqual([{ name: "documents_public", roles: ["anon"] }]);
		expect(design.triggers?.map(({ name }) => name)).toEqual(["documents_touch"]);
		expect(design.functions?.map(({ name }) => name)).toEqual(["touch_doc"]);
	});
});
