import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Design } from "../shared/design";
import { generateDesignSql } from "./sql";
import { createPGliteSandbox } from "./sandbox";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const workspaces: DesignWorkspace[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function design(): Design {
	return {
		tables: [{
			id: "items", name: "Items", position: { x: 0, y: 0 },
			columns: [
				{ id: "id", name: "id", type: "bigint", nullable: false, primaryKey: true, unique: false, identity: true, default: { kind: "none" }, notes: "" },
				{ id: "embedding", name: "embedding", type: "vector", typeParameters: { dimensions: 3 }, nullable: true, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "" },
				{ id: "title", name: "title", type: "varchar", typeParameters: { length: 80 }, nullable: false, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "" },
			],
			indexes: [{ id: "embedding_hnsw", method: "hnsw", keys: [{ columnId: "embedding", operatorClass: "vector_cosine_ops" }], with: { m: 16, efConstruction: 64 } }, { id: "title_idx", method: "btree", keys: [{ columnId: "title", order: "desc", nulls: "last" }], includeColumnIds: ["id"] }],
		}],
		relationships: [], manyToManyRelationships: [], viewport: { x: 0, y: 0, zoom: 1 },
	};
}

describe("PostgreSQL indexes and pgvector", () => {
	test("generates structured column modifiers, extension, and indexes", () => {
		const generated = generateDesignSql(design());
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect(generated.sql).toContain("CREATE EXTENSION IF NOT EXISTS vector;");
		expect(generated.sql).toContain('"embedding" vector(3)');
		expect(generated.sql).toContain('"title" varchar(80)');
		expect(generated.sql).toContain('USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64)');
		expect(generated.sql).toContain('USING btree ("title" DESC NULLS LAST) INCLUDE ("id")');
	});

	test("blocks incompatible vector indexes and missing id references", () => {
		const draft = design();
		draft.tables[0].indexes = [{ id: "bad", method: "ivfflat", keys: [{ columnId: "embedding", operatorClass: "sparsevec_l2_ops" }] }];
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(false);
		if (generated.ok) return;
		expect(generated.errors.join(" ")).toContain("compatible pgvector column and operator class");
	});

	test("applies vector HNSW and reports catalog indexes", async () => {
		const generated = generateDesignSql(design());
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		const sandbox = createPGliteSandbox();
		try {
			const applied = await sandbox.apply(generated.sql);
			expect(applied.ok).toBe(true);
			if (applied.ok) {
				const items = applied.tables.find((table) => table.name === "Items");
				expect(items?.indexes?.some((index) => index.method === "hnsw" && index.definition.includes("vector_cosine_ops"))).toBe(true);
				expect(items?.indexes?.some((index) => index.definition.includes("INCLUDE (id)") || index.definition.includes("INCLUDE (\"id\")"))).toBe(true);
			}
		} finally { await sandbox.dispose(); }
	});

	test("generates and applies named enum types and enum columns", async () => {
		const draft = design();
		draft.enumTypes = [{ id: "visibility", name: "Visibility", labels: ["private", "public"] }];
		draft.tables[0].columns.push({ id: "visibility-column", name: "visibility", type: "enum", enumTypeId: "visibility", nullable: false, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "" });
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect(generated.sql).toContain('CREATE TYPE "Visibility" AS ENUM (\'private\', \'public\');');
		expect(generated.sql).toContain('"visibility" "Visibility" NOT NULL');
		const sandbox = createPGliteSandbox();
		try { expect((await sandbox.apply(generated.sql)).ok).toBe(true); } finally { await sandbox.dispose(); }
	});

	test("renders referential actions and validates nullability requirements", () => {
		const draft = design();
		draft.tables.push({ id: "owners", name: "Owners", position: { x: 400, y: 0 }, columns: [{ id: "owner-id", name: "id", type: "uuid", nullable: false, primaryKey: true, unique: false, identity: false, default: { kind: "none" }, notes: "" }] });
		draft.tables[0].columns.push({ id: "owner-fk", name: "owner_id", type: "uuid", nullable: true, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "" });
		draft.relationships.push({ id: "owner-rel", cardinality: "one-to-many", referencingTableId: "items", referencingColumnId: "owner-fk", referencedTableId: "owners", onDelete: "SET NULL", onUpdate: "CASCADE" });
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(true);
		if (generated.ok) expect(generated.sql).toContain("ON UPDATE CASCADE ON DELETE SET NULL");
		draft.tables[0].columns.find((column) => column.id === "owner-fk")!.nullable = false;
		const invalid = generateDesignSql(draft);
		expect(invalid.ok).toBe(false);
		if (!invalid.ok) expect(invalid.errors.join(" ")).toContain("SET NULL");
	});

	test("enforces composite unique constraints in the sandbox", async () => {
		const draft = design();
		draft.tables[0].columns.push({ id: "locale", name: "locale", type: "text", nullable: false, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "" });
		draft.tables[0].uniqueConstraints = [{ id: "title-locale", columnIds: ["title", "locale"], nullsNotDistinct: true }];
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect(generated.sql).toContain("UNIQUE NULLS NOT DISTINCT (\"title\", \"locale\")");
		const sandbox = createPGliteSandbox();
		try {
			const applied = await sandbox.apply(generated.sql);
			expect(applied.ok).toBe(true);
			if (applied.ok) {
				const db = new PGlite({ extensions: { vector } });
				await db.exec(generated.sql);
				await db.exec(`INSERT INTO "Items" (title, locale) VALUES ('A', 'en')`);
				await expect(db.exec(`INSERT INTO "Items" (title, locale) VALUES ('A', 'en')`)).rejects.toThrow();
				await db.close();
			}
		} finally { await sandbox.dispose(); }
	});

	test("persists indexes and enum types through undo, redo, and reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-postgres-features-"));
		directories.push(directory);
		const databasePath = join(directory, "design.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Feature model" });
		const created = await workspace.addTable({ name: "Records" });
		const tableId = created.design!.tables[0].id;
		const index = { id: "name_idx", method: "btree" as const, keys: [{ columnId: created.design!.tables[0].columns[0].id, order: "desc" as const }] };
		await workspace.updateIndexes({ tableId, indexes: [index] });
		expect(workspace.getState().design?.tables[0].indexes).toEqual([index]);
		await workspace.undo();
		expect(workspace.getState().design?.tables[0].indexes ?? []).toEqual([]);
		await workspace.redo();
		expect(workspace.getState().design?.tables[0].indexes).toEqual([index]);
		const enumType = { id: "record-state", name: "RecordState", labels: ["new", "saved"] };
		await workspace.updateEnumTypes({ enumTypes: [enumType] });
		await workspace.close();
		workspaces.splice(workspaces.indexOf(workspace), 1);
		const reopened = await createDesignWorkspace({ databasePath });
		workspaces.push(reopened);
		expect(reopened.getState().design?.tables[0].indexes).toEqual([index]);
		expect(reopened.getState().design?.enumTypes).toEqual([enumType]);
	}, 30_000);
});
