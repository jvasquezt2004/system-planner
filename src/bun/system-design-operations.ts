import type { CanvasPoint, WorkspaceState } from "../shared/design";
import {
	addSystemComponent,
	addSystemConnection,
	findSystemComponent,
	findSystemConnection,
	moveSystemComponent,
	openSpotNear,
	removeSystemComponent,
	removeSystemConnection,
	updateSystemComponent,
	updateSystemConnection,
	systemDesignContent as toSystemContent,
	type SystemComponentChanges,
	type SystemConnectionChanges,
	type SystemContent,
	type SystemDesign,
} from "../shared/system-design";
import type { DesignWorkspace } from "./workspace";

/**
 * One Assistant operation on the System design. Fields that an operation does
 * not use are omitted. Ids are chosen by the Assistant so later operations in
 * the same batch can refer to items it adds.
 */
export type SystemOperation = {
	op:
		| "add_component"
		| "update_component"
		| "move_component"
		| "remove_component"
		| "add_connection"
		| "update_connection"
		| "remove_connection";
	id?: string;
	componentId?: string;
	connectionId?: string;
	sourceId?: string;
	targetId?: string;
	name?: string;
	kind?: "generic" | "database";
	technology?: string;
	description?: string;
	label?: string;
	protocol?: string;
	x?: number;
	y?: number;
};

export type PlannedSystemAction =
	| { type: "addComponent"; action: Parameters<DesignWorkspace["addSystemComponent"]>[0] }
	| { type: "updateComponent"; action: Parameters<DesignWorkspace["updateSystemComponent"]>[0] }
	| { type: "moveComponent"; action: Parameters<DesignWorkspace["moveSystemComponent"]>[0] }
	| { type: "removeComponent"; action: Parameters<DesignWorkspace["removeSystemComponent"]>[0] }
	| { type: "addConnection"; action: Parameters<DesignWorkspace["addSystemConnection"]>[0] }
	| { type: "updateConnection"; action: Parameters<DesignWorkspace["updateSystemConnection"]>[0] }
	| { type: "removeConnection"; action: Parameters<DesignWorkspace["removeSystemConnection"]>[0] };

export type SystemOperationPlan = {
	actions: PlannedSystemAction[];
	/** The design after every operation, computed without touching the workspace. */
	next: SystemDesign;
};

/**
 * Validates a whole batch against the current design before anything is saved.
 * Any invalid operation throws, so the batch either applies in full or not at
 * all. Operations that are only valid after an earlier one in the batch are
 * accepted, because each one is checked against the design it would see.
 */
