import { createHash } from "node:crypto";
import type { CanvasPoint, WorkspaceState } from "../shared/design";
import type { CustomIcon } from "../shared/component-catalog";
import {
	type SystemComponentKind,
	type SystemComponentProperty,
	type SystemConnectionSide,
	type SystemContent,
	type SystemComponentChanges,
	type SystemConnectionChanges,
	type SystemDesign,
	type SystemGroupChanges,
	SYSTEM_GROUP_DEFAULT_SIZE,
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	findSystemComponent,
	findSystemConnection,
	findSystemGroup,
	findSystemService,
	moveSystemComponent,
	moveSystemGroup,
	moveSystemService,
	openServiceSpotNear,
	openSpotNear,
	removeSystemComponent,
	removeSystemConnection,
	removeSystemGroup,
	removeSystemService,
	systemDesignContent as toSystemContent,
	systemGroupsContaining,
	updateSystemComponent,
	updateSystemConnection,
	updateSystemGroup,
	updateSystemService,
} from "../shared/system-design";
import {
	applySystemLayout,
	computeSystemLayout,
	frameAroundMembers,
	type SystemLayoutAction,
} from "../shared/system-layout";
import type { DesignWorkspace } from "./workspace";

/**
 * One Assistant operation on the System design. Fields that an operation does
 * not use are omitted. Ids are chosen by the Assistant so later operations in
 * the same batch can refer to items it adds.
 *
 * Ownership, Group membership, and database links use the names the read
 * reports: `ownerServiceId`, `memberIds`, and `linkedDesignId`. `null` releases
 * ownership, unlinks a database design, or leaves an item in no owner.
 */
export type SystemOperation = {
	op:
		| "add_component"
		| "update_component"
		| "move_component"
		| "remove_component"
		| "add_service"
		| "update_service"
		| "move_service"
		| "remove_service"
		| "add_group"
		| "update_group"
		| "move_group"
		| "remove_group"
		| "add_connection"
		| "update_connection"
		| "remove_connection"
		| "arrange_layout";
	id?: string;
	componentId?: string;
	serviceId?: string;
	groupId?: string;
	connectionId?: string;
	sourceId?: string;
	targetId?: string;
	/** For arrange_layout: the Components to arrange. Omitted means every Component. */
	componentIds?: string[];
	name?: string;
	kind?: SystemComponentKind;
	technology?: string;
	description?: string;
	properties?: SystemComponentProperty[];
	icon?: CustomIcon;
	label?: string;
	interactionType?: string;
	protocol?: string;
	ownerServiceId?: string | null;
	linkedDesignId?: string | null;
	memberIds?: string[];
	fromSide?: SystemConnectionSide;
	toSide?: SystemConnectionSide;
	bendPoints?: CanvasPoint[];
	labelOffset?: CanvasPoint | null;
	x?: number;
	y?: number;
	width?: number;
	height?: number;
};

export type PlannedSystemAction =
	| { type: "addComponent"; action: Parameters<DesignWorkspace["addSystemComponent"]>[0] }
	| { type: "updateComponent"; action: Parameters<DesignWorkspace["updateSystemComponent"]>[0] }
	| { type: "moveComponent"; action: Parameters<DesignWorkspace["moveSystemComponent"]>[0] }
	| { type: "removeComponent"; action: Parameters<DesignWorkspace["removeSystemComponent"]>[0] }
	| { type: "addService"; action: Parameters<DesignWorkspace["addSystemService"]>[0] }
	| { type: "updateService"; action: Parameters<DesignWorkspace["updateSystemService"]>[0] }
	| { type: "moveService"; action: Parameters<DesignWorkspace["moveSystemService"]>[0] }
	| { type: "removeService"; action: Parameters<DesignWorkspace["removeSystemService"]>[0] }
	| { type: "addGroup"; action: Parameters<DesignWorkspace["addSystemGroup"]>[0] }
	| { type: "updateGroup"; action: Parameters<DesignWorkspace["updateSystemGroup"]>[0] }
	| { type: "moveGroup"; action: Parameters<DesignWorkspace["moveSystemGroup"]>[0] }
	| { type: "removeGroup"; action: Parameters<DesignWorkspace["removeSystemGroup"]>[0] }
	| { type: "addConnection"; action: Parameters<DesignWorkspace["addSystemConnection"]>[0] }
	| { type: "updateConnection"; action: Parameters<DesignWorkspace["updateSystemConnection"]>[0] }
	| { type: "removeConnection"; action: Parameters<DesignWorkspace["removeSystemConnection"]>[0] }
	| { type: "arrangeLayout"; action: SystemLayoutAction };

