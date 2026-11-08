import { describe, expect, test } from "bun:test";
import type { Design, DesignColumn, DesignTable } from "../shared/design";
import { createPGliteSandbox } from "./sandbox";
import { generateDesignSql, renderSchemaFile } from "./sql";

/**
 * Only what PostgreSQL itself rejects may stop SQL from being generated. Everything else is advice from
 * Supabase's Postgres best practices and is reported as a warning. Each case here is checked against a real
 * PostgreSQL (PGlite), so a rule can't be relaxed past what the database accepts.
 */

function column(id: string, name: string, type: DesignColumn["type"], extra: Partial<DesignColumn> = {}): DesignColumn {
	return { id, name, type, nullable: true, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "", ...extra };
}
function table(id: string, name: string, columns: DesignColumn[], extra: Partial<DesignTable> = {}): DesignTable {
	return { id, name, position: { x: 0, y: 0 }, columns, ...extra };
}
function design(tables: DesignTable[], extra: Partial<Design> = {}): Design {
	return { tables, relationships: [], manyToManyRelationships: [], viewport: { x: 0, y: 0, zoom: 1 }, ...extra };
}
const pk = (id = "id", type: DesignColumn["type"] = "uuid") => column(id, "id", type, { nullable: false, primaryKey: true });

async function postgresAccepts(sql: string): Promise<boolean> {
	const sandbox = createPGliteSandbox();
	try { return (await sandbox.apply(sql)).ok; } finally { await sandbox.dispose(); }
}
async function generates(draft: Design) {
	const generated = generateDesignSql(draft);
	if (!generated.ok) throw new Error(`Expected SQL, got errors: ${generated.errors.join("; ")}`);
	expect(await postgresAccepts(generated.sql)).toBe(true);
	return generated;
}

describe("rules that were stricter than PostgreSQL", () => {
	test("an empty Design is valid SQL", async () => {
		await generates(design([]));
	});

	test("a table without a primary key warns instead of blocking", async () => {
		const generated = await generates(design([table("log", "audit_log", [column("msg", "message", "text")])]));
		expect(generated.warnings.join(" ")).toContain("no primary key");
		expect(renderSchemaFile(design([table("log", "audit_log", [column("msg", "message", "text")])]))).toContain("-- Table \"audit_log\" has no primary key");
	});

	test("a table without columns warns instead of blocking", async () => {
		const generated = await generates(design([table("t", "empty_table", [])]));
		expect(generated.warnings.join(" ")).toContain("no columns");
	});

	test("a composite primary key is rendered as one", async () => {
		const generated = await generates(design([table("m", "memberships", [
			column("a", "org_id", "uuid", { nullable: false, primaryKey: true }),
			column("b", "user_id", "uuid", { nullable: false, primaryKey: true }),
		])]));
		expect(generated.sql).toContain('PRIMARY KEY ("org_id", "user_id")');
	});

	test("a single-column unique constraint is valid", async () => {
		await generates(design([table("t", "things", [pk(), column("e", "email", "text")], { uniqueConstraints: [{ id: "u", columnIds: ["e"] }] })]));
	});

	test("integer types may reference each other, text types too, as in PostgreSQL", async () => {
		const draft = design([
			table("o", "orders", [pk("oid", "bigint"), column("c", "customer_id", "integer")]),
			table("c", "customers", [pk("cid", "bigint")]),
		], { relationships: [{ id: "r", cardinality: "one-to-many", referencingTableId: "o", referencingColumnId: "c", referencedTableId: "c" }] });
		await generates(draft);
	});

	test("SET NULL on a required column and SET DEFAULT without a default warn, since PostgreSQL accepts them", async () => {
		const draft = design([
			table("o", "orders", [pk("oid"), column("c", "customer_id", "uuid", { nullable: false })]),
			table("c", "customers", [pk("cid")]),
		], { relationships: [{ id: "r", cardinality: "one-to-many", referencingTableId: "o", referencingColumnId: "c", referencedTableId: "c", onDelete: "SET NULL", onUpdate: "SET DEFAULT" }] });
		const generated = await generates(draft);
		expect(generated.warnings.join(" ")).toContain("SET NULL");
		expect(generated.warnings.join(" ")).toContain("SET DEFAULT");
	});

	test("best-practice advice: unindexed foreign keys, mixed-case names, timestamp without time zone", async () => {
		const draft = design([
			table("o", "Orders", [pk("oid"), column("c", "customer_id", "uuid"), column("t", "placed", "timestamp")]),
			table("c", "customers", [pk("cid")]),
		], { relationships: [{ id: "r", cardinality: "one-to-many", referencingTableId: "o", referencingColumnId: "c", referencedTableId: "c" }] });
		const warnings = (await generates(draft)).warnings.join("\n");
		expect(warnings).toContain('Foreign key "Orders"."customer_id" has no index');
		expect(warnings).toContain('Table "Orders" is mixed case');
		expect(warnings).toContain("timestamptz");
		// An index on the column silences the foreign key advice.
		draft.tables[0].indexes = [{ id: "i", method: "btree", keys: [{ columnId: "c" }] }];
		expect((await generates(draft)).warnings.join("\n")).not.toContain("has no index");
	});
});

