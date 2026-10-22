import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import type { Design } from "../shared/design";
import { indexMethodProblem, indexOperatorClasses } from "../shared/index-methods";
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
				{
					id: "embedding",
					name: "embedding",
					type: "vector",
					typeParameters: { dimensions: 3 },
					nullable: true,
					primaryKey: false,
					unique: false,
					identity: false,
					default: { kind: "none" },
					notes: "",
				},
				{
					id: "title",
					name: "title",
					type: "varchar",
					typeParameters: { length: 80 },
					nullable: false,
					primaryKey: false,
					unique: false,
					identity: false,
					default: { kind: "none" },
					notes: "",
				},
			],
			indexes: [
				{
					id: "embedding_hnsw",
					method: "hnsw",
					keys: [{
						columnId: "embedding",
						operatorClass: "vector_cosine_ops",
					}],
					with: { m: 16, efConstruction: 64 },
				},
				{
					id: "title_idx",
					method: "btree",
					keys: [{ columnId: "title", order: "desc", nulls: "last" }],
					includeColumnIds: ["id"],
				},
			],
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
		draft.tables[0].indexes = [{
			id: "bad",
			method: "ivfflat",
			keys: [{ columnId: "embedding", operatorClass: "sparsevec_l2_ops" }],
		}];
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
		draft.tables[0].columns.push({
			id: "visibility-column",
			name: "visibility",
			type: "enum",
			enumTypeId: "visibility",
			nullable: false,
			primaryKey: false,
			unique: false,
			identity: false,
			default: { kind: "none" },
			notes: "",
		});
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
		draft.tables.push({
			id: "owners",
			name: "Owners",
			position: { x: 400, y: 0 },
			columns: [{
				id: "owner-id",
				name: "id",
				type: "uuid",
				nullable: false,
				primaryKey: true,
				unique: false,
				identity: false,
				default: { kind: "none" },
				notes: "",
			}],
		});
		draft.tables[0].columns.push({
			id: "owner-fk",
			name: "owner_id",
			type: "uuid",
			nullable: true,
			primaryKey: false,
			unique: false,
			identity: false,
			default: { kind: "none" },
			notes: "",
		});
		draft.relationships.push({
			id: "owner-rel",
			cardinality: "one-to-many",
			referencingTableId: "items",
			referencingColumnId: "owner-fk",
			referencedTableId: "owners",
			onDelete: "SET NULL",
			onUpdate: "CASCADE",
		});
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
		draft.tables[0].columns.push({
			id: "locale",
			name: "locale",
			type: "text",
			nullable: false,
			primaryKey: false,
			unique: false,
			identity: false,
			default: { kind: "none" },
			notes: "",
		});
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

	test("plans removal effects and removes stale index and unique references", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-removal-plan-"));
		directories.push(directory);
		const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Removal dependencies" });
		const created = await workspace.addTable({ name: "Records" });
		const table = created.design!.tables[0];
		const id = table.columns[0].id;
		const titleState = await workspace.addColumn({ tableId: table.id, name: "title" });
		const title = titleState.design!.tables[0].columns.find((column) => column.name === "title")!;
		const localeState = await workspace.addColumn({ tableId: table.id, name: "locale" });
		const locale = localeState.design!.tables[0].columns.find((column) => column.name === "locale")!;
		await workspace.updateColumn({ tableId: table.id, columnId: title.id, changes: { primaryKey: true, nullable: false } });
		await workspace.updateIndexes({
			tableId: table.id,
			indexes: [{
				id: "multi",
				name: "multi_idx",
				method: "btree",
				keys: [{ columnId: id }, { columnId: title.id }],
				includeColumnIds: [locale.id],
			}],
		});
		await workspace.updateUniqueConstraints({ tableId: table.id, uniqueConstraints: [{ id: "unique", columnIds: [id, title.id] }] });
		const plan = workspace.describeRemoval({ kind: "column", tableId: table.id, columnId: id });
		expect(plan.indexes).toEqual([{ table: "Records", indexId: "multi", name: "multi_idx", removedKeys: 1, removedIncludes: 0 }]);
		expect(plan.uniqueConstraints).toHaveLength(1);
		await expect(workspace.removeColumn({ tableId: table.id, columnId: id })).rejects.toThrow(/index multi_idx/);
		const removed = await workspace.removeColumn({ tableId: table.id, columnId: id, confirmed: true });
		expect(removed.design?.tables[0].indexes?.[0].keys).toEqual([{ columnId: title.id }]);
		expect(removed.design?.tables[0].uniqueConstraints).toEqual([]);
		const tablePlan = workspace.describeRemoval({ kind: "table", tableId: table.id });
		expect(tablePlan.indexes).toHaveLength(1);
		expect(tablePlan.uniqueConstraints).toEqual([]);
		await expect(workspace.removeTable({ tableId: table.id })).rejects.toThrow(/schema item/);
	}, 30_000);

	test("blocks removal of enum types used by columns", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-enum-removal-"));
		directories.push(directory);
		const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Enum safety" });
		const created = await workspace.addTable({ name: "Records" });
		const table = created.design!.tables[0];
		const enumType = { id: "status", name: "Status", labels: ["open", "closed"] };
		await workspace.updateEnumTypes({ enumTypes: [enumType] });
		const withColumn = await workspace.addColumn({ tableId: table.id, name: "state", type: "enum" });
		const column = withColumn.design!.tables[0].columns.find((candidate) => candidate.name === "state")!;
		await workspace.updateColumn({ tableId: table.id, columnId: column.id, changes: { enumTypeId: enumType.id } });
		await expect(workspace.updateEnumTypes({ enumTypes: [] })).rejects.toThrow(/Records.state/);
		expect(workspace.getState().design?.enumTypes).toEqual([enumType]);
	}, 30_000);

	test("validates registry operator classes for built-in and vector methods", () => {
		expect(indexOperatorClasses("btree", "text").map((option) => option.name)).toEqual(["text_ops", "text_pattern_ops"]);
		expect(indexOperatorClasses("gin", "jsonb").map((option) => option.name)).toEqual(["jsonb_ops", "jsonb_path_ops"]);
		expect(indexOperatorClasses("gin", "text", true).map((option) => option.name)).toEqual(["array_ops"]);
		expect(indexOperatorClasses("gist", "inet").map((option) => option.name)).toEqual(["inet_ops"]);
		expect(indexOperatorClasses("spgist", "cidr").map((option) => option.name)).toEqual(["inet_ops"]);
		expect(indexOperatorClasses("ivfflat", "sparsevec")).toEqual([]);
		const invalid = indexMethodProblem({ id: "idx", method: "btree", keys: [{ columnId: "v", operatorClass: "vector_l2_ops" }] }, [{ type: "vector" }]);
		expect(invalid).toContain("no compatible operator class");
		const draft = design();
		draft.tables[0].indexes = [
			{ id: "gin", method: "gin", keys: [{ columnId: "title", operatorClass: "text_pattern_ops" }] },
			{ id: "network", method: "gist", keys: [{ columnId: "title", operatorClass: "inet_ops" }] },
		];
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(false);
		if (!generated.ok) expect(generated.errors.join(" ")).toContain("operator class incompatible");
	});

	test("types and renders the BRIN pages per range option", () => {
		const draft = design();
		draft.tables[0].indexes = [{
			id: "title_brin",
			method: "brin",
			keys: [{ columnId: "title" }],
			with: { pagesPerRange: 128 },
		}];
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(true);
		if (generated.ok) {
			expect(generated.sql).toContain("WITH (pages_per_range = 128)");
		}
	});

	test("reserves explicit later index names before generating earlier names", () => {
		const draft = design();
		const first = draft.tables[0];
		first.indexes = [{ id: "generated", method: "btree", keys: [{ columnId: first.columns[0].id }] }];
		const second = {
			id: "later",
			name: "Later",
			position: { x: 300, y: 0 },
			columns: [{ ...first.columns[0], id: "later-id", name: "id" }],
			indexes: [{ id: "explicit", name: "Items_id_idx", method: "btree" as const, keys: [{ columnId: "later-id" }] }],
		};
		draft.tables.push(second);
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect(generated.sql).toContain('INDEX "Items_id_idx" ON "Later"');
		expect(generated.sql).toContain('INDEX "Items_id_idx_2" ON "Items"');
	});

	test("validates temporal, interval, and money defaults in the sandbox", async () => {
		const draft = design();
		const table = draft.tables[0];
		const defaults = [
			{ id: "time", name: "time_value", type: "time" as const, literalType: "time" as const, value: "09:30:00" },
			{ id: "timetz", name: "timetz_value", type: "timetz" as const, literalType: "time" as const, value: "09:30:00-05:00" },
			{ id: "interval", name: "interval_value", type: "interval" as const, literalType: "text" as const, value: "1 day 2 hours" },
			{ id: "money", name: "money_value", type: "money" as const, literalType: "numeric" as const, value: "12.50" },
		];
		for (const item of defaults) table.columns.push({
			id: item.id,
			name: item.name,
			type: item.type,
			nullable: true,
			primaryKey: false,
			unique: false,
			identity: false,
			default: { kind: "literal", literalType: item.literalType, value: item.value },
			notes: "",
		});
		const generated = generateDesignSql(draft);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;
		expect(generated.sql).toContain('"time_value" time DEFAULT TIME \'09:30:00\'');
		expect(generated.sql).toContain('"timetz_value" timetz DEFAULT TIME WITH TIME ZONE \'09:30:00-05:00\'');
		const sandbox = createPGliteSandbox();
		try { expect(await sandbox.apply(generated.sql)).toMatchObject({ ok: true }); } finally { await sandbox.dispose(); }
	});

	test("validates workspace update payloads and skips unchanged updates", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-action-validation-"));
		directories.push(directory);
		const workspace = await createDesignWorkspace({ databasePath: join(directory, "design.sqlite") });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Action validation" });
		const created = await workspace.addTable({ name: "Records" });
		const table = created.design!.tables[0];
		const revision = workspace.getState().revision;
		await workspace.updateIndexes({ tableId: table.id, indexes: [] });
		await workspace.updateUniqueConstraints({ tableId: table.id, uniqueConstraints: [] });
		await workspace.updateEnumTypes({ enumTypes: [] });
		expect(workspace.getState().revision).toBe(revision);
		await expect(workspace.updateIndexes({
			tableId: table.id,
			indexes: [{ id: "bad", method: "btree", keys: [{ columnId: "missing" }] }],
		})).rejects.toThrow(/could not be found/);
		await expect(workspace.updateUniqueConstraints({
			tableId: table.id,
			uniqueConstraints: [{
				id: "bad",
				columnIds: ["missing", "also-missing"],
			}],
		})).rejects.toThrow(/could not be found/);
		await expect(workspace.updateEnumTypes({
			enumTypes: [{ id: "invalid", name: "  ", labels: ["value"] }],
		})).rejects.toThrow(/Enum type name is required/);
	}, 30_000);
});
