import type {
	Design,
	DesignEnumType,
	DesignFunction,
	DesignRelationship,
	DesignTable,
	DesignTrigger,
	EdgeFunction,
	Scenario,
	WorkspaceState,
} from "../shared/design";
import type { StoredScenario } from "./store";
import { keepSystemGroupMembers, type SystemComponent, type SystemConnection, type SystemContent, type SystemGroup, type SystemService } from "../shared/system-design";

type Node = Record<string, any>;
const nameOf = (node: Node | undefined): string | undefined => node?.relname ?? node?.RangeVar?.relname;
const nodeName = (node: Node | undefined): string | undefined => node?.String?.sval ?? node?.sval ?? node?.name;

export type RestorationResult =
	| {
			ok: true;
			design: Design;
			scenarios: StoredScenario[];
			edgeFunctions: EdgeFunction[];
			/** Present when the turn changed Components or Connections. Services and Groups are kept as they are now. */
			systemDesign?: { services: SystemService[]; groups: SystemGroup[]; components: SystemComponent[]; connections: SystemConnection[] };
	  }
	| {
			ok: false;
			conflicts: string[];
	  };

export class TurnTracker {
	readonly turnId: string;
	readonly projectId: string;

	// Tables
	readonly addedTableIds = new Set<string>();
	readonly removedTables = new Map<string, DesignTable>();
	readonly modifiedTables = new Map<string, { before: DesignTable; after: DesignTable }>();
	readonly addedTablesSnapshot = new Map<string, DesignTable>();

	// Enum Types
	readonly addedEnumIds = new Set<string>();
	readonly removedEnums = new Map<string, DesignEnumType>();
	readonly modifiedEnums = new Map<string, { before: DesignEnumType; after: DesignEnumType }>();
	readonly addedEnumsSnapshot = new Map<string, DesignEnumType>();

	// Functions
	readonly addedFunctionIds = new Set<string>();
	readonly removedFunctions = new Map<string, DesignFunction>();
	readonly modifiedFunctions = new Map<string, { before: DesignFunction; after: DesignFunction }>();
	readonly addedFunctionsSnapshot = new Map<string, DesignFunction>();

	// Triggers
	readonly addedTriggerIds = new Set<string>();
	readonly removedTriggers = new Map<string, DesignTrigger>();
	readonly modifiedTriggers = new Map<string, { before: DesignTrigger; after: DesignTrigger }>();
	readonly addedTriggersSnapshot = new Map<string, DesignTrigger>();

	// Relationships
	readonly addedRelationshipIds = new Set<string>();
	readonly removedRelationships = new Map<string, DesignRelationship>();
	readonly modifiedRelationships = new Map<string, { before: DesignRelationship; after: DesignRelationship }>();
	readonly addedRelationshipsSnapshot = new Map<string, DesignRelationship>();

	// Scenarios
	readonly addedScenarioIds = new Set<string>();
	readonly removedScenarios = new Map<string, StoredScenario>();
	readonly modifiedScenarios = new Map<string, { before: StoredScenario; after: StoredScenario }>();
	readonly addedScenariosSnapshot = new Map<string, StoredScenario>();

	// Edge Functions
	readonly addedEdgeFunctionIds = new Set<string>();
	readonly removedEdgeFunctions = new Map<string, EdgeFunction>();
	readonly modifiedEdgeFunctions = new Map<string, { before: EdgeFunction; after: EdgeFunction }>();
	readonly addedEdgeFunctionsSnapshot = new Map<string, EdgeFunction>();

	/**
	 * System design Components and Connections the turn changed, keyed by kind and
	 * id. `original` is the value before the turn (null when the turn added it);
	 * `last` is the value the turn left (null when the turn removed it).
	 */
	readonly systemChanges = new Map<string, {
		kind: "component" | "connection";
		id: string;
		original: SystemComponent | SystemConnection | null;
		last: SystemComponent | SystemConnection | null;
	}>();

	constructor(turnId: string, projectId: string) {
		this.turnId = turnId;
		this.projectId = projectId;
	}

	/** Records one Assistant edit to the System design; net-zero changes leave no trace. */
	recordSystemMutation(before: SystemContent, after: SystemContent) {
		const compare = (kind: "component" | "connection", previous: (SystemComponent | SystemConnection)[], next: (SystemComponent | SystemConnection)[]) => {
			const ids = new Set([...previous.map((item) => item.id), ...next.map((item) => item.id)]);
			for (const id of ids) {
				const prior = previous.find((item) => item.id === id) ?? null;
				const latest = next.find((item) => item.id === id) ?? null;
				if (JSON.stringify(prior) === JSON.stringify(latest)) continue;
				const key = `${kind}:${id}`;
				const existing = this.systemChanges.get(key);
				const entry = existing ?? { kind, id, original: structuredClone(prior), last: null };
				entry.last = structuredClone(latest);
				if (JSON.stringify(entry.original) === JSON.stringify(entry.last)) this.systemChanges.delete(key);
				else this.systemChanges.set(key, entry);
			}
		};
		compare("component", before.components, after.components);
		compare("connection", before.connections, after.connections);
	}

