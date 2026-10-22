/**
 * Sample designs shared by the ORM generator tests. Every fixture is accepted
 * by the PostgreSQL generator and the sandbox (see src/bun/schema-code.test.ts),
 * so a generator test can rely on it being a valid design.
 */

import type { ColumnDefault } from "../column-defaults";
import type { ColumnType, ColumnTypeParameters } from "../column-types";
import type {
	Design,
	DesignColumn,
	DesignEnumType,
	DesignIndex,
	DesignManyToManyAssociation,
	DesignRelationship,
	DesignTable,
	DesignUniqueConstraint,
} from "../design";

type ColumnOptions = {
	typeParameters?: ColumnTypeParameters;
	enumTypeId?: string;
	nullable?: boolean;
	primaryKey?: boolean;
	unique?: boolean;
	identity?: boolean;
	default?: ColumnDefault;
};

function column(id: string, name: string, type: ColumnType, options: ColumnOptions = {}): DesignColumn {
	return {
		id,
		name,
		type,
		...(options.typeParameters ? { typeParameters: options.typeParameters } : {}),
		...(options.enumTypeId ? { enumTypeId: options.enumTypeId } : {}),
		nullable: options.nullable ?? false,
		primaryKey: options.primaryKey ?? false,
		unique: options.unique ?? false,
		identity: options.identity ?? false,
		default: options.default ?? { kind: "none" },
		notes: "",
	};
}

function table(
	id: string,
	name: string,
	columns: DesignColumn[],
	extra: { indexes?: DesignIndex[]; uniqueConstraints?: DesignUniqueConstraint[] } = {},
): DesignTable {
	return { id, name, position: { x: 0, y: 0 }, columns, ...extra };
}

function relationship(
	id: string,
	referencingTableId: string,
	referencingColumnId: string,
	referencedTableId: string,
	options: Partial<Pick<DesignRelationship, "cardinality" | "onDelete" | "onUpdate">> = {},
): DesignRelationship {
	return {
		id,
		cardinality: options.cardinality ?? "one-to-many",
		referencingTableId,
		referencingColumnId,
		referencedTableId,
		...(options.onDelete ? { onDelete: options.onDelete } : {}),
		...(options.onUpdate ? { onUpdate: options.onUpdate } : {}),
	};
}

function design(
	tables: DesignTable[],
	relationships: DesignRelationship[] = [],
	manyToManyRelationships: DesignManyToManyAssociation[] = [],
	enumTypes: DesignEnumType[] = [],
): Design {
	return {
		tables,
		relationships,
		manyToManyRelationships,
		viewport: { x: 0, y: 0, zoom: 1 },
		enumTypes,
	};
}

const bigintKey = (id: string) => column(id, "id", "bigint", { primaryKey: true, identity: true });

/** One table with an identity key and a few plain columns. */
export const minimalDesign: Design = design([
	table("t_users", "users", [
		bigintKey("c_users_id"),
		column("c_users_email", "email", "text", { unique: true }),
		column("c_users_name", "display_name", "text", { nullable: true }),
	]),
]);

/**
 * A blog that exercises every relationship shape: one-to-many with actions,
 * two references between the same pair of tables, one-to-one, a
 * self-reference, and a many-to-many junction with its own extra column. It
 * also carries an enum, defaults, arrays, a composite unique constraint, and
 * several index methods.
 */
