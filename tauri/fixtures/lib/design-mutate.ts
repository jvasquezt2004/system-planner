/**
 * Type-preserving mutation of database Design documents.
 *
 * Unlike the generic mutator, this one knows what each field means, so it swaps a
 * column type for another column type, an id for another id, a referential action
 * for another action. That keeps documents loadable by a typed model while still
 * reaching every validation branch: duplicate and missing ids, reserved and
 * oversized names, unsupported options, cycles.
 *
 * Mutations are recorded as small path edits so a fixture can store the edits
 * instead of whole documents and the Rust side can replay them on the same base.
 */
import type { Rng } from "./mutate";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PathStep = string | number;
export type Edit =
	| { op: "set"; path: PathStep[]; value: Json }
	| { op: "delete"; path: PathStep[] }
	| { op: "insert"; path: PathStep[]; value: Json }
	| { op: "remove"; path: PathStep[] };

const COLUMN_TYPES = ["bigint", "integer", "smallint", "text", "varchar", "char", "uuid", "boolean", "numeric", "real", "double precision", "date", "time", "timetz", "timestamp", "timestamptz", "interval", "jsonb", "json", "bytea", "inet", "cidr", "macaddr", "money", "vector", "halfvec", "sparsevec", "bit", "enum", "bogus"];
const INDEX_METHODS = ["btree", "hash", "gin", "gist", "spgist", "brin", "hnsw", "ivfflat", "bogus"];
const FUNCTION_TYPES = ["text", "uuid", "integer", "integer[]", "orders", "orders[]", "users", "role", "trigger", "void", "numeric(10, 2)", "TABLE(id integer, name text)", "TABLE(x text)", "table (a int)", "bad;type", "", "$x", "it's", "numeric(10,", "double precision", "timestamp with time zone"];
const NAMES = ["orders", "Orders", "users", "order items", "a\"b", "select", "", " ", "x".repeat(70), "世界", "é", "tbl_ünï", "id", "created_at", "user", "table", "with space", "a\u0000b", "name", "Name", "k".repeat(63), "k".repeat(64), "events"];
const TEXTS = ["", " ", "true", "id = auth.uid()", "role = 'admin'", "SELECT 1;", "BEGIN RETURN NEW; END;", "$function$ inside", "x; DROP TABLE y", "note", "a\u0000b", "  padded  ", "CREATE VIEW v AS SELECT 1;  ", "-- comment"];
const OPERATOR_CLASSES = ["text_pattern_ops", "varchar_pattern_ops", "vector_l2_ops", "vector_cosine_ops", "vector_ip_ops", "jsonb_path_ops", "jsonb_ops", "halfvec_l2_ops", "inet_ops", "array_ops", "bit_hamming_ops", "BAD-OP", "", "Upper_ops", "9ops"];
const ROLES = ["anon", "authenticated", "service_role", "", "two words", "a\"b"];

const ENUMS: Record<string, string[]> = {
	command: ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"],
	mode: ["permissive", "restrictive", "loose"],
	language: ["sql", "plpgsql", "python"],
	volatility: ["volatile", "stable", "immutable", "pure"],
	security: ["invoker", "definer", "other"],
	timing: ["BEFORE", "AFTER", "INSTEAD OF", "DURING"],
	level: ["ROW", "STATEMENT", "TABLE"],
	event: ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "SELECT"],
	cardinality: ["one-to-many", "one-to-one", "many-to-many", "none"],
	onDelete: ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT", "IGNORE"],
	onUpdate: ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT", "IGNORE"],
	order: ["asc", "desc", "up"],
	nulls: ["first", "last", "middle"],
	phase: ["before", "after", "during"],
	method: INDEX_METHODS,
};