	recordDesignMutation(before: Design, after: Design) {
		// Tables added or modified
		for (const table of after.tables) {
			const prev = before.tables.find((t) => t.id === table.id);
			if (!prev) {
				if (this.removedTables.has(table.id)) {
					const orig = this.removedTables.get(table.id)!;
					this.removedTables.delete(table.id);
					if (JSON.stringify(orig) !== JSON.stringify(table)) {
						this.modifiedTables.set(table.id, { before: orig, after: structuredClone(table) });
					}
				} else {
					this.addedTableIds.add(table.id);
					this.addedTablesSnapshot.set(table.id, structuredClone(table));
				}
			} else if (JSON.stringify(prev) !== JSON.stringify(table)) {
				if (this.addedTableIds.has(table.id)) {
					this.addedTablesSnapshot.set(table.id, structuredClone(table));
				} else if (this.modifiedTables.has(table.id)) {
					const existing = this.modifiedTables.get(table.id)!;
					this.modifiedTables.set(table.id, { before: existing.before, after: structuredClone(table) });
				} else {
					this.modifiedTables.set(table.id, { before: structuredClone(prev), after: structuredClone(table) });
				}
			}
		}

		// Tables removed
		for (const table of before.tables) {
			if (!after.tables.some((t) => t.id === table.id)) {
				if (this.addedTableIds.has(table.id)) {
					this.addedTableIds.delete(table.id);
					this.addedTablesSnapshot.delete(table.id);
				} else if (this.modifiedTables.has(table.id)) {
					const existing = this.modifiedTables.get(table.id)!;
					this.modifiedTables.delete(table.id);
					this.removedTables.set(table.id, existing.before);
				} else {
					this.removedTables.set(table.id, structuredClone(table));
				}
			}
		}

		// Relationships
		for (const rel of after.relationships) {
			const prev = before.relationships.find((r) => r.id === rel.id);
			if (!prev) {
				if (this.removedRelationships.has(rel.id)) {
					const orig = this.removedRelationships.get(rel.id)!;
					this.removedRelationships.delete(rel.id);
					if (JSON.stringify(orig) !== JSON.stringify(rel)) {
						this.modifiedRelationships.set(rel.id, { before: orig, after: structuredClone(rel) });
					}
				} else {
					this.addedRelationshipIds.add(rel.id);
					this.addedRelationshipsSnapshot.set(rel.id, structuredClone(rel));
				}
			} else if (JSON.stringify(prev) !== JSON.stringify(rel)) {
				if (this.addedRelationshipIds.has(rel.id)) {
					this.addedRelationshipsSnapshot.set(rel.id, structuredClone(rel));
				} else if (this.modifiedRelationships.has(rel.id)) {
					const existing = this.modifiedRelationships.get(rel.id)!;
					this.modifiedRelationships.set(rel.id, { before: existing.before, after: structuredClone(rel) });
				} else {
					this.modifiedRelationships.set(rel.id, { before: structuredClone(prev), after: structuredClone(rel) });
				}
			}
		}
		for (const rel of before.relationships) {
			if (!after.relationships.some((r) => r.id === rel.id)) {
				if (this.addedRelationshipIds.has(rel.id)) {
					this.addedRelationshipIds.delete(rel.id);
					this.addedRelationshipsSnapshot.delete(rel.id);
				} else if (this.modifiedRelationships.has(rel.id)) {
					const existing = this.modifiedRelationships.get(rel.id)!;
					this.modifiedRelationships.delete(rel.id);
					this.removedRelationships.set(rel.id, existing.before);
				} else {
					this.removedRelationships.set(rel.id, structuredClone(rel));
				}
			}
		}

		// Enum Types
		for (const enumType of after.enumTypes ?? []) {
			const prev = (before.enumTypes ?? []).find((e) => e.id === enumType.id);
			if (!prev) {
				if (this.removedEnums.has(enumType.id)) {
					const orig = this.removedEnums.get(enumType.id)!;
					this.removedEnums.delete(enumType.id);
					if (JSON.stringify(orig) !== JSON.stringify(enumType)) {
						this.modifiedEnums.set(enumType.id, { before: orig, after: structuredClone(enumType) });
					}
				} else {
					this.addedEnumIds.add(enumType.id);
					this.addedEnumsSnapshot.set(enumType.id, structuredClone(enumType));
				}
			} else if (JSON.stringify(prev) !== JSON.stringify(enumType)) {
				if (this.addedEnumIds.has(enumType.id)) {
					this.addedEnumsSnapshot.set(enumType.id, structuredClone(enumType));
				} else if (this.modifiedEnums.has(enumType.id)) {
					const existing = this.modifiedEnums.get(enumType.id)!;
					this.modifiedEnums.set(enumType.id, { before: existing.before, after: structuredClone(enumType) });
				} else {
					this.modifiedEnums.set(enumType.id, { before: structuredClone(prev), after: structuredClone(enumType) });
				}
			}
		}
		for (const enumType of before.enumTypes ?? []) {
			if (!(after.enumTypes ?? []).some((e) => e.id === enumType.id)) {
				if (this.addedEnumIds.has(enumType.id)) {
					this.addedEnumIds.delete(enumType.id);
					this.addedEnumsSnapshot.delete(enumType.id);
				} else if (this.modifiedEnums.has(enumType.id)) {
					const existing = this.modifiedEnums.get(enumType.id)!;
					this.modifiedEnums.delete(enumType.id);
					this.removedEnums.set(enumType.id, existing.before);
				} else {
					this.removedEnums.set(enumType.id, structuredClone(enumType));
				}
			}
		}

		// Functions
		for (const fn of after.functions ?? []) {
			const prev = (before.functions ?? []).find((f) => f.id === fn.id);
			if (!prev) {
				if (this.removedFunctions.has(fn.id)) {
					const orig = this.removedFunctions.get(fn.id)!;
					this.removedFunctions.delete(fn.id);
					if (JSON.stringify(orig) !== JSON.stringify(fn)) {
						this.modifiedFunctions.set(fn.id, { before: orig, after: structuredClone(fn) });
					}
				} else {
					this.addedFunctionIds.add(fn.id);
					this.addedFunctionsSnapshot.set(fn.id, structuredClone(fn));
				}
			} else if (JSON.stringify(prev) !== JSON.stringify(fn)) {
				if (this.addedFunctionIds.has(fn.id)) {
					this.addedFunctionsSnapshot.set(fn.id, structuredClone(fn));
				} else if (this.modifiedFunctions.has(fn.id)) {
					const existing = this.modifiedFunctions.get(fn.id)!;
					this.modifiedFunctions.set(fn.id, { before: existing.before, after: structuredClone(fn) });
				} else {
					this.modifiedFunctions.set(fn.id, { before: structuredClone(prev), after: structuredClone(fn) });
				}
			}
		}
		for (const fn of before.functions ?? []) {
			if (!(after.functions ?? []).some((f) => f.id === fn.id)) {
				if (this.addedFunctionIds.has(fn.id)) {
					this.addedFunctionIds.delete(fn.id);
					this.addedFunctionsSnapshot.delete(fn.id);
				} else if (this.modifiedFunctions.has(fn.id)) {
					const existing = this.modifiedFunctions.get(fn.id)!;
					this.modifiedFunctions.delete(fn.id);
					this.removedFunctions.set(fn.id, existing.before);
				} else {
					this.removedFunctions.set(fn.id, structuredClone(fn));
				}
			}
		}

		// Triggers
		for (const tr of after.triggers ?? []) {
			const prev = (before.triggers ?? []).find((t) => t.id === tr.id);
			if (!prev) {
				if (this.removedTriggers.has(tr.id)) {
					const orig = this.removedTriggers.get(tr.id)!;
					this.removedTriggers.delete(tr.id);
					if (JSON.stringify(orig) !== JSON.stringify(tr)) {
						this.modifiedTriggers.set(tr.id, { before: orig, after: structuredClone(tr) });
					}
				} else {
					this.addedTriggerIds.add(tr.id);
					this.addedTriggersSnapshot.set(tr.id, structuredClone(tr));
				}
			} else if (JSON.stringify(prev) !== JSON.stringify(tr)) {
				if (this.addedTriggerIds.has(tr.id)) {
					this.addedTriggersSnapshot.set(tr.id, structuredClone(tr));
				} else if (this.modifiedTriggers.has(tr.id)) {
					const existing = this.modifiedTriggers.get(tr.id)!;
					this.modifiedTriggers.set(tr.id, { before: existing.before, after: structuredClone(tr) });
				} else {
					this.modifiedTriggers.set(tr.id, { before: structuredClone(prev), after: structuredClone(tr) });
				}
			}
		}
		for (const tr of before.triggers ?? []) {
			if (!(after.triggers ?? []).some((t) => t.id === tr.id)) {
				if (this.addedTriggerIds.has(tr.id)) {
					this.addedTriggerIds.delete(tr.id);
					this.addedTriggersSnapshot.delete(tr.id);
				} else if (this.modifiedTriggers.has(tr.id)) {
					const existing = this.modifiedTriggers.get(tr.id)!;
					this.modifiedTriggers.delete(tr.id);
					this.removedTriggers.set(tr.id, existing.before);
				} else {
					this.removedTriggers.set(tr.id, structuredClone(tr));
				}
			}
		}
	}

