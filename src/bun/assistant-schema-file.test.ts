import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesignWorkspace } from "./workspace";
import { applyAssistantDdl } from "./assistant-ddl";
import { applySchemaFile } from "./assistant-schema-file";
import { generateDesignSql, renderSchemaFile } from "./sql";

const directories: string[] = [];
const workspaces: Awaited<ReturnType<typeof createDesignWorkspace>>[] = [];
afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function richWorkspace() {
	const directory = mkdtempSync(join(tmpdir(), "schema-file-"));
	directories.push(directory);
	const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
	workspaces.push(workspace);
	await workspace.createProject({ name: "Schema file" });
	await applyAssistantDdl(workspace, `
CREATE TYPE ticket_status AS ENUM ('open', 'closed');
CREATE TABLE orgs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tickets (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  title text NOT NULL,
  status ticket_status NOT NULL DEFAULT 'open',
  UNIQUE (org_id, title)
);
CREATE INDEX tickets_status_idx ON tickets (status);
CREATE INDEX tickets_title_idx ON tickets (title);
CREATE OR REPLACE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
CREATE TRIGGER tickets_touch BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION touch();
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tickets_read ON tickets FOR SELECT USING (true);
COMMENT ON COLUMN tickets.title IS 'What the customer wrote';`);
	return workspace;
}
const sqlOf = (workspace: Awaited<ReturnType<typeof richWorkspace>>) => {
	const generated = generateDesignSql(workspace.getState().design!);
	if (!generated.ok) throw new Error(generated.errors.join("; "));
	return generated.sql;
};
const table = (workspace: Awaited<ReturnType<typeof richWorkspace>>, name: string) => workspace.getState().design!.tables.find((candidate) => candidate.name === name)!;

describe("schema file", () => {
	test("an unedited file changes nothing", async () => {
		const workspace = await richWorkspace();
		expect(await applySchemaFile(workspace, sqlOf(workspace))).toEqual({ status: "unchanged" });
	});

	test("adding a column changes only that column: identities, positions, notes, and the rest survive", async () => {
		const workspace = await richWorkspace();
		const before = structuredClone(workspace.getState().design!);
		const text = sqlOf(workspace).replace('"title" text NOT NULL,', '"title" text NOT NULL,\n  "priority" integer,');
		expect(text).not.toBe(sqlOf(workspace));
		const result = await applySchemaFile(workspace, text);
		const { state: _state, ...summary } = result as Extract<typeof result, { status: "applied" }>;
		expect(summary).toEqual({ status: "applied", tablesChanged: ["tickets"], tablesAdded: [], tablesRemoved: [], keptAsSql: [] });
		const after = workspace.getState().design!;
		const tickets = table(workspace, "tickets");
		expect(tickets.columns.map((column) => column.name)).toEqual(["id", "org_id", "title", "priority", "status"]);
		// Everything else is exactly what it was.
		const strip = (design: typeof before) => ({ ...design, tables: design.tables.map((t) => t.name === "tickets" ? { ...t, columns: t.columns.filter((c) => c.name !== "priority") } : t) });
		expect(strip(after)).toEqual(before);
		expect(sqlOf(workspace)).toContain('"priority" integer');
	});

	test("removing an index line drops that index only, even one made without a name", async () => {
		const workspace = await richWorkspace();
		const text = sqlOf(workspace).replace(/CREATE INDEX "tickets_title_idx"[^;]*;\n*/, "");
		await applySchemaFile(workspace, text);
		expect((table(workspace, "tickets").indexes ?? []).map((index) => index.name)).toEqual(["tickets_status_idx"]);
	});

	test("removing a table and what refers to it removes it from the Design", async () => {
		const workspace = await richWorkspace();
		const statements = sqlOf(workspace).split(/\n\n/).filter((statement) => !/"tickets"/.test(statement));
		const result = await applySchemaFile(workspace, `${statements.join("\n\n")}\n`);
		expect(result).toMatchObject({ status: "applied", tablesRemoved: ["tickets"] });
		expect(workspace.getState().design!.tables.map((candidate) => candidate.name)).toEqual(["orgs"]);
		expect(workspace.getState().design!.relationships).toEqual([]);
	});

	test("SQL the Design cannot model is kept, and PostgreSQL errors change nothing", async () => {
		const workspace = await richWorkspace();
		const before = workspace.getState().design;
		const result = await applySchemaFile(workspace, `${sqlOf(workspace)}\nCREATE VIEW open_tickets AS SELECT id FROM tickets WHERE status = 'open';\n`);
		expect(result).toMatchObject({ status: "applied", keptAsSql: ["CREATE VIEW open_tickets AS SELECT id FROM tickets WHERE status = 'open'"] });
		const kept = workspace.getState().design;
		await expect(applySchemaFile(workspace, `${sqlOf(workspace)}\nCREATE VIEW broken AS SELECT nope FROM tickets;\n`)).rejects.toThrow("PostgreSQL rejected schema.sql");
		expect(workspace.getState().design).toEqual(kept);
		expect(kept).not.toEqual(before);
		// Applying the same text again is a no-op: raw SQL keeps its identity.
		expect(await applySchemaFile(workspace, sqlOf(workspace))).toEqual({ status: "unchanged" });
	});

	test("refuses syntax errors and an empty file", async () => {
		const workspace = await richWorkspace();
		const before = workspace.getState().design;
		await expect(applySchemaFile(workspace, "CREATE TABEL nope (id int);")).rejects.toThrow("could not be read");
		await expect(applySchemaFile(workspace, "-- nothing here\n")).rejects.toThrow("would delete the whole schema");
		expect(workspace.getState().design).toEqual(before);
	});
	test("a Design with repeated index names is still written as editable SQL, and applying it repairs the Design", async () => {
		const workspace = await richWorkspace();
		const tickets = table(workspace, "tickets");
		const index = tickets.indexes![0];
		// What repeated, failing migrations left behind: the same named index several times.
		await workspace.updateIndexes({ tableId: tickets.id, designId: workspace.getState().activeDesignId!, indexes: [...tickets.indexes!, { ...index, id: "dup-1" }, { ...index, id: "dup-2" }] });
		expect(generateDesignSql(workspace.getState().design!).ok).toBe(false);

		const file = renderSchemaFile(workspace.getState().design!);
		expect(file).toContain("-- This Design has problems.");
		expect(file).toContain('CREATE TABLE "tickets"');
		expect(file.match(/CREATE INDEX "tickets_status_idx"/g)).toHaveLength(3);

		// Applying the file as it is removes the repeats; nothing is "unchanged" while the Design has problems.
		const result = await applySchemaFile(workspace, file);
		expect(result).toMatchObject({ status: "applied" });
		expect(generateDesignSql(workspace.getState().design!).ok).toBe(true);
		expect((table(workspace, "tickets").indexes ?? []).map((candidate) => candidate.name)).toEqual(["tickets_status_idx", "tickets_title_idx"]);
		expect(await applySchemaFile(workspace, sqlOf(workspace))).toEqual({ status: "unchanged" });
	});

	test("a different index under an existing name is refused, an identical one is ignored", async () => {
		const workspace = await richWorkspace();
		await applyAssistantDdl(workspace, "CREATE INDEX tickets_status_idx ON tickets (status);");
		expect((table(workspace, "tickets").indexes ?? []).filter((candidate) => candidate.name === "tickets_status_idx")).toHaveLength(1);
		await expect(applyAssistantDdl(workspace, "CREATE INDEX tickets_status_idx ON tickets (title);")).rejects.toThrow("already exists on tickets");
	});
});
