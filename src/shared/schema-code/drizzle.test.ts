import { describe, expect, test } from "bun:test";
import { SCHEMA_CODE_FIXTURES } from "./fixtures";
import { generateDrizzleSchema } from "./drizzle";

describe("generateDrizzleSchema", () => {
	test("matches full-output snapshots for every shared fixture", () => {
		const minimal = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.minimal);
		const blog = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		const vector = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.vector);
		const typeCatalog = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.typeCatalog);
		const awkwardNames = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.awkwardNames);

		expect(minimal.ok).toBe(true);
		expect(blog.ok).toBe(true);
		expect(vector.ok).toBe(true);
		expect(typeCatalog.ok).toBe(true);
		expect(awkwardNames.ok).toBe(true);
		if (!minimal.ok || !blog.ok || !vector.ok || !typeCatalog.ok || !awkwardNames.ok) return;

		expect(minimal.code).toMatchInlineSnapshot(`
		  "import * as pg from "drizzle-orm/pg-core";

		  export const users = pg.pgTable("users", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"email": pg.text("email").unique("users_email_key").notNull(),
		  	"displayName": pg.text("display_name"),
		  }, (t) => [
		  ]);
		  "
		`);
		expect(blog.code).toMatchInlineSnapshot(`
		  "import * as pg from "drizzle-orm/pg-core";
		  import { relations as drizzleRelations } from "drizzle-orm";
		  import type { AnyPgColumn } from "drizzle-orm/pg-core";
		  import { sql } from "drizzle-orm";

		  export const userRole = pg.pgEnum("user_role", ["member","editor","admin"]);

		  export const users = pg.pgTable("users", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"email": pg.varchar("email", { length: 255 }).unique("users_email_key").notNull(),
		  	"displayName": pg.text("display_name"),
		  	"role": userRole("role").default(sql.raw("'member'")).notNull(),
		  	"createdAt": pg.timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
		  }, (t) => [
		  	pg.index("users_created_at_idx").using("brin", t["createdAt"]).with({"pages_per_range":32})
		  ]);

		  export const profiles = pg.pgTable("profiles", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"userId": pg.bigint("user_id", { mode: "number" }).notNull(),
		  	"bio": pg.text("bio"),
		  	"birthday": pg.date("birthday", { mode: "string" }),
		  }, (t) => [
		  	pg.foreignKey({ name: "profiles_user_id_fkey", columns: [t["userId"]], foreignColumns: [users["id"]] }).onDelete("cascade"),
		  	pg.unique("profiles_user_id_key").on(t["userId"])
		  ]);

		  export const posts = pg.pgTable("posts", {
		  	"id": pg.uuid("id").primaryKey().defaultRandom(),
		  	"authorId": pg.bigint("author_id", { mode: "number" }).notNull(),
		  	"editorId": pg.bigint("editor_id", { mode: "number" }),
		  	"title": pg.text("title").notNull(),
		  	"slug": pg.varchar("slug", { length: 120 }).notNull(),
		  	"body": pg.text("body"),
		  	"keywords": pg.text("keywords").array(),
		  	"published": pg.boolean("published").default(sql.raw("false")).notNull(),
		  	"rating": pg.numeric("rating", { precision: 3, scale: 1 }),
		  	"metadata": pg.jsonb("metadata").default(sql.raw("JSONB '{}'")).notNull(),
		  	"createdAt": pg.timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
		  }, (t) => [
		  	pg.foreignKey({ name: "posts_author_id_fkey", columns: [t["authorId"]], foreignColumns: [users["id"]] }).onDelete("cascade"),
		  	pg.foreignKey({ name: "posts_editor_id_fkey", columns: [t["editorId"]], foreignColumns: [users["id"]] }).onDelete("set null"),
		  	pg.unique("posts_author_slug_key").on(t["authorId"], t["slug"]),
		  	pg.index("posts_author_id_created_at_idx").using("btree", t["authorId"], t["createdAt"].desc().nullsLast()) /* PostgreSQL migration follow-up: add INCLUDE (title); Drizzle ORM does not model INCLUDE columns */,
		  	pg.index("posts_keywords_gin").using("gin", t["keywords"]),
		  	pg.index("posts_metadata_idx").using("gin", t["metadata"].op("jsonb_path_ops")).with({"fastupdate":false}),
		  	pg.index("posts_slug_idx").using("hash", t["slug"]),
		  	pg.uniqueIndex("posts_title_editor_id_idx").using("btree", t["title"], t["editorId"]) /* PostgreSQL migration follow-up: add NULLS NOT DISTINCT; Drizzle ORM does not model this index option */
		  ]);

		  export const comments = pg.pgTable("comments", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"postId": pg.uuid("post_id").notNull(),
		  	// Drizzle assigns inline foreign keys its own name; use a raw SQL migration to preserve "comments_parent_id_fkey".
		  	"parentId": pg.bigint("parent_id", { mode: "number" }).references((): AnyPgColumn => comments["id"], { onUpdate: "no action", onDelete: "set null" }),
		  	"body": pg.text("body").notNull(),
		  }, (t) => [
		  	pg.foreignKey({ name: "comments_post_id_fkey", columns: [t["postId"]], foreignColumns: [posts["id"]] }).onUpdate("cascade").onDelete("cascade")
		  ]);

		  export const tags = pg.pgTable("tags", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"name": pg.varchar("name", { length: 64 }).unique("tags_name_key").notNull(),
		  }, (t) => [
		  ]);

		  export const postTags = pg.pgTable("post_tags", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"postId": pg.uuid("post_id").notNull(),
		  	"tagId": pg.bigint("tag_id", { mode: "number" }).notNull(),
		  	"addedAt": pg.timestamp("added_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
		  }, (t) => [
		  	pg.foreignKey({ name: "post_tags_post_id_fkey", columns: [t["postId"]], foreignColumns: [posts["id"]] }).onDelete("cascade"),
		  	pg.foreignKey({ name: "post_tags_tag_id_fkey", columns: [t["tagId"]], foreignColumns: [tags["id"]] }).onDelete("restrict"),
		  	pg.unique("post_tags_pair_key").on(t["postId"], t["tagId"])
		  ]);

		  export const usersRelations = drizzleRelations(users, (helpers) => ({
		  		"posts": helpers.many(posts, { relationName: "r_posts_author" }),
		  		"posts_2": helpers.many(posts, { relationName: "r_posts_editor" }),
		  		"profiles": helpers.many(profiles, { relationName: "r_profiles_user" }),
		  }));

		  export const profilesRelations = drizzleRelations(profiles, (helpers) => ({
		  		"user": helpers.one(users, { fields: [profiles["userId"]], references: [users["id"]], relationName: "r_profiles_user" }),
		  }));

		  export const postsRelations = drizzleRelations(posts, (helpers) => ({
		  		"author": helpers.one(users, { fields: [posts["authorId"]], references: [users["id"]], relationName: "r_posts_author" }),
		  		"editor": helpers.one(users, { fields: [posts["editorId"]], references: [users["id"]], relationName: "r_posts_editor" }),
		  		"comments": helpers.many(comments, { relationName: "r_comments_post" }),
		  		"postTags": helpers.many(postTags, { relationName: "r_post_tags_post" }),
		  }));

		  export const commentsRelations = drizzleRelations(comments, (helpers) => ({
		  		"post": helpers.one(posts, { fields: [comments["postId"]], references: [posts["id"]], relationName: "r_comments_post" }),
		  		"parent": helpers.one(comments, { fields: [comments["parentId"]], references: [comments["id"]], relationName: "r_comments_parent" }),
		  		"comments": helpers.many(comments, { relationName: "r_comments_parent" }),
		  }));

		  export const tagsRelations = drizzleRelations(tags, (helpers) => ({
		  		"postTags": helpers.many(postTags, { relationName: "r_post_tags_tag" }),
		  }));

		  export const postTagsRelations = drizzleRelations(postTags, (helpers) => ({
		  		"post": helpers.one(posts, { fields: [postTags["postId"]], references: [posts["id"]], relationName: "r_post_tags_post" }),
		  		"tag": helpers.one(tags, { fields: [postTags["tagId"]], references: [tags["id"]], relationName: "r_post_tags_tag" }),
		  }));
		  "
		`);
		expect(vector.code).toMatchInlineSnapshot(`
		  "import * as pg from "drizzle-orm/pg-core";

		  export const documents = pg.pgTable("documents", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"content": pg.text("content").notNull(),
		  	"embedding": pg.vector("embedding", { dimensions: 1536 }).notNull(),
		  	"summaryEmbedding": pg.halfvec("summary_embedding", { dimensions: 768 }),
		  	"keywordsEmbedding": pg.sparsevec("keywords_embedding", { dimensions: 30000 }),
		  	"signature": pg.bit("signature", { dimensions: 256 }),
		  }, (t) => [
		  	pg.index("documents_embedding_idx").using("hnsw", t["embedding"].op("vector_cosine_ops")).with({"m":16,"ef_construction":64}),
		  	pg.index("documents_summary_ivfflat").using("ivfflat", t["summaryEmbedding"].op("halfvec_l2_ops")).with({"lists":100}),
		  	pg.index("documents_keywords_embedding_idx").using("hnsw", t["keywordsEmbedding"].op("sparsevec_ip_ops")),
		  	pg.index("documents_signature_idx").using("hnsw", t["signature"].op("bit_hamming_ops"))
		  ]);
		  "
		`);
		expect(typeCatalog.code).toMatchInlineSnapshot(`
		  "import * as pg from "drizzle-orm/pg-core";
		  import { sql } from "drizzle-orm";

		  export const mood = pg.pgEnum("mood", ["happy","sad","in-between"]);

		  export const typeCatalog = pg.pgTable("type_catalog", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"integerValue": pg.integer("integer_value"),
		  	"smallintValue": pg.smallint("smallint_value"),
		  	"textValue": pg.text("text_value"),
		  	"varcharValue": pg.varchar("varchar_value", { length: 40 }),
		  	"varcharUnbounded": pg.varchar("varchar_unbounded"),
		  	"charValue": pg.char("char_value", { length: 2 }),
		  	"uuidValue": pg.uuid("uuid_value"),
		  	"booleanValue": pg.boolean("boolean_value"),
		  	"numericValue": pg.numeric("numeric_value"),
		  	"moneyAmount": pg.numeric("money_amount", { precision: 12, scale: 2 }),
		  	"realValue": pg.real("real_value"),
		  	"doubleValue": pg.doublePrecision("double_value"),
		  	"dateValue": pg.date("date_value", { mode: "string" }),
		  	"timeValue": pg.time("time_value"),
		  	"timetzValue": pg.time("timetz_value", { withTimezone: true }),
		  	"timestampValue": pg.timestamp("timestamp_value", { mode: "string" }),
		  	"timestamptzValue": pg.timestamp("timestamptz_value", { withTimezone: true, mode: "string" }),
		  	"intervalValue": pg.interval("interval_value"),
		  	"jsonValue": pg.json("json_value"),
		  	"jsonbValue": pg.jsonb("jsonb_value"),
		  	"byteaValue": pg.customType({ dataType: () => "bytea" })("bytea_value"),
		  	"inetValue": pg.inet("inet_value"),
		  	"cidrValue": pg.cidr("cidr_value"),
		  	"macaddrValue": pg.macaddr("macaddr_value"),
		  	"moneyValue": pg.customType({ dataType: () => "money" })("money_value"),
		  	"bitValue": pg.bit("bit_value", { dimensions: 8 }),
		  	"vectorValue": pg.vector("vector_value", { dimensions: 3 }),
		  	"halfvecValue": pg.halfvec("halfvec_value", { dimensions: 3 }),
		  	"sparsevecValue": pg.sparsevec("sparsevec_value", { dimensions: 3 }),
		  	"moodValue": mood("mood_value"),
		  	"moodHistory": mood("mood_history").array(),
		  	"integerList": pg.integer("integer_list").array(),
		  	"uuidList": pg.uuid("uuid_list").array(),
		  	"integerDefault": pg.integer("integer_default").default(sql.raw("42")).notNull(),
		  	"numericDefault": pg.numeric("numeric_default").default(sql.raw("1.50")).notNull(),
		  	"textDefault": pg.text("text_default").default(sql.raw("'it''s \\"quoted\\"'")).notNull(),
		  	"dateDefault": pg.date("date_default", { mode: "string" }).default(sql.raw("DATE '2024-01-31'")).notNull(),
		  }, (t) => [
		  ]);
		  "
		`);
		expect(awkwardNames.code).toMatchInlineSnapshot(`
		  "import * as pg from "drizzle-orm/pg-core";
		  import { relations as drizzleRelations } from "drizzle-orm";

		  export const orderStatus = pg.pgEnum("order-status", ["new","in progress","2nd try","None"]);

		  export const classTable = pg.pgTable("class", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"fromTable": pg.text("from").notNull(),
		  	"importTable": pg.text("import"),
		  	"typeTable": pg.text("type"),
		  	"field2faSecret": pg.text("2fa_secret"),
		  	"displayName": pg.text("Display Name"),
		  	"userId": pg.integer("user_id"),
		  	"userId_2": pg.integer("userId"),
		  }, (t) => [
		  ]);

		  export const orderItems = pg.pgTable("order_items", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  	"classId": pg.bigint("class_id", { mode: "number" }).notNull(),
		  	"status": orderStatus("status").notNull(),
		  }, (t) => [
		  	pg.foreignKey({ name: "order_items_class_id_fkey", columns: [t["classId"]], foreignColumns: [classTable["id"]] })
		  ]);

		  export const orderItems_2 = pg.pgTable("OrderItems", {
		  	"id": pg.bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		  }, (t) => [
		  ]);

		  export const classTableRelations = drizzleRelations(classTable, (helpers) => ({
		  		"orderItems": helpers.many(orderItems, { relationName: "r_order_items_class" }),
		  }));

		  export const orderItemsRelations = drizzleRelations(orderItems, (helpers) => ({
		  		"clas": helpers.one(classTable, { fields: [orderItems["classId"]], references: [classTable["id"]], relationName: "r_order_items_class" }),
		  }));
		  "
		`);
	});

	test("maps all registry types, options, arrays, and structured defaults", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.typeCatalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const fragment of [
			'pg.bigint("id", { mode: "number" })',
			'pg.varchar("varchar_value", { length: 40 })',
			'pg.numeric("money_amount", { precision: 12, scale: 2 })',
			'pg.timestamp("timestamptz_value", { withTimezone: true, mode: "string" })',
			'pg.customType({ dataType: () => "bytea" })',
			'pg.bit("bit_value", { dimensions: 8 })',
			'pg.vector("vector_value", { dimensions: 3 })',
			'pg.halfvec("halfvec_value", { dimensions: 3 })',
			'pg.sparsevec("sparsevec_value", { dimensions: 3 })',
			'mood("mood_history").array()',
			'pg.integer("integer_list").array()',
			'.default(sql.raw("DATE \'2024-01-31\'"))',
		]) {
			expect(generated.code).toContain(fragment);
		}
	});

	test("allocates valid, collision-free identifiers", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.awkwardNames);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const name of ["classTable", "orderItems", "orderItems_2", "orderStatus"]) {
			expect(generated.code).toContain(`const ${name}`);
		}
		for (const name of ["field2faSecret", "displayName", "userId", "userId_2"]) {
			expect(generated.code).toContain(`"${name}":`);
		}
		expect(generated.code).toContain('pg.pgTable("class"');
		expect(generated.code).toContain('pg.pgTable("OrderItems"');
	});

	test("generates both directions for one-to-many, one-to-one, self, and multiple foreign keys", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const name of [
			"r_posts_author",
			"r_posts_editor",
			"r_profiles_user",
			"r_comments_parent",
		]) {
			expect(generated.code).toContain(`relationName: "${name}"`);
		}
		expect(generated.code).toContain('"posts_2": helpers.many(posts');
		expect(generated.code).toContain('"comments": helpers.many(comments');
		expect(generated.code).toContain('pg.unique("profiles_user_id_key").on(t["userId"])');
		expect(generated.code).toContain('pg.unique("post_tags_pair_key").on');
		expect(generated.code).toContain('references((): AnyPgColumn => comments["id"]');
		expect(generated.code).toContain('raw SQL migration to preserve "comments_parent_id_fkey"');
	});

	test("preserves index names, access methods, ordering, opclasses, and documents unsupported options", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const fragment of [
			'pg.index("users_created_at_idx").using("brin"',
			'.with({"pages_per_range":32})',
			'.desc().nullsLast()',
			'.op("jsonb_path_ops")',
			"add INCLUDE (title)",
			"NULLS NOT DISTINCT",
		]) {
			expect(generated.code).toContain(fragment);
		}
	});

	test("generates enum declarations and pgvector columns and indexes", () => {
		const schema = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(schema.ok).toBe(true);
		if (schema.ok) {
			expect(schema.code).toContain('pg.pgEnum("user_role", ["member","editor","admin"])');
		}

		const vector = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.vector);
		expect(vector.ok).toBe(true);
		if (!vector.ok) return;

		for (const fragment of [
			'pg.vector("embedding", { dimensions: 1536 })',
			'pg.halfvec("summary_embedding", { dimensions: 768 })',
			'pg.sparsevec("keywords_embedding", { dimensions: 30000 })',
			'pg.bit("signature", { dimensions: 256 })',
			'.using("hnsw", t["embedding"].op("vector_cosine_ops"))',
			'.with({"m":16,"ef_construction":64})',
			'.using("ivfflat", t["summaryEmbedding"].op("halfvec_l2_ops"))',
		]) {
			expect(vector.code).toContain(fragment);
		}
	});
});
