import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignWorkspace } from "./workspace";
import { applyAssistantDdl } from "./assistant-ddl";
import { generateDesignSql } from "./sql";

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
		if (result.status !== "confirmation-required") throw new Error("Expected a DDL confirmation.");
		expect(result.targets).toHaveLength(1);
		expect(result.projectId).toBe(workspace.getState().project!.id);
		expect(result.revision).toBe(workspace.getState().revision);
		expect(workspace.getState().design).toEqual(before);
	});

	test("translates supported enums, defaults, indexes, routines, policies, and comments", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TYPE visibility AS ENUM ('public', 'private');
			CREATE TABLE documents (
				id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				visibility visibility NOT NULL DEFAULT 'private',
				title varchar(40) DEFAULT 'Untitled',
				created_at timestamptz DEFAULT now()
			);
			CREATE INDEX documents_visibility_idx ON documents (visibility);
			CREATE OR REPLACE FUNCTION touch_doc() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
			BEGIN NEW.created_at = now(); RETURN NEW; END;
			$$;
			CREATE TRIGGER documents_touch BEFORE UPDATE ON documents FOR EACH ROW WHEN (NEW.created_at IS NOT NULL) EXECUTE FUNCTION touch_doc();
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
		expect(design.functions?.find(({ name }) => name === "touch_doc")?.security).toBe("definer");
		expect(design.triggers?.[0]?.when).toBe("NEW.created_at IS NOT NULL");
		const result = generateDesignSql(workspace.getState().design!);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain("SECURITY DEFINER");
		expect(result.sql).toContain("CREATE TRIGGER");
		expect(result.sql).toContain("WHEN (NEW.created_at IS NOT NULL)");
		expect(result.sql).toContain("USING (visibility = 'public')");
		expect(result.sql).not.toContain("COMMENT ON COLUMN");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("preserves enum storage and column notes in SQL accepted by the sandbox", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TYPE visibility AS ENUM ('public', 'private');
			CREATE TABLE documents (id integer PRIMARY KEY, visibility visibility NOT NULL);
			COMMENT ON COLUMN documents.visibility IS 'Visibility note';
		`);
		const design = workspace.getState().design!;
		const result = generateDesignSql(design);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain(`CREATE TYPE "visibility" AS ENUM ('public', 'private');`);
		expect(result.sql).toContain('"visibility" "visibility" NOT NULL');
		expect(result.sql).not.toContain("COMMENT ON COLUMN");
		expect(design.tables.find(({ name }) => name === "documents")?.columns.find(({ name }) => name === "visibility")?.notes).toBe("Visibility note");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("rejects BY DEFAULT identity without changing design", async () => {
		const workspace = await openWorkspace();
		const before = workspace.getState();
		await expect(applyAssistantDdl(workspace, "CREATE TABLE generated_ids (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);")).rejects.toThrow("GENERATED BY DEFAULT");
		expect(workspace.getState().design).toEqual(before.design);
		expect(workspace.getState().sandbox).toEqual(before.sandbox);
	});

	test("extracts policy and trigger expressions from their own DDL statements", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TABLE documents (id integer PRIMARY KEY, owner_id integer NOT NULL);
			ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
			CREATE POLICY own_documents ON documents FOR SELECT USING (owner_id = 17);
			CREATE POLICY other_documents ON documents FOR SELECT USING (owner_id = 23);
			CREATE OR REPLACE FUNCTION touch_documents() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
			CREATE TRIGGER own_documents_touch BEFORE UPDATE ON documents FOR EACH ROW WHEN (NEW.owner_id > 17) EXECUTE FUNCTION touch_documents();
			CREATE TRIGGER other_documents_touch BEFORE UPDATE ON documents FOR EACH ROW WHEN (NEW.owner_id < 23) EXECUTE FUNCTION touch_documents();
		`);
		const table = workspace.getState().design!.tables.find(({ name }) => name === "documents")!;
		expect(table.policies?.map(({ using }) => using)).toEqual(["owner_id = 17", "owner_id = 23"]);
		expect(workspace.getState().design?.triggers?.map(({ when }) => when)).toEqual(["NEW.owner_id > 17", "NEW.owner_id < 23"]);
		const result = generateDesignSql(workspace.getState().design!);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain("USING (owner_id = 17)");
		expect(result.sql).toContain("USING (owner_id = 23)");
		expect(result.sql).toContain("WHEN (NEW.owner_id > 17)");
		expect(result.sql).toContain("WHEN (NEW.owner_id < 23)");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("rejects schema-qualified drops and unsupported index modifiers atomically", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE records (id integer PRIMARY KEY, label text);");
		const before = workspace.getState().design;
		await expect(applyAssistantDdl(workspace, "DROP TABLE public.records;")).rejects.toThrow("schema-qualified");
		expect(workspace.getState().design).toEqual(before);
		await expect(applyAssistantDdl(workspace, "ALTER TABLE public.records RENAME TO renamed_records;")).rejects.toThrow("schema-qualified");
		expect(workspace.getState().design).toEqual(before);
		await expect(applyAssistantDdl(workspace, "CREATE TABLE child_records (extra text) INHERITS (records);")).rejects.toThrow("table inheritance");
		expect(workspace.getState().design).toEqual(before);
		await expect(applyAssistantDdl(workspace, "CREATE INDEX records_label_idx ON records (label unsupported_ops);")).rejects.toThrow("no compatible operator class");
		expect(workspace.getState().design).toEqual(before);
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("rejects DDL after its expected project changes", async () => {
		const workspace = await openWorkspace();
		const before = workspace.getState().design;
		await expect(applyAssistantDdl(workspace, "CREATE TABLE records (id integer PRIMARY KEY);", { expectedProjectId: "another-project" })).rejects.toThrow("project changed");
		expect(workspace.getState().design).toEqual(before);
	});
	test("recomputes junction inference from later ALTER constraints with payload columns", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TABLE students (id integer PRIMARY KEY);
			CREATE TABLE courses (id integer PRIMARY KEY);
			CREATE TABLE enrollments (id integer PRIMARY KEY, student_id integer NOT NULL, course_id integer NOT NULL, grade text);
			ALTER TABLE enrollments ADD CONSTRAINT enrollments_student_fk FOREIGN KEY (student_id) REFERENCES students(id);
			ALTER TABLE enrollments ADD CONSTRAINT enrollments_course_fk FOREIGN KEY (course_id) REFERENCES courses(id);
			ALTER TABLE enrollments ADD CONSTRAINT enrollments_pair_unique UNIQUE (student_id, course_id);
		`);
		const design = workspace.getState().design!;
		const table = design.tables.find(({ name }) => name === "enrollments")!;
		expect(design.manyToManyRelationships.some(({ junctionTableId }) => junctionTableId === table.id)).toBe(true);
		expect(table.columns.some(({ name }) => name === "grade")).toBe(true);
		const result = generateDesignSql(design);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain('"grade" text');
		expect(result.sql).toContain('CONSTRAINT "enrollments_pair_unique" UNIQUE ("student_id", "course_id")');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("unwraps ALTER TYPE column definitions and keeps enum storage", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TYPE state AS ENUM ('open', 'closed'); CREATE TABLE tickets (id integer PRIMARY KEY, status text NOT NULL); ALTER TABLE tickets ALTER COLUMN status TYPE state;");
		const design = workspace.getState().design!;
		const status = design.tables.find(({ name }) => name === "tickets")!.columns.find(({ name }) => name === "status")!;
		expect(status.type).toBe("enum");
		expect(status.enumTypeId).toBe(design.enumTypes?.find(({ name }) => name === "state")?.id);
		const result = generateDesignSql(design);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain('"status" "state" NOT NULL');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("updates relationship cardinality when uniqueness arrives in ALTER TABLE", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE accounts (id integer PRIMARY KEY); CREATE TABLE profiles (id integer PRIMARY KEY, account_id integer NOT NULL REFERENCES accounts(id)); ALTER TABLE profiles ADD CONSTRAINT profiles_account_unique UNIQUE (account_id);");
		const design = workspace.getState().design!;
		const relationship = design.relationships.find(({ referencingTableId }) => design.tables.find(({ id }) => id === referencingTableId)?.name === "profiles")!;
		expect(relationship.cardinality).toBe("one-to-one");
		const result = generateDesignSql(design);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain('"account_id" integer NOT NULL UNIQUE');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("removes table-owned triggers on a confirmed drop", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TABLE records (id integer PRIMARY KEY);
			CREATE TABLE keep_table (id integer PRIMARY KEY);
			CREATE OR REPLACE FUNCTION noop_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
			CREATE TRIGGER records_noop BEFORE INSERT ON records FOR EACH ROW EXECUTE FUNCTION noop_trigger();
		`);
		const pending = await applyAssistantDdl(workspace, "DROP TABLE records;");
		expect(pending.status).toBe("confirmation-required");
		if (pending.status !== "confirmation-required") throw new Error("Expected a DDL confirmation.");
		await applyAssistantDdl(workspace, "DROP TABLE records;", { confirmedDrops: true, confirmation: { projectId: pending.projectId, designId: pending.designId, revision: pending.revision, targetIds: pending.targets.map(({ targetId }) => targetId) } });
		const design = workspace.getState().design!;
		expect(design.tables.some(({ name }) => name === "records")).toBe(false);
		expect(design.triggers).toEqual([]);
		const sqlResult = generateDesignSql(design);
		if (!sqlResult.ok) throw new Error(sqlResult.errors.join("; "));
		expect(sqlResult.sql).not.toContain("CREATE TRIGGER");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("preserves representable index ordering and NULL ordering", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE records (id integer PRIMARY KEY, label text); CREATE INDEX records_label_idx ON records (label DESC NULLS FIRST);");
		const index = workspace.getState().design!.tables.find(({ name }) => name === "records")!.indexes?.[0];
		expect(index?.keys).toEqual([expect.objectContaining({ order: "desc", nulls: "first" })]);
		const result = generateDesignSql(workspace.getState().design!);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.errors.join("; "));
		expect(result.sql).toContain('"label" DESC NULLS FIRST');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("aggregates and confirms every target in a multi-table drop batch", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TABLE accounts (id integer PRIMARY KEY);
			CREATE TABLE profiles (id integer PRIMARY KEY, account_id integer REFERENCES accounts(id));
			CREATE TABLE audit_logs (id integer PRIMARY KEY);
			CREATE TABLE audit_entries (id integer PRIMARY KEY, log_id integer REFERENCES audit_logs(id));
		`);
		const sql = "DROP TABLE accounts, audit_logs;";
		const pending = await applyAssistantDdl(workspace, sql);
		if (pending.status !== "confirmation-required") throw new Error("Expected a DDL confirmation.");
		expect(pending.targets.map(({ targetId }) => targetId).sort()).toEqual(["table:accounts", "table:audit_logs"]);
		expect(pending.removal.relationships).toHaveLength(2);
		expect(pending.projectId).toBe(workspace.getState().project!.id);
		expect(pending.revision).toBe(workspace.getState().revision);
		const applied = await applyAssistantDdl(workspace, sql, {
			confirmedDrops: true,
			confirmation: { projectId: pending.projectId, designId: pending.designId, revision: pending.revision, targetIds: pending.targets.map(({ targetId }) => targetId) },
		});
		expect(applied.status).toBe("applied");
		const design = workspace.getState().design!;
		expect(design.tables.some(({ name }) => name === "accounts" || name === "audit_logs")).toBe(false);
		expect(design.relationships).toEqual([]);
		expect(workspace.getState().sandbox.status).toBe("applied");
		const generated = generateDesignSql(design);
		expect(generated.ok).toBe(true);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).not.toContain('"accounts"');
		expect(generated.sql).not.toContain('"audit_logs"');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
	test("rejects a confirmed drop after its revision changes", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE users (id integer PRIMARY KEY); CREATE TABLE posts (id integer PRIMARY KEY, user_id integer REFERENCES users(id));");
		const pending = await applyAssistantDdl(workspace, "DROP TABLE users;");
		if (pending.status !== "confirmation-required") throw new Error("Expected a DDL confirmation.");
		await expect(applyAssistantDdl(workspace, "DROP TABLE users;", {
			confirmedDrops: true,
			confirmation: { projectId: pending.projectId, designId: pending.designId, revision: pending.revision, targetIds: [] },
		})).rejects.toThrow("confirmation is stale");
		await expect(applyAssistantDdl(workspace, "DROP TABLE users;", {
			confirmedDrops: true,
			confirmation: { projectId: "another-project", designId: pending.designId, revision: pending.revision, targetIds: pending.targets.map(({ targetId }) => targetId) },
		})).rejects.toThrow("confirmation is stale");
		await applyAssistantDdl(workspace, "CREATE TABLE unrelated (id integer PRIMARY KEY);");
		await expect(applyAssistantDdl(workspace, "DROP TABLE users;", {
			confirmedDrops: true,
			confirmation: { projectId: pending.projectId, designId: pending.designId, revision: pending.revision, targetIds: pending.targets.map(({ targetId }) => targetId) },
		})).rejects.toThrow("confirmation is stale");
	});
	test("rejects Assistant DDL for a different target Design", async () => {
		const workspace = await openWorkspace();
		const before = workspace.getState().design;
		const projectId = workspace.getState().project?.id;
		if (!projectId || !before) throw new Error("Expected an open project and Design.");
		await expect(applyAssistantDdl(workspace, "CREATE TABLE should_not_exist (id integer);", {
			expectedProjectId: projectId,
			expectedDesignId: "another-design",
		})).rejects.toThrow("Design changed");
		expect(workspace.getState().design).toEqual(before);
	});


	test("rejects DROP VIEW before resolving its name as a table", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE t (id integer PRIMARY KEY);");
		const before = workspace.getState().design!;
		const beforeSql = generateDesignSql(before);
		if (!beforeSql.ok) throw new Error(beforeSql.errors.join("; "));

		await expect(applyAssistantDdl(workspace, "DROP VIEW t;")).rejects.toThrow("DROP VIEW is not supported");

		expect(workspace.getState().design).toEqual(before);
		const afterSql = generateDesignSql(workspace.getState().design!);
		if (!afterSql.ok) throw new Error(afterSql.errors.join("; "));
		expect(afterSql.sql).toBe(beforeSql.sql);
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("recovers RLS predicates after UTF-8 text before the statement", async () => {
		const workspace = await openWorkspace();
		const sql = `/*${"é".repeat(90)}*/ CREATE TABLE t (id integer PRIMARY KEY); ALTER TABLE t ENABLE ROW LEVEL SECURITY; CREATE POLICY p ON t USING (false);`;
		await applyAssistantDdl(workspace, sql);

		const design = workspace.getState().design!;
		expect(design.tables.find(({ name }) => name === "t")?.policies?.[0]?.using).toBe("false");
		const generated = generateDesignSql(design);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).toContain("USING (false)");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("emits project functions before policies that call them", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, `
			CREATE TABLE t (id integer PRIMARY KEY);
			CREATE OR REPLACE FUNCTION allowed() RETURNS boolean LANGUAGE SQL AS $$ SELECT true $$;
			ALTER TABLE t ENABLE ROW LEVEL SECURITY;
			CREATE POLICY p ON t USING (allowed());
		`);

		const generated = generateDesignSql(workspace.getState().design!);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql.indexOf('CREATE FUNCTION "allowed"')).toBeLessThan(generated.sql.indexOf("CREATE POLICY"));
		expect(generated.sql).toContain("USING (allowed())");
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("preserves relationship-owned one-to-one uniqueness through unrelated ALTER", async () => {
		const workspace = await openWorkspace();
		const accountsState = await workspace.addTable({ name: "accounts" });
		const profilesState = await workspace.addTable({ name: "profiles" });
		const accounts = accountsState.design!.tables.find(({ name }) => name === "accounts")!;
		const profiles = profilesState.design!.tables.find(({ name }) => name === "profiles")!;
		await workspace.addRelationship({ referencingTableId: profiles.id, referencedTableId: accounts.id, cardinality: "one-to-one" });
		const originalRelationship = workspace.getState().design!.relationships.find(({ referencingTableId }) => referencingTableId === profiles.id)!;
		const localColumn = workspace.getState().design!.tables.find(({ id }) => id === profiles.id)!.columns.find(({ id }) => id === originalRelationship.referencingColumnId)!;

		await applyAssistantDdl(workspace, "ALTER TABLE profiles ADD COLUMN note text;");

		const design = workspace.getState().design!;
		expect(design.relationships.find(({ id }) => id === originalRelationship.id)?.cardinality).toBe("one-to-one");
		const generated = generateDesignSql(design);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).toContain(`UNIQUE ("${localColumn.name}")`);
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("preserves relationship-owned junction uniqueness through unrelated ALTER", async () => {
		const workspace = await openWorkspace();
		const aState = await workspace.addTable({ name: "a" });
		const bState = await workspace.addTable({ name: "b" });
		const a = aState.design!.tables.find(({ name }) => name === "a")!;
		const b = bState.design!.tables.find(({ name }) => name === "b")!;
		await workspace.addRelationship({ referencingTableId: a.id, referencedTableId: b.id, cardinality: "many-to-many" });
		const designBefore = workspace.getState().design!;
		const association = designBefore.manyToManyRelationships[0]!;
		const junction = designBefore.tables.find(({ id }) => id === association.junctionTableId)!;
		const endpointNames = designBefore.relationships
			.filter(({ id }) => id === association.leftRelationshipId || id === association.rightRelationshipId)
			.map(({ referencingColumnId }) => junction.columns.find(({ id }) => id === referencingColumnId)!.name);
		await applyAssistantDdl(workspace, `ALTER TABLE "${junction.name}" ADD COLUMN note text;`);

		const design = workspace.getState().design!;
		expect(design.manyToManyRelationships).toContainEqual(association);
		const generated = generateDesignSql(design);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).toContain(`UNIQUE ("${endpointNames[0]}", "${endpointNames[1]}")`);
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("places unrelated tables to the right of existing cards", async () => {
		const workspace = await openWorkspace();
		const created = await workspace.addTable({ name: "far_card" });
		const farCard = created.design!.tables.find(({ name }) => name === "far_card")!;
		await workspace.moveTable({ tableId: farCard.id, position: { x: 1700, y: 600 } });

		await applyAssistantDdl(workspace, "CREATE TABLE unrelated (id integer PRIMARY KEY);");

		const design = workspace.getState().design!;
		expect(design.tables.find(({ name }) => name === "far_card")?.position).toEqual({ x: 1700, y: 600 });
		expect(design.tables.find(({ name }) => name === "unrelated")?.position).toEqual({ x: 2000, y: 600 });
		const generated = generateDesignSql(design);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).toContain('CREATE TABLE "unrelated"');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});

	test("translates a supported text operator class into accepted SQL", async () => {
		const workspace = await openWorkspace();
		await applyAssistantDdl(workspace, "CREATE TABLE t (id integer PRIMARY KEY, label text); CREATE INDEX assistant_opclass ON t (label text_pattern_ops);");

		const design = workspace.getState().design!;
		expect(design.tables.find(({ name }) => name === "t")?.indexes?.[0]?.keys[0]?.operatorClass).toBe("text_pattern_ops");
		const generated = generateDesignSql(design);
		if (!generated.ok) throw new Error(generated.errors.join("; "));
		expect(generated.sql).toContain('"label" text_pattern_ops');
		expect(workspace.getState().sandbox.status).toBe("applied");
	});
});
