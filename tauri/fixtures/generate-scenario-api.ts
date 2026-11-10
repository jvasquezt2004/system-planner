/**
 * Differential fixtures for the Scenario API emulation (`scenario-api.ts`): the PostgREST requests a
 * Scenario's code makes against the sandbox database, and the responses and request-log entries the
 * original gives. Each session starts from the same seeded database and replays its requests in
 * order, so writes are seen by later reads.
 *
 * Run from tauri/: bun fixtures/generate-scenario-api.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createPGliteSandbox, SUPABASE_SANDBOX_BOOTSTRAP, SUPABASE_SANDBOX_GRANTS } from "../../src/bun/sandbox";
import { captureScenarioResultGrids, handleSandboxApiRequest } from "../../src/bun/scenario-api";
import type { DesignFunction, SandboxApiRequest } from "../../src/shared/design";
import { seededRng, type Rng } from "./lib/mutate";

const schema = `
CREATE TABLE customers (id uuid PRIMARY KEY, name text NOT NULL, email text UNIQUE, age integer, meta jsonb, tags text[], created_at timestamptz);
CREATE TABLE orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE, total numeric(10,2) DEFAULT 0, status text DEFAULT 'new', placed_on date);
CREATE TABLE products (id integer PRIMARY KEY, title text NOT NULL, price numeric(8,2));
CREATE TABLE order_items (id integer PRIMARY KEY, order_id bigint REFERENCES orders(id), product_id integer REFERENCES products(id), qty integer DEFAULT 1);
CREATE TABLE profiles (id uuid PRIMARY KEY REFERENCES customers(id), bio text);
CREATE TABLE tags (id integer PRIMARY KEY, label text);
CREATE TABLE customer_tags (customer_id uuid REFERENCES customers(id), tag_id integer REFERENCES tags(id), PRIMARY KEY (customer_id, tag_id));
CREATE TABLE messages (id integer PRIMARY KEY, sender uuid REFERENCES customers(id), recipient uuid REFERENCES customers(id), body text);
CREATE TABLE secrets (id integer PRIMARY KEY, owner uuid, note text);
ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
CREATE POLICY own ON secrets USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
CREATE TABLE "Odd Table" ("Odd Col" integer PRIMARY KEY, "select" text);
CREATE FUNCTION add_numbers(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a + b $$;
CREATE FUNCTION customer_names() RETURNS SETOF text LANGUAGE sql STABLE AS $$ SELECT name FROM customers ORDER BY name $$;
CREATE FUNCTION touch_customers() RETURNS void LANGUAGE sql AS $$ UPDATE customers SET age = coalesce(age, 0) + 1 $$;
CREATE FUNCTION orders_for(cid uuid) RETURNS SETOF orders LANGUAGE sql STABLE AS $$ SELECT * FROM orders WHERE customer_id = cid ORDER BY id $$;
CREATE FUNCTION first_customer() RETURNS customers LANGUAGE sql STABLE AS $$ SELECT * FROM customers ORDER BY name LIMIT 1 $$;
CREATE FUNCTION pair() RETURNS TABLE(x integer, y text) LANGUAGE sql STABLE AS $$ SELECT 1, 'one' UNION ALL SELECT 2, 'two' $$;
CREATE FUNCTION fail_always() RETURNS integer LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'nope'; END $$;
`;

const seed = `
INSERT INTO customers VALUES
 ('00000000-0000-0000-0000-000000000001', 'Ada', 'ada@example.com', 36, '{"vip": true, "level": 3}', '{a,b}', '2024-01-02T03:04:05Z'),
 ('00000000-0000-0000-0000-000000000002', 'Grace', 'grace@example.com', 45, NULL, '{}', '2024-02-03T00:00:00Z'),
 ('00000000-0000-0000-0000-000000000003', 'Linus', NULL, NULL, '{"vip": false}', NULL, NULL);
INSERT INTO orders (customer_id, total, status, placed_on) VALUES
 ('00000000-0000-0000-0000-000000000001', 10.50, 'paid', '2024-03-01'),
 ('00000000-0000-0000-0000-000000000001', 99.99, 'new', '2024-03-02'),
 ('00000000-0000-0000-0000-000000000002', 5, 'paid', NULL);
INSERT INTO products VALUES (1, 'Pen', 1.25), (2, 'Book', 12), (3, 'Lamp', 30.5);
INSERT INTO order_items VALUES (1, 1, 1, 2), (2, 1, 2, 1), (3, 2, 3, 1), (4, 3, 1, 5);
INSERT INTO profiles VALUES ('00000000-0000-0000-0000-000000000001', 'Mathematician');
INSERT INTO tags VALUES (1, 'vip'), (2, 'beta'), (3, 'staff');
INSERT INTO customer_tags VALUES ('00000000-0000-0000-0000-000000000001', 1), ('00000000-0000-0000-0000-000000000001', 2), ('00000000-0000-0000-0000-000000000002', 2);
INSERT INTO messages VALUES (1, '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'hi'), (2, '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'hello');
INSERT INTO secrets VALUES (1, '00000000-0000-0000-0000-000000000001', 'ada secret'), (2, '00000000-0000-0000-0000-000000000002', 'grace secret');
INSERT INTO "Odd Table" VALUES (1, 'a'), (2, 'b');
`;

const functions: DesignFunction[] = [
	fn("add_numbers", [["a", "integer"], ["b", "integer"]], "integer", false, "immutable"),
	fn("customer_names", [], "text", true, "stable"),
	fn("touch_customers", [], "void", false, "volatile"),
	fn("orders_for", [["cid", "uuid"]], "orders", true, "stable"),
	fn("first_customer", [], "customers", false, "stable"),
	fn("pair", [], "TABLE(x integer, y text)", true, "stable"),
	fn("fail_always", [], "integer", false, "volatile"),
];

function fn(name: string, args: Array<[string, string]>, returnType: string, returnsSet: boolean, volatility: "immutable" | "stable" | "volatile"): DesignFunction {
	return { id: `fn-${name}`, name, arguments: args.map(([argName, type]) => ({ name: argName, type })), returnType, returnsSet, language: "sql", volatility, security: "invoker", body: "" };
}

const token = (claims: Record<string, unknown>) => `Bearer h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const ADA = "00000000-0000-0000-0000-000000000001";
const GRACE = "00000000-0000-0000-0000-000000000002";
const identities: Array<Record<string, string>> = [
	{},
	{ authorization: token({ role: "authenticated", sub: ADA }) },
	{ authorization: token({ role: "authenticated", sub: GRACE, email: "g@x.dev" }) },
	{ authorization: token({ role: "service_role" }) },
	{ authorization: token({ role: "superuser" }) },
	{ authorization: "Bearer broken" },
];

const get = (table: string, query = "", headers: Record<string, string> = {}): SandboxApiRequest => ({ method: "GET", path: `/rest/v1/${table}`, query, headers, body: null });
const send = (method: string, table: string, body: unknown, query = "", headers: Record<string, string> = {}): SandboxApiRequest => ({ method, path: `/rest/v1/${table}`, query, headers, body: body === undefined ? null : JSON.stringify(body) });
const rpc = (name: string, method: string, body: unknown, query = "", headers: Record<string, string> = {}): SandboxApiRequest => ({ method, path: `/rest/v1/rpc/${name}`, query, headers, body: body === undefined ? null : JSON.stringify(body) });

const service = { authorization: token({ role: "service_role" }) };
const representation = { prefer: "return=representation" };

const fixed: SandboxApiRequest[] = [
	get("customers"),
	get("customers", "select=id,name&order=name.desc"),
	get("customers", "select=name&age=gte.40"),
	get("customers", "select=name&age=is.null"),
	get("customers", "select=name&email=not.is.null"),
	get("customers", "select=name&name=in.(Ada,Grace)"),
	get("customers", 'select=name&name=in.("Ada","G,race")'),
	get("customers", "select=name&name=ilike.*ra*"),
	get("customers", "select=name&or=(age.gt.40,name.eq.Linus)"),
	get("customers", "select=name&name=neq.Ada&order=name.asc.nullsfirst&limit=1&offset=1"),
	get("customers", "select=name", { prefer: "count=exact" }),
	get("customers", "select=name&limit=1", { prefer: "count=exact" }),
	get("customers", "select=name&limit=1&offset=2", { prefer: "count=exact" }),
	get("customers", "select=name", { range: "1-1", "range-unit": "items" }),
	get("customers", "select=name", { range: "0-" }),
	get("customers", "select=name&age=eq.999", { prefer: "count=exact" }),
	get("customers", "select=name&id=eq." + ADA, { accept: "application/vnd.pgrst.object+json" }),
	get("customers", "select=name", { accept: "application/vnd.pgrst.object+json" }),
	get("customers", "select=name", { accept: "text/csv" }),
	get("customers", "select=name", { prefer: "count=planned" }),
	get("customers", "select=name", { prefer: "return=minimal" }),
	{ method: "HEAD", path: "/rest/v1/customers", query: "select=name", headers: { prefer: "count=exact" }, body: null },
	get("customers", "select=nope"),
	get("customers", "select=name&nope=eq.1"),
	get("customers", "select=name&order=nope"),
	get("customers", "select=name&order=name.sideways"),
	get("customers", "select=name&limit=abc"),
	get("customers", "select=name&and=(age.gt.1)"),
	get("customers", "select=alias:name"),
	get("customers", "select=meta->vip"),
	get("customers", "select=name&age=between.1.2"),
	get("customers", "select=meta,tags,created_at,age"),
	get("orders", "select=id,total,status,placed_on&order=id"),
	get("orders", "select=*,customers(name)&order=id"),
	get("orders", "select=id,customers(name,email)&order=id"),
	get("orders", "select=id,order_items(qty,products(title))&order=id"),
	get("customers", "select=name,orders(id,total)&order=name"),
	get("customers", "select=name,orders(id,total)&orders.order=total.desc&orders.limit=1&order=name"),
	get("customers", "select=name,orders(id,status)&orders.status=eq.paid&order=name"),
	get("customers", "select=name,orders!inner(id)&order=name"),
	get("customers", "select=name,orders!inner(id)&orders.status=eq.paid&order=name"),
	get("customers", "select=name,profiles(bio)&order=name"),
	get("customers", "select=name,tags(label)&order=name"),
	get("customers", "select=name,tags!inner(label)&tags.label=eq.vip"),
	get("customers", "select=name,messages(body)"),
	get("customers", "select=name,messages!sender(body)&order=name"),
	get("customers", "select=name,messages!messages_sender_fkey(body)&order=name"),
	get("messages", "select=body,customers(name)"),
	get("messages", "select=body,customers!recipient(name)&order=id"),
	get("customers", "select=name,nothing(id)"),
	get("customers", "select=name,orders(id"),
	get("customers", "select=*,orders(*,order_items(*))&order=name"),
	get("customers", 'select=name&"name"=eq.Ada'),
	get("Odd Table", 'select="Odd Col","select"&order=Odd Col'),
	get("secrets", "select=note"),
	get("secrets", "select=note", { authorization: token({ role: "authenticated", sub: ADA }) }),
	get("secrets", "select=note", { authorization: token({ role: "service_role" }) }),
	get("customerz", "select=name"),
	get("custmers", "select=name"),
	{ method: "GET", path: "/rest/v1/", query: "", headers: {}, body: null },
	{ method: "GET", path: "/auth/v1/user", query: "", headers: {}, body: null },
	{ method: "OPTIONS", path: "/rest/v1/customers", query: "", headers: {}, body: null },
	send("POST", "customers", { id: "00000000-0000-0000-0000-000000000009", name: "Zed", age: 20 }, "", representation),
	send("POST", "customers", { id: "00000000-0000-0000-0000-000000000009", name: "Zed again" }),
	send("POST", "customers", [{ id: "00000000-0000-0000-0000-00000000000a", name: "A", meta: { k: [1, 2] }, tags: ["x", "y"] }, { id: "00000000-0000-0000-0000-00000000000b", name: "B", age: 5 }], "select=id,name,age", representation),
	send("POST", "customers", [{ id: "00000000-0000-0000-0000-00000000000c", name: "C" }, { id: "00000000-0000-0000-0000-00000000000d", age: 1 }]),
	send("POST", "customers", [{ id: "00000000-0000-0000-0000-00000000000e", name: "E" }, { id: "00000000-0000-0000-0000-00000000000f", name: "F", age: 2 }], "", { prefer: "return=representation,missing=default,count=exact" }),
	send("POST", "customers", { name: "No id" }),
	send("POST", "customers", { id: "not-a-uuid", name: "x" }),
	send("POST", "customers", { nope: 1 }),
	send("POST", "customers", []),
	send("POST", "customers", "text"),
	send("POST", "customers", { id: ADA, name: "Ada II" }, "on_conflict=id", { prefer: "resolution=merge-duplicates,return=representation" }),
	send("POST", "customers", { id: ADA, name: "Ada III" }, "", { prefer: "resolution=ignore-duplicates,return=representation" }),
	send("POST", "customers", { email: "ada@example.com", name: "Dup" }, "on_conflict=email", { prefer: "resolution=merge-duplicates,return=representation" }),
	send("POST", "customers", { id: ADA, name: "x" }, "on_conflict=nope", { prefer: "resolution=merge-duplicates" }),
	send("POST", "customers", { id: ADA }, "", { prefer: "resolution=other" }),
	send("POST", "customers", { id: ADA, name: "x" }, "", { prefer: "return=headers-only" }),
	send("POST", "orders", { customer_id: "00000000-0000-0000-0000-0000000000ff", total: 1 }),
	send("POST", "orders", { customer_id: GRACE }, "", { prefer: "return=representation,count=exact", accept: "application/vnd.pgrst.object+json" }),
	send("POST", "orders", [{ customer_id: GRACE }, { customer_id: ADA }], "", { prefer: "return=representation", accept: "application/vnd.pgrst.object+json" }),
	send("POST", "orders", {}, "", representation),
	send("POST", "products", { id: 10, title: null }),
	send("POST", "products", { id: 11, title: "T", price: "12.5" }, "", representation),
	send("POST", "products", { id: 12, title: "T", price: 1e21 }, "", representation),
	send("PATCH", "customers", { age: 50 }, "id=eq." + ADA, representation),
	send("PATCH", "customers", { age: 50 }, "id=eq." + ADA, { prefer: "count=exact" }),
	send("PATCH", "customers", { age: 1 }, "name=like.*a*", { prefer: "return=representation,count=exact" }),
	send("PATCH", "customers", { age: 1 }),
	send("PATCH", "customers", { nope: 1 }, "id=eq." + ADA),
	send("PATCH", "customers", {}, "id=eq." + ADA),
	send("PATCH", "customers", [1], "id=eq." + ADA),
	send("PATCH", "customers", { age: 7 }, "or=(name.eq.Ada,name.eq.Grace)", { prefer: "return=representation", accept: "application/vnd.pgrst.object+json" }),
	send("PATCH", "customers", { age: 7 }, "id=eq." + ADA, { prefer: "return=representation", accept: "application/vnd.pgrst.object+json" }),
	send("PATCH", "customers", { id: "nope" }, "id=eq." + ADA),
	send("PATCH", "customers", { age: 1 }, "id=eq." + ADA + "&order=name"),
	send("PATCH", "customers", { age: 1 }, "id=eq." + ADA + "&on_conflict=id"),
	send("PATCH", "customers", { meta: { deep: { value: [1, "two"] } } }, "id=eq." + ADA, { prefer: "return=representation", ...{} }),
	send("DELETE", "customers", undefined, "id=eq." + GRACE, representation),
	send("DELETE", "orders", undefined, "id=eq.1", { prefer: "count=exact" }),
	send("DELETE", "orders", undefined, "id=gt.0"),
	send("DELETE", "customers", undefined),
	send("DELETE", "customers", undefined, "id=eq." + ADA),
	send("DELETE", "order_items", undefined, "qty=in.(1,2)", { prefer: "return=representation", ...{} }),
	send("DELETE", "customer_tags", undefined, "tag_id=eq.1", { prefer: "return=representation" }),
	send("PUT", "customers", {}),
	rpc("add_numbers", "POST", { a: 1, b: 2 }),
	rpc("add_numbers", "POST", { a: "5", b: "6" }),
	rpc("add_numbers", "GET", undefined, "a=3&b=4"),
	rpc("add_numbers", "POST", { a: 1 }),
	rpc("add_numbers", "POST", { a: 1, b: 2, c: 3 }),
	rpc("add_numbers", "POST", [1, 2]),
	rpc("add_numbers", "POST", { a: 1, b: 2 }, "order=x"),
	rpc("add_numbers", "POST", { a: 1, b: 2 }, "select=x"),
	rpc("add_numbers", "PATCH", {}),
	rpc("customer_names", "POST", {}),
	rpc("customer_names", "GET", undefined),
	rpc("touch_customers", "POST", {}),
	rpc("touch_customers", "GET", undefined),
	rpc("orders_for", "POST", { cid: ADA }),
	rpc("orders_for", "POST", { cid: ADA }, "select=id,status,customers(name)"),
	rpc("orders_for", "GET", undefined, "cid=" + ADA + "&select=id"),
	rpc("orders_for", "GET", undefined, "cid=" + ADA + "&status=eq.paid"),
	rpc("orders_for", "POST", { cid: ADA }, "order=id.desc"),
	rpc("orders_for", "POST", { cid: ADA }, "orders.limit=1&select=id"),
	rpc("first_customer", "POST", {}, "select=name,orders(id)"),
	rpc("first_customer", "POST", {}),
	rpc("pair", "POST", {}),
	rpc("pair", "POST", {}, "select=x"),
	rpc("pair", "GET", undefined, "x=eq.1"),
	rpc("fail_always", "POST", {}),
	rpc("missing_function", "POST", {}),
	{ method: "POST", path: "/rest/v1/rpc/add_numbers/extra", query: "", headers: {}, body: "{}" },
	{ method: "POST", path: "/rest/v1/functions/hello", query: "", headers: {}, body: "{}", invocation: { functionName: "hello", status: 200, response: { message: "hi" } }, invocationRef: "ref-1" },
	{ method: "GET", path: "/rest/v1/customers", query: "select=name", headers: { authorization: token({ role: "authenticated", sub: ADA }) }, body: null, invocationRef: "ref-2" },
];

// The same requests under every kind of caller, for the ones where who asks changes the answer.
const asEveryone = ["secrets", "customers", "orders"].flatMap((table) => identities.map((headers) => get(table, "select=*&order=id", headers)));
const writesAsEveryone = identities.map((headers, index) => send("POST", "secrets", { id: 10 + index, owner: ADA, note: "mine" }, "", { ...headers, prefer: "return=representation" }));

/* Random but well-formed reads, so filters, orders, projections and embeds are combined unexpectedly. */
const rng: Rng = seededRng(0x5ce9a210);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const tableShapes: Record<string, { columns: string[]; filters: string[]; embeds: string[] }> = {
	customers: { columns: ["id", "name", "email", "age", "meta", "tags", "created_at"], filters: ["age=gt.30", "age=lte.40", "name=like.A*", "name=ilike.*N*", "email=is.null", "age=in.(36,45)", "name=not.eq.Ada", "or=(age.is.null,name.eq.Grace)"], embeds: ["orders(id,total)", "orders(*)", "profiles(bio)", "tags(label)", "messages!sender(body)", "orders!inner(id)"] },
	orders: { columns: ["id", "customer_id", "total", "status", "placed_on"], filters: ["status=eq.paid", "total=gte.10", "placed_on=is.null", "id=in.(1,3)", "status=neq.new"], embeds: ["customers(name)", "order_items(qty)", "order_items(products(title))", "customers!inner(name)"] },
	products: { columns: ["id", "title", "price"], filters: ["price=gt.2", "title=ilike.*o*", "id=lt.3"], embeds: ["order_items(qty)", "order_items(orders(status))"] },
	order_items: { columns: ["id", "order_id", "product_id", "qty"], filters: ["qty=gte.2", "order_id=eq.1"], embeds: ["orders(status)", "products(title,price)"] },
};
const random: SandboxApiRequest[] = [];
for (let index = 0; index < 220; index += 1) {
	const table = pick(Object.keys(tableShapes));
	const shape = tableShapes[table]!;
	const columns = shape.columns.filter(() => rng() < 0.6);
	if (!columns.length) columns.push(shape.columns[0]!);
	const parts: string[] = [];
	const select = [...columns, ...(rng() < 0.4 ? [pick(shape.embeds)] : [])];
	if (rng() < 0.9) parts.push(`select=${select.join(",")}`);
	if (rng() < 0.5) parts.push(pick(shape.filters));
	if (rng() < 0.3) parts.push(pick(shape.filters));
	if (rng() < 0.5) parts.push(`order=${pick(shape.columns)}.${pick(["asc", "desc"])}${rng() < 0.2 ? "." + pick(["nullsfirst", "nullslast"]) : ""}`);
	if (rng() < 0.3) parts.push(`limit=${Math.floor(rng() * 4)}`);
	if (rng() < 0.2) parts.push(`offset=${Math.floor(rng() * 3)}`);
	const headers: Record<string, string> = { ...pick(identities) };
	if (rng() < 0.3) headers.prefer = "count=exact";
	random.push(get(table, parts.join("&"), headers));
}