const ID_KEYS = new Set(["tableId", "columnId", "referencingTableId", "referencingColumnId", "referencedTableId", "functionId", "enumTypeId", "junctionTableId", "leftTableId", "rightTableId", "leftRelationshipId", "rightRelationshipId"]);
const ID_LIST_KEYS = new Set(["columnIds", "includeColumnIds", "tableDependencies"]);
const TEXT_KEYS = new Set(["body", "sql", "using", "withCheck", "when", "notes", "creates", "attachedTo", "returnType"]);
const NUMBER_POOLS: Record<string, number[]> = {
	x: [0, 40, -120.5, 300, 0.005],
	y: [0, 40, -75, 480],
	zoom: [0.5, 1, 2],
	length: [1, 10, 255, 0, -1, 1.5, 10485760, 10485761],
	precision: [1, 10, 38, 0, 1001, 2.5],
	scale: [-1, 0, 2, 1001, -1001, 3.5],
	dimensions: [1, 3, 1536, 0, 2000, 2001, 4001, 64001, 1.5, 1000000001],
	fillfactor: [10, 70, 90, 100, 9, 101, 50.5, 0],
	pagesPerRange: [1, 128, 0, 1.5],
	lists: [1, 100, 0, 2.5],
	m: [4, 16, 100, 101, 0],
	efConstruction: [4, 64, 3, 0, 200],
};
/** Optional keys that may be absent in a valid typed document. */
const OPTIONAL_KEYS = new Set(["typeParameters", "enumTypeId", "indexes", "uniqueConstraints", "name", "nullsNotDistinct", "includeColumnIds", "with", "unique", "onDelete", "onUpdate", "enumTypes", "functions", "triggers", "rawStatements", "tableDependencies", "columnIds", "creates", "attachedTo", "order", "nulls", "operatorClass", "length", "precision", "scale", "dimensions", "array", "fillfactor", "fastupdate", "pagesPerRange", "lists", "m", "efConstruction"]);
const DEFAULTS: Json[] = [
	{ kind: "none" },
	{ kind: "currentTimestamp" },
	{ kind: "generateUuid" },
	{ kind: "literal", literalType: "integer", value: "0" },
	{ kind: "literal", literalType: "text", value: "it's" },
	{ kind: "literal", literalType: "boolean", value: "true" },
	{ kind: "literal", literalType: "json", value: "{}" },
	{ kind: "literal", literalType: "timestamp", value: "2024-02-29T12:00:00Z" },
	{ kind: "literal", literalType: "integer", value: "abc" },
];
const PARAMETERS: Json[] = [{ length: 120 }, { precision: 10, scale: 2 }, { dimensions: 3 }, { array: true }, { length: 0 }, { dimensions: 1536, array: true }, {}, { precision: 5 }];

const isObject = (value: unknown): value is { [key: string]: Json } => value !== null && typeof value === "object" && !Array.isArray(value);

function collect(value: Json, path: PathStep[] = [], out: PathStep[][] = []): PathStep[][] {
	out.push(path);
	if (Array.isArray(value)) value.forEach((item, index) => collect(item, [...path, index], out));
	else if (isObject(value)) for (const key of Object.keys(value)) collect(value[key]!, [...path, key], out);
	return out;
}

function ids(doc: Json): string[] {
	const found: string[] = [];
	const visit = (node: Json) => {
		if (Array.isArray(node)) node.forEach(visit);
		else if (isObject(node)) {
			if (typeof node.id === "string") found.push(node.id);
			Object.values(node).forEach(visit);
		}
	};
	visit(doc);
	return found;
}

function getAt(doc: Json, path: PathStep[]): Json {
	let current: Json = doc;
	for (const step of path) current = (current as never)[step as never] as Json;
	return current;
}

/** Applies an edit to the document in place. The Rust test support implements the same four operations. */
export function applyEdit(doc: Json, edit: Edit) {
	const parentPath = edit.path.slice(0, -1);
	const parent = (parentPath.length === 0 ? doc : getAt(doc, parentPath)) as never as Record<string | number, Json>;
	const last = edit.path[edit.path.length - 1]!;
	switch (edit.op) {
		case "set": parent[last] = edit.value; break;
		case "delete": delete parent[last]; break;
		case "insert": (parent as unknown as Json[]).splice(last as number, 0, edit.value); break;
		case "remove": (parent as unknown as Json[]).splice(last as number, 1); break;
	}
}