	recordScenarioCreated(scenario: StoredScenario) {
		this.addedScenarioIds.add(scenario.id);
		this.addedScenariosSnapshot.set(scenario.id, structuredClone(scenario));
	}

	recordScenarioModified(before: StoredScenario, after: StoredScenario) {
		if (this.addedScenarioIds.has(before.id)) {
			this.addedScenariosSnapshot.set(before.id, structuredClone(after));
		} else if (this.modifiedScenarios.has(before.id)) {
			const existing = this.modifiedScenarios.get(before.id)!;
			this.modifiedScenarios.set(before.id, { before: existing.before, after: structuredClone(after) });
		} else {
			this.modifiedScenarios.set(before.id, { before: structuredClone(before), after: structuredClone(after) });
		}
	}

	recordScenarioRemoved(scenario: StoredScenario) {
		if (this.addedScenarioIds.has(scenario.id)) {
			this.addedScenarioIds.delete(scenario.id);
			this.addedScenariosSnapshot.delete(scenario.id);
		} else if (this.modifiedScenarios.has(scenario.id)) {
			const existing = this.modifiedScenarios.get(scenario.id)!;
			this.modifiedScenarios.delete(scenario.id);
			this.removedScenarios.set(scenario.id, existing.before);
		} else {
			this.removedScenarios.set(scenario.id, structuredClone(scenario));
		}
	}

	recordEdgeFunctionCreated(edge: EdgeFunction) {
		this.addedEdgeFunctionIds.add(edge.id);
		this.addedEdgeFunctionsSnapshot.set(edge.id, structuredClone(edge));
	}

	recordEdgeFunctionModified(before: EdgeFunction, after: EdgeFunction) {
		if (this.addedEdgeFunctionIds.has(before.id)) {
			this.addedEdgeFunctionsSnapshot.set(before.id, structuredClone(after));
		} else if (this.modifiedEdgeFunctions.has(before.id)) {
			const existing = this.modifiedEdgeFunctions.get(before.id)!;
			this.modifiedEdgeFunctions.set(before.id, { before: existing.before, after: structuredClone(after) });
		} else {
			this.modifiedEdgeFunctions.set(before.id, { before: structuredClone(before), after: structuredClone(after) });
		}
	}

	recordEdgeFunctionRemoved(edge: EdgeFunction) {
		if (this.addedEdgeFunctionIds.has(edge.id)) {
			this.addedEdgeFunctionIds.delete(edge.id);
			this.addedEdgeFunctionsSnapshot.delete(edge.id);
		} else if (this.modifiedEdgeFunctions.has(edge.id)) {
			const existing = this.modifiedEdgeFunctions.get(edge.id)!;
			this.modifiedEdgeFunctions.delete(edge.id);
			this.removedEdgeFunctions.set(edge.id, existing.before);
		} else {
			this.removedEdgeFunctions.set(edge.id, structuredClone(edge));
		}
	}

	hasChanges(): boolean {
		return (
			this.systemChanges.size > 0 ||
			this.addedTableIds.size > 0 ||
			this.removedTables.size > 0 ||
			this.modifiedTables.size > 0 ||
			this.addedEnumIds.size > 0 ||
			this.removedEnums.size > 0 ||
			this.modifiedEnums.size > 0 ||
			this.addedFunctionIds.size > 0 ||
			this.removedFunctions.size > 0 ||
			this.modifiedFunctions.size > 0 ||
			this.addedTriggerIds.size > 0 ||
			this.removedTriggers.size > 0 ||
			this.modifiedTriggers.size > 0 ||
			this.addedRelationshipIds.size > 0 ||
			this.removedRelationships.size > 0 ||
			this.modifiedRelationships.size > 0 ||
			this.addedScenarioIds.size > 0 ||
			this.removedScenarios.size > 0 ||
			this.modifiedScenarios.size > 0 ||
			this.addedEdgeFunctionIds.size > 0 ||
			this.removedEdgeFunctions.size > 0 ||
			this.modifiedEdgeFunctions.size > 0
		);
	}

