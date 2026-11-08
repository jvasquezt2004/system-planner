import type { Design } from "../../../src/shared/design";

const column = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
	id,
	name,
	type,
	nullable: true,
	primaryKey: false,
	unique: false,
	identity: false,
	default: { kind: "none" },
	notes: "",
	...extra,
});

/** A modern Design that uses every optional part of the document. */
export const DESIGN_RICH = {
	tables: [
		{
			id: "t-users",
			name: "users",
			position: { x: 40, y: 40 },
			columns: [
				column("c-u-id", "id", "uuid", { nullable: false, primaryKey: true, default: { kind: "generateUuid" } }),
				column("c-u-email", "email", "text", { nullable: false, unique: true, notes: "Login address" }),
				column("c-u-name", "display_name", "varchar", { typeParameters: { length: 120 } }),
				column("c-u-created", "created_at", "timestamptz", { nullable: false, default: { kind: "currentTimestamp" } }),
				column("c-u-score", "score", "integer", { default: { kind: "literal", literalType: "integer", value: "0" } }),
				column("c-u-role", "role", "enum", { enumTypeId: "enum-role", default: { kind: "literal", literalType: "text", value: "member" } }),
				column("c-u-embedding", "embedding", "vector", { typeParameters: { dimensions: 3 } }),
				column("c-u-tags", "tags", "text", { typeParameters: { array: true } }),
			],
			indexes: [
				{ id: "ix-1", name: "users_email_idx", method: "btree", keys: [{ columnId: "c-u-email", order: "asc", nulls: "last" }], unique: true, includeColumnIds: ["c-u-name"] },
				{ id: "ix-2", method: "hnsw", keys: [{ columnId: "c-u-embedding", operatorClass: "vector_l2_ops" }], with: { m: 16, efConstruction: 64 } },
			],
			uniqueConstraints: [{ id: "uq-1", name: "users_email_name", columnIds: ["c-u-email", "c-u-name"], nullsNotDistinct: true }],
			rowLevelSecurity: true,
			policies: [
				{ id: "pol-1", name: "own rows", command: "SELECT", roles: ["authenticated"], mode: "permissive", using: "id = auth.uid()", withCheck: "" },
			],
		},
		{
			id: "t-orders",
			name: "orders",
			position: { x: 380, y: 40 },
			columns: [
				column("c-o-id", "id", "bigint", { nullable: false, primaryKey: true, identity: true }),
				column("c-o-user", "user_id", "uuid", { nullable: false }),
				column("c-o-total", "total", "numeric", { typeParameters: { precision: 10, scale: 2 }, default: { kind: "literal", literalType: "numeric", value: "0.00" } }),
				column("c-o-paid", "paid", "boolean", { default: { kind: "literal", literalType: "boolean", value: "false" } }),
				column("c-o-meta", "meta", "jsonb", { default: { kind: "literal", literalType: "json", value: "{}" } }),
			],
			rowLevelSecurity: false,
			policies: [],
		},
		{
			id: "t-tags",
			name: "tags",
			position: { x: 40, y: 320 },
			columns: [column("c-t-id", "id", "bigint", { nullable: false, primaryKey: true, identity: true }), column("c-t-label", "label", "text", { nullable: false })],
			rowLevelSecurity: false,
			policies: [],
		},
		{
			id: "t-order-tags",
			name: "order_tags",
			position: { x: 380, y: 320 },
			columns: [
				column("c-ot-id", "id", "bigint", { nullable: false, primaryKey: true, identity: true }),
				column("c-ot-order", "order_id", "bigint", { nullable: false }),
				column("c-ot-tag", "tag_id", "bigint", { nullable: false }),
			],
			rowLevelSecurity: false,
			policies: [],
		},
	],
	relationships: [
		{ id: "rel-1", cardinality: "one-to-many", referencingTableId: "t-orders", referencingColumnId: "c-o-user", referencedTableId: "t-users", onDelete: "CASCADE", onUpdate: "NO ACTION" },
		{ id: "rel-2", cardinality: "one-to-many", referencingTableId: "t-order-tags", referencingColumnId: "c-ot-order", referencedTableId: "t-orders" },
		{ id: "rel-3", cardinality: "one-to-one", referencingTableId: "t-order-tags", referencingColumnId: "c-ot-tag", referencedTableId: "t-tags", onDelete: "SET NULL" },
	],
	manyToManyRelationships: [
		{ id: "m2m-1", leftTableId: "t-orders", rightTableId: "t-tags", junctionTableId: "t-order-tags", leftRelationshipId: "rel-2", rightRelationshipId: "rel-3" },
	],
	viewport: { x: 12.5, y: -8, zoom: 0.8 },
	enumTypes: [{ id: "enum-role", name: "role", labels: ["admin", "member", "guest"] }],
	functions: [
		{
			id: "fn-1",
			name: "touch_updated",
			arguments: [],
			returnType: "trigger",
			returnsSet: false,
			language: "plpgsql",
			volatility: "volatile",
			security: "invoker",
			body: "BEGIN RETURN NEW; END;",
			tableDependencies: ["t-users"],
		},
	],
	triggers: [
		{ id: "tr-1", name: "users_touch", tableId: "t-users", timing: "BEFORE", events: [{ event: "INSERT" }, { event: "UPDATE", columnIds: ["c-u-email"] }], level: "ROW", functionId: "fn-1", when: "" },
	],
	rawStatements: [
		{ id: "raw-1", sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto;", phase: "before" },
		{ id: "raw-2", sql: "CREATE VIEW paid_orders AS SELECT * FROM orders WHERE paid;", phase: "after", creates: "view:paid_orders", attachedTo: "orders" },
	],
} as unknown as Design;

/**
 * A Design saved by the first versions of the app: no relationships, no
 * cardinality, no viewport, and columns without uniqueness, defaults, or notes.
 */
export const DESIGN_LEGACY = {
	tables: [
		{
			id: "t1",
			name: "customers",
			position: { x: 40, y: 40 },
			columns: [
				{ id: "c1", name: "id", type: "bigint", nullable: false, primaryKey: true, identity: true },
				{ id: "c2", name: "name", type: "text", nullable: false, primaryKey: false, identity: false },
				{ id: "c3", name: "joined", type: "timestamp", nullable: true, primaryKey: false, identity: false, default: { kind: "currentTimestamp" } },
			],
		},
	],
} as unknown as Design;

const full = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({
	id, name, type, nullable: true, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "", ...extra,
});
const pk = (id: string, name = "id", type = "bigint") => full(id, name, type, { nullable: false, primaryKey: true, identity: type !== "uuid", ...(type === "uuid" ? { default: { kind: "generateUuid" } } : {}) });

/**
 * A normalized Design that exercises every SQL branch: all index methods, vector
 * columns, enums, composite keys, a foreign-key cycle, a self reference, a real
 * many-to-many junction, policies, functions, triggers and raw statements.
 */
export const DESIGN_FEATURES = {
	tables: [
		{
			id: "t-authors", name: "authors", position: { x: 0, y: 0 },
			columns: [pk("a-id"), full("a-name", "name", "text", { nullable: false }), full("a-bio", "bio", "text"), full("a-email", "email", "varchar", { typeParameters: { length: 200 }, unique: true }), full("a-fav", "favourite_post_id", "bigint")],
			indexes: [
				{ id: "ix-a1", method: "btree", keys: [{ columnId: "a-name", order: "desc", nulls: "last" }], includeColumnIds: ["a-bio"] },
				{ id: "ix-a2", name: "authors_bio_trgm", method: "btree", keys: [{ columnId: "a-bio", operatorClass: "text_pattern_ops" }], unique: true, nullsNotDistinct: true, with: { fillfactor: 70 } },
			],
			uniqueConstraints: [{ id: "uq-a1", columnIds: ["a-name", "a-email"] }],
			rowLevelSecurity: true,
			policies: [
				{ id: "pol-a1", name: "authors are public", command: "SELECT", roles: [], mode: "permissive", using: "true", withCheck: "" },
				{ id: "pol-a2", name: "authors edit own", command: "UPDATE", roles: ["authenticated", "service_role"], mode: "restrictive", using: "id = 1", withCheck: "id = 1" },
			],
		},
		{
			id: "t-posts", name: "posts", position: { x: 320, y: 0 },
			columns: [
				pk("p-id"), full("p-author", "author_id", "bigint", { nullable: false }), full("p-title", "title", "text", { nullable: false }), full("p-embedding", "embedding", "vector", { typeParameters: { dimensions: 3 } }),
				full("p-tags", "tags", "text", { typeParameters: { array: true } }), full("p-body", "body", "jsonb"), full("p-created", "created_at", "timestamptz", { nullable: false, default: { kind: "currentTimestamp" } }),
				full("p-status", "status", "enum", { enumTypeId: "e-status", default: { kind: "literal", literalType: "text", value: "draft" } }), full("p-score", "score", "numeric", { typeParameters: { precision: 8, scale: 2 } }),
				full("p-shape", "shape", "halfvec", { typeParameters: { dimensions: 4 } }), full("p-range", "views", "integer", { default: { kind: "literal", literalType: "integer", value: "0" } }),
			],
			indexes: [
				{ id: "ix-p1", method: "hnsw", keys: [{ columnId: "p-embedding", operatorClass: "vector_l2_ops" }], with: { m: 16, efConstruction: 64 } },
				{ id: "ix-p2", method: "gin", keys: [{ columnId: "p-body" }], with: { fastupdate: false } },
				{ id: "ix-p3", method: "gin", keys: [{ columnId: "p-tags" }] },
				{ id: "ix-p4", method: "brin", keys: [{ columnId: "p-created" }], with: { pagesPerRange: 64 } },
				{ id: "ix-p5", method: "hash", keys: [{ columnId: "p-title" }] },
				{ id: "ix-p6", method: "btree", keys: [{ columnId: "p-author" }, { columnId: "p-created", order: "desc" }] },
				{ id: "ix-p7", method: "btree", keys: [{ columnId: "p-author" }] },
				{ id: "ix-p8", method: "ivfflat", keys: [{ columnId: "p-shape", operatorClass: "halfvec_cosine_ops" }], with: { lists: 100 } },
			],
			rowLevelSecurity: false, policies: [],
		},
		{
			id: "t-comments", name: "comments", position: { x: 640, y: 0 },
			columns: [pk("c-id", "id", "uuid"), full("c-post", "post_id", "bigint", { nullable: false }), full("c-parent", "parent_id", "uuid"), full("c-text", "text", "text", { nullable: false })],
			rowLevelSecurity: false, policies: [],
		},
		{
			id: "t-tags", name: "Tags", position: { x: 0, y: 320 },
			columns: [pk("t-id"), full("t-label", "Label", "text", { nullable: false, unique: true })],
			rowLevelSecurity: false, policies: [],
		},
		{
			id: "t-post-tags", name: "post_tags", position: { x: 320, y: 320 },
			columns: [pk("pt-id"), full("pt-post", "post_id", "bigint", { nullable: false }), full("pt-tag", "tag_id", "bigint", { nullable: false })],
			rowLevelSecurity: false, policies: [],
		},
		{
			id: "t-profiles", name: "profiles", position: { x: 640, y: 320 },
			columns: [full("pr-author", "author_id", "bigint", { nullable: false, primaryKey: true }), full("pr-theme", "theme", "text")],
			rowLevelSecurity: false, policies: [],
		},
	],
	relationships: [
		{ id: "r-post-author", cardinality: "one-to-many", referencingTableId: "t-posts", referencingColumnId: "p-author", referencedTableId: "t-authors", onDelete: "CASCADE", onUpdate: "RESTRICT" },
		{ id: "r-author-fav", cardinality: "one-to-many", referencingTableId: "t-authors", referencingColumnId: "a-fav", referencedTableId: "t-posts", onDelete: "SET NULL" },
		{ id: "r-comment-post", cardinality: "one-to-many", referencingTableId: "t-comments", referencingColumnId: "c-post", referencedTableId: "t-posts" },
		{ id: "r-comment-parent", cardinality: "one-to-many", referencingTableId: "t-comments", referencingColumnId: "c-parent", referencedTableId: "t-comments", onDelete: "SET NULL" },
		{ id: "r-pt-post", cardinality: "one-to-many", referencingTableId: "t-post-tags", referencingColumnId: "pt-post", referencedTableId: "t-posts" },
		{ id: "r-pt-tag", cardinality: "one-to-many", referencingTableId: "t-post-tags", referencingColumnId: "pt-tag", referencedTableId: "t-tags" },
		{ id: "r-profile-author", cardinality: "one-to-one", referencingTableId: "t-profiles", referencingColumnId: "pr-author", referencedTableId: "t-authors", onDelete: "CASCADE" },
	],
	manyToManyRelationships: [{ id: "m-posts-tags", leftTableId: "t-posts", rightTableId: "t-tags", junctionTableId: "t-post-tags", leftRelationshipId: "r-pt-post", rightRelationshipId: "r-pt-tag" }],
	viewport: { x: 0, y: 0, zoom: 1 },
	enumTypes: [{ id: "e-status", name: "post_status", labels: ["draft", "published", "archived"] }],
	functions: [
		{ id: "f-touch", name: "touch_updated", arguments: [], returnType: "trigger", returnsSet: false, language: "plpgsql", volatility: "volatile", security: "invoker", body: "BEGIN RETURN NEW; END;" },
		{ id: "f-recent", name: "recent_posts", arguments: [{ name: "n", type: "integer" }, { name: "author", type: "authors" }], returnType: "TABLE(id bigint, title text)", returnsSet: true, language: "sql", volatility: "stable", security: "definer", body: "SELECT id, title FROM posts LIMIT n -- $function$", tableDependencies: ["t-posts"] },
	],
	triggers: [{ id: "tr-touch", name: "posts_touch", tableId: "t-posts", timing: "BEFORE", events: [{ event: "INSERT" }, { event: "UPDATE", columnIds: ["p-title", "p-body"] }], level: "ROW", functionId: "f-touch", when: "NEW.title IS NOT NULL" }],
	rawStatements: [
		{ id: "raw-b", sql: "CREATE EXTENSION IF NOT EXISTS pgcrypto", phase: "before" },
		{ id: "raw-a", sql: "CREATE VIEW recent AS SELECT * FROM posts;  ", phase: "after", creates: "view:recent", attachedTo: "posts" },
	],
} as unknown as Design;