export const blogDesign: Design = design(
	[
		table(
			"t_users",
			"users",
			[
				bigintKey("c_users_id"),
				column("c_users_email", "email", "varchar", {
					typeParameters: { length: 255 },
					unique: true,
				}),
				column("c_users_name", "display_name", "text", { nullable: true }),
				column("c_users_role", "role", "enum", {
					enumTypeId: "e_user_role",
					default: { kind: "literal", literalType: "text", value: "member" },
				}),
				column("c_users_created", "created_at", "timestamptz", {
					default: { kind: "currentTimestamp" },
				}),
			],
			{
				indexes: [
					{
						id: "i_users_created",
						method: "brin",
						keys: [{ columnId: "c_users_created" }],
						with: { pagesPerRange: 32 },
					},
				],
			},
		),
		table("t_profiles", "profiles", [
			bigintKey("c_profiles_id"),
			column("c_profiles_user", "user_id", "bigint"),
			column("c_profiles_bio", "bio", "text", { nullable: true }),
			column("c_profiles_birthday", "birthday", "date", { nullable: true }),
		]),
		table(
			"t_posts",
			"posts",
			[
				column("c_posts_id", "id", "uuid", {
					primaryKey: true,
					default: { kind: "generateUuid" },
				}),
				column("c_posts_author", "author_id", "bigint"),
				column("c_posts_editor", "editor_id", "bigint", { nullable: true }),
				column("c_posts_title", "title", "text"),
				column("c_posts_slug", "slug", "varchar", { typeParameters: { length: 120 } }),
				column("c_posts_body", "body", "text", { nullable: true }),
				column("c_posts_tags", "keywords", "text", {
					typeParameters: { array: true },
					nullable: true,
				}),
				column("c_posts_published", "published", "boolean", {
					default: { kind: "literal", literalType: "boolean", value: "false" },
				}),
				column("c_posts_rating", "rating", "numeric", {
					typeParameters: { precision: 3, scale: 1 },
					nullable: true,
				}),
				column("c_posts_metadata", "metadata", "jsonb", {
					default: { kind: "literal", literalType: "json", value: "{}" },
				}),
				column("c_posts_created", "created_at", "timestamptz", {
					default: { kind: "currentTimestamp" },
				}),
			],
			{
				uniqueConstraints: [
					{
						id: "u_posts_author_slug",
						name: "posts_author_slug_key",
						columnIds: ["c_posts_author", "c_posts_slug"],
					},
				],
				indexes: [
					{
						id: "i_posts_author_created",
						method: "btree",
						keys: [
							{ columnId: "c_posts_author" },
							{ columnId: "c_posts_created", order: "desc", nulls: "last" },
						],
						includeColumnIds: ["c_posts_title"],
					},
					{
						id: "i_posts_keywords",
						name: "posts_keywords_gin",
						method: "gin",
						keys: [{ columnId: "c_posts_tags" }],
					},
					{
						id: "i_posts_metadata",
						method: "gin",
						keys: [{ columnId: "c_posts_metadata", operatorClass: "jsonb_path_ops" }],
						with: { fastupdate: false },
					},
					{
						id: "i_posts_slug_hash",
						method: "hash",
						keys: [{ columnId: "c_posts_slug" }],
					},
					{
						id: "i_posts_title_unique",
						method: "btree",
						keys: [{ columnId: "c_posts_title" }, { columnId: "c_posts_editor" }],
						unique: true,
						nullsNotDistinct: true,
					},
				],
			},
		),
		table("t_comments", "comments", [
			bigintKey("c_comments_id"),
			column("c_comments_post", "post_id", "uuid"),
			column("c_comments_parent", "parent_id", "bigint", { nullable: true }),
			column("c_comments_body", "body", "text"),
		]),
		table("t_tags", "tags", [
			bigintKey("c_tags_id"),
			column("c_tags_name", "name", "varchar", { typeParameters: { length: 64 }, unique: true }),
		]),
		table("t_post_tags", "post_tags", [
			bigintKey("c_post_tags_id"),
			column("c_post_tags_post", "post_id", "uuid"),
			column("c_post_tags_tag", "tag_id", "bigint"),
			column("c_post_tags_added", "added_at", "timestamptz", {
				default: { kind: "currentTimestamp" },
			}),
		]),
	],
	[
		relationship("r_posts_author", "t_posts", "c_posts_author", "t_users", {
			onDelete: "CASCADE",
		}),
		relationship("r_posts_editor", "t_posts", "c_posts_editor", "t_users", {
			onDelete: "SET NULL",
		}),
		relationship("r_profiles_user", "t_profiles", "c_profiles_user", "t_users", {
			cardinality: "one-to-one",
			onDelete: "CASCADE",
		}),
		relationship("r_comments_post", "t_comments", "c_comments_post", "t_posts", {
			onDelete: "CASCADE",
			onUpdate: "CASCADE",
		}),
		relationship("r_comments_parent", "t_comments", "c_comments_parent", "t_comments", {
			onDelete: "SET NULL",
		}),
		relationship("r_post_tags_post", "t_post_tags", "c_post_tags_post", "t_posts", {
			onDelete: "CASCADE",
		}),
		relationship("r_post_tags_tag", "t_post_tags", "c_post_tags_tag", "t_tags", {
			onDelete: "RESTRICT",
		}),
	],
	[
		{
			id: "m_posts_tags",
			leftTableId: "t_posts",
			rightTableId: "t_tags",
			junctionTableId: "t_post_tags",
			leftRelationshipId: "r_post_tags_post",
			rightRelationshipId: "r_post_tags_tag",
		},
	],
	[{ id: "e_user_role", name: "user_role", labels: ["member", "editor", "admin"] }],
);

