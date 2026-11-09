/**
 * Hand-written sessions for the interplay random calls rarely line up: an enum a column uses, an
 * index that includes a column that is then removed, a trigger that fires on a column's update.
 * Each step reads ids from the live state, so a script is a list of intentions.
 */
import type { WorkspaceState } from "../../../src/shared/design";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutateOnce, seededRng } from "./mutate";
import { openDriver, type StepOutcome } from "./workspace-driver";

export type Call = { method: string; params: unknown };
/** A script step reads the live state and the outcome of the call before it. */
export type Script = Array<(state: WorkspaceState, last?: StepOutcome) => Call>;

const design = (state: WorkspaceState) => state.design!;
const table = (state: WorkspaceState, name: string) => design(state).tables.find((candidate) => candidate.name === name)!;
const column = (state: WorkspaceState, tableName: string, name: string) => table(state, tableName).columns.find((candidate) => candidate.name === name)!;
const on = (state: WorkspaceState) => ({ designId: state.activeDesignId! });
const add = (name: string) => (state: WorkspaceState): Call => ({ method: "addTable", params: { ...on(state), name } });
const addColumn = (tableName: string, name: string, type = "text") => (state: WorkspaceState): Call => ({
	method: "addColumn",
	params: { ...on(state), tableId: table(state, tableName).id, name, type },
});
const open = (): Call => ({ method: "createProject", params: { name: "Scripted" } });

const triggerFunction = { id: "fn-touch", name: "touch", arguments: [], returnType: "trigger", returnsSet: false, language: "plpgsql", volatility: "volatile", security: "invoker", body: "BEGIN RETURN NEW; END;" };