	computeRestoration(currentState: WorkspaceState): RestorationResult {
		const conflicts: string[] = [];

		// 1. Scenarios conflict checks
		for (const id of this.addedScenarioIds) {
			const current = currentState.scenarios.find((s) => s.id === id);
			if (current) {
				const snapshot = this.addedScenariosSnapshot.get(id);
				if (snapshot && (current.source !== snapshot.source || current.name !== snapshot.name)) {
					conflicts.push(`Scenario "${current.name}" was modified after this turn`);
				}
			}
		}
		for (const [id, { before, after }] of this.modifiedScenarios) {
			const current = currentState.scenarios.find((s) => s.id === id);
			if (!current) {
				conflicts.push(`Scenario "${before.name}" was removed after this turn`);
			} else if (current.source !== after.source || current.name !== after.name) {
				conflicts.push(`Scenario "${current.name}" was modified after this turn`);
			}
		}
		for (const [, removed] of this.removedScenarios) {
			if (currentState.scenarios.some((s) => s.name === removed.name)) {
				conflicts.push(`Scenario "${removed.name}" already exists`);
			}
		}

		// 2. Edge Functions conflict checks
		for (const id of this.addedEdgeFunctionIds) {
			const current = currentState.edgeFunctions.find((e) => e.id === id);
			if (current) {
				const snapshot = this.addedEdgeFunctionsSnapshot.get(id);
				if (snapshot && (current.source !== snapshot.source || current.name !== snapshot.name)) {
					conflicts.push(`Edge function "${current.name}" was modified after this turn`);
				}
			}
		}
		for (const [id, { before, after }] of this.modifiedEdgeFunctions) {
			const current = currentState.edgeFunctions.find((e) => e.id === id);
			if (!current) {
				conflicts.push(`Edge function "${before.name}" was removed after this turn`);
			} else if (current.source !== after.source || current.name !== after.name) {
				conflicts.push(`Edge function "${current.name}" was modified after this turn`);
			}
		}
		for (const [, removed] of this.removedEdgeFunctions) {
			if (currentState.edgeFunctions.some((e) => e.name === removed.name)) {
				conflicts.push(`Edge function "${removed.name}" already exists`);
			}
		}

		// 3. Design conflict checks
		const currentDesign = currentState.design;
		if (!currentDesign) {
			return { ok: false, conflicts: ["No design currently open"] };
		}

		for (const tableId of this.addedTableIds) {
			const currentTable = currentDesign.tables.find((t) => t.id === tableId);
			if (currentTable) {
				// Referencing foreign keys
				for (const rel of currentDesign.relationships) {
					if (this.addedRelationshipIds.has(rel.id)) continue;
					if (rel.referencedTableId === tableId) {
						const referencingTable = currentDesign.tables.find((t) => t.id === rel.referencingTableId);
						conflicts.push(`table "${currentTable.name}" is referenced by foreign key on table "${referencingTable?.name ?? "unknown"}"`);
					}
					if (rel.referencingTableId === tableId) {
						const referencedTable = currentDesign.tables.find((t) => t.id === rel.referencedTableId);
						conflicts.push(`table "${currentTable.name}" has a foreign key referencing table "${referencedTable?.name ?? "unknown"}"`);
					}
				}
				// Manual triggers attached to this table
				for (const tr of currentDesign.triggers ?? []) {
					if (this.addedTriggerIds.has(tr.id)) continue;
					if (tr.tableId === tableId) {
						conflicts.push(`table "${currentTable.name}" has trigger "${tr.name}"`);
					}
				}
				// Modified manually after turn
				const snapshot = this.addedTablesSnapshot.get(tableId);
				if (snapshot && JSON.stringify(currentTable) !== JSON.stringify(snapshot)) {
					conflicts.push(`table "${currentTable.name}" was modified after this turn`);
				}
			}
		}

		for (const [tableId, { before, after }] of this.modifiedTables) {
			const currentTable = currentDesign.tables.find((t) => t.id === tableId);
			if (!currentTable) {
				conflicts.push(`table "${before.name}" was removed after this turn`);
			} else {
				const addedCols = after.columns.filter((c) => !before.columns.some((b) => b.id === c.id));
				for (const col of addedCols) {
					const curCol = currentTable.columns.find((c) => c.id === col.id);
					if (curCol) {
						for (const rel of currentDesign.relationships) {
							if (this.addedRelationshipIds.has(rel.id)) continue;
							if (rel.referencingColumnId === col.id || (rel.referencedTableId === currentTable.id && col.primaryKey)) {
								conflicts.push(`column "${currentTable.name}.${col.name}" is referenced by a relationship`);
							}
						}
						// Index covering this column
						const assistantAddedIndexIds = new Set(
							(after.indexes ?? []).filter((idx) => !(before.indexes ?? []).some((b) => b.id === idx.id)).map((idx) => idx.id),
						);
						for (const idx of currentTable.indexes ?? []) {
							if (!assistantAddedIndexIds.has(idx.id) && idx.keys.some((k) => k.columnId === col.id)) {
								conflicts.push(`column "${currentTable.name}.${col.name}" is covered by index "${idx.name}"`);
							}
						}
						// Unique constraint covering this column
						const assistantAddedUcIds = new Set(
							(after.uniqueConstraints ?? []).filter((u) => !(before.uniqueConstraints ?? []).some((b) => b.id === u.id)).map((u) => u.id),
						);
						for (const uc of currentTable.uniqueConstraints ?? []) {
							if (!assistantAddedUcIds.has(uc.id) && uc.columnIds.includes(col.id)) {
								conflicts.push(`column "${currentTable.name}.${col.name}" is covered by unique constraint "${uc.name}"`);
							}
						}
						// Trigger referencing this column
						for (const tr of currentDesign.triggers ?? []) {
							if (!this.addedTriggerIds.has(tr.id) && tr.tableId === tableId && tr.events.some((e) => e.columnIds?.includes(col.id))) {
								conflicts.push(`column "${currentTable.name}.${col.name}" is referenced by trigger "${tr.name}"`);
							}
						}
						if (JSON.stringify(curCol) !== JSON.stringify(col)) {
							conflicts.push(`column "${currentTable.name}.${col.name}" was modified after this turn`);
						}
					}
				}
			}
		}

		// Relationships
		for (const relId of this.addedRelationshipIds) {
			const currentRel = currentDesign.relationships.find((r) => r.id === relId);
			if (currentRel) {
				const snapshot = this.addedRelationshipsSnapshot.get(relId);
				if (snapshot && JSON.stringify(currentRel) !== JSON.stringify(snapshot)) {
					conflicts.push("relationship was modified after this turn");
				}
			}
		}
		for (const [relId, { after }] of this.modifiedRelationships) {
			const currentRel = currentDesign.relationships.find((r) => r.id === relId);
			if (!currentRel) {
				conflicts.push("relationship was removed after this turn");
			} else if (JSON.stringify(currentRel) !== JSON.stringify(after)) {
				conflicts.push("relationship was modified after this turn");
			}
		}
		for (const [, removed] of this.removedRelationships) {
			const refTable = currentDesign.tables.find((t) => t.id === removed.referencingTableId);
			const targetTable = currentDesign.tables.find((t) => t.id === removed.referencedTableId);
			if (!refTable) {
				conflicts.push("referencing table for relationship does not exist");
			}
			if (!targetTable) {
				conflicts.push("referenced table for relationship does not exist");
			}
			if (refTable && !refTable.columns.some((c) => c.id === removed.referencingColumnId)) {
				conflicts.push("referencing column for relationship does not exist");
			}
		}

		// Enum Types
		for (const enumId of this.addedEnumIds) {
			const currentEnum = currentDesign.enumTypes?.find((e) => e.id === enumId);
			if (currentEnum) {
				const snapshot = this.addedEnumsSnapshot.get(enumId);
				if (snapshot && JSON.stringify(currentEnum) !== JSON.stringify(snapshot)) {
					conflicts.push(`enum type "${currentEnum.name}" was modified after this turn`);
				}
				for (const table of currentDesign.tables) {
					if (this.addedTableIds.has(table.id)) continue;
					for (const col of table.columns) {
						if (col.enumTypeId === enumId) {
							conflicts.push(`enum type "${currentEnum.name}" is used by column "${table.name}.${col.name}"`);
						}
					}
				}
			}
		}
		for (const [enumId, { before, after }] of this.modifiedEnums) {
			const currentEnum = currentDesign.enumTypes?.find((e) => e.id === enumId);
			if (!currentEnum) {
				conflicts.push(`enum type "${before.name}" was removed after this turn`);
			} else if (JSON.stringify(currentEnum) !== JSON.stringify(after)) {
				conflicts.push(`enum type "${currentEnum.name}" was modified after this turn`);
			}
		}
		for (const [, removed] of this.removedEnums) {
			if (currentDesign.enumTypes?.some((e) => e.name === removed.name)) {
				conflicts.push(`enum type "${removed.name}" already exists`);
			}
		}

		// Functions
		for (const fnId of this.addedFunctionIds) {
			const currentFn = currentDesign.functions?.find((f) => f.id === fnId);
			if (currentFn) {
				const snapshot = this.addedFunctionsSnapshot.get(fnId);
				if (snapshot && JSON.stringify(currentFn) !== JSON.stringify(snapshot)) {
					conflicts.push(`Function "${currentFn.name}" was modified after this turn`);
				}
				for (const tr of currentDesign.triggers ?? []) {
					if (this.addedTriggerIds.has(tr.id)) continue;
					if (tr.functionId === fnId) {
						conflicts.push(`Function "${currentFn.name}" is used by trigger "${tr.name}"`);
					}
				}
			}
		}
		for (const [fnId, { before, after }] of this.modifiedFunctions) {
			const currentFn = currentDesign.functions?.find((f) => f.id === fnId);
			if (!currentFn) {
				conflicts.push(`Function "${before.name}" was removed after this turn`);
			} else if (JSON.stringify(currentFn) !== JSON.stringify(after)) {
				conflicts.push(`Function "${currentFn.name}" was modified after this turn`);
			}
		}
		for (const [, removed] of this.removedFunctions) {
			if (currentDesign.functions?.some((f) => f.name === removed.name)) {
				conflicts.push(`Function "${removed.name}" already exists`);
			}
		}

		// Triggers
		for (const trId of this.addedTriggerIds) {
			const currentTr = currentDesign.triggers?.find((t) => t.id === trId);
			if (currentTr) {
				const snapshot = this.addedTriggersSnapshot.get(trId);
				if (snapshot && JSON.stringify(currentTr) !== JSON.stringify(snapshot)) {
					conflicts.push(`trigger "${currentTr.name}" was modified after this turn`);
				}
			}
		}
		for (const [trId, { before, after }] of this.modifiedTriggers) {
			const currentTr = currentDesign.triggers?.find((t) => t.id === trId);
			if (!currentTr) {
				conflicts.push(`trigger "${before.name}" was removed after this turn`);
			} else if (JSON.stringify(currentTr) !== JSON.stringify(after)) {
				conflicts.push(`trigger "${currentTr.name}" was modified after this turn`);
			}
		}
		for (const [, removed] of this.removedTriggers) {
			const targetTable = currentDesign.tables.find((t) => t.id === removed.tableId);
			if (!targetTable) {
				conflicts.push(`table for trigger "${removed.name}" does not exist`);
			}
			const targetFn = currentDesign.functions?.find((f) => f.id === removed.functionId);
			if (!targetFn) {
				conflicts.push(`function for trigger "${removed.name}" does not exist`);
			}
			if (targetTable && (currentDesign.triggers ?? []).some((t) => t.tableId === removed.tableId && t.name === removed.name)) {
				conflicts.push(`trigger "${removed.name}" already exists`);
			}
		}

		// Removed tables
		for (const [, removed] of this.removedTables) {
			if (currentDesign.tables.some((t) => t.name === removed.name)) {
				conflicts.push(`table "${removed.name}" already exists`);
			}
		}

		if (conflicts.length > 0) {
			return { ok: false, conflicts };
		}

		// Compute restored scenarios
		const restoredScenarios: StoredScenario[] = currentState.scenarios
			.filter((s) => !this.addedScenarioIds.has(s.id))
			.map((s) => {
				const modified = this.modifiedScenarios.get(s.id);
				return modified ? structuredClone(modified.before) : structuredClone(s);
			});
		for (const removed of this.removedScenarios.values()) {
			restoredScenarios.push(structuredClone(removed));
		}

		// Compute restored edge functions
		const restoredEdgeFunctions: EdgeFunction[] = currentState.edgeFunctions
			.filter((e) => !this.addedEdgeFunctionIds.has(e.id))
			.map((e) => {
				const modified = this.modifiedEdgeFunctions.get(e.id);
				return modified ? structuredClone(modified.before) : structuredClone(e);
			});
		for (const removed of this.removedEdgeFunctions.values()) {
			restoredEdgeFunctions.push(structuredClone(removed));
		}

		// Compute restored design
		const restoredTables: DesignTable[] = currentDesign.tables
			.filter((t) => !this.addedTableIds.has(t.id))
			.map((t) => {
				const modified = this.modifiedTables.get(t.id);
				if (!modified) return structuredClone(t);
				const { before, after } = modified;
				const assistantAddedColIds = new Set(
					after.columns
						.filter((c) => !before.columns.some((b) => b.id === c.id))
						.map((c) => c.id),
				);
				const assistantRemovedCols = before.columns.filter(
					(b) => !after.columns.some((c) => c.id === b.id),
				);
				const columns = t.columns
					.filter((c) => !assistantAddedColIds.has(c.id))
					.map((c) => {
						const beforeCol = before.columns.find((b) => b.id === c.id);
						const afterCol = after.columns.find((a) => a.id === c.id);
						if (beforeCol && afterCol && JSON.stringify(beforeCol) !== JSON.stringify(afterCol)) {
							return structuredClone(beforeCol);
						}
						return structuredClone(c);
					});
				for (const restoredCol of assistantRemovedCols) {
					columns.push(structuredClone(restoredCol));
				}

				// Indexes: remove assistant-added indexes, restore assistant-removed indexes, keep manual indexes
				const assistantAddedIndexIds = new Set(
					(after.indexes ?? [])
						.filter((idx) => !(before.indexes ?? []).some((b) => b.id === idx.id))
						.map((idx) => idx.id),
				);
				const assistantRemovedIndexes = (before.indexes ?? []).filter(
					(b) => !(after.indexes ?? []).some((idx) => idx.id === b.id),
				);
				const indexes = (t.indexes ?? []).filter((idx) => !assistantAddedIndexIds.has(idx.id));
				for (const restoredIdx of assistantRemovedIndexes) {
					indexes.push(structuredClone(restoredIdx));
				}

				// Unique Constraints: remove assistant-added UCs, restore assistant-removed UCs, keep manual UCs
				const assistantAddedUcIds = new Set(
					(after.uniqueConstraints ?? [])
						.filter((u) => !(before.uniqueConstraints ?? []).some((b) => b.id === u.id))
						.map((u) => u.id),
				);
				const assistantRemovedUcs = (before.uniqueConstraints ?? []).filter(
					(b) => !(after.uniqueConstraints ?? []).some((u) => u.id === b.id),
				);
				const uniqueConstraints = (t.uniqueConstraints ?? []).filter((u) => !assistantAddedUcIds.has(u.id));
				for (const restoredUc of assistantRemovedUcs) {
					uniqueConstraints.push(structuredClone(restoredUc));
				}

				// Policies: remove assistant-added policies, restore assistant-removed policies, keep manual policies
				const assistantAddedPolicyIds = new Set(
					(after.policies ?? [])
						.filter((p) => !(before.policies ?? []).some((b) => b.id === p.id))
						.map((p) => p.id),
				);
				const assistantRemovedPolicies = (before.policies ?? []).filter(
					(b) => !(after.policies ?? []).some((p) => p.id === b.id),
				);
				const policies = (t.policies ?? [])
					.filter((p) => !assistantAddedPolicyIds.has(p.id))
					.map((p) => {
						const beforeP = (before.policies ?? []).find((b) => b.id === p.id);
						const afterP = (after.policies ?? []).find((a) => a.id === p.id);
						if (beforeP && afterP && JSON.stringify(beforeP) !== JSON.stringify(afterP)) {
							return structuredClone(beforeP);
						}
						return structuredClone(p);
					});
				for (const restoredP of assistantRemovedPolicies) {
					policies.push(structuredClone(restoredP));
				}

				return {
					...t,
					name: t.name === after.name ? before.name : t.name,
					rowLevelSecurity: t.rowLevelSecurity === after.rowLevelSecurity ? before.rowLevelSecurity : t.rowLevelSecurity,
					columns,
					indexes,
					uniqueConstraints,
					policies,
				};
			});
		for (const removed of this.removedTables.values()) {
			restoredTables.push(structuredClone(removed));
		}

		const restoredRelationships: DesignRelationship[] = currentDesign.relationships
			.filter((r) => !this.addedRelationshipIds.has(r.id))
			.map((r) => {
				const modified = this.modifiedRelationships.get(r.id);
				return modified ? structuredClone(modified.before) : structuredClone(r);
			});
		for (const removed of this.removedRelationships.values()) {
			restoredRelationships.push(structuredClone(removed));
		}

		const restoredEnumTypes: DesignEnumType[] = (currentDesign.enumTypes ?? [])
			.filter((e) => !this.addedEnumIds.has(e.id))
			.map((e) => {
				const modified = this.modifiedEnums.get(e.id);
				return modified ? structuredClone(modified.before) : structuredClone(e);
			});
		for (const removed of this.removedEnums.values()) {
			restoredEnumTypes.push(structuredClone(removed));
		}

		const restoredFunctions: DesignFunction[] = (currentDesign.functions ?? [])
			.filter((f) => !this.addedFunctionIds.has(f.id))
			.map((f) => {
				const modified = this.modifiedFunctions.get(f.id);
				return modified ? structuredClone(modified.before) : structuredClone(f);
			});
		for (const removed of this.removedFunctions.values()) {
			restoredFunctions.push(structuredClone(removed));
		}

		const restoredTriggers: DesignTrigger[] = (currentDesign.triggers ?? [])
			.filter((tr) => !this.addedTriggerIds.has(tr.id))
			.map((tr) => {
				const modified = this.modifiedTriggers.get(tr.id);
				return modified ? structuredClone(modified.before) : structuredClone(tr);
			});
		for (const removed of this.removedTriggers.values()) {
			restoredTriggers.push(structuredClone(removed));
		}

		const restoredDesign: Design = {
			...currentDesign,
			tables: restoredTables,
			relationships: restoredRelationships,
			enumTypes: restoredEnumTypes,
			functions: restoredFunctions,
			triggers: restoredTriggers,
			viewport: currentDesign.viewport,
		};

		const systemDesign = this.restoreSystemDesign(currentState);
		if (typeof systemDesign === "string") return { ok: false, conflicts: [...conflicts, systemDesign] };
		return {
			ok: true,
			design: restoredDesign,
			scenarios: restoredScenarios,
			edgeFunctions: restoredEdgeFunctions,
			...(systemDesign ? { systemDesign } : {}),
		};
	}