export type SystemOperationPlan = {
	actions: PlannedSystemAction[];
	/** The design after every operation, computed without touching the workspace. */
	next: SystemDesign;
	/**
	 * What the batch removes or moves beyond the items it names: deleted
	 * Connections, released Components, changed Group membership. Reported back
	 * to the Assistant so it can tell the designer.
	 */
	impacts: string[];
};

/**
 * Validates a whole batch against the current design before anything is saved.
 * Any invalid operation throws, so the batch either applies in full or not at
 * all. Operations that are only valid after an earlier one in the batch are
 * accepted, because each one is checked against the design it would see.
 * `designIds` are the database Designs of the Project that a Component may link.
 */
export function planSystemOperations(
	current: SystemDesign,
	operations: SystemOperation[],
	assistantTurnId?: string,
	designIds: ReadonlySet<string> = new Set(),
): SystemOperationPlan {
	if (operations.length === 0) throw new Error("At least one System design operation is required.");
	const attribution = assistantTurnId === undefined ? {} : { assistantTurnId };
	let next = structuredClone(current);
	const actions: PlannedSystemAction[] = [];
	const impacts: string[] = [];

	operations.forEach((operation, index) => {
		const label = `Operation ${index + 1} (${operation.op})`;
		const before = next;
		try {
			switch (operation.op) {
				case "add_component": {
					const id = requireId(operation.id, "id");
					const position = operation.x !== undefined && operation.y !== undefined
						? { x: operation.x, y: operation.y }
						: openSpotNear(next, { x: 120, y: 120 });
					const linkedDesignId = requireLinkedDesign(operation.linkedDesignId, designIds);
					if (typeof operation.ownerServiceId === "string") requireExistingService(next, operation.ownerServiceId, "ownerServiceId");
					const action = {
						id,
						...(operation.kind !== undefined ? { kind: operation.kind } : {}),
						...(operation.name !== undefined ? { name: operation.name } : {}),
						...(operation.technology !== undefined ? { technology: operation.technology } : {}),
						...(operation.description !== undefined ? { description: operation.description } : {}),
						...(operation.properties !== undefined ? { properties: operation.properties } : {}),
						...(operation.icon !== undefined ? { icon: operation.icon } : {}),
						...(operation.ownerServiceId !== undefined ? { serviceId: operation.ownerServiceId } : {}),
						...(typeof linkedDesignId === "string" ? { designId: linkedDesignId } : {}),
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
					if (typeof operation.ownerServiceId === "string") requireExistingService(next, operation.ownerServiceId, "ownerServiceId");
					const changes = componentChanges(operation, designIds);
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
				case "add_service": {
					const id = requireId(operation.id, "id");
					const position = operation.x !== undefined && operation.y !== undefined
						? { x: operation.x, y: operation.y }
						: openServiceSpotNear(next, { x: 120, y: 120 });
					const action = {
						id,
						...(operation.name !== undefined ? { name: operation.name } : {}),
						x: position.x,
						y: position.y,
						...attribution,
					};
					next = addSystemService(next, { id, name: operation.name, position });
					actions.push({ type: "addService", action });
					return;
				}
				case "update_service": {
					const serviceId = requireExistingService(next, operation.serviceId, "serviceId");
					if (operation.name === undefined) throw new Error("Give a name to change.");
					const changes = { name: operation.name };
					next = updateSystemService(next, serviceId, changes);
					actions.push({ type: "updateService", action: { serviceId, changes, ...attribution } });
					return;
				}
				case "move_service": {
					const serviceId = requireExistingService(next, operation.serviceId, "serviceId");
					const position = requirePoint(operation);
					next = moveSystemService(next, serviceId, position);
					actions.push({ type: "moveService", action: { serviceId, x: position.x, y: position.y, ...attribution } });
					return;
				}
				case "remove_service": {
					const serviceId = requireExistingService(next, operation.serviceId, "serviceId");
					next = removeSystemService(next, serviceId);
					actions.push({ type: "removeService", action: { serviceId, ...attribution } });
					return;
				}
				case "add_group": {
					const id = requireId(operation.id, "id");
					const memberIds = operation.memberIds ?? [];
					const fitted = frameAroundMembers(next, memberIds);
					const position = operation.x !== undefined && operation.y !== undefined
						? { x: operation.x, y: operation.y }
						: fitted?.position ?? openServiceSpotNear(next, { x: 120, y: 120 });
					const size = operation.width !== undefined && operation.height !== undefined
						? { width: operation.width, height: operation.height }
						: fitted?.size ?? SYSTEM_GROUP_DEFAULT_SIZE;
					const action = {
						id,
						...(operation.name !== undefined ? { name: operation.name } : {}),
						x: position.x,
						y: position.y,
						width: size.width,
						height: size.height,
						memberIds,
						...attribution,
					};
					next = addSystemGroup(next, { id, name: operation.name, position, size, memberIds });
					actions.push({ type: "addGroup", action });
					return;
				}
				case "update_group": {
					const groupId = requireExistingGroup(next, operation.groupId, "groupId");
					const changes: SystemGroupChanges = {};
					if (operation.name !== undefined) changes.name = operation.name;
					if (operation.memberIds !== undefined) changes.memberIds = operation.memberIds;
					if (Object.keys(changes).length === 0) throw new Error("Give at least one field to change.");
					next = updateSystemGroup(next, groupId, changes);
					actions.push({ type: "updateGroup", action: { groupId, changes, ...attribution } });
					return;
				}
				case "move_group": {
					const groupId = requireExistingGroup(next, operation.groupId, "groupId");
					const position = requirePoint(operation);
					next = moveSystemGroup(next, groupId, position);
					actions.push({ type: "moveGroup", action: { groupId, x: position.x, y: position.y, ...attribution } });
					return;
				}
				case "remove_group": {
					const groupId = requireExistingGroup(next, operation.groupId, "groupId");
					next = removeSystemGroup(next, groupId);
					actions.push({ type: "removeGroup", action: { groupId, ...attribution } });
					return;
				}
				case "add_connection": {
					const id = requireId(operation.id, "id");
					const sourceId = requireEndpoint(next, operation.sourceId, "sourceId");
					const targetId = requireEndpoint(next, operation.targetId, "targetId");
					const action = {
						id,
						sourceId,
						targetId,
						...(operation.label !== undefined ? { label: operation.label } : {}),
						...(operation.interactionType !== undefined ? { interactionType: operation.interactionType } : {}),
						...(operation.protocol !== undefined ? { protocol: operation.protocol } : {}),
						...attribution,
					};
					next = addSystemConnection(next, action);
					actions.push({ type: "addConnection", action });
					return;
				}
				case "update_connection": {
					const connectionId = requireExistingConnection(next, operation.connectionId);
					const changes = connectionChanges(next, operation);
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
				case "arrange_layout": {
					const placement = computeSystemLayout(next, operation.componentIds);
					next = applySystemLayout(next, placement);
					actions.push({ type: "arrangeLayout", action: { placement, ...attribution } });
					return;
				}
				default:
					throw new Error(`Unsupported operation "${String((operation as { op: unknown }).op)}".`);
			}
		} catch (error) {
			throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			impacts.push(...describeImpact(before, next, operation));
		}
	});
	return { actions, next, impacts: impacts.filter((note) => note.length > 0) };
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
			case "addService": state = await workspace.addSystemService(planned.action); break;
			case "updateService": state = await workspace.updateSystemService(planned.action); break;
			case "moveService": state = await workspace.moveSystemService(planned.action); break;
			case "removeService": state = await workspace.removeSystemService(planned.action); break;
			case "addGroup": state = await workspace.addSystemGroup(planned.action); break;
			case "updateGroup": state = await workspace.updateSystemGroup(planned.action); break;
			case "moveGroup": state = await workspace.moveSystemGroup(planned.action); break;
			case "removeGroup": state = await workspace.removeSystemGroup(planned.action); break;
			case "addConnection": state = await workspace.addSystemConnection(planned.action); break;
			case "updateConnection": state = await workspace.updateSystemConnection(planned.action); break;
			case "removeConnection": state = await workspace.removeSystemConnection(planned.action); break;
			case "arrangeLayout": state = await workspace.arrangeSystemLayout(planned.action); break;
		}
	}
	return state;
}

/**
 * Refuses a batch that changes an item the Assistant read before the item
 * changed since, including the items an operation depends on: a removed
 * Service's Components and Connections, a Group's members, a moved Group's
 * contents. An arrangement depends on everything it read. The Assistant must
 * read the project again first. Unrelated manual edits do not block the batch.
 */
export function checkSystemReadPreconditions(
	read: SystemContent | undefined,
	current: SystemDesign,
	operations: SystemOperation[],
) {
	if (!read) return;
	const referenced = new Set<string>();
	for (const operation of operations) {
		for (const key of referencedItems(read, current, operation)) referenced.add(key);
	}
	const changed: string[] = [];
	for (const key of referenced) {
		const [kind, id] = splitKey(key);
		const before = findInContent(read, kind, id);
		if (!before) continue;
		const now = findInDesign(current, kind, id);
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

/** A short, stable version of one item's content, so a reader can tell whether it changed. */
export function systemItemVersion(item: unknown): string {
	return createHash("sha256").update(JSON.stringify(item)).digest("hex").slice(0, 12);
}

/**
 * The focused architecture context the Assistant reads: every item with its
 * stable id, relevant version, ownership, Group membership and nesting, database
 * link, and Connection attachment, route, and label overrides, plus diagnostics
 * that name what a designer would want to fix.
 */
export function readSystemArchitecture(
	design: SystemDesign,
	designs: readonly { id: string; name: string }[],
) {
	const designIds = new Set(designs.map((item) => item.id));
	return {
		services: design.services.map((service) => ({
			id: service.id,
			name: service.name,
			position: service.position,
			size: service.size,
			ownedComponentIds: design.components.filter((component) => component.serviceId === service.id).map((component) => component.id),
			version: systemItemVersion(service),
		})),
		groups: design.groups.map((group) => ({
			id: group.id,
			name: group.name,
			position: group.position,
			size: group.size,
			memberIds: group.memberIds,
			containedInGroupIds: systemGroupsContaining(design, group.id).map((item) => item.id),
			version: systemItemVersion(group),
		})),
		components: design.components.map((component) => ({
			id: component.id,
			kind: component.kind,
			name: component.name,
			...(component.technology !== undefined ? { technology: component.technology } : {}),
			...(component.description !== undefined ? { description: component.description } : {}),
			properties: component.properties,
			...(component.icon !== undefined ? { icon: component.icon } : {}),
			position: component.position,
			ownerServiceId: component.serviceId,
			linkedDesignId: component.designId ?? null,
			groupIds: systemGroupsContaining(design, component.id).map((item) => item.id),
			version: systemItemVersion(component),
		})),
		connections: design.connections.map((connection) => ({
			id: connection.id,
			sourceId: connection.sourceId,
			targetId: connection.targetId,
			label: connection.label,
			...(connection.protocol !== undefined ? { protocol: connection.protocol } : {}),
			...(connection.interactionType !== undefined ? { interactionType: connection.interactionType } : {}),
			attachment: { fromSide: connection.fromSide ?? "auto", toSide: connection.toSide ?? "auto" },
			bendPoints: connection.bendPoints ?? [],
			labelOffset: connection.labelOffset ?? null,
			version: systemItemVersion(connection),
		})),
		designs: designs.map((item) => ({ id: item.id, name: item.name })),
		diagnostics: systemDiagnostics(design, designIds),
	};
}

/** Problems a designer would want fixed. None of them block editing. */
export function systemDiagnostics(design: SystemDesign, designIds: ReadonlySet<string>): string[] {
	const notes: string[] = [];
	for (const component of design.components) {
		if (component.kind === "database" && component.designId === undefined) {
			notes.push(`Database component "${component.name}" (${component.id}) has no linked database design.`);
		}
		if (component.designId !== undefined && !designIds.has(component.designId)) {
			notes.push(`Component "${component.name}" (${component.id}) links design "${component.designId}", which is not in this Project.`);
		}
	}
	for (const service of design.services) {
		if (!design.components.some((component) => component.serviceId === service.id)) {
			notes.push(`Service "${service.name}" (${service.id}) owns no Components.`);
		}
	}
	for (const group of design.groups) {
		if (group.memberIds.length === 0) notes.push(`Group "${group.name}" (${group.id}) has no members.`);
	}
	const linkedBy = new Map<string, string[]>();
	for (const component of design.components) {
		if (component.designId === undefined) continue;
		linkedBy.set(component.designId, [...(linkedBy.get(component.designId) ?? []), component.id]);
	}
	for (const [designId, componentIds] of linkedBy) {
		if (componentIds.length > 1) notes.push(`Design "${designId}" is a shared schema linked from ${componentIds.join(", ")}.`);
	}
	return notes;
}

function describeImpact(before: SystemDesign, after: SystemDesign, operation: SystemOperation): string[] {
	const notes: string[] = [];
	const removedConnections = before.connections.filter((connection) => !findSystemConnection(after, connection.id));
	for (const connection of removedConnections) {
		if (connection.id === operation.connectionId) continue;
		notes.push(`Removed Connection "${connection.label}" (${connection.id}) because one of its endpoints was removed.`);
	}
	const released = after.components.filter((component) => {
		const previous = findSystemComponent(before, component.id);
		return previous !== undefined && previous.serviceId !== null && component.serviceId === null;
	});
	if (released.length > 0) notes.push(`Released ${released.length} Component${released.length === 1 ? "" : "s"} to system scope: ${released.map((item) => item.id).join(", ")}.`);
	for (const group of after.groups) {
		const previous = findSystemGroup(before, group.id);
		if (previous && JSON.stringify(previous.memberIds) !== JSON.stringify(group.memberIds) && operation.op !== "update_group") {
			notes.push(`Group "${group.name}" (${group.id}) membership changed.`);
		}
	}
	if (operation.op === "arrange_layout") {
		notes.push(`Arranged layout for ${after.components.length} Components.`);
	}
	if (operation.op === "move_service" || operation.op === "move_group") {
		const moved = after.components.filter((component) => {
			const previous = findSystemComponent(before, component.id);
			return previous !== undefined && (previous.position.x !== component.position.x || previous.position.y !== component.position.y);
		});
		if (moved.length > 0) notes.push(`Moved ${moved.length} Component${moved.length === 1 ? "" : "s"} with the frame: ${moved.map((item) => item.id).join(", ")}.`);
	}
	return notes;
}

/**
 * Items an operation reads or changes beyond the ones it names, so a stale
 * read of any of them refuses the batch. Keys are `kind:id`.
 */
function referencedItems(read: SystemContent, current: SystemDesign, operation: SystemOperation): string[] {
	const keys: string[] = [];
	const add = (kind: "component" | "service" | "group" | "connection", id: string | null | undefined) => {
		if (typeof id === "string" && id.length > 0) keys.push(`${kind}:${id}`);
	};
	const addIdentity = (id: string | null | undefined) => {
		if (typeof id !== "string" || id.length === 0) return;
		if (findSystemComponent(current, id)) add("component", id);
		else if (findSystemService(current, id)) add("service", id);
		else if (findSystemGroup(current, id)) add("group", id);
	};
	const addComponentsOf = (serviceId: string) => {
		for (const component of current.components) if (component.serviceId === serviceId) add("component", component.id);
	};
	const addConnectionsAndGroupsOf = (itemId: string) => {
		for (const connection of current.connections) {
			if (connection.sourceId === itemId || connection.targetId === itemId) add("connection", connection.id);
		}
		for (const group of systemGroupsContaining(current, itemId)) add("group", group.id);
	};
	switch (operation.op) {
		case "add_component":
			add("service", operation.ownerServiceId ?? undefined);
			return keys;
		case "update_component":
			add("component", operation.componentId);
			add("service", operation.ownerServiceId ?? undefined);
			return keys;
		case "move_component":
			add("component", operation.componentId);
			return keys;
		case "remove_component":
			add("component", operation.componentId);
			if (operation.componentId) addConnectionsAndGroupsOf(operation.componentId);
			return keys;
		case "add_service":
			return keys;
		case "update_service":
			add("service", operation.serviceId);
			return keys;
		case "move_service":
			add("service", operation.serviceId);
			if (operation.serviceId) addComponentsOf(operation.serviceId);
			return keys;
		case "remove_service":
			add("service", operation.serviceId);
			if (operation.serviceId) {
				addComponentsOf(operation.serviceId);
				addConnectionsAndGroupsOf(operation.serviceId);
			}
			return keys;
		case "add_group":
			for (const memberId of operation.memberIds ?? []) addIdentity(memberId);
			return keys;
		case "update_group":
			add("group", operation.groupId);
			for (const memberId of operation.memberIds ?? []) addIdentity(memberId);
			return keys;
		case "move_group":
		case "remove_group": {
			add("group", operation.groupId);
			const group = operation.groupId ? findSystemGroup(current, operation.groupId) : undefined;
			for (const memberId of group?.memberIds ?? []) addIdentity(memberId);
			return keys;
		}
		case "add_connection":
			return keys;
		case "update_connection": {
			add("connection", operation.connectionId);
			addIdentity(operation.sourceId);
			addIdentity(operation.targetId);
			return keys;
		}
		case "remove_connection":
			add("connection", operation.connectionId);
			return keys;
		case "arrange_layout":
			for (const item of read.components) add("component", item.id);
			for (const item of read.services) add("service", item.id);
			for (const item of read.groups) add("group", item.id);
			for (const item of read.connections) add("connection", item.id);
			return keys;
		default:
			return keys;
	}
}

function splitKey(key: string): ["component" | "service" | "group" | "connection", string] {
	const separator = key.indexOf(":");
	return [key.slice(0, separator) as "component" | "service" | "group" | "connection", key.slice(separator + 1)];
}

function findInContent(content: SystemContent, kind: string, id: string): unknown {
	switch (kind) {
		case "component": return content.components.find((item) => item.id === id);
		case "service": return content.services.find((item) => item.id === id);
		case "group": return content.groups.find((item) => item.id === id);
		case "connection": return content.connections.find((item) => item.id === id);
		default: return undefined;
	}
}

function findInDesign(design: SystemDesign, kind: string, id: string): unknown {
	switch (kind) {
		case "component": return findSystemComponent(design, id);
		case "service": return findSystemService(design, id);
		case "group": return findSystemGroup(design, id);
		case "connection": return findSystemConnection(design, id);
		default: return undefined;
	}
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

function requireExistingService(design: SystemDesign, value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required.`);
	if (!findSystemService(design, value)) throw new Error(`${label} "${value}" does not match a Service.`);
	return value;
}

function requireExistingGroup(design: SystemDesign, value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required.`);
	if (!findSystemGroup(design, value)) throw new Error(`${label} "${value}" does not match a Group.`);
	return value;
}

/** A Connection endpoint is a Component or a Service. */
function requireEndpoint(design: SystemDesign, value: string | undefined, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required.`);
	if (!findSystemComponent(design, value) && !findSystemService(design, value)) {
		throw new Error(`${label} "${value}" does not match a Component or Service.`);
	}
	return value;
}

function requireExistingConnection(design: SystemDesign, value: string | undefined): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("connectionId is required.");
	if (!findSystemConnection(design, value)) throw new Error(`connectionId "${value}" does not match a Connection.`);
	return value;
}

/**
 * A database Design named for a Component. `null` means unlink and is returned
 * as `null`; undefined means the field was not given.
 */
function requireLinkedDesign(value: string | null | undefined, designIds: ReadonlySet<string>): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (!designIds.has(value)) throw new Error(`linkedDesignId "${value}" does not match a database design in this Project.`);
	return value;
}

function requirePoint(operation: SystemOperation): CanvasPoint {
	if (typeof operation.x !== "number" || typeof operation.y !== "number") throw new Error("x and y are required.");
	return { x: operation.x, y: operation.y };
}

function componentChanges(operation: SystemOperation, designIds: ReadonlySet<string>): SystemComponentChanges {
	const changes: SystemComponentChanges = {};
	if (operation.name !== undefined) changes.name = operation.name;
	if (operation.kind !== undefined) changes.kind = operation.kind;
	if (operation.technology !== undefined) changes.technology = operation.technology;
	if (operation.description !== undefined) changes.description = operation.description;
	if (operation.properties !== undefined) changes.properties = operation.properties;
	if (operation.icon !== undefined) changes.icon = operation.icon;
	if (operation.ownerServiceId !== undefined) changes.serviceId = operation.ownerServiceId;
	const linkedDesignId = requireLinkedDesign(operation.linkedDesignId, designIds);
	if (linkedDesignId !== undefined) changes.designId = linkedDesignId ?? undefined;
	return changes;
}

function connectionChanges(design: SystemDesign, operation: SystemOperation): SystemConnectionChanges {
	const changes: SystemConnectionChanges = {};
	if (operation.label !== undefined) changes.label = operation.label;
	if (operation.interactionType !== undefined) changes.interactionType = operation.interactionType;
	if (operation.protocol !== undefined) changes.protocol = operation.protocol;
	if (operation.sourceId !== undefined) changes.sourceId = requireEndpoint(design, operation.sourceId, "sourceId");
	if (operation.targetId !== undefined) changes.targetId = requireEndpoint(design, operation.targetId, "targetId");
	if (operation.fromSide !== undefined) changes.fromSide = operation.fromSide;
	if (operation.toSide !== undefined) changes.toSide = operation.toSide;
	if (operation.bendPoints !== undefined) changes.bendPoints = operation.bendPoints;
	if (operation.labelOffset !== undefined) changes.labelOffset = operation.labelOffset;
	return changes;
}
