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
			arguments: [{ name: "target", type: "text" }],
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