describe("rules PostgreSQL really enforces still block", () => {
	const errorsOf = (draft: Design) => { const generated = generateDesignSql(draft); return generated.ok ? [] : generated.errors.join("\n"); };

	test("duplicate table, column, and index names", () => {
		expect(errorsOf(design([table("a", "t", [pk()]), table("b", "t", [pk("id2")])]))).toContain("used more than once");
		expect(errorsOf(design([table("a", "t", [pk(), column("x", "id", "text")])]))).toContain("used more than once");
		expect(errorsOf(design([table("a", "t", [pk(), column("x", "v", "text")], { indexes: [{ id: "1", name: "i", method: "btree", keys: [{ columnId: "x" }] }, { id: "2", name: "i", method: "btree", keys: [{ columnId: "x" }] }] })]))).toContain('name "i" is used more than once');
	});

	test("a foreign key must reference a single primary key column of a compatible type", () => {
		const base = (referencing: DesignColumn, referenced: DesignTable) => design([table("o", "orders", [pk("oid"), referencing]), referenced], { relationships: [{ id: "r", cardinality: "one-to-many", referencingTableId: "o", referencingColumnId: referencing.id, referencedTableId: referenced.id }] });
		expect(errorsOf(base(column("c", "customer_id", "uuid"), table("c", "customers", [pk("cid", "integer")])))).toContain("needs matching types");
		expect(errorsOf(base(column("c", "customer_id", "uuid"), table("c", "customers", [column("cid", "id", "uuid")])))).toContain("primary key");
	});

	test("an empty unique constraint and a trigger without a trigger function", () => {
		expect(errorsOf(design([table("a", "t", [pk()], { uniqueConstraints: [{ id: "u", columnIds: [] }] })]))).toContain("at least one column");
	});
});