export class DesignMutator {
	constructor(readonly rng: Rng) {}
	private chance(p: number) {
		return this.rng() < p;
	}
	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.rng() * items.length)]!;
	}

	/** One mutation of the document, applied in place; returns the edit that was made, or null when nothing applied. */
	mutate(doc: Json): Edit | null {
		const paths = collect(doc).filter((path) => path.length > 0);
		let path = this.pick(paths);
		// A default's fields only make sense together, so a change anywhere inside replaces the whole default.
		const insideDefault = path.indexOf("default");
		if (insideDefault >= 0 && insideDefault < path.length - 1) path = path.slice(0, insideDefault + 1);
		const key = path[path.length - 1]!;
		const value = getAt(doc, path);
		const parentPath = path.slice(0, -1);
		const parent = parentPath.length === 0 ? doc : getAt(doc, parentPath);
		const inArray = Array.isArray(parent);
		// The key naming the list an element belongs to (columnIds, roles, ...), or the object key itself.
		const owner = inArray ? (parentPath[parentPath.length - 1] as string | number) : key;
		const edit = this.edit(doc, path, key, owner, value, inArray, parent);
		if (edit) applyEdit(doc, edit);
		return edit;
	}

	private edit(doc: Json, path: PathStep[], key: PathStep, owner: PathStep, value: Json, inArray: boolean, parent: Json): Edit | null {
		const allIds = ids(doc);
		// Structural edits on lists.
		if (Array.isArray(value) && value.length > 0 && this.chance(0.35)) {
			const index = Math.floor(this.rng() * value.length);
			if (this.chance(0.5)) return { op: "remove", path: [...path, index] };
			const clone = structuredClone(value[index]!) as Json;
			if (isObject(clone) && typeof clone.id === "string") clone.id = `${clone.id}-${Math.floor(this.rng() * 1000)}`;
			return { op: "insert", path: [...path, index], value: clone };
		}
		if (Array.isArray(value) && value.length === 0 && this.chance(0.3)) {
			const member = this.fresh(String(key), allIds);
			return member === undefined ? null : { op: "insert", path: [...path, 0], value: member };
		}
		// Optional members come and go.
		if (typeof key === "string" && OPTIONAL_KEYS.has(key) && !inArray && canBeAbsent(key, parent) && this.chance(0.18)) return { op: "delete", path };
		if (isObject(parent) && this.chance(0.04)) {
			const absent = this.addable(parent, allIds);
			if (absent) return { op: "set", path: [...parentPath(path), absent.key], value: absent.value };
		}
		if (typeof key === "string" && key === "default") return { op: "set", path, value: structuredClone(this.pick(DEFAULTS)) };
		if (key === "typeParameters") return { op: "set", path, value: structuredClone(this.pick(PARAMETERS)) };
		if (typeof value === "boolean") return { op: "set", path, value: !value };
		if (typeof value === "number") {
			const pool = NUMBER_POOLS[String(key)];
			return { op: "set", path, value: pool ? this.pick(pool) : this.pick([0, 1, 40, -3]) };
		}
		if (typeof value === "string") return { op: "set", path, value: this.string(doc, path, String(key), String(owner), inArray, allIds) };
		return null;
	}

	private string(doc: Json, path: PathStep[], key: string, owner: string, inArray: boolean, allIds: string[]): string {
		const idLike = ID_KEYS.has(key) || (inArray && ID_LIST_KEYS.has(owner));
		if (idLike) return this.chance(0.12) ? this.pick(["missing", "", "  "]) : this.pick(allIds);
		if (key === "id") return this.chance(0.5) && allIds.length > 0 ? this.pick(allIds) : `dup-${Math.floor(this.rng() * 50)}`;
		if (ENUMS[key]) return this.pick(ENUMS[key]!);
		if (key === "type") {
			const parent = getAt(doc, path.slice(0, -1));
			const isArgument = isObject(parent) && !("primaryKey" in parent);
			return isArgument ? this.pick(FUNCTION_TYPES) : this.pick(COLUMN_TYPES);
		}
		if (key === "operatorClass") return this.pick(OPERATOR_CLASSES);
		if (key === "returnType") return this.pick(FUNCTION_TYPES);
		if (inArray && owner === "roles") return this.pick(ROLES);
		if (inArray && owner === "labels") return this.pick(["admin", "member", "", " ", "dup", "it's", "a\u0000b"]);
		if (key === "name") {
			const names = [...NAMES, ...this.namesIn(doc)];
			return this.pick(names);
		}
		if (TEXT_KEYS.has(key)) return this.pick(TEXTS);
		return this.pick(NAMES);
	}

	private namesIn(doc: Json): string[] {
		const found: string[] = [];
		const visit = (node: Json) => {
			if (Array.isArray(node)) node.forEach(visit);
			else if (isObject(node)) {
				if (typeof node.name === "string") found.push(node.name);
				Object.values(node).forEach(visit);
			}
		};
		visit(doc);
		return found;
	}

	/** A new optional member for an object that does not have it yet. */
	private addable(parent: { [key: string]: Json }, allIds: string[]): { key: string; value: Json } | null {
		const options: Array<{ key: string; value: Json }> = [];
		if ("columns" in parent) {
			options.push({ key: "indexes", value: [] }, { key: "uniqueConstraints", value: [] });
			options.push({ key: "rowLevelSecurity", value: true });
		}
		if ("primaryKey" in parent) options.push({ key: "typeParameters", value: structuredClone(this.pick(PARAMETERS)) });
		if ("keys" in parent) options.push({ key: "with", value: this.pick([{ fillfactor: 70 }, { m: 16, efConstruction: 64 }, { lists: 100 }, { fastupdate: false }, { bogus: 1 }, { fillfactor: 5, m: 200 }]) as Json });
		if ("keys" in parent) options.push({ key: "includeColumnIds", value: allIds.slice(0, 2) }, { key: "nullsNotDistinct", value: true }, { key: "unique", value: true });
		if ("referencingTableId" in parent) options.push({ key: "onDelete", value: this.pick(ENUMS.onDelete!) }, { key: "onUpdate", value: this.pick(ENUMS.onUpdate!) });
		const fresh = options.filter((option) => !(option.key in parent));
		return fresh.length > 0 ? this.pick(fresh) : null;
	}

	/** A plausible new list member for an empty list. */
	private fresh(listKey: string, allIds: string[]): Json | undefined {
		const id = `new-${Math.floor(this.rng() * 1000)}`;
		const anyId = () => (allIds.length > 0 ? this.pick(allIds) : "missing");
		switch (listKey) {
			case "indexes": return { id, method: this.pick(INDEX_METHODS), keys: [{ columnId: anyId() }] };
			case "uniqueConstraints": return { id, columnIds: [anyId(), anyId()] };
			case "policies": return { id, name: this.pick(NAMES), command: this.pick(ENUMS.command!), roles: [this.pick(ROLES)], mode: "permissive", using: this.pick(TEXTS), withCheck: this.pick(TEXTS) };
			case "enumTypes": return { id, name: this.pick(NAMES), labels: ["a", "b"] };
			case "relationships": return { id, cardinality: "one-to-many", referencingTableId: anyId(), referencingColumnId: anyId(), referencedTableId: anyId() };
			case "rawStatements": return { id, sql: this.pick(TEXTS), phase: this.pick(ENUMS.phase!) };
			case "functions": return { id, name: this.pick(NAMES), arguments: [], returnType: this.pick(FUNCTION_TYPES), returnsSet: this.chance(0.3), language: "plpgsql", volatility: "volatile", security: "invoker", body: this.pick(TEXTS) };
			case "triggers": return { id, name: this.pick(NAMES), tableId: anyId(), timing: "BEFORE", events: [{ event: "INSERT" }], level: "ROW", functionId: anyId(), when: "" };
			case "columnIds": case "includeColumnIds": case "tableDependencies": return anyId();
			case "labels": return "label";
			case "roles": return this.pick(ROLES);
			case "manyToManyRelationships": return { id, leftTableId: anyId(), rightTableId: anyId(), junctionTableId: anyId(), leftRelationshipId: anyId(), rightRelationshipId: anyId() };
			case "keys": return { columnId: anyId() };
			case "arguments": return { name: this.pick(NAMES), type: this.pick(FUNCTION_TYPES) };
			case "events": return { event: this.pick(ENUMS.event!) };
			case "tables": return { id, name: this.pick(NAMES), position: { x: 0, y: 0 }, columns: [], rowLevelSecurity: false, policies: [] };
			case "columns": return { id, name: this.pick(NAMES), type: this.pick(COLUMN_TYPES), nullable: true, primaryKey: false, unique: false, identity: false, default: { kind: "none" }, notes: "" };
			default: return undefined;
		}
	}
}

const parentPath = (path: PathStep[]) => path.slice(0, -1);

/** Whether a member the typed model treats as optional on this kind of object may be absent. */
function canBeAbsent(key: string, parent: Json): boolean {
	if (!isObject(parent)) return false;
	switch (key) {
		// Required on tables, columns, functions and the like; optional on indexes and unique constraints.
		case "name": return "keys" in parent || "columnIds" in parent;
		// Required on a column, optional on an index.
		case "unique": return "keys" in parent;
		// Required on a unique constraint, optional on a trigger event.
		case "columnIds": return "event" in parent;
		default: return true;
	}
}