	/**
	 * Restores the System design items the turn changed. A later manual edit to
	 * one of them is a conflict, reported by name; untouched items are left alone.
	 */
	private restoreSystemDesign(
		currentState: WorkspaceState,
	): { services: SystemService[]; groups: SystemGroup[]; components: SystemComponent[]; connections: SystemConnection[] } | string | null {
		if (this.systemChanges.size === 0) return null;
		const services = structuredClone(currentState.systemDesign?.services ?? []);
		const components = structuredClone(currentState.systemDesign?.components ?? []);
		const connections = structuredClone(currentState.systemDesign?.connections ?? []);
		const conflicts: string[] = [];
		for (const change of this.systemChanges.values()) {
			const current = change.kind === "component"
				? components.find((item) => item.id === change.id) ?? null
				: connections.find((item) => item.id === change.id) ?? null;
			if (JSON.stringify(current) !== JSON.stringify(change.last)) {
				conflicts.push(`${describeSystemChange(change)} was modified after this Assistant turn`);
			}
		}
		if (conflicts.length > 0) return conflicts.join("; ");
		for (const change of this.systemChanges.values()) {
			if (change.kind === "component") {
				restoreSystemItem(components, change.id, change.original as SystemComponent | null);
			} else {
				restoreSystemItem(connections, change.id, change.original as SystemConnection | null);
			}
		}
		// Groups keep their current membership, minus any Component the revert removed.
		const currentGroups = currentState.systemDesign?.groups ?? [];
		const liveIds = new Set([...services, ...components, ...currentGroups].map((item) => item.id));
		const groups = structuredClone(keepSystemGroupMembers(currentGroups, liveIds));
		return { services, groups, components, connections };
	}
}

