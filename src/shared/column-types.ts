/**
 * The single source of truth for the supported common PostgreSQL column types.
 * The type picker, validation, SQL generation, and sandbox checks all read from
 * this registry so their supported variants cannot drift apart.
 */

export type ColumnTypeFamilyId =
	| "integer"
	| "text"
	| "uuid"
	| "boolean"
	| "numeric"
	| "temporal"
	| "json";

/** A readable grouping used by the type picker and the type-family symbols. */
export type ColumnTypeFamily = {
	id: ColumnTypeFamilyId;
	label: string;
	glyph: string;
	summary: string;
};

export const COLUMN_TYPE_FAMILIES: readonly ColumnTypeFamily[] = [
	{
		id: "integer",
		label: "Integer",
		glyph: "#",
		summary: "Whole numbers, including identity-generated keys",
	},
	{
		id: "text",
		label: "Text",
		glyph: "T",
		summary: "Variable-length character data",
	},
	{
		id: "uuid",
		label: "UUID",
		glyph: "U",
		summary: "Universally unique identifier",
	},
	{
		id: "boolean",
		label: "Boolean",
		glyph: "B",
		summary: "True or false",
	},
	{
		id: "numeric",
		label: "Numeric",
		glyph: "N",
		summary: "Exact decimal numbers",
	},
	{
		id: "temporal",
		label: "Date/time",
		glyph: "D",
		summary: "Calendar dates and timestamps",
	},
	{
		id: "json",
		label: "JSON",
		glyph: "{}",
		summary: "Structured JSONB documents",
	},
];

type ColumnTypeDefinition = {
	/** Exact PostgreSQL type name, used verbatim in generated SQL. */
	type: string;
	label: string;
	family: ColumnTypeFamilyId;
	/** Identity generation is only meaningful for integer types. */
	identity: boolean;
};

export const COLUMN_TYPE_DEFINITIONS = [
	{ type: "bigint", label: "Big integer", family: "integer", identity: true },
	{ type: "integer", label: "Integer", family: "integer", identity: true },
	{ type: "smallint", label: "Small integer", family: "integer", identity: true },
	{ type: "text", label: "Text", family: "text", identity: false },
	{ type: "uuid", label: "UUID", family: "uuid", identity: false },
	{ type: "boolean", label: "Boolean", family: "boolean", identity: false },
	{ type: "numeric", label: "Numeric", family: "numeric", identity: false },
	{ type: "date", label: "Date", family: "temporal", identity: false },
	{
		type: "timestamptz",
		label: "Timestamp with time zone",
		family: "temporal",
		identity: false,
	},
	{ type: "jsonb", label: "JSONB", family: "json", identity: false },
] as const satisfies readonly ColumnTypeDefinition[];

export type ColumnType = (typeof COLUMN_TYPE_DEFINITIONS)[number]["type"];

export type ColumnTypeInfo = Omit<ColumnTypeDefinition, "type" | "family"> & {
	type: ColumnType;
	family: ColumnTypeFamily;
};

const definitionsByType = new Map<string, ColumnTypeDefinition>(
	COLUMN_TYPE_DEFINITIONS.map((definition) => [definition.type, definition]),
);

const familiesById = new Map<ColumnTypeFamilyId, ColumnTypeFamily>(
	COLUMN_TYPE_FAMILIES.map((family) => [family.id, family]),
);

export function isSupportedColumnType(value: unknown): value is ColumnType {
	return typeof value === "string" && definitionsByType.has(value);
}

/** Returns null for a type that is not in the supported registry. */
export function findColumnTypeInfo(value: string): ColumnTypeInfo | null {
	const definition = definitionsByType.get(value);
	if (!definition) return null;
	const family = familiesById.get(definition.family);
	if (!family) return null;
	return {
		type: definition.type as ColumnType,
		label: definition.label,
		identity: definition.identity,
		family,
	};
}

export function columnTypeInfo(type: ColumnType): ColumnTypeInfo {
	const info = findColumnTypeInfo(type);
	if (!info) throw new Error(`Unsupported column type: ${type}`);
	return info;
}
