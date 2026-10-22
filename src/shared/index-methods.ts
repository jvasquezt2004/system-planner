/** Shared PostgreSQL index access-method and operator-class capabilities. */

import type { ColumnType } from "./column-types";
import type { DesignIndex, IndexAccessMethod } from "./design";

/** Operator-class choices accepted for one indexed column type. */
export type IndexOperatorClassOption = {
	name: string;
	/** Whether PostgreSQL selects this class when the design omits one. */
	default: boolean;
};

/** Features and per-type operator classes exposed by an access method. */
export type IndexMethodDefinition = {
	method: IndexAccessMethod;
	label: string;
	unique: boolean;
	include: boolean;
	ordering: boolean;
	storageOptions: readonly string[];
	defaultTypes: readonly ColumnType[];
	arrayDefault: boolean;
	arrayTypes?: readonly ColumnType[];
	operatorClasses: Readonly<Partial<Record<ColumnType, readonly IndexOperatorClassOption[]>>>;
};

const options = (...names: string[]): IndexOperatorClassOption[] =>
	names.map((name) => ({ name, default: false }));

const COMPARABLE_TYPES: readonly ColumnType[] = [
	"bigint",
	"integer",
	"smallint",
	"text",
	"varchar",
	"char",
	"uuid",
	"boolean",
	"numeric",
	"real",
	"double precision",
	"date",
	"time",
	"timetz",
	"timestamp",
	"timestamptz",
	"interval",
	"bytea",
	"inet",
	"cidr",
	"macaddr",
	"money",
	"jsonb",
	"bit",
	"enum",
];

/**
 * PostgreSQL access-method rules used by SQL validation, editor choices, and
 * downstream model consumers. This lists only types represented in the design.
 */
export const INDEX_METHOD_DEFINITIONS: readonly IndexMethodDefinition[] = [
	{
		method: "btree",
		label: "B-tree",
		unique: true,
		include: true,
		ordering: true,
		storageOptions: ["fillfactor"],
		defaultTypes: COMPARABLE_TYPES,
		arrayDefault: true,
		arrayTypes: COMPARABLE_TYPES,
		operatorClasses: {
			text: [{ name: "text_ops", default: true }, ...options("text_pattern_ops")],
			varchar: [{ name: "varchar_ops", default: true }, ...options("varchar_pattern_ops")],
			char: [
				{ name: "bpchar_ops", default: true },
				...options("bpchar_pattern_ops"),
			],
		},
	},
	{
		method: "hash",
		label: "Hash",
		unique: false,
		include: false,
		ordering: false,
		storageOptions: ["fillfactor"],
		defaultTypes: [
			"bigint", "integer", "smallint", "text", "varchar", "char", "uuid",
			"boolean", "numeric", "real", "double precision", "date", "time",
			"timetz", "timestamp", "timestamptz", "interval", "bytea", "inet",
			"cidr", "macaddr", "money", "jsonb", "bit", "enum",
		],
		arrayDefault: true,
		arrayTypes: COMPARABLE_TYPES,
		operatorClasses: {},
	},
	{
		method: "gin",
		label: "GIN",
		unique: false,
		include: false,
		ordering: false,
		storageOptions: ["fastupdate"],
		defaultTypes: ["jsonb"],
		arrayDefault: true,
		arrayTypes: COMPARABLE_TYPES,
		operatorClasses: {
			jsonb: [
				{ name: "jsonb_ops", default: true },
				{ name: "jsonb_path_ops", default: false },
			],
		},
	},
	{
		method: "gist",
		label: "GiST",
		unique: false,
		include: true,
		ordering: false,
		storageOptions: ["fillfactor"],
		defaultTypes: [],
		arrayDefault: false,
		operatorClasses: { inet: options("inet_ops"), cidr: options("inet_ops") },
	},
	{
		method: "spgist",
		label: "SP-GiST",
		unique: false,
		include: true,
		ordering: false,
		storageOptions: ["fillfactor"],
		defaultTypes: [],
		arrayDefault: false,
		operatorClasses: { inet: options("inet_ops"), cidr: options("inet_ops") },
	},
	{
		method: "brin",
		label: "BRIN",
		unique: false,
		include: false,
		ordering: false,
		storageOptions: ["pagesPerRange"],
		defaultTypes: [
			"bigint", "integer", "smallint", "text", "varchar", "char", "uuid",
			"boolean", "numeric", "real", "double precision", "date", "time",
			"timetz", "timestamp", "timestamptz", "interval", "bytea", "inet",
			"cidr", "macaddr", "money", "bit", "enum",
		],
		arrayDefault: false,
		operatorClasses: {},
	},
	{
		method: "hnsw",
		label: "HNSW",
		unique: false,
		include: false,
		ordering: false,
		storageOptions: ["m", "efConstruction"],
		defaultTypes: [],
		arrayDefault: false,
		operatorClasses: {
			vector: options("vector_l2_ops", "vector_ip_ops", "vector_cosine_ops", "vector_l1_ops"),
			halfvec: options("halfvec_l2_ops", "halfvec_ip_ops", "halfvec_cosine_ops", "halfvec_l1_ops"),
			sparsevec: options("sparsevec_l2_ops", "sparsevec_ip_ops", "sparsevec_cosine_ops", "sparsevec_l1_ops"),
			bit: options("bit_hamming_ops", "bit_jaccard_ops"),
		},
	},
	{
		method: "ivfflat",
		label: "IVFFlat",
		unique: false,
		include: false,
		ordering: false,
		storageOptions: ["lists"],
		defaultTypes: [],
		arrayDefault: false,
		operatorClasses: {
			vector: options("vector_l2_ops", "vector_ip_ops", "vector_cosine_ops"),
			halfvec: options("halfvec_l2_ops", "halfvec_ip_ops", "halfvec_cosine_ops"),
			bit: options("bit_hamming_ops"),
		},
	},
];

