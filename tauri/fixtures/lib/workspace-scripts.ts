/**
 * Hand-written sessions for the interplay random calls rarely line up: an enum a column uses, an
 * index that includes a column that is then removed, a trigger that fires on a column's update.
 * Each step reads ids from the live state, so a script is a list of intentions.
 */
import type { WorkspaceState } from "../../../src/shared/design";

export type Call = { method: string; params: unknown };
export type Script = Array<(state: WorkspaceState) => Call>;

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
};