const groups: SandboxApiRequest[][] = [fixed, [...asEveryone, ...writesAsEveryone], random];

const sandbox = createPGliteSandbox();
const applied = await sandbox.apply(schema);
if (!applied.ok) throw new Error(`The fixture schema was rejected: ${applied.error}`);
const tables = applied.tables;
const relationships = applied.relationships;

const sessions: unknown[] = [];
for (const requests of groups) {
	const database = new PGlite({ extensions: { vector } });
	await database.waitReady;
	await database.exec(SUPABASE_SANDBOX_BOOTSTRAP);
	await database.exec(schema);
	await database.exec(SUPABASE_SANDBOX_GRANTS);
	await database.exec(seed);
	const steps: unknown[] = [];
	for (const request of requests) {
		const { response, entry } = await handleSandboxApiRequest(database, tables, request, relationships, functions);
		steps.push({ request, response: JSON.parse(JSON.stringify(response)), entry: JSON.parse(JSON.stringify(entry)) });
	}
	const grids = await captureScenarioResultGrids(database, tables);
	sessions.push({ steps, grids: JSON.parse(JSON.stringify(grids)) });
	await database.close();
}
await sandbox.dispose();

const all = (sessions as Array<{ steps: Array<{ response: { status: number } }> }>).flatMap((session) => session.steps);
const byStatus = new Map<number, number>();
for (const step of all) byStatus.set(step.response.status, (byStatus.get(step.response.status) ?? 0) + 1);
console.log(`scenario api: ${all.length} requests in ${sessions.length} sessions; statuses ${[...byStatus].sort(([a], [b]) => a - b).map(([status, count]) => `${status}×${count}`).join(" ")}`);

mkdirSync(join(import.meta.dir, "data"), { recursive: true });
writeFileSync(join(import.meta.dir, "data/scenario-api.json"), `${JSON.stringify({ schema, seed, tables, relationships, functions, sessions })}\n`);