/** Finds the shared capability record for an access method. */
export function findIndexMethod(method: unknown): IndexMethodDefinition | null {
	return INDEX_METHOD_DEFINITIONS.find((entry) => entry.method === method) ?? null;
}

/** Returns operator classes valid for the selected access method and column. */
export function indexOperatorClasses(
	method: IndexAccessMethod,
	type: ColumnType,
	array = false,
): readonly IndexOperatorClassOption[] {
	const definition = findIndexMethod(method);
	if (!definition) return [];
	if (array) {
		if (definition.arrayDefault && definition.arrayTypes?.includes(type)) {
			return [{ name: "array_ops", default: true }];
		}
		return [];
	}
	const choices = definition.operatorClasses[type] ?? [];
	if (choices.length > 0) return choices;
	if (definition.defaultTypes.includes(type)) {
		return [{ name: "default", default: true }];
	}
	return [];
}

/** Checks whether a modeled index still matches its selected column types. */
export function indexMethodProblem(
	index: DesignIndex,
	types: readonly { type: ColumnType; array?: boolean; dimensions?: number }[],
): string | null {
	const method = findIndexMethod(index.method);
	if (!method) return "This access method is not supported.";
	if (index.unique && !method.unique) return `${method.label} does not support unique indexes.`;
	if ((index.includeColumnIds?.length ?? 0) > 0 && !method.include) return `${method.label} does not support INCLUDE columns.`;
	if (index.keys.some((key) => (key.order || key.nulls) && !method.ordering)) return `${method.label} does not support key ordering.`;
	if (index.method === "hnsw" || index.method === "ivfflat") {
		if (index.keys.length !== 1) return `${method.label} needs exactly one key column.`;
		const column = types[0];
		const limit = column?.type === "vector" ? 2000 : column?.type === "halfvec" ? 4000 : column?.type === "bit" ? 64000 : undefined;
		if (limit && column.dimensions !== undefined && column.dimensions > limit) {
			return `${method.label} supports at most ${limit} dimensions for ${column.type} columns.`;
		}
	}
	for (let position = 0; position < index.keys.length; position += 1) {
		const column = types[position];
		if (!column) continue;
		const classes = indexOperatorClasses(index.method, column.type, column.array);
		const selected = index.keys[position]?.operatorClass;
		if (selected ? !classes.some((entry) => entry.name === selected) : !classes.some((entry) => entry.default)) {
			return `${method.label} has no compatible operator class for key ${position + 1} (${column.type}${column.array ? "[]" : ""}).`;
		}
	}
	return null;
}
