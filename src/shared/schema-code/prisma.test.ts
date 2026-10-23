import { describe, expect, test } from "bun:test";
import {
	SCHEMA_CODE_FIXTURES,
	awkwardNamesDesign,
	blogDesign,
	typeCatalogDesign,
	vectorDesign,
} from "./fixtures";
import { generatePrismaSchema } from "./prisma";

describe("generatePrismaSchema", () => {
	test("matches complete output for every shared fixture", () => {
		const schemas = Object.fromEntries(
			Object.entries(SCHEMA_CODE_FIXTURES).map(([name, design]) => {
				const result = generatePrismaSchema(design);
				expect(result.ok).toBe(true);
				return [name, result.ok ? result.code : result.errors];
			}),
		);

		expect(schemas).toMatchInlineSnapshot(`
		  {
		    "awkwardNames": 
		  "// Generated schema for Prisma ORM 7.10.1. Connection URL belongs in prisma.config.ts.
		  generator client {
		    provider = "prisma-client"
		    output   = "../generated/prisma"
		  }

		  datasource db {
		    provider = "postgresql"
		  }

		  enum OrderStatus {
		    New             @map("new")
		    InProgress      @map("in progress")
		    Generated2ndTry @map("2nd try")
		    None

		    @@map("order-status")
		  }

		  model Class {
		    id                 BigInt      @id @default(autoincrement())
		    from               String
		    import             String?
		    type_2             String?     @map("type")
		    Generated2faSecret String?     @map("2fa_secret")
		    displayName        String?     @map("Display Name")
		    userId             Int?        @map("user_id")
		    userId_2           Int?        @map("userId")
		    orderItems         OrderItem[] @relation("OrderItemClass")

		    @@map("class")
		  }

		  model OrderItem {
		    id      BigInt      @id @default(autoincrement())
		    classId BigInt      @map("class_id")
		    status  OrderStatus
		    class   Class       @relation("OrderItemClass", fields: [classId], references: [id], onDelete: NoAction, onUpdate: NoAction, map: "order_items_class_id_fkey")

		    @@map("order_items")
		  }

		  model OrderItem_2 {
		    id BigInt @id @default(autoincrement())

		    @@map("OrderItems")
		  }

		  // PostgreSQL migration notes
		  // Prisma autoincrement() cannot distinguish GENERATED ALWAYS identity; SQL uses GENERATED ALWAYS.
		  "
		  ,
		    "blog": 
		  "// Generated schema for Prisma ORM 7.10.1. Connection URL belongs in prisma.config.ts.
		  generator client {
		    provider = "prisma-client"
		    output   = "../generated/prisma"
		  }

		  datasource db {
		    provider = "postgresql"
		  }

		  enum UserRole {
		    Member @map("member")
		    Editor @map("editor")
		    Admin  @map("admin")

		    @@map("user_role")
		  }

		  model User {
		    id          BigInt   @id @default(autoincrement())
		    email       String   @unique(map: "users_email_key") @db.VarChar(255)
		    displayName String?  @map("display_name")
		    role        UserRole @default(Member)
		    createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
		    authorPosts Post[]   @relation("PostAuthor")
		    editorPosts Post[]   @relation("PostEditor")
		    profile     Profile? @relation("ProfileUser")

		    @@index([createdAt], type: Brin, map: "users_created_at_idx")
		    // WITH (pages_per_range = 32) needs a raw SQL migration.
		    @@map("users")
		  }

		  model Profile {
		    id       BigInt    @id @default(autoincrement())
		    userId   BigInt    @unique(map: "profiles_user_id_key") @map("user_id")
		    bio      String?
		    birthday DateTime? @db.Date
		    user     User      @relation("ProfileUser", fields: [userId], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "profiles_user_id_fkey")

		    @@map("profiles")
		  }

		  model Post {
		    id        String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
		    authorId  BigInt    @map("author_id")
		    editorId  BigInt?   @map("editor_id")
		    title     String
		    slug      String    @db.VarChar(120)
		    body      String?
		    keywords  String[]
		    published Boolean   @default(false)
		    rating    Decimal?  @db.Decimal(3, 1)
		    metadata  Json      @default("{}")
		    createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
		    author    User      @relation("PostAuthor", fields: [authorId], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "posts_author_id_fkey")
		    editor    User?     @relation("PostEditor", fields: [editorId], references: [id], onDelete: SetNull, onUpdate: NoAction, map: "posts_editor_id_fkey")
		    comments  Comment[] @relation("CommentPost")
		    postTags  PostTag[] @relation("PostTagPost")

		    @@unique([authorId, slug], map: "posts_author_slug_key")
		    @@unique([title, editorId], map: "posts_title_editor_id_idx")
		    @@index([authorId, createdAt(sort: Desc, nulls: Last)], type: BTree, map: "posts_author_id_created_at_idx")
		    // INCLUDE ("title") needs a raw SQL migration.
		    @@index([keywords], type: Gin, map: "posts_keywords_gin")
		    @@index([metadata(ops: JsonbPathOps)], type: Gin, map: "posts_metadata_idx")
		    // WITH (fastupdate = false) needs a raw SQL migration.
		    @@index([slug], type: Hash, map: "posts_slug_idx")
		    // NULLS NOT DISTINCT needs a raw SQL migration.
		    @@map("posts")
		  }

		  model Comment {
		    id       BigInt    @id @default(autoincrement())
		    postId   String    @map("post_id") @db.Uuid
		    parentId BigInt?   @map("parent_id")
		    body     String
		    post     Post      @relation("CommentPost", fields: [postId], references: [id], onDelete: Cascade, onUpdate: Cascade, map: "comments_post_id_fkey")
		    parent   Comment?  @relation("CommentParent", fields: [parentId], references: [id], onDelete: SetNull, onUpdate: NoAction, map: "comments_parent_id_fkey")
		    children Comment[] @relation("CommentParent")

		    @@map("comments")
		  }

		  model Tag {
		    id       BigInt    @id @default(autoincrement())
		    name     String    @unique(map: "tags_name_key") @db.VarChar(64)
		    postTags PostTag[] @relation("PostTagTag")

		    @@map("tags")
		  }

		  model PostTag {
		    id      BigInt   @id @default(autoincrement())
		    postId  String   @map("post_id") @db.Uuid
		    tagId   BigInt   @map("tag_id")
		    addedAt DateTime @default(now()) @map("added_at") @db.Timestamptz(6)
		    post    Post     @relation("PostTagPost", fields: [postId], references: [id], onDelete: Cascade, onUpdate: NoAction, map: "post_tags_post_id_fkey")
		    tag     Tag      @relation("PostTagTag", fields: [tagId], references: [id], onDelete: Restrict, onUpdate: NoAction, map: "post_tags_tag_id_fkey")

		    @@unique([postId, tagId], map: "post_tags_pair_key")
		    @@map("post_tags")
		  }

		  // PostgreSQL migration notes
		  // Prisma autoincrement() cannot distinguish GENERATED ALWAYS identity; SQL uses GENERATED ALWAYS.
		  // Prisma cannot model nullable lists; PostgreSQL nullable arrays: Post.keywords.
		  // CREATE INDEX "users_created_at_idx" ON "users" USING brin ("created_at") WITH (pages_per_range = 32);
		  // CREATE INDEX "posts_author_id_created_at_idx" ON "posts" USING btree ("author_id", "created_at" DESC NULLS LAST) INCLUDE ("title");
		  // CREATE INDEX "posts_metadata_idx" ON "posts" USING gin ("metadata" jsonb_path_ops) WITH (fastupdate = false);
		  // CREATE UNIQUE INDEX "posts_title_editor_id_idx" ON "posts" USING btree ("title", "editor_id") NULLS NOT DISTINCT;
		  "
		  ,
		    "minimal": 
		  "// Generated schema for Prisma ORM 7.10.1. Connection URL belongs in prisma.config.ts.
		  generator client {
		    provider = "prisma-client"
		    output   = "../generated/prisma"
		  }

		  datasource db {
		    provider = "postgresql"
		  }

		  model User {
		    id          BigInt  @id @default(autoincrement())
		    email       String  @unique(map: "users_email_key")
		    displayName String? @map("display_name")

		    @@map("users")
		  }

		  // PostgreSQL migration notes
		  // Prisma autoincrement() cannot distinguish GENERATED ALWAYS identity; SQL uses GENERATED ALWAYS.
		  "
		  ,
		    "typeCatalog": 
		  "// Generated schema for Prisma ORM 7.10.1. Connection URL belongs in prisma.config.ts.
		  generator client {
		    provider        = "prisma-client"
		    output          = "../generated/prisma"
		    previewFeatures = ["postgresqlExtensions"]
		  }

		  datasource db {
		    provider   = "postgresql"
		    extensions = [vector]
		  }

		  enum Mood {
		    Happy     @map("happy")
		    Sad       @map("sad")
		    InBetween @map("in-between")

		    @@map("mood")
		  }

		  model TypeCatalog {
		    id               BigInt                       @id @default(autoincrement())
		    integerValue     Int?                         @map("integer_value")
		    smallintValue    Int?                         @map("smallint_value") @db.SmallInt
		    textValue        String?                      @map("text_value")
		    varcharValue     String?                      @map("varchar_value") @db.VarChar(40)
		    varcharUnbounded String?                      @map("varchar_unbounded")
		    charValue        String?                      @map("char_value") @db.Char(2)
		    uuidValue        String?                      @map("uuid_value") @db.Uuid
		    booleanValue     Boolean?                     @map("boolean_value")
		    numericValue     Decimal?                     @map("numeric_value") @db.Decimal
		    moneyAmount      Decimal?                     @map("money_amount") @db.Decimal(12, 2)
		    realValue        Float?                       @map("real_value") @db.Real
		    doubleValue      Float?                       @map("double_value")
		    dateValue        DateTime?                    @map("date_value") @db.Date
		    timeValue        DateTime?                    @map("time_value") @db.Time(6)
		    timetzValue      DateTime?                    @map("timetz_value") @db.Timetz(6)
		    timestampValue   DateTime?                    @map("timestamp_value") @db.Timestamp(6)
		    timestamptzValue DateTime?                    @map("timestamptz_value") @db.Timestamptz(6)
		    intervalValue    Unsupported("interval")?     @map("interval_value")
		    jsonValue        Json?                        @map("json_value") @db.Json
		    jsonbValue       Json?                        @map("jsonb_value")
		    byteaValue       Bytes?                       @map("bytea_value")
		    inetValue        String?                      @map("inet_value") @db.Inet
		    cidrValue        Unsupported("cidr")?         @map("cidr_value")
		    macaddrValue     Unsupported("macaddr")?      @map("macaddr_value")
		    moneyValue       Decimal?                     @map("money_value") @db.Money
		    bitValue         String?                      @map("bit_value") @db.Bit(8)
		    vectorValue      Unsupported("vector(3)")?    @map("vector_value")
		    halfvecValue     Unsupported("halfvec(3)")?   @map("halfvec_value")
		    sparsevecValue   Unsupported("sparsevec(3)")? @map("sparsevec_value")
		    moodValue        Mood?                        @map("mood_value")
		    moodHistory      Mood[]                       @map("mood_history")
		    integerList      Int[]                        @map("integer_list")
		    uuidList         String[]                     @map("uuid_list") @db.Uuid
		    integerDefault   Int                          @default(42) @map("integer_default")
		    numericDefault   Decimal                      @default(1.50) @map("numeric_default") @db.Decimal
		    textDefault      String                       @default("it's \\"quoted\\"") @map("text_default")
		    dateDefault      DateTime                     @default(dbgenerated("'2024-01-31'::date")) @map("date_default") @db.Date

		    @@map("type_catalog")
		  }

		  // PostgreSQL migration notes
		  // Prisma autoincrement() cannot distinguish GENERATED ALWAYS identity; SQL uses GENERATED ALWAYS.
		  // Prisma cannot model nullable lists; PostgreSQL nullable arrays: TypeCatalog.moodHistory, TypeCatalog.integerList, TypeCatalog.uuidList.
		  "
		  ,
		    "vector": 
		  "// Generated schema for Prisma ORM 7.10.1. Connection URL belongs in prisma.config.ts.
		  generator client {
		    provider        = "prisma-client"
		    output          = "../generated/prisma"
		    previewFeatures = ["postgresqlExtensions"]
		  }

		  datasource db {
		    provider   = "postgresql"
		    extensions = [vector]
		  }

		  model Document {
		    id                BigInt                           @id @default(autoincrement())
		    content           String
		    embedding         Unsupported("vector(1536)")
		    summaryEmbedding  Unsupported("halfvec(768)")?     @map("summary_embedding")
		    keywordsEmbedding Unsupported("sparsevec(30000)")? @map("keywords_embedding")
		    signature         String?                          @db.Bit(256)

		    @@map("documents")
		  }

		  // PostgreSQL migration notes
		  // Prisma autoincrement() cannot distinguish GENERATED ALWAYS identity; SQL uses GENERATED ALWAYS.
		  // CREATE INDEX "documents_embedding_idx" ON "documents" USING hnsw ("embedding" vector_cosine_ops) WITH (m = 16, ef_construction = 64);
		  // CREATE INDEX "documents_summary_ivfflat" ON "documents" USING ivfflat ("summary_embedding" halfvec_l2_ops) WITH (lists = 100);
		  // CREATE INDEX "documents_keywords_embedding_idx" ON "documents" USING hnsw ("keywords_embedding" sparsevec_ip_ops);
		  // CREATE INDEX "documents_signature_idx" ON "documents" USING hnsw ("signature" bit_hamming_ops);
		  "
		  ,
		  }
		  `);
	});

	test("preserves converted names without collisions", () => {
		const result = generatePrismaSchema(awkwardNamesDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.code).toMatch(/displayName\s+String\?\s+@map\("Display Name"\)/);
		expect(result.code).toMatch(/userId_2\s+Int\?\s+@map\("userId"\)/);
		expect(result.code).toContain("model OrderItem_2 {");
		expect(result.code).toContain('InProgress      @map("in progress")');
	});

	test("uses singular shared model names and maps tables unchanged", () => {
		const result = generatePrismaSchema(blogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		for (const model of ["User", "Profile", "Post", "Comment", "Tag", "PostTag"]) {
			expect(result.code).toContain(`model ${model} {`);
		}
		expect(result.code).toContain('@@map("users")');
		expect(result.code).toContain('@@map("post_tags")');
		expect(result.code).not.toContain("model Users {");
	});

	test("uses shared forward/backward relationship names and stable relation labels", () => {
		const result = generatePrismaSchema(blogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.code).toMatch(/author\s+User\s+@relation\("PostAuthor", fields:/);
		expect(result.code).toMatch(/editor\s+User\?\s+@relation\("PostEditor", fields:/);
		expect(result.code).toMatch(/authorPosts\s+Post\[\]\s+@relation\("PostAuthor"\)/);
		expect(result.code).toMatch(/editorPosts\s+Post\[\]\s+@relation\("PostEditor"\)/);
		expect(result.code).toMatch(/profile\s+Profile\?\s+@relation\("ProfileUser"\)/);
		expect(result.code).toMatch(/user\s+User\s+@relation\("ProfileUser", fields:/);
		expect(result.code).toMatch(/parent\s+Comment\?\s+@relation\("CommentParent", fields:/);
		expect(result.code).toMatch(/children\s+Comment\[\]\s+@relation\("CommentParent"\)/);
		expect(result.code).toMatch(/postTags\s+PostTag\[\]\s+@relation\("PostTagPost"\)/);
		expect(result.code).toMatch(/post\s+Post\s+@relation\("CommentPost", fields:/);
		expect(result.code).toMatch(/comments\s+Comment\[\]\s+@relation\("CommentPost"\)/);
		expect(result.code).toMatch(/post\s+Post\s+@relation\("PostTagPost", fields:/);
		expect(result.code).toMatch(/postTags\s+PostTag\[\]\s+@relation\("PostTagTag"\)/);
		expect(result.code).toMatch(/tag\s+Tag\s+@relation\("PostTagTag", fields:/);
		expect(result.code).toContain('@@unique([postId, tagId], map: "post_tags_pair_key")');
		expect(result.code).not.toMatch(/\btags\s+Tag\[\]/);
		expect(result.code).not.toMatch(/\bposts\s+Post\[\]/);
	});

	test("retains native types, typed defaults, and mapped enum labels", () => {
		const result = generatePrismaSchema(typeCatalogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.code).toContain("@db.VarChar(40)");
		expect(result.code).toContain("@db.Decimal(12, 2)");
		expect(result.code).toContain("@db.Bit(8)");
		expect(result.code).not.toContain("@db.Text");
		expect(result.code).not.toContain("@db.Boolean");
		expect(result.code).not.toContain("@db.BigInt");
		expect(result.code).toContain('@default(dbgenerated("\'2024-01-31\'::date"))');
		expect(result.code).toContain('InBetween @map("in-between")');
	});

	test("keeps per-index notes short and groups required SQL in the footer", () => {
		const result = generatePrismaSchema(blogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.code.match(/\/\/ PostgreSQL migration notes/g)).toHaveLength(1);
		expect(result.code).toContain("// NULLS NOT DISTINCT needs a raw SQL migration.");
		expect(result.code).toContain(
			'// CREATE UNIQUE INDEX "posts_title_editor_id_idx" ON "posts" USING btree ("title", "editor_id") NULLS NOT DISTINCT;',
		);
	});
	test("warns when row-level security or policies need PostgreSQL migrations", () => {
		const design = structuredClone(blogDesign);
		(design.tables[0] as typeof design.tables[number] & { rowLevelSecurity?: boolean }).rowLevelSecurity = true;
		const result = generatePrismaSchema(design);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.code).toContain("// Row-level security and policies are not represented");
	});
	test("renders defaults for PostgreSQL types Prisma exposes as Unsupported", () => {
		const design = structuredClone(typeCatalogDesign);
		const columns = design.tables[0]!.columns;
		for (const [id, value] of [
			["c_tc_interval", "5 days"],
			["c_tc_cidr", "192.168.0.0/24"],
			["c_tc_macaddr", "08:00:2b:01:02:03"],
		]) {
			const column = columns.find((item) => item.id === id)!;
			column.default = { kind: "literal", literalType: "text", value };
		}

		const result = generatePrismaSchema(design);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.code).toContain('@default(dbgenerated("\'5 days\'::interval"))');
		expect(result.code).toContain('@default(dbgenerated("\'192.168.0.0/24\'::cidr"))');
		expect(result.code).toContain('@default(dbgenerated("\'08:00:2b:01:02:03\'::macaddr"))');
	});


	test("declares pgvector and includes exact migration statements for its indexes", () => {
		const result = generatePrismaSchema(vectorDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.code).toContain("extensions = [vector]");
		expect(result.code).toContain('Unsupported("vector(1536)")');
		expect(result.code).toContain('CREATE INDEX "documents_embedding_idx"');
		expect(result.code).toContain('USING hnsw ("embedding" vector_cosine_ops)');
		expect(result.code).toContain("WITH (m = 16, ef_construction = 64)");
		expect(result.code).toEndWith("\n");
	});
});