export const SCRIPTS: Record<string, Script> = {
	// An enum type a column uses cannot be dropped until the column stops using it.
	enums: [
		open, add("orders"), addColumn("orders", "status"),
		(state) => ({ method: "updateEnumTypes", params: { ...on(state), enumTypes: [{ id: "e1", name: "state", labels: ["open", "closed"] }, { id: "e2", name: "kind", labels: ["a"] }] } }),
		(state) => ({ method: "updateColumn", params: { ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "status").id, changes: { type: "enum", enumTypeId: "e1" } } }),
		(state) => ({ method: "updateEnumTypes", params: { ...on(state), enumTypes: [{ id: "e2", name: "kind", labels: ["a"] }] } }),
		(state) => ({ method: "updateEnumTypes", params: { ...on(state), enumTypes: [{ id: "e1", name: "state", labels: ["open", "closed", "void"] }, { id: "e2", name: "kind", labels: ["a"] }] } }),
		(state) => ({ method: "updateColumn", params: { ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "status").id, changes: { type: "text" } } }),
		(state) => ({ method: "updateEnumTypes", params: { ...on(state), enumTypes: [{ id: "e2", name: "kind", labels: ["a"] }] } }),
		(state) => ({ method: "updateEnumTypes", params: { ...on(state), enumTypes: [{ id: "e2", name: "kind", labels: ["a"] }] } }),
	],

	// Removing a column cleans up what used it: index keys and INCLUDE lists, unique constraints, trigger columns.
	cascades: [
		open, add("orders"), addColumn("orders", "total", "numeric"), addColumn("orders", "note"), addColumn("orders", "sku"),
		(state) => ({
			method: "updateIndexes",
			params: {
				...on(state), tableId: table(state, "orders").id,
				indexes: [
					{ id: "ix-1", name: "by_total", method: "btree", keys: [{ columnId: column(state, "orders", "total").id, order: "desc" }], includeColumnIds: [column(state, "orders", "note").id, column(state, "orders", "sku").id], with: { fillfactor: 70 } },
					{ id: "ix-2", method: "btree", keys: [{ columnId: column(state, "orders", "note").id }] },
					{ id: "ix-3", method: "hash", keys: [{ columnId: column(state, "orders", "sku").id }], unique: true },
				],
			},
		}),
		(state) => ({
			method: "updateUniqueConstraints",
			params: {
				...on(state), tableId: table(state, "orders").id,
				uniqueConstraints: [
					{ id: "uq-1", name: "note_sku", columnIds: [column(state, "orders", "note").id, column(state, "orders", "sku").id] },
					{ id: "uq-2", columnIds: [column(state, "orders", "total").id], nullsNotDistinct: true },
				],
			},
		}),
		(state) => ({ method: "updateFunctions", params: { ...on(state), functions: [triggerFunction] } }),
		(state) => ({
			method: "updateTriggers",
			params: {
				...on(state),
				triggers: [
					{ id: "tr-1", name: "touch_orders", tableId: table(state, "orders").id, timing: "BEFORE", events: [{ event: "UPDATE", columnIds: [column(state, "orders", "note").id, column(state, "orders", "sku").id] }, { event: "INSERT" }], level: "ROW", functionId: "fn-touch", when: "" },
					{ id: "tr-2", name: "only_total", tableId: table(state, "orders").id, timing: "AFTER", events: [{ event: "UPDATE", columnIds: [column(state, "orders", "total").id] }], level: "ROW", functionId: "fn-touch", when: " NEW.total > 0 " },
				],
			},
		}),
		(state) => ({ method: "describeRemoval", params: { kind: "column", ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "note").id } }),
		(state) => ({ method: "removeColumn", params: { ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "note").id } }),
		(state) => ({ method: "removeColumn", params: { ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "note").id, confirmed: true } }),
		(state) => ({ method: "removeColumn", params: { ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "sku").id, confirmed: true } }),
		(state) => ({ method: "removeColumn", params: { ...on(state), tableId: table(state, "orders").id, columnId: column(state, "orders", "total").id, confirmed: true } }),
		(state) => ({ method: "describeRemoval", params: { kind: "function", ...on(state), functionId: "fn-touch" } }),
		(state) => ({ method: "removeFunction", params: { ...on(state), functionId: "fn-touch" } }),
		(state) => ({ method: "removeFunction", params: { ...on(state), functionId: "fn-touch", confirmed: true } }),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "orders").id } }),
	],

	// Relationships of every cardinality, edited and removed, and the tables and columns they hang on.
	relationships: [
		open, add("customers"), add("orders"), add("tags"), add("products"),
		(state) => ({ method: "addRelationship", params: { ...on(state), referencingTableId: table(state, "orders").id, referencedTableId: table(state, "customers").id } }),
		(state) => ({ method: "addRelationship", params: { ...on(state), referencingTableId: table(state, "products").id, referencedTableId: table(state, "customers").id, cardinality: "one-to-one" } }),
		(state) => ({ method: "addRelationship", params: { ...on(state), referencingTableId: table(state, "products").id, referencedTableId: table(state, "tags").id, cardinality: "many-to-many", junctionPosition: { x: 12.345, y: 7 } } }),
		(state) => ({ method: "addRelationship", params: { ...on(state), referencingTableId: table(state, "products").id, referencedTableId: table(state, "tags").id, cardinality: "many-to-many" } }),
		(state) => ({ method: "updateRelationship", params: { ...on(state), relationshipId: design(state).relationships[0]!.id, onDelete: "CASCADE", onUpdate: "RESTRICT", required: false } }),
		(state) => ({ method: "updateRelationship", params: { ...on(state), relationshipId: design(state).relationships[0]!.id, onDelete: "CASCADE" } }),
		(state) => ({ method: "updateRelationship", params: { ...on(state), relationshipId: design(state).relationships[1]!.id, cardinality: "one-to-many" } }),
		(state) => ({ method: "updateRelationship", params: { ...on(state), relationshipId: design(state).relationships[2]!.id, required: false } }),
		(state) => ({ method: "updateRelationship", params: { ...on(state), relationshipId: design(state).relationships[2]!.id, cardinality: "one-to-one" } }),
		(state) => ({ method: "updateRelationship", params: { ...on(state), relationshipId: design(state).relationships[2]!.id, onDelete: "SET NULL" } }),
		(state) => ({ method: "describeRemoval", params: { kind: "table", ...on(state), tableId: table(state, "customers").id } }),
		(state) => ({ method: "describeRemoval", params: { kind: "table", ...on(state), tableId: table(state, "tags").id } }),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "customers").id } }),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "customers").id, confirmed: true } }),
		(state) => ({ method: "removeRelationship", params: { ...on(state), relationshipId: design(state).relationships[0]!.id } }),
		(state) => ({ method: "removeColumn", params: { ...on(state), tableId: table(state, "products").id, columnId: table(state, "products").columns.at(-1)!.id } }),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "products").id, confirmed: true } }),
	],

	// Functions that name tables, and the triggers that depend on them.
	functions: [
		open, add("orders"), add("order_lines"), addColumn("orders", "total", "numeric"),
		(state) => ({
			method: "updateFunctions",
			params: {
				...on(state),
				functions: [
					triggerFunction,
					{ id: "fn-sum", name: "sum_lines", arguments: [{ name: "order_id", type: "bigint" }], returnType: "numeric", returnsSet: false, language: "sql", volatility: "stable", security: "invoker", body: "SELECT sum(x) FROM public . \"order_lines\" JOIN orders ON true" },
					{ id: "fn-rows", name: "rows_of", arguments: [], returnType: "TABLE (id bigint)", returnsSet: false, language: "sql", volatility: "stable", security: "definer", body: "SELECT id FROM orders_archive" },
					{ id: "fn-typed", name: "typed", arguments: [{ name: "o", type: "orders[]" }], returnType: "integer", returnsSet: false, language: "sql", volatility: "immutable", security: "invoker", body: "SELECT 1" },
				],
			},
		}),
		(state) => ({ method: "updateFunctions", params: { ...on(state), functions: design(state).functions } }),
		(state) => ({
			method: "updateFunctions",
			params: { ...on(state), functions: design(state).functions!.map((fn) => (fn.id === "fn-sum" ? { ...fn, body: `${fn.body} UNION ALL SELECT 1 FROM tags` } : fn)) },
		}),
		(state) => ({ method: "updateFunctions", params: { ...on(state), functions: [{ ...triggerFunction, language: "sql" }] } }),
		(state) => ({
			method: "updateTriggers",
			params: { ...on(state), triggers: [{ id: "tr-1", name: "touch", tableId: table(state, "orders").id, timing: "BEFORE", events: [{ event: "INSERT" }, { event: "INSERT" }], level: "ROW", functionId: "fn-touch" }] },
		}),
		(state) => ({
			method: "updateTriggers",
			params: { ...on(state), triggers: [{ id: "tr-1", name: "touch", tableId: table(state, "orders").id, timing: "BEFORE", events: [{ event: "INSERT" }, { event: "DELETE" }], level: "STATEMENT", functionId: "fn-touch", when: "  true  " }] },
		}),
		(state) => ({
			method: "updateTriggers",
			params: { ...on(state), triggers: [...design(state).triggers!, { id: "tr-2", name: "touch", tableId: table(state, "order_lines").id, timing: "AFTER", events: [{ event: "UPDATE", columnIds: ["nope"] }], level: "ROW", functionId: "fn-touch" }] },
		}),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "orders").id } }),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "orders").id, confirmed: true } }),
		(state) => ({ method: "removeFunction", params: { ...on(state), functionId: "fn-touch" } }),
	],

	// Scenarios and Edge functions, with Undo across them and typing grouped into one step.
	sources: [
		open,
		(state) => ({ method: "createScenario", params: { ...on(state), name: "  Happy path " } }),
		(state) => ({ method: "createScenario", params: { ...on(state), name: "Checkout" } }),
		(state) => ({ method: "updateScenarioSource", params: { ...on(state), scenarioId: state.scenarios[0]!.id, source: "a" } }),
		(state) => ({ method: "updateScenarioSource", params: { ...on(state), scenarioId: state.scenarios[0]!.id, source: "ab" } }),
		(state) => ({ method: "renameScenario", params: { ...on(state), scenarioId: state.scenarios[0]!.id, name: "Renamed" } }),
		(state) => ({ method: "renameScenario", params: { ...on(state), scenarioId: state.scenarios[0]!.id, name: "Renamed again" } }),
		(state) => ({ method: "createEdgeFunction", params: { ...on(state), name: "hello" } }),
		(state) => ({ method: "createEdgeFunction", params: { ...on(state), name: "hello" } }),
		(state) => ({ method: "createEdgeFunction", params: { ...on(state), name: "Hello" } }),
		(state) => ({ method: "createEdgeFunction", params: { ...on(state), name: "bye" } }),
		(state) => ({ method: "renameEdgeFunction", params: { ...on(state), edgeFunctionId: state.edgeFunctions[0]!.id, name: "bye" } }),
		(state) => ({ method: "renameEdgeFunction", params: { ...on(state), edgeFunctionId: state.edgeFunctions[0]!.id, name: "hello" } }),
		(state) => ({ method: "updateEdgeFunctionSource", params: { ...on(state), edgeFunctionId: state.edgeFunctions[0]!.id, source: "one" } }),
		(state) => ({ method: "updateEdgeFunctionSource", params: { ...on(state), edgeFunctionId: state.edgeFunctions[0]!.id, source: "two" } }),
		(state) => ({ method: "removeEdgeFunction", params: { ...on(state), edgeFunctionId: state.edgeFunctions[1]!.id } }),
		(state) => ({ method: "removeScenario", params: { ...on(state), scenarioId: state.scenarios[1]!.id } }),
		...Array.from({ length: 12 }, () => (state: WorkspaceState): Call => ({ method: "undo", params: on(state) })),
		...Array.from({ length: 12 }, () => (state: WorkspaceState): Call => ({ method: "redo", params: on(state) })),
		(state) => ({ method: "exportProject", params: {} }),
	],

	// Policies and row-level security.
	policies: [
		open, add("accounts"),
		(state) => ({
			method: "updatePolicies",
			params: {
				...on(state), tableId: table(state, "accounts").id, rowLevelSecurity: true,
				policies: [
					{ id: "p1", name: " read ", command: "SELECT", roles: ["authenticated", " authenticated ", "anon"], mode: "permissive", using: "true", withCheck: "" },
					{ id: "p2", name: "write", command: "ALL", roles: [], mode: "restrictive", using: "auth.uid() = id", withCheck: "true" },
				],
			},
		}),
		(state) => ({ method: "updatePolicies", params: { ...on(state), tableId: table(state, "accounts").id, rowLevelSecurity: true, policies: table(state, "accounts").policies } }),
		(state) => ({ method: "updatePolicies", params: { ...on(state), tableId: table(state, "accounts").id, rowLevelSecurity: false, policies: table(state, "accounts").policies } }),
		(state) => ({ method: "updatePolicies", params: { ...on(state), tableId: table(state, "accounts").id, rowLevelSecurity: true, policies: [{ id: "p1", name: "a", command: "ALL", roles: [], mode: "permissive", using: "", withCheck: "" }, { id: "p1", name: "b", command: "ALL", roles: [], mode: "permissive", using: "", withCheck: "" }] } }),
		(state) => ({ method: "updatePolicies", params: { ...on(state), tableId: table(state, "accounts").id, rowLevelSecurity: true, policies: [{ id: "p1", name: "a", command: "ALL", roles: [], mode: "permissive", using: "", withCheck: "" }, { id: "p2", name: "a", command: "ALL", roles: [], mode: "permissive", using: "", withCheck: "" }] } }),
		(state) => ({ method: "updatePolicies", params: { ...on(state), tableId: table(state, "accounts").id, rowLevelSecurity: true, policies: [{ id: "p1", name: "a", command: "ALL", roles: [], mode: "sometimes", using: "", withCheck: "" }] } }),
	],

	// Undo and Redo across Design, System design and Walkthrough edits, with typing grouped into one step.
	history: [
		open, add("orders"),
		// Renames in a row (one second apart) are one Undo step; a gap longer than the window starts a new one.
		(state) => ({ method: "renameTable", params: { ...on(state), tableId: table(state, "orders").id, name: "A" } }),
		(state) => ({ method: "renameTable", params: { ...on(state), tableId: table(state, "A").id, name: "AB" } }),
		addColumn("AB", "note"),
		(state) => ({ method: "updateColumn", params: { ...on(state), tableId: table(state, "AB").id, columnId: column(state, "AB", "note").id, changes: { notes: "x" } } }),
		(state) => ({ method: "updateColumn", params: { ...on(state), tableId: table(state, "AB").id, columnId: column(state, "AB", "note").id, changes: { notes: "xy" } } }),
		(state) => ({ method: "moveTable", params: { ...on(state), tableId: table(state, "AB").id, position: { x: 400, y: 300 } } }),
		(state) => ({ method: "setViewport", params: { ...on(state), x: 5, y: 6, zoom: 1.5 } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		// A new edit discards what Redo would have replayed.
		add("fresh"),
		(state) => ({ method: "redo", params: on(state) }),
		// System design and Walkthrough edits share the same history.
		(state) => ({ method: "addSystemService", params: { x: 0, y: 0, name: "Backend" } }),
		(state) => ({ method: "addSystemComponent", params: { x: 10, y: 10, kind: "database", name: "Primary" } }),
		(state) => ({ method: "addSystemComponent", params: { x: 300, y: 10, kind: "api", name: "Gateway" } }),
		(state) => ({
			method: "addSystemConnection",
			params: { sourceId: state.systemDesign!.components[0]!.id, targetId: state.systemDesign!.components[1]!.id, label: "reads" },
		}),
		(state) => ({ method: "updateSystemComponent", params: { componentId: state.systemDesign!.components[0]!.id, changes: { description: "first" } } }),
		(state) => ({ method: "updateSystemComponent", params: { componentId: state.systemDesign!.components[0]!.id, changes: { description: "second" } } }),
		(state) => ({ method: "linkSystemDatabase", params: { componentId: state.systemDesign!.components[0]!.id, designId: state.activeDesignId } }),
		(state) => ({ method: "createWalkthrough", params: { name: "Checkout" } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		// Removing a table with its relationships, then taking it back.
		(state) => ({ method: "addRelationship", params: { ...on(state), referencingTableId: table(state, "fresh").id, referencedTableId: table(state, "AB").id } }),
		(state) => ({ method: "removeTable", params: { ...on(state), tableId: table(state, "AB").id, confirmed: true } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		// Setting a description again moves its key behind the linked design: the content is the same,
		// yet the original counts it as a change on its own, and Undo reverses it.
		(state) => ({ method: "addSystemService", params: { x: 0, y: 400, name: "Spacer" } }),
		(state) => ({ method: "updateSystemComponent", params: { componentId: state.systemDesign!.components[0]!.id, changes: { description: "second" } } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		(state) => ({ method: "addSystemService", params: { x: 0, y: 800, name: "Spacer 2" } }),
		(state) => ({ method: "updateSystemComponent", params: { componentId: state.systemDesign!.components[0]!.id, changes: { technology: "Postgres" } } }),
		(state) => ({ method: "addSystemService", params: { x: 0, y: 1200, name: "Spacer 3" } }),
		(state) => ({ method: "updateSystemComponent", params: { componentId: state.systemDesign!.components[0]!.id, changes: { technology: "Postgres" } } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		// Collapsed Services and focus are presentation: Undo drops them only when their Service goes away.
		(state) => ({ method: "addSystemService", params: { x: 600, y: 0, name: "Extra" } }),
		(state) => ({ method: "setSystemServiceCollapsed", params: { serviceId: state.systemDesign!.services.at(-1)!.id, collapsed: true } }),
		(state) => ({ method: "setSystemFocus", params: { serviceId: state.systemDesign!.services.at(-1)!.id } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: on(state) }),
		// Typing in a Function body is one step.
		(state) => ({ method: "updateFunctions", params: { ...on(state), functions: [triggerFunction] } }),
		(state) => ({ method: "updateFunctions", params: { ...on(state), functions: [{ ...triggerFunction, body: "BEGIN RETURN OLD; END;" }] } }),
		(state) => ({ method: "updateFunctions", params: { ...on(state), functions: [{ ...triggerFunction, body: "BEGIN RETURN NULL; END;" }] } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		// All the way back, and forward again.
		...Array.from({ length: 40 }, () => (state: WorkspaceState): Call => ({ method: "undo", params: on(state) })),
		...Array.from({ length: 40 }, () => (state: WorkspaceState): Call => ({ method: "redo", params: on(state) })),
		// Each design keeps its own history; a stale or unknown design is refused.
		(state) => ({ method: "createDesign", params: { name: "Second" } }),
		add("other"),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "redo", params: { designId: state.designs[0]!.id } }),
		(state) => ({ method: "openDesign", params: { designId: state.designs[0]!.id } }),
		(state) => ({ method: "undo", params: on(state) }),
		(state) => ({ method: "undo", params: { designId: "bogus" } }),
		(state) => ({ method: "redo", params: on(state) }),
	],

};

/**
 * What the typed Rust `Design` requires. The original stores a hand-damaged design as it is (a
 * column without `nullable`, an index key that is not an object); the Rust model refuses it with
 * a typed error instead. Documents that differ only by that are left out of the recorded sessions.
 */
export function typedDesignProblem(design: any): string | null {
	const isString = (value: unknown) => typeof value === "string";
	const isBoolean = (value: unknown) => typeof value === "boolean";
	const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || value === null || check(value);
	const isObject = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
	const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);
	const list = (value: unknown, check: (item: any) => boolean) => Array.isArray(value) && value.every(check);
	const strings = (value: unknown) => list(value, isString);
	const point = (value: any) => isObject(value) && isNumber(value.x) && isNumber(value.y);
	const column = (value: any) =>
		isObject(value) && [value.id, value.name, value.type, value.notes].every(isString) && [value.nullable, value.primaryKey, value.unique, value.identity].every(isBoolean)
		&& isObject(value.default) && optional(value.enumTypeId, isString)
		&& optional(value.typeParameters, (parameters) => isObject(parameters) && Object.entries(parameters as Record<string, unknown>).every(([key, entry]) => (key === "array" ? isBoolean(entry) || entry === undefined : isNumber(entry) || entry === undefined)));
	const key = (value: any) => isObject(value) && isString(value.columnId) && optional(value.order, isString) && optional(value.nulls, isString) && optional(value.operatorClass, isString);
	const index = (value: any) =>
		isObject(value) && isString(value.id) && isString(value.method) && optional(value.name, isString) && list(value.keys, key) && optional(value.unique, isBoolean)
		&& optional(value.nullsNotDistinct, isBoolean) && optional(value.includeColumnIds, strings) && optional(value.with, isObject);
	const unique = (value: any) => isObject(value) && isString(value.id) && optional(value.name, isString) && strings(value.columnIds) && optional(value.nullsNotDistinct, isBoolean);
	const policy = (value: any) => isObject(value) && [value.id, value.name, value.command, value.mode, value.using, value.withCheck].every(isString) && strings(value.roles);
	const table = (value: any) =>
		isObject(value) && isString(value.id) && isString(value.name) && point(value.position) && list(value.columns, column) && optional(value.indexes, (items) => list(items, index))
		&& optional(value.uniqueConstraints, (items) => list(items, unique)) && isBoolean(value.rowLevelSecurity) && list(value.policies, policy);
	const relationship = (value: any) =>
		isObject(value) && [value.id, value.cardinality, value.referencingTableId, value.referencingColumnId, value.referencedTableId].every(isString)
		&& optional(value.onDelete, isString) && optional(value.onUpdate, isString);
	const association = (value: any) =>
		isObject(value) && [value.id, value.leftTableId, value.rightTableId, value.junctionTableId, value.leftRelationshipId, value.rightRelationshipId].every(isString);
	const enumType = (value: any) => isObject(value) && isString(value.id) && isString(value.name) && strings(value.labels);
	const raw = (value: any) => isObject(value) && isString(value.id) && isString(value.sql) && isString(value.phase) && optional(value.creates, isString) && optional(value.attachedTo, isString);
	if (!isObject(design)) return "design";
	if (!list(design.tables, table)) return "tables";
	if (!list(design.relationships, relationship)) return "relationships";
	if (!list(design.manyToManyRelationships, association)) return "manyToManyRelationships";
	if (!(isObject(design.viewport) && [design.viewport.x, design.viewport.y, design.viewport.zoom].every(isNumber))) return "viewport";
	if (!optional(design.enumTypes, (items) => list(items, enumType))) return "enumTypes";
	if (!optional(design.rawStatements, (items) => list(items, raw))) return "rawStatements";
	return null;
}

/** Imports whose Scenarios and Edge functions are valid, repeated, mis-named or missing a source. */
function sourceVariants(exported: any): unknown[] {
	const withSources = (scenarios: unknown, edgeFunctions: unknown) => ({
		...exported,
		designs: exported.designs.map((entry: any, index: number) => (index === 0 ? { ...entry, scenarios, edgeFunctions } : entry)),
	});
	const scenario = (id: string, name: string, source = "export default async () => {}") => ({ id, name, source });
	const edge = (id: string, name: string, source = "export default () => new Response('ok')") => ({ id, name, source });
	return [
		withSources([scenario("s1", "Happy path"), scenario("s2", "  Padded name  ")], [edge("f1", "hello"), edge("f2", "with-dash_and_9")]),
		withSources([scenario("s1", "Same id"), scenario("s1", "Other")], []),
		withSources([scenario("s1", "x".repeat(80))], []),
		withSources([scenario("s1", "x".repeat(81))], []),
		withSources([scenario("s1", "é".repeat(80))], []),
		withSources([scenario("s1", "💥".repeat(41))], []),
		withSources([scenario("s1", "   ")], []),
		withSources([scenario("", "No id")], []),
		withSources([{ id: "s1", name: "No source" }], []),
		withSources([], [edge("f1", "Upper")]),
		withSources([], [edge("f1", "has space")]),
		withSources([], [edge("f1", "same"), edge("f2", "same")]),
		withSources([], [edge("f1", "one"), edge("f1", "two")]),
		withSources([], [edge("f1", "")]),
		withSources([], [{ id: "f1", name: "no-source" }]),
		withSources([], [edge("f1", "é")]),
		withSources(scenario("s1", "not a list"), []),
		withSources([], "not a list"),
		withSources([scenario("s1", "Fine")], [edge("f1", "fine")]),
	];
}

/** Engine-specific messages from malformed input to the original's unchecked code: no other engine words them alike. */
const ENGINE_ERROR = /Spread syntax|Type error|is not an object|is not a function|is not iterable|\(In '|evaluating '/;

/**
 * Exporting a Project and importing it, then importing the same file damaged in many ways. A damaged
 * file is kept only when the original answers it the same way anywhere: accepted, or refused with a
 * message of its own, without writing anything. Input that makes the JavaScript engine itself throw
 * (an unchecked `.map` on a missing list) is dropped, as its message belongs to the engine.
 */
export async function transferScript(): Promise<Script> {
	const prefix: Script = [
			open, add("orders"), add("customers"), addColumn("orders", "total", "numeric"), addColumn("orders", "status"),
			(state) => ({ method: "addRelationship", params: { ...on(state), referencingTableId: table(state, "orders").id, referencedTableId: table(state, "customers").id } }),
			(state) => ({ method: "updateEnumTypes", params: { ...on(state), enumTypes: [{ id: "e1", name: "state", labels: ["open", "closed"] }] } }),
			(state) => ({ method: "updateFunctions", params: { ...on(state), functions: [triggerFunction, { id: "fn-sum", name: "sum_orders", arguments: [], returnType: "numeric", returnsSet: false, language: "sql", volatility: "stable", security: "invoker", body: "SELECT sum(total) FROM orders" }] } }),
			(state) => ({
				method: "updateTriggers",
				params: { ...on(state), triggers: [{ id: "tr-1", name: "touch_orders", tableId: table(state, "orders").id, timing: "BEFORE", events: [{ event: "UPDATE", columnIds: [column(state, "orders", "status").id] }], level: "ROW", functionId: "fn-touch", when: "" }] },
			}),
			(state) => ({ method: "updateIndexes", params: { ...on(state), tableId: table(state, "orders").id, indexes: [{ id: "ix-1", name: "by_total", method: "btree", keys: [{ columnId: column(state, "orders", "total").id }], with: { fillfactor: 70 } }] } }),
			(state) => ({ method: "updatePolicies", params: { ...on(state), tableId: table(state, "customers").id, rowLevelSecurity: true, policies: [{ id: "p1", name: "read", command: "SELECT", roles: ["anon"], mode: "permissive", using: "true", withCheck: "" }] } }),
			(state) => ({ method: "createDesign", params: { name: "Reporting" } }),
			add("facts"),
			(state) => ({ method: "addSystemService", params: { x: 0, y: 0, name: "Backend" } }),
			(state) => ({ method: "addSystemComponent", params: { x: 20, y: 20, kind: "database", name: "Primary", serviceId: state.systemDesign!.services[0]!.id } }),
			(state) => ({ method: "addSystemComponent", params: { x: 300, y: 20, kind: "api", name: "Gateway" } }),
			(state) => ({ method: "linkSystemDatabase", params: { componentId: state.systemDesign!.components[0]!.id, designId: state.designs[1]!.id } }),
			(state) => ({ method: "addSystemConnection", params: { sourceId: state.systemDesign!.components[1]!.id, targetId: state.systemDesign!.components[0]!.id, label: "reads", protocol: "SQL" } }),
			(state) => ({ method: "createWalkthrough", params: { name: "Checkout" } }),
			(state) => ({ method: "addWalkthroughStep", params: { walkthroughId: state.walkthroughs[0]!.id, connectionId: state.systemDesign!.connections[0]!.id, title: "Read", action: "send" } }),
			(state) => ({ method: "setActiveView", params: { view: "database" } }),
	];
	const scratch = async (run: (driver: Awaited<ReturnType<typeof openDriver>>) => Promise<unknown>) => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-scratch-"));
		try {
			const driver = await openDriver(directory);
			const result = await run(driver);
			await driver.close();
			return result;
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	};
	const exported = (await scratch(async (driver) => {
		let last: StepOutcome | undefined;
		for (const [index, step] of prefix.entries()) {
			const call = step(driver.workspace.getState(), last);
			last = (await driver.run(call.method, JSON.parse(JSON.stringify(call.params)), index)).outcome;
		}
		const final = await driver.run("exportProject", {}, prefix.length);
		return (final.outcome as { ok: { value: unknown } }).ok.value;
	})) as any;

	const accepted: unknown[] = [];
	for (let seed = 1; accepted.length < 160 && seed < 2000; seed += 1) {
		const rng = seededRng(seed * 9973);
		const copy = structuredClone(exported);
		for (let times = 1 + Math.floor(rng() * 3); times > 0; times -= 1) mutateOnce(copy, rng);
		// A Function's recorded dependencies that are not a list are spread into characters by the original.
		const odd = (copy.designs ?? []).some((entry: any) => Array.isArray(entry?.design?.functions) && entry.design.functions.some((fn: any) => fn && fn.tableDependencies !== undefined && !Array.isArray(fn.tableDependencies)));
		if (odd) continue;
		const clean = await scratch(async (driver) => {
			const { outcome } = await driver.run("importProject", JSON.parse(JSON.stringify(copy)), 0);
			if ("error" in outcome) return !ENGINE_ERROR.test(outcome.error) && driver.workspace.getState().projects.length === 0;
			const stored = (await driver.run("exportProject", {}, 1)).outcome as { ok: { value: any } };
			return stored.ok.value.designs.every((entry: any) => typedDesignProblem(entry.design) === null);
		});
		if (clean) accepted.push(copy);
	}
	return [
		...prefix,
			() => ({ method: "exportProject", params: {} }),
			() => ({ method: "importProject", params: exported }),
			() => ({ method: "exportProject", params: {} }),
			() => ({ method: "importProject", params: { ...exported, version: 2 } }),
			() => ({ method: "importProject", params: { ...exported, version: "1" } }),
			() => ({ method: "importProject", params: { ...exported, format: "other" } }),
			() => ({ method: "importProject", params: [] }),
			() => ({ method: "importProject", params: null }),
			() => ({ method: "importProject", params: { ...exported, designs: [] } }),
			() => ({ method: "importProject", params: { ...exported, project: { ...exported.project, activeDesignId: "nope" } } }),
			() => ({ method: "importProject", params: { ...exported, designs: [exported.designs[0], exported.designs[0]] } }),
			// Scenarios and Edge functions: the checks on names, identities and sources.
			...sourceVariants(exported).map((document) => (): Call => ({ method: "importProject", params: document })),
			...accepted.map((document) => (): Call => ({ method: "importProject", params: document })),
			() => ({ method: "exportProject", params: {} }),
	];
}