/** pgvector columns of every vector type with HNSW and IVFFlat indexes. */
export const vectorDesign: Design = design([
	table(
		"t_documents",
		"documents",
		[
			bigintKey("c_documents_id"),
			column("c_documents_content", "content", "text"),
			column("c_documents_embedding", "embedding", "vector", {
				typeParameters: { dimensions: 1536 },
			}),
			column("c_documents_summary", "summary_embedding", "halfvec", {
				typeParameters: { dimensions: 768 },
				nullable: true,
			}),
			column("c_documents_sparse", "keywords_embedding", "sparsevec", {
				typeParameters: { dimensions: 30000 },
				nullable: true,
			}),
			column("c_documents_signature", "signature", "bit", {
				typeParameters: { length: 256 },
				nullable: true,
			}),
		],
		{
			indexes: [
				{
					id: "i_documents_embedding",
					method: "hnsw",
					keys: [{ columnId: "c_documents_embedding", operatorClass: "vector_cosine_ops" }],
					with: { m: 16, efConstruction: 64 },
				},
				{
					id: "i_documents_summary",
					name: "documents_summary_ivfflat",
					method: "ivfflat",
					keys: [{ columnId: "c_documents_summary", operatorClass: "halfvec_l2_ops" }],
					with: { lists: 100 },
				},
				{
					id: "i_documents_sparse",
					method: "hnsw",
					keys: [{ columnId: "c_documents_sparse", operatorClass: "sparsevec_ip_ops" }],
				},
				{
					id: "i_documents_signature",
					method: "hnsw",
					keys: [{ columnId: "c_documents_signature", operatorClass: "bit_hamming_ops" }],
				},
			],
		},
	),
]);