export function checkDdlRelevantContent(
	readDesign: Design | undefined,
	currentDesign: Design,
	statements: Node[],
): void {
	if (!readDesign) return;

	const batchCreatedTables = new Set<string>();
	const batchCreatedEnums = new Set<string>();
	const batchCreatedFunctions = new Set<string>();

	for (const item of statements) {
		const stmt = item.stmt as Node;
		if (!stmt) continue;
		if (stmt.CreateStmt) {
			const name = nameOf(stmt.CreateStmt.relation);
			if (name) batchCreatedTables.add(name);
		} else if (stmt.CreateEnumStmt) {
			const parts = stmt.CreateEnumStmt.typeName ?? [];
			const name = nodeName(parts[parts.length - 1]);
			if (name) batchCreatedEnums.add(name);
		} else if (stmt.CreateFunctionStmt) {
			const parts = stmt.CreateFunctionStmt.funcname?.map(nodeName).filter(Boolean) ?? [];
			const name = parts[parts.length - 1];
			if (name) batchCreatedFunctions.add(name);
		}
	}

	for (const item of statements) {
		const stmt = item.stmt as Node;
		if (!stmt) continue;

		if (stmt.CreateStmt) {
			const tableName = nameOf(stmt.CreateStmt.relation);
			if (tableName) {
				if (
					!readDesign.tables.some((t) => t.name === tableName) &&
					currentDesign.tables.some((t) => t.name === tableName)
				) {
					throw new Error(
						`Stale relevant content: table "${tableName}" was created since last read. Re-read the project before proposing changes.`,
					);
				}
			}
			// Check referenced foreign key tables
			for (const elt of stmt.CreateStmt.tableElts ?? []) {
				const colDef = elt.ColumnDef;
				if (colDef) {
					for (const c of colDef.constraints ?? []) {
						const con = c.Constraint;
						if (con?.contype === "CONSTR_FOREIGN") {
							const refTable = nameOf(con.pktable);
							if (refTable && !batchCreatedTables.has(refTable)) {
								const readRef = readDesign.tables.find((t) => t.name === refTable);
								const curRef = currentDesign.tables.find((t) => t.name === refTable);
								if (!readRef || !curRef || JSON.stringify(readRef) !== JSON.stringify(curRef)) {
									throw new Error(
										`Stale relevant content: referenced table "${refTable}" changed since last read. Re-read the project before proposing changes.`,
									);
								}
							}
						}
					}
					const typeNames = colDef.typeName?.names?.map(nodeName).filter(Boolean) ?? [];
					const rawType = typeNames[typeNames.length - 1];
					if (rawType && !batchCreatedEnums.has(rawType) && readDesign.enumTypes?.some((e) => e.name === rawType)) {
						const readEnum = readDesign.enumTypes.find((e) => e.name === rawType);
						const curEnum = currentDesign.enumTypes?.find((e) => e.name === rawType);
						if (!readEnum || !curEnum || JSON.stringify(readEnum) !== JSON.stringify(curEnum)) {
							throw new Error(
								`Stale relevant content: referenced enum type "${rawType}" changed since last read. Re-read the project before proposing changes.`,
							);
						}
					}
				}
				const con = elt.Constraint;
				if (con?.contype === "CONSTR_FOREIGN") {
					const refTable = nameOf(con.pktable);
					if (refTable && !batchCreatedTables.has(refTable)) {
						const readRef = readDesign.tables.find((t) => t.name === refTable);
						const curRef = currentDesign.tables.find((t) => t.name === refTable);
						if (!readRef || !curRef || JSON.stringify(readRef) !== JSON.stringify(curRef)) {
							throw new Error(
								`Stale relevant content: referenced table "${refTable}" changed since last read. Re-read the project before proposing changes.`,
							);
						}
					}
				}
			}
		} else if (stmt.AlterTableStmt) {
			const tableName = nameOf(stmt.AlterTableStmt.relation);
			if (tableName) {
				const readTable = readDesign.tables.find((t) => t.name === tableName);
				const curTable = currentDesign.tables.find((t) => t.name === tableName);
				if (!readTable || !curTable || JSON.stringify(readTable) !== JSON.stringify(curTable)) {
					throw new Error(
						`Stale relevant content: table "${tableName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
			for (const cmdItem of stmt.AlterTableStmt.cmds ?? []) {
				const cmd = cmdItem.AlterTableCmd;
				if (!cmd) continue;
				const con = cmd.def?.Constraint;
				if (con?.contype === "CONSTR_FOREIGN") {
					const refTable = nameOf(con.pktable);
					if (refTable && !batchCreatedTables.has(refTable)) {
						const readRef = readDesign.tables.find((t) => t.name === refTable);
						const curRef = currentDesign.tables.find((t) => t.name === refTable);
						if (!readRef || !curRef || JSON.stringify(readRef) !== JSON.stringify(curRef)) {
							throw new Error(
								`Stale relevant content: referenced table "${refTable}" changed since last read. Re-read the project before proposing changes.`,
							);
						}
					}
				}
				const colDef = cmd.def?.ColumnDef;
				if (colDef) {
					for (const c of colDef.constraints ?? []) {
						const colCon = c.Constraint;
						if (colCon?.contype === "CONSTR_FOREIGN") {
							const refTable = nameOf(colCon.pktable);
							if (refTable && !batchCreatedTables.has(refTable)) {
								const readRef = readDesign.tables.find((t) => t.name === refTable);
								const curRef = currentDesign.tables.find((t) => t.name === refTable);
								if (!readRef || !curRef || JSON.stringify(readRef) !== JSON.stringify(curRef)) {
									throw new Error(
										`Stale relevant content: referenced table "${refTable}" changed since last read. Re-read the project before proposing changes.`,
									);
								}
							}
						}
					}
					const typeNames = colDef.typeName?.names?.map(nodeName).filter(Boolean) ?? [];
					const rawType = typeNames[typeNames.length - 1];
					if (rawType && !batchCreatedEnums.has(rawType) && readDesign.enumTypes?.some((e) => e.name === rawType)) {
						const readEnum = readDesign.enumTypes.find((e) => e.name === rawType);
						const curEnum = currentDesign.enumTypes?.find((e) => e.name === rawType);
						if (!readEnum || !curEnum || JSON.stringify(readEnum) !== JSON.stringify(curEnum)) {
							throw new Error(
								`Stale relevant content: referenced enum type "${rawType}" changed since last read. Re-read the project before proposing changes.`,
							);
						}
					}
				}
			}
		} else if (stmt.DropStmt) {
			for (const obj of stmt.DropStmt.objects ?? []) {
				const tableName = nameOf(obj) ?? (obj.List?.items ? nodeName(obj.List.items[obj.List.items.length - 1]) : undefined);
				if (tableName) {
					const readTable = readDesign.tables.find((t) => t.name === tableName);
					const curTable = currentDesign.tables.find((t) => t.name === tableName);
					if (!readTable || !curTable || JSON.stringify(readTable) !== JSON.stringify(curTable)) {
						throw new Error(
							`Stale relevant content: table "${tableName}" changed since last read. Re-read the project before proposing changes.`,
						);
					}
					if (curTable) {
						const newRefs = currentDesign.relationships.filter(
							(r) => r.referencedTableId === curTable.id && !readDesign.relationships.some((rr) => rr.id === r.id),
						);
						if (newRefs.length > 0) {
							throw new Error(
								`Stale relevant content: new references were added to table "${tableName}" since last read. Re-read the project before proposing changes.`,
							);
						}
					}
				}
			}
		} else if (stmt.IndexStmt) {
			const tableName = nameOf(stmt.IndexStmt.relation);
			if (tableName) {
				const readTable = readDesign.tables.find((t) => t.name === tableName);
				const curTable = currentDesign.tables.find((t) => t.name === tableName);
				if (!readTable || !curTable || JSON.stringify(readTable) !== JSON.stringify(curTable)) {
					throw new Error(
						`Stale relevant content: table "${tableName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
		} else if (stmt.CreateTrigStmt) {
			const tableName = nameOf(stmt.CreateTrigStmt.relation);
			if (tableName) {
				const readTable = readDesign.tables.find((t) => t.name === tableName);
				const curTable = currentDesign.tables.find((t) => t.name === tableName);
				if (!readTable || !curTable || JSON.stringify(readTable) !== JSON.stringify(curTable)) {
					throw new Error(
						`Stale relevant content: table "${tableName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
			const fnParts = stmt.CreateTrigStmt.funcname?.map(nodeName).filter(Boolean) ?? [];
			const fnName = fnParts[fnParts.length - 1];
			if (fnName && !batchCreatedFunctions.has(fnName)) {
				const readFn = readDesign.functions?.find((f) => f.name === fnName);
				const curFn = currentDesign.functions?.find((f) => f.name === fnName);
				if (!readFn || !curFn || JSON.stringify(readFn) !== JSON.stringify(curFn)) {
					throw new Error(
						`Stale relevant content: trigger function "${fnName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
		} else if (stmt.CreatePolicyStmt) {
			const tableName = nameOf(stmt.CreatePolicyStmt.table);
			if (tableName) {
				const readTable = readDesign.tables.find((t) => t.name === tableName);
				const curTable = currentDesign.tables.find((t) => t.name === tableName);
				if (!readTable || !curTable || JSON.stringify(readTable) !== JSON.stringify(curTable)) {
					throw new Error(
						`Stale relevant content: table "${tableName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
		} else if (stmt.CommentStmt) {
			const names = stmt.CommentStmt.object?.List?.items?.map(nodeName).filter(Boolean) ?? [];
			if (names.length >= 1) {
				const tableName = names[0];
				const readTable = readDesign.tables.find((t) => t.name === tableName);
				const curTable = currentDesign.tables.find((t) => t.name === tableName);
				if (!readTable || !curTable || JSON.stringify(readTable) !== JSON.stringify(curTable)) {
					throw new Error(
						`Stale relevant content: table "${tableName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
		} else if (stmt.CreateFunctionStmt) {
			const fnParts = stmt.CreateFunctionStmt.funcname?.map(nodeName).filter(Boolean) ?? [];
			const fnName = fnParts[fnParts.length - 1];
			if (fnName) {
				const readFn = readDesign.functions?.find((f) => f.name === fnName);
				const curFn = currentDesign.functions?.find((f) => f.name === fnName);
				if (readFn && curFn && JSON.stringify(readFn) !== JSON.stringify(curFn)) {
					throw new Error(
						`Stale relevant content: function "${fnName}" changed since last read. Re-read the project before proposing changes.`,
					);
				}
			}
		}
	}
}

export function checkCodeRelevantContent(
	readState: { revision: number; design: Design; scenarios: Scenario[]; edgeFunctions: EdgeFunction[] } | undefined,
	currentState: WorkspaceState,
	kind: "scenario" | "edge-function" | "function-body",
	id: string | undefined,
	action: "create" | "rename" | "remove" | "write" | "edit",
	name?: string,
): void {
	if (!readState) return;

	if (action === "create") {
		if (name) {
			const trimmed = name.trim();
			if (kind === "scenario") {
				if (!readState.scenarios.some((s) => s.name === trimmed) && currentState.scenarios.some((s) => s.name === trimmed)) {
					throw new Error(`Stale relevant content: Scenario "${trimmed}" was created since last read. Re-read the project before creating it.`);
				}
			} else if (kind === "edge-function") {
				if (!readState.edgeFunctions.some((e) => e.name === trimmed) && currentState.edgeFunctions.some((e) => e.name === trimmed)) {
					throw new Error(`Stale relevant content: Edge function "${trimmed}" was created since last read. Re-read the project before creating it.`);
				}
			}
		}
		return;
	}

	if (!id) return;

	if (kind === "scenario") {
		const readItem = readState.scenarios.find((s) => s.id === id);
		const curItem = currentState.scenarios.find((s) => s.id === id);
		if (readItem && curItem && (readItem.source !== curItem.source || readItem.name !== curItem.name)) {
			throw new Error(`Stale relevant content: Scenario "${curItem.name}" changed since last read. Re-read the project before writing code.`);
		}
		if (readItem && !curItem) {
			throw new Error(`Stale relevant content: Scenario "${readItem.name}" was removed since last read. Re-read the project before writing code.`);
		}
	} else if (kind === "edge-function") {
		const readItem = readState.edgeFunctions.find((e) => e.id === id);
		const curItem = currentState.edgeFunctions.find((e) => e.id === id);
		if (readItem && curItem && (readItem.source !== curItem.source || readItem.name !== curItem.name)) {
			throw new Error(`Stale relevant content: Edge function "${curItem.name}" changed since last read. Re-read the project before writing code.`);
		}
		if (readItem && !curItem) {
			throw new Error(`Stale relevant content: Edge function "${readItem.name}" was removed since last read. Re-read the project before writing code.`);
		}
	} else if (kind === "function-body") {
		const readFn = readState.design.functions?.find((f) => f.id === id);
		const curFn = currentState.design?.functions?.find((f) => f.id === id);
		if (readFn && curFn && readFn.body !== curFn.body) {
			throw new Error(`Stale relevant content: Function "${curFn.name}" changed since last read. Re-read the project before writing code.`);
		}
		if (readFn && !curFn) {
			throw new Error(`Stale relevant content: Function "${readFn.name}" was removed since last read. Re-read the project before writing code.`);
		}
	}
}

/** Puts an item back to its original value, or removes it when the turn added it. */
function restoreSystemItem<T extends { id: string }>(list: T[], id: string, original: T | null) {
	const index = list.findIndex((item) => item.id === id);
	if (original === null) {
		if (index >= 0) list.splice(index, 1);
	} else if (index >= 0) {
		list[index] = structuredClone(original);
	} else {
		list.push(structuredClone(original));
	}
}

function describeSystemChange(change: { kind: "component" | "connection"; original: SystemComponent | SystemConnection | null; last: SystemComponent | SystemConnection | null }): string {
	const item = change.last ?? change.original;
	if (change.kind === "component") return `Component "${(item as SystemComponent).name}"`;
	return `Connection "${(item as SystemConnection).label}"`;
}
