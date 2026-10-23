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
		  "import { pgTable, bigint, text } from "drizzle-orm/pg-core";

		  export const user = pgTable("users", {
		    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
		    email: text("email").unique("users_email_key").notNull(),
		    displayName: text("display_name"),
		  });
		  "
		`);
		expect(blog.code).toMatchInlineSnapshot(`
		  "import {
		    pgTable,
		    pgEnum,
		    bigint,
		    varchar,
		    text,
		    timestamp,
		    index,
		    date,
		    uuid,
		    boolean,
		    numeric,
		    jsonb,
		    unique,
		    uniqueIndex,
		    foreignKey,
		  } from "drizzle-orm/pg-core";
		  import { relations } from "drizzle-orm";
		  import type { AnyPgColumn } from "drizzle-orm/pg-core";

		  export const userRole = pgEnum("user_role", ["member", "editor", "admin"]);

		  export const user = pgTable(
		    "users",
		    {
		      id: bigint("id", { mode: "bigint" }).primaryKey()
		        .generatedAlwaysAsIdentity(),
		      email: varchar("email", { length: 255 }).unique("users_email_key").notNull(),
		      displayName: text("display_name"),
		      role: userRole("role").default("member").notNull(),
		      createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
		        .defaultNow().notNull(),
		    },
		    (t) => [
		      index("users_created_at_idx").using("brin", t.createdAt).with(
		        { pages_per_range: 32 },
		      ),
		    ],
		  );

		  export const profile = pgTable(
		    "profiles",
		    {
		      id: bigint("id", { mode: "bigint" }).primaryKey()
		        .generatedAlwaysAsIdentity(),
		      userId: bigint("user_id", { mode: "bigint" }).notNull(),
		      bio: text("bio"),
		      birthday: date("birthday", { mode: "string" }),
		    },
		    (t) => [
		      foreignKey({
		        name: "profiles_user_id_fkey",
		        columns: [t.userId],
		        foreignColumns: [user.id],
		      }).onDelete("cascade"),
		      unique("profiles_user_id_key").on(t.userId),
		    ],
		  );

		  export const post = pgTable(
		    "posts",
		    {
		      id: uuid("id").primaryKey().defaultRandom(),
		      authorId: bigint("author_id", { mode: "bigint" }).notNull(),
		      editorId: bigint("editor_id", { mode: "bigint" }),
		      title: text("title").notNull(),
		      slug: varchar("slug", { length: 120 }).notNull(),
		      body: text("body"),
		      keywords: text("keywords").array(),
		      published: boolean("published").default(false).notNull(),
		      rating: numeric("rating", { precision: 3, scale: 1 }),
		      metadata: jsonb("metadata").default({}).notNull(),
		      createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
		        .defaultNow().notNull(),
		    },
		    (t) => [
		      foreignKey({
		        name: "posts_author_id_fkey",
		        columns: [t.authorId],
		        foreignColumns: [user.id],
		      }).onDelete("cascade"),
		      foreignKey({
		        name: "posts_editor_id_fkey",
		        columns: [t.editorId],
		        foreignColumns: [user.id],
		      }).onDelete("set null"),
		      unique("posts_author_slug_key").on(t.authorId, t.slug),
		      // PostgreSQL migration: add INCLUDE (title); Drizzle ORM does not model INCLUDE columns.
		      index("posts_author_id_created_at_idx").using(
		        "btree",
		        t.authorId,
		        t.createdAt.desc().nullsLast(),
		      ),
		      index("posts_keywords_gin").using("gin", t.keywords),
		      index("posts_metadata_idx").using("gin", t.metadata.op("jsonb_path_ops"))
		        .with({ fastupdate: false }),
		      index("posts_slug_idx").using("hash", t.slug),
		      // PostgreSQL migration: add NULLS NOT DISTINCT; Drizzle ORM does not model this index option.
		      uniqueIndex("posts_title_editor_id_idx").using("btree", t.title, t.editorId),
		    ],
		  );

		  // Raw SQL migration: preserve inline foreign-key names "comments_parent_id_fkey"; Drizzle references() does not name constraints.
		  export const comment = pgTable(
		    "comments",
		    {
		      id: bigint("id", { mode: "bigint" }).primaryKey()
		        .generatedAlwaysAsIdentity(),
		      postId: uuid("post_id").notNull(),
		      parentId: bigint("parent_id", { mode: "bigint" }).references(
		        (): AnyPgColumn => comment.id,
		        { onDelete: "set null" },
		      ),
		      body: text("body").notNull(),
		    },
		    (t) => [
		      foreignKey({
		        name: "comments_post_id_fkey",
		        columns: [t.postId],
		        foreignColumns: [post.id],
		      }).onUpdate("cascade").onDelete("cascade"),
		    ],
		  );

		  export const tag = pgTable("tags", {
		    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
		    name: varchar("name", { length: 64 }).unique("tags_name_key").notNull(),
		  });

		  export const postTag = pgTable(
		    "post_tags",
		    {
		      id: bigint("id", { mode: "bigint" }).primaryKey()
		        .generatedAlwaysAsIdentity(),
		      postId: uuid("post_id").notNull(),
		      tagId: bigint("tag_id", { mode: "bigint" }).notNull(),
		      addedAt: timestamp("added_at", { withTimezone: true, mode: "string" })
		        .defaultNow().notNull(),
		    },
		    (t) => [
		      foreignKey({
		        name: "post_tags_post_id_fkey",
		        columns: [t.postId],
		        foreignColumns: [post.id],
		      }).onDelete("cascade"),
		      foreignKey({
		        name: "post_tags_tag_id_fkey",
		        columns: [t.tagId],
		        foreignColumns: [tag.id],
		      }).onDelete("restrict"),
		      unique("post_tags_pair_key").on(t.postId, t.tagId),
		    ],
		  );

		  export const userRelations = relations(user, ({ one, many }) => ({
		    authorPosts: many(post, { relationName: "post_author" }),
		    editorPosts: many(post, { relationName: "post_editor" }),
		    profile: one(profile),
		  }));

		  export const profileRelations = relations(profile, ({ one }) => ({
		    user: one(user, { fields: [profile.userId], references: [user.id] }),
		  }));

		  export const postRelations = relations(post, ({ one, many }) => ({
		    author: one(user, {
		      fields: [post.authorId],
		      references: [user.id],
		      relationName: "post_author",
		    }),
		    editor: one(user, {
		      fields: [post.editorId],
		      references: [user.id],
		      relationName: "post_editor",
		    }),
		    comments: many(comment),
		    postTags: many(postTag),
		  }));

		  export const commentRelations = relations(comment, ({ one, many }) => ({
		    post: one(post, { fields: [comment.postId], references: [post.id] }),
		    parent: one(comment, {
		      fields: [comment.parentId],
		      references: [comment.id],
		      relationName: "comment_parent",
		    }),
		    children: many(comment, { relationName: "comment_parent" }),
		  }));

		  export const tagRelations = relations(tag, ({ many }) => ({
		    postTags: many(postTag),
		  }));

		  export const postTagRelations = relations(postTag, ({ one }) => ({
		    post: one(post, { fields: [postTag.postId], references: [post.id] }),
		    tag: one(tag, { fields: [postTag.tagId], references: [tag.id] }),
		  }));
		  "
		`);
		expect(vector.code).toMatchInlineSnapshot(`
		  "import {
		    pgTable,
		    bigint,
		    text,
		    vector,
		    halfvec,
		    sparsevec,
		    bit,
		    index,
		  } from "drizzle-orm/pg-core";

		  export const document = pgTable(
		    "documents",
		    {
		      id: bigint("id", { mode: "bigint" }).primaryKey()
		        .generatedAlwaysAsIdentity(),
		      content: text("content").notNull(),
		      embedding: vector("embedding", { dimensions: 1536 }).notNull(),
		      summaryEmbedding: halfvec("summary_embedding", { dimensions: 768 }),
		      keywordsEmbedding: sparsevec("keywords_embedding", { dimensions: 30000 }),
		      signature: bit("signature", { dimensions: 256 }),
		    },
		    (t) => [
		      index("documents_embedding_idx").using(
		        "hnsw",
		        t.embedding.op("vector_cosine_ops"),
		      ).with({ m: 16, ef_construction: 64 }),
		      index("documents_summary_ivfflat").using(
		        "ivfflat",
		        t.summaryEmbedding.op("halfvec_l2_ops"),
		      ).with({ lists: 100 }),
		      index("documents_keywords_embedding_idx").using(
		        "hnsw",
		        t.keywordsEmbedding.op("sparsevec_ip_ops"),
		      ),
		      index("documents_signature_idx").using(
		        "hnsw",
		        t.signature.op("bit_hamming_ops"),
		      ),
		    ],
		  );
		  "
		`);
		expect(typeCatalog.code).toMatchInlineSnapshot(`
		  "import {
		    pgTable,
		    pgEnum,
		    bigint,
		    integer,
		    smallint,
		    text,
		    varchar,
		    char,
		    uuid,
		    boolean,
		    numeric,
		    real,
		    doublePrecision,
		    date,
		    time,
		    timestamp,
		    interval,
		    json,
		    jsonb,
		    customType,
		    inet,
		    cidr,
		    macaddr,
		    bit,
		    vector,
		    halfvec,
		    sparsevec,
		  } from "drizzle-orm/pg-core";

		  export const mood = pgEnum("mood", ["happy", "sad", "in-between"]);

		  export const typeCatalog = pgTable("type_catalog", {
		    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
		    integerValue: integer("integer_value"),
		    smallintValue: smallint("smallint_value"),
		    textValue: text("text_value"),
		    varcharValue: varchar("varchar_value", { length: 40 }),
		    varcharUnbounded: varchar("varchar_unbounded"),
		    charValue: char("char_value", { length: 2 }),
		    uuidValue: uuid("uuid_value"),
		    booleanValue: boolean("boolean_value"),
		    numericValue: numeric("numeric_value"),
		    moneyAmount: numeric("money_amount", { precision: 12, scale: 2 }),
		    realValue: real("real_value"),
		    doubleValue: doublePrecision("double_value"),
		    dateValue: date("date_value", { mode: "string" }),
		    timeValue: time("time_value"),
		    timetzValue: time("timetz_value", { withTimezone: true }),
		    timestampValue: timestamp("timestamp_value", { mode: "string" }),
		    timestamptzValue: timestamp("timestamptz_value", {
		      withTimezone: true,
		      mode: "string",
		    }),
		    intervalValue: interval("interval_value"),
		    jsonValue: json("json_value"),
		    jsonbValue: jsonb("jsonb_value"),
		    byteaValue: customType({ dataType: () => "bytea" })("bytea_value"),
		    inetValue: inet("inet_value"),
		    cidrValue: cidr("cidr_value"),
		    macaddrValue: macaddr("macaddr_value"),
		    moneyValue: customType({ dataType: () => "money" })("money_value"),
		    bitValue: bit("bit_value", { dimensions: 8 }),
		    vectorValue: vector("vector_value", { dimensions: 3 }),
		    halfvecValue: halfvec("halfvec_value", { dimensions: 3 }),
		    sparsevecValue: sparsevec("sparsevec_value", { dimensions: 3 }),
		    moodValue: mood("mood_value"),
		    moodHistory: mood("mood_history").array(),
		    integerList: integer("integer_list").array(),
		    uuidList: uuid("uuid_list").array(),
		    integerDefault: integer("integer_default").default(42).notNull(),
		    numericDefault: numeric("numeric_default").default("1.50").notNull(),
		    textDefault: text("text_default").default('it\\'s "quoted"').notNull(),
		    dateDefault: date("date_default", { mode: "string" }).default("2024-01-31")
		      .notNull(),
		  });
		  "
		`);
		expect(awkwardNames.code).toMatchInlineSnapshot(`
		  "import {
		    pgTable,
		    pgEnum,
		    bigint,
		    text,
		    integer,
		    foreignKey,
		  } from "drizzle-orm/pg-core";
		  import { relations } from "drizzle-orm";

		  export const orderStatus = pgEnum("order-status", [
		    "new",
		    "in progress",
		    "2nd try",
		    "None",
		  ]);

		  export const classTable = pgTable("class", {
		    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
		    fromTable: text("from").notNull(),
		    importTable: text("import"),
		    typeTable: text("type"),
		    field2faSecret: text("2fa_secret"),
		    displayName: text("Display Name"),
		    userId: integer("user_id"),
		    userId_2: integer("userId"),
		  });

		  export const orderItem = pgTable(
		    "order_items",
		    {
		      id: bigint("id", { mode: "bigint" }).primaryKey()
		        .generatedAlwaysAsIdentity(),
		      classId: bigint("class_id", { mode: "bigint" }).notNull(),
		      status: orderStatus("status").notNull(),
		    },
		    (t) => [
		      foreignKey({
		        name: "order_items_class_id_fkey",
		        columns: [t.classId],
		        foreignColumns: [classTable.id],
		      }),
		    ],
		  );

		  export const orderItem_2 = pgTable("OrderItems", {
		    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
		  });

		  export const classTableRelations = relations(classTable, ({ many }) => ({
		    orderItems: many(orderItem),
		  }));

		  export const orderItemRelations = relations(orderItem, ({ one }) => ({
		    classTable: one(classTable, {
		      fields: [orderItem.classId],
		      references: [classTable.id],
		    }),
		  }));
		  "
		`);
	});

	test("maps all registry types, options, arrays, and structured defaults", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.typeCatalog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const fragment of [
			'bigint("id", { mode: "bigint" })',
			'varchar("varchar_value", { length: 40 })',
			'numeric("money_amount", { precision: 12, scale: 2 })',
			'timestamp("timestamptz_value", {',
			"withTimezone: true,",
			'mode: "string",',
			'customType({ dataType: () => "bytea" })',
			'bit("bit_value", { dimensions: 8 })',
			'vector("vector_value", { dimensions: 3 })',
			'halfvec("halfvec_value", { dimensions: 3 })',
			'sparsevec("sparsevec_value", { dimensions: 3 })',
			'mood("mood_history").array()',
			'integer("integer_list").array()',
			'.default("2024-01-31")',
			".default(42)",
			'.default("1.50")',
			".default('it\\'s",
		]) {
			expect(generated.code).toContain(fragment);
		}
	});

	test("allocates valid, collision-free identifiers", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.awkwardNames);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const name of ["classTable", "orderItem", "orderItem_2", "orderStatus"]) {
			expect(generated.code).toContain(`const ${name}`);
		}
		for (const name of ["field2faSecret", "displayName", "userId", "userId_2"]) {
			expect(generated.code).toContain(`${name}:`);
		}
		expect(generated.code).toContain('pgTable("class"');
		expect(generated.code).toContain('pgTable("OrderItems"');
	});

	test("uses shared relationship names and relationship cardinality", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const fragment of [
			'authorPosts: many(post, { relationName: "post_author" })',
			'editorPosts: many(post, { relationName: "post_editor" })',
			"profile: one(profile)",
			"author: one(user, {",
			"fields: [post.authorId],",
			"references: [user.id],",
			'relationName: "post_author",',
			"comments: many(comment)",
			"parent: one(comment, {",
			'children: many(comment, { relationName: "comment_parent" })',
			"postTags: many(postTag)",
			"post: one(post, { fields: [postTag.postId]",
			"tag: one(tag, { fields: [postTag.tagId]",
		]) {
			expect(generated.code).toContain(fragment);
		}
		expect(generated.code).not.toContain("r_posts_author");
		expect(generated.code).not.toContain("posts_2");
		expect(generated.code).not.toContain("profiles: many");
		expect(generated.code).toContain(
			'unique("profiles_user_id_key").on(t.userId)',
		);
		expect(generated.code).toContain('unique("post_tags_pair_key").on');
		expect(generated.code).toContain(
			"AnyPgColumn => comment.id",
		);
		expect(generated.code).toContain(
			"Raw SQL migration: preserve inline foreign-key names",
		);
		expect(generated.code).toContain('published: boolean("published").default(false)');
		expect(generated.code).toContain('metadata: jsonb("metadata").default({})');
		expect(generated.code).toContain("({ many })");
		expect(generated.code).toContain("({ one })");
	});

	test("assigns a shared relation name to both sides of a self-reference", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const fragment of [
			"parent: one(comment, {",
			"fields: [comment.parentId],",
			"references: [comment.id],",
			'relationName: "comment_parent",',
		]) {
			expect(generated.code).toContain(fragment);
		}
		expect(generated.code).toContain(
			'children: many(comment, { relationName: "comment_parent" })',
		);
		expect(
			[...generated.code.matchAll(/relationName: "comment_parent"/g)],
		).toHaveLength(2);
	});

	test("preserves index names, access methods, ordering, opclasses, and documents unsupported options", () => {
		const generated = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(generated.ok).toBe(true);
		if (!generated.ok) return;

		for (const fragment of [
			'index("users_created_at_idx")',
			"pages_per_range: 32",
			".desc().nullsLast()",
			'.op("jsonb_path_ops")',
			"PostgreSQL migration: add INCLUDE (title)",
			"PostgreSQL migration: add NULLS NOT DISTINCT",
		]) {
			expect(generated.code).toContain(fragment);
		}
	});

	test("generates enum declarations and pgvector columns and indexes", () => {
		const schema = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.blog);
		expect(schema.ok).toBe(true);
		if (schema.ok) {
			expect(schema.code).toContain('pgEnum("user_role", ["member", "editor", "admin"])');
		}

		const vector = generateDrizzleSchema(SCHEMA_CODE_FIXTURES.vector);
		expect(vector.ok).toBe(true);
		if (!vector.ok) return;

		for (const fragment of [
			'vector("embedding", { dimensions: 1536 })',
			'halfvec("summary_embedding", { dimensions: 768 })',
			'sparsevec("keywords_embedding", { dimensions: 30000 })',
			'bit("signature", { dimensions: 256 })',
			'index("documents_embedding_idx")',
			'"hnsw",',
			't.embedding.op("vector_cosine_ops")',
			"ef_construction: 64",
			'"ivfflat",',
			't.summaryEmbedding.op("halfvec_l2_ops")',
		]) {
			expect(vector.code).toContain(fragment);
		}
	});
	test("warns when row-level security or policies need PostgreSQL migrations", () => {
		const design = structuredClone(SCHEMA_CODE_FIXTURES.minimal);
		design.tables[0].policies = [{
			id: "policy", name: "read_rows", command: "SELECT", roles: ["anon"],
			mode: "permissive", using: "true", withCheck: "",
		}];
		const result = generateDrizzleSchema(design);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.code).toContain("// Row-level security and policies are not represented");
	});
});