/** One column of every supported type, so type mapping can be checked in one place. */
export const typeCatalogDesign: Design = design(
	[
		table("t_type_catalog", "type_catalog", [
			bigintKey("c_tc_id"),
			column("c_tc_integer", "integer_value", "integer", { nullable: true }),
			column("c_tc_smallint", "smallint_value", "smallint", { nullable: true }),
			column("c_tc_text", "text_value", "text", { nullable: true }),
			column("c_tc_varchar", "varchar_value", "varchar", {
				typeParameters: { length: 40 },
				nullable: true,
			}),
			column("c_tc_varchar_free", "varchar_unbounded", "varchar", { nullable: true }),
			column("c_tc_char", "char_value", "char", { typeParameters: { length: 2 }, nullable: true }),
			column("c_tc_uuid", "uuid_value", "uuid", { nullable: true }),
			column("c_tc_boolean", "boolean_value", "boolean", { nullable: true }),
			column("c_tc_numeric", "numeric_value", "numeric", { nullable: true }),
			column("c_tc_numeric_ps", "money_amount", "numeric", {
				typeParameters: { precision: 12, scale: 2 },
				nullable: true,
			}),
			column("c_tc_real", "real_value", "real", { nullable: true }),
			column("c_tc_double", "double_value", "double precision", { nullable: true }),
			column("c_tc_date", "date_value", "date", { nullable: true }),
			column("c_tc_time", "time_value", "time", { nullable: true }),
			column("c_tc_timetz", "timetz_value", "timetz", { nullable: true }),
			column("c_tc_timestamp", "timestamp_value", "timestamp", { nullable: true }),
			column("c_tc_timestamptz", "timestamptz_value", "timestamptz", { nullable: true }),
			column("c_tc_interval", "interval_value", "interval", { nullable: true }),
			column("c_tc_json", "json_value", "json", { nullable: true }),
			column("c_tc_jsonb", "jsonb_value", "jsonb", { nullable: true }),
			column("c_tc_bytea", "bytea_value", "bytea", { nullable: true }),
			column("c_tc_inet", "inet_value", "inet", { nullable: true }),
			column("c_tc_cidr", "cidr_value", "cidr", { nullable: true }),
			column("c_tc_macaddr", "macaddr_value", "macaddr", { nullable: true }),
			column("c_tc_money", "money_value", "money", { nullable: true }),
			column("c_tc_bit", "bit_value", "bit", { typeParameters: { length: 8 }, nullable: true }),
			column("c_tc_vector", "vector_value", "vector", {
				typeParameters: { dimensions: 3 },
				nullable: true,
			}),
			column("c_tc_halfvec", "halfvec_value", "halfvec", {
				typeParameters: { dimensions: 3 },
				nullable: true,
			}),
			column("c_tc_sparsevec", "sparsevec_value", "sparsevec", {
				typeParameters: { dimensions: 3 },
				nullable: true,
			}),
			column("c_tc_enum", "mood_value", "enum", { enumTypeId: "e_mood", nullable: true }),
			column("c_tc_enum_array", "mood_history", "enum", {
				enumTypeId: "e_mood",
				typeParameters: { array: true },
				nullable: true,
			}),
			column("c_tc_int_array", "integer_list", "integer", {
				typeParameters: { array: true },
				nullable: true,
			}),
			column("c_tc_uuid_array", "uuid_list", "uuid", {
				typeParameters: { array: true },
				nullable: true,
			}),
			column("c_tc_integer_default", "integer_default", "integer", {
				default: { kind: "literal", literalType: "integer", value: "42" },
			}),
			column("c_tc_numeric_default", "numeric_default", "numeric", {
				default: { kind: "literal", literalType: "numeric", value: "1.50" },
			}),
			column("c_tc_text_default", "text_default", "text", {
				default: { kind: "literal", literalType: "text", value: "it's \"quoted\"" },
			}),
			column("c_tc_date_default", "date_default", "date", {
				default: { kind: "literal", literalType: "date", value: "2024-01-31" },
			}),
		]),
	],
	[],
	[],
	[{ id: "e_mood", name: "mood", labels: ["happy", "sad", "in-between"] }],
);

/**
 * Names that are awkward in code: reserved words in TypeScript and Python,
 * leading digits, spaces, mixed case, and names that collide once converted
 * to PascalCase or camelCase.
 */
export const awkwardNamesDesign: Design = design(
	[
		table("t_class", "class", [
			bigintKey("c_class_id"),
			column("c_class_from", "from", "text"),
			column("c_class_import", "import", "text", { nullable: true }),
			column("c_class_type", "type", "text", { nullable: true }),
			column("c_class_digits", "2fa_secret", "text", { nullable: true }),
			column("c_class_spaces", "Display Name", "text", { nullable: true }),
			column("c_class_snake", "user_id", "integer", { nullable: true }),
			column("c_class_camel", "userId", "integer", { nullable: true }),
		]),
		table("t_order_items", "order_items", [
			bigintKey("c_order_items_id"),
			column("c_order_items_class", "class_id", "bigint"),
			column("c_order_items_status", "status", "enum", { enumTypeId: "e_status" }),
		]),
		table("t_order_items_camel", "OrderItems", [bigintKey("c_order_items_camel_id")]),
	],
	[relationship("r_order_items_class", "t_order_items", "c_order_items_class", "t_class")],
	[],
	[{ id: "e_status", name: "order-status", labels: ["new", "in progress", "2nd try", "None"] }],
);

/** Every fixture by name, for tests that iterate over all of them. */
export const SCHEMA_CODE_FIXTURES = {
	minimal: minimalDesign,
	blog: blogDesign,
	vector: vectorDesign,
	typeCatalog: typeCatalogDesign,
	awkwardNames: awkwardNamesDesign,
} as const satisfies Record<string, Design>;