describe("readable SQL", () => {
	const fk = (id: string, from: string, column: string, to: string): Design["relationships"][number] => ({ id, cardinality: "one-to-many", referencingTableId: from, referencingColumnId: column, referencedTableId: to });

	test("foreign keys are written inside CREATE TABLE, with referenced tables created first", async () => {
		// Designed child-first, as in a real project: dishes was drawn before the table it references.
		const draft = design([
			table("d", "dishes", [pk("did"), column("cat", "category_id", "uuid")]),
			table("c", "dish_categories", [pk("cid")]),
			table("s", "staff", [pk("sid"), column("boss", "boss_id", "uuid")]),
		], { relationships: [fk("r1", "d", "cat", "c"), fk("r2", "s", "boss", "s")] });
		const generated = await generates(draft);
		const sql = generated.sql;
		expect(sql.indexOf('CREATE TABLE "dish_categories"')).toBeLessThan(sql.indexOf('CREATE TABLE "dishes"'));
		expect(sql).toContain('CONSTRAINT "dishes_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "dish_categories" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION');
		expect(sql).toContain('CONSTRAINT "staff_boss_id_fkey" FOREIGN KEY ("boss_id") REFERENCES "staff" ("id")'); // a table may reference itself
		expect(sql).not.toContain("ADD CONSTRAINT");
	});

	test("only references that form a cycle are added afterwards", async () => {
		const draft = design([
			table("a", "accounts", [pk("aid"), column("owner", "owner_id", "uuid")]),
			table("u", "users", [pk("uid"), column("acct", "account_id", "uuid")]),
		], { relationships: [fk("r1", "a", "owner", "u"), fk("r2", "u", "acct", "a")] });
		const sql = (await generates(draft)).sql;
		expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(1);
		expect(sql.match(/FOREIGN KEY/g)).toHaveLength(2);
	});

	test("a one-to-one reference keeps its uniqueness next to its foreign key", async () => {
		const draft = design([
			table("p", "profiles", [pk("pid"), column("u", "user_id", "uuid")]),
			table("u", "users", [pk("uid")]),
		], { relationships: [{ ...fk("r", "p", "u", "u"), cardinality: "one-to-one" }] });
		const sql = (await generates(draft)).sql;
		expect(sql).toContain('FOREIGN KEY ("user_id") REFERENCES "users"');
		expect(sql).toContain('UNIQUE ("user_id")');
		expect(sql).not.toContain("ADD CONSTRAINT");
	});

	test("a junction that is already unique on its pair gets no second constraint", async () => {
		const junction = (extra: Partial<DesignTable>) => design([
			table("d", "dishes", [pk("did")]),
			table("s", "stations", [pk("sid")]),
			table("j", "dish_stations", [pk("jid"), column("dish", "dish_id", "uuid", { nullable: false }), column("station", "station_id", "uuid", { nullable: false })], extra),
		], {
			relationships: [fk("r1", "j", "dish", "d"), fk("r2", "j", "station", "s")],
			manyToManyRelationships: [{ id: "m", leftTableId: "d", rightTableId: "s", junctionTableId: "j", leftRelationshipId: "r1", rightRelationshipId: "r2" }],
		});
		const unique = (sql: string) => (sql.match(/UNIQUE \("dish_id", "station_id"\)/g) ?? []).length;
		expect(unique((await generates(junction({}))).sql)).toBe(1); // the pair constraint itself
		expect(unique((await generates(junction({ uniqueConstraints: [{ id: "u", columnIds: ["dish", "station"] }] }))).sql)).toBe(1); // theirs, not a second
		const withIndex = (await generates(junction({ indexes: [{ id: "i", name: "pair_uidx", method: "btree", unique: true, keys: [{ columnId: "station" }, { columnId: "dish" }] }] }))).sql;
		expect(unique(withIndex)).toBe(0);
		expect(withIndex).toContain('CREATE UNIQUE INDEX "pair_uidx"');
	});

	test("an index that only repeats the start of another is called out", async () => {
		const draft = design([table("t", "dish_stations", [pk("tid"), column("d", "dish_id", "uuid"), column("s", "station_id", "uuid")], {
			indexes: [
				{ id: "a", name: "by_dish", method: "btree", keys: [{ columnId: "d" }] },
				{ id: "b", name: "by_dish_station", method: "btree", unique: true, keys: [{ columnId: "d" }, { columnId: "s" }] },
				{ id: "c", name: "by_station", method: "btree", keys: [{ columnId: "s" }] },
			],
		})]);
		const warnings = (await generates(draft)).warnings.join("\n");
		expect(warnings).toContain('Index "by_dish" on "dish_stations" is already covered by index "by_dish_station"');
		expect(warnings).not.toContain('Index "by_station"');
	});
});