export function planSystemOperations(
	current: SystemDesign,
	operations: SystemOperation[],
	assistantTurnId?: string,
): SystemOperationPlan {
	if (operations.length === 0) throw new Error("At least one System design operation is required.");
	const attribution = assistantTurnId === undefined ? {} : { assistantTurnId };
	let next = structuredClone(current);
	const actions: PlannedSystemAction[] = [];

	operations.forEach((operation, index) => {
		const label = `Operation ${index + 1} (${operation.op})`;
		try {
			switch (operation.op) {
				case "add_component": {
					const id = requireId(operation.id, "id");
					const position = operation.x !== undefined && operation.y !== undefined
						? { x: operation.x, y: operation.y }
						: openSpotNear(next, { x: 120, y: 120 });
					const action = {
						id,
						...(operation.kind !== undefined ? { kind: operation.kind } : {}),
						...(operation.name !== undefined ? { name: operation.name } : {}),
						...(operation.technology !== undefined ? { technology: operation.technology } : {}),
						...(operation.description !== undefined ? { description: operation.description } : {}),
						x: position.x,
						y: position.y,
						...attribution,
					};
					next = addSystemComponent(next, { ...action, position });
					actions.push({ type: "addComponent", action });
					return;
				}
				case "update_component": {
					const componentId = requireExisting(next, operation.componentId, "componentId");
					const changes = componentChanges(operation);
					if (Object.keys(changes).length === 0) throw new Error("Give at least one field to change.");
					next = updateSystemComponent(next, componentId, changes);
					actions.push({ type: "updateComponent", action: { componentId, changes, ...attribution } });
					return;
				}
				case "move_component": {
					const componentId = requireExisting(next, operation.componentId, "componentId");
					const position = requirePoint(operation);
					next = moveSystemComponent(next, componentId, position);
					actions.push({ type: "moveComponent", action: { componentId, x: position.x, y: position.y, ...attribution } });
					return;
				}
				case "remove_component": {
					const componentId = requireExisting(next, operation.componentId, "componentId");
					next = removeSystemComponent(next, componentId);
					actions.push({ type: "removeComponent", action: { componentId, ...attribution } });
					return;
				}
				case "add_connection": {
					const id = requireId(operation.id, "id");
					const sourceId = requireExisting(next, operation.sourceId, "sourceId");
					const targetId = requireExisting(next, operation.targetId, "targetId");
					const action = {
						id,
						sourceId,
						targetId,
						...(operation.label !== undefined ? { label: operation.label } : {}),
						...(operation.protocol !== undefined ? { protocol: operation.protocol } : {}),
						...attribution,
					};
					next = addSystemConnection(next, action);
					actions.push({ type: "addConnection", action });
					return;
				}
				case "update_connection": {
					const connectionId = requireExistingConnection(next, operation.connectionId);
					const changes = connectionChanges(operation);
					if (Object.keys(changes).length === 0) throw new Error("Give at least one field to change.");
					next = updateSystemConnection(next, connectionId, changes);
					actions.push({ type: "updateConnection", action: { connectionId, changes, ...attribution } });
					return;
				}
				case "remove_connection": {
					const connectionId = requireExistingConnection(next, operation.connectionId);
					next = removeSystemConnection(next, connectionId);
					actions.push({ type: "removeConnection", action: { connectionId, ...attribution } });
					return;
				}
				default:
					throw new Error(`Unsupported operation "${String((operation as { op: unknown }).op)}".`);
			}
		} catch (error) {
			throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});
	return { actions, next };
}

/** Applies a validated plan through the public workspace actions, in order. */
export async function applySystemOperationPlan(
	workspace: DesignWorkspace,
	plan: SystemOperationPlan,
): Promise<WorkspaceState> {
	let state = workspace.getState();
	for (const planned of plan.actions) {
		switch (planned.type) {
			case "addComponent": state = await workspace.addSystemComponent(planned.action); break;
			case "updateComponent": state = await workspace.updateSystemComponent(planned.action); break;
			case "moveComponent": state = await workspace.moveSystemComponent(planned.action); break;
			case "removeComponent": state = await workspace.removeSystemComponent(planned.action); break;
			case "addConnection": state = await workspace.addSystemConnection(planned.action); break;
			case "updateConnection": state = await workspace.updateSystemConnection(planned.action); break;
			case "removeConnection": state = await workspace.removeSystemConnection(planned.action); break;
		}
	}
	return state;
}

/**
 * Refuses a batch that changes an item the Assistant read before the item
 * changed since. The Assistant must read the project again first.
 */
export function checkSystemReadPreconditions(
	read: SystemContent | undefined,
	current: SystemDesign,
	operations: SystemOperation[],
) {
	if (!read) return;
	const referenced = new Set<string>();
	for (const operation of operations) {
		if (operation.op === "remove_connection" || operation.op === "update_connection") {
			if (operation.connectionId) referenced.add(`connection:${operation.connectionId}`);
		} else if (operation.op !== "add_component" && operation.op !== "add_connection" && operation.componentId) {
			referenced.add(`component:${operation.componentId}`);
		}
	}
	const changed: string[] = [];
	for (const key of referenced) {
		const [kind, id] = key.split(":") as ["component" | "connection", string];
		const before = kind === "component" ? read.components.find((item) => item.id === id) : read.connections.find((item) => item.id === id);
		if (!before) continue;
		const now = kind === "component" ? findSystemComponent(current, id) : findSystemConnection(current, id);
		if (JSON.stringify(before) !== JSON.stringify(now ?? null)) changed.push(`${kind} ${id}`);
	}
	if (changed.length > 0) {
		throw new Error(`These items changed after you read the project: ${changed.join(", ")}. Read the project again before editing them.`);
	}
}

/** The System design content a read or a snapshot records. */
export function systemReadContent(design: SystemDesign | null | undefined): SystemContent | undefined {
	return design ? toSystemContent(design) : undefined;
}

function requireId(value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`A new ${label} is required.`);
	return value.trim();
}

function requireExisting(design: SystemDesign, value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required.`);
	if (!findSystemComponent(design, value)) throw new Error(`${label} "${value}" does not match a Component.`);
	return value;
}

function requireExistingConnection(design: SystemDesign, value: string | undefined): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("connectionId is required.");
	if (!findSystemConnection(design, value)) throw new Error(`connectionId "${value}" does not match a Connection.`);
	return value;
}

function requirePoint(operation: SystemOperation): CanvasPoint {
	if (typeof operation.x !== "number" || typeof operation.y !== "number") throw new Error("x and y are required.");
	return { x: operation.x, y: operation.y };
}

function componentChanges(operation: SystemOperation): SystemComponentChanges {
	const changes: SystemComponentChanges = {};
	if (operation.name !== undefined) changes.name = operation.name;
	if (operation.kind !== undefined) changes.kind = operation.kind;
	if (operation.technology !== undefined) changes.technology = operation.technology;
	if (operation.description !== undefined) changes.description = operation.description;
	return changes;
}

function connectionChanges(operation: SystemOperation): SystemConnectionChanges {
	const changes: SystemConnectionChanges = {};
	if (operation.label !== undefined) changes.label = operation.label;
	if (operation.protocol !== undefined) changes.protocol = operation.protocol;
	return changes;
}
