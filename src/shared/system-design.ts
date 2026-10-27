import type { CanvasPoint, CanvasViewport } from "./design";
import { CLIENT_TRAFFIC_KINDS, componentDefaultNameStem, type ClientTrafficKind } from "./component-catalog";

/**
 * The authoritative System design of one Project: Services that own Components,
 * generic and database Components at system scope or inside a Service, the
 * directed, labeled Connections between Components and Services, and Groups that
 * organize Components, Services, and other Groups. Walkthroughs and kind-specific
 * catalogs are added by later tickets.
 *
 * Component, Service, Group, and Connection `id`s are stable identities.
 * Component, Service, and Group ids share one namespace, so a Connection endpoint
 * or a Group member names exactly one item. A Component has at most one owning
 * Service (`serviceId`). Ownership changes only through explicit actions; a
 * Component's position never assigns it. Group membership is also explicit and
 * never changes ownership.
 */

/** "generic" and "database" are the original kinds; the rest are registered in the catalog. */
export type SystemComponentKind = "generic" | "database" | ClientTrafficKind;

export type SystemComponentProperty = {
	key: string;
	value: string;
};

export type SystemComponent = {
	id: string;
	kind: SystemComponentKind;
	name: string;
	technology?: string;
	description?: string;
	properties: SystemComponentProperty[];
	position: CanvasPoint;
	/**
	 * The Service that owns this Component, or null for system scope: a shared or
	 * independent resource. Placing a Component inside a Service boundary does not
	 * assign it.
	 */
	serviceId: string | null;
	/**
	 * The linked database Design for a Database component. Several Database
	 * components may name the same Design. Omitted when the component is
	 * conceptual.
	 */
	designId?: string;
};

export type SystemServiceSize = {
	width: number;
	height: number;
};

/** A named expanded boundary that owns the Components whose `serviceId` names it. */
export type SystemService = {
	id: string;
	name: string;
	/** The top-left corner of the boundary, in canvas space. */
	position: CanvasPoint;
	size: SystemServiceSize;
};

/**
 * A named, non-owning region such as a business domain, region, or network
 * boundary. `memberIds` name Components, Services, or child Groups explicitly;
 * the frame's geometry is layout only and never decides membership. Members may
 * belong to several Groups, and a Group may nest inside another, but never
 * contain itself. A Group is not a Connection endpoint.
 */
export type SystemGroup = {
	id: string;
	name: string;
	/** The top-left corner of the frame, in canvas space. */
	position: CanvasPoint;
	size: SystemServiceSize;
	/** Component, Service, or child Group ids, without duplicates. */
	memberIds: string[];
};

export type SystemConnection = {
	id: string;
	/** A Component or Service id. */
	sourceId: string;
	/** A Component or Service id. */
	targetId: string;
	label: string;
	/** Optional interaction type, such as "Synchronous request" or "Event". */
	interactionType?: string;
	protocol?: string;
};

export type SystemDesign = {
	services: SystemService[];
	groups: SystemGroup[];
	components: SystemComponent[];
	connections: SystemConnection[];
	/** Presentation only: saved outside Project content history. */
	viewport: CanvasViewport;
};

/** The System design content that Undo, Revert, and the Assistant change; viewport is navigation. */
export type SystemContent = Omit<SystemDesign, "viewport">;

export type SystemViewName = "system" | "database";

export const SYSTEM_COMPONENT_KINDS: readonly SystemComponentKind[] = ["generic", "database", ...CLIENT_TRAFFIC_KINDS];
export const DEFAULT_SYSTEM_CONNECTION_LABEL = "Interaction";
export const SYSTEM_COMPONENT_NAME_LIMIT = 80;
export const SYSTEM_CONNECTION_LABEL_LIMIT = 80;
export const SYSTEM_PROPERTY_LIMIT = 40;
export const SYSTEM_COMPONENT_SIZE = { width: 180, height: 84 } as const;
export const SYSTEM_SERVICE_DEFAULT_SIZE: SystemServiceSize = { width: 420, height: 280 };
export const SYSTEM_SERVICE_MIN_SIZE: SystemServiceSize = { width: 240, height: 160 };
export const SYSTEM_GROUP_DEFAULT_SIZE: SystemServiceSize = { width: 360, height: 240 };
export const SYSTEM_GROUP_MIN_SIZE: SystemServiceSize = { width: 160, height: 120 };
export const SYSTEM_DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export function createEmptySystemDesign(): SystemDesign {
	return { services: [], groups: [], components: [], connections: [], viewport: { ...SYSTEM_DEFAULT_VIEWPORT } };
}

/**
 * The system overview of a Project migrated from the single-database model:
 * one system-scope Database component linked to the original Design. No
 * Services, Connections, or Walkthroughs are invented.
 */
export function createMigratedSystemDesign(databaseDesignId: string, componentId: string, name = "Database"): SystemDesign {
	return {
		services: [],
		groups: [],
		components: [{
			id: componentId,
			kind: "database",
			name,
			properties: [],
			position: { x: 120, y: 120 },
			serviceId: null,
			designId: databaseDesignId,
		}],
		connections: [],
		viewport: { ...SYSTEM_DEFAULT_VIEWPORT },
	};
}

export type SystemComponentInput = {
	id: string;
	kind?: SystemComponentKind;
	name?: string;
	technology?: string;
	description?: string;
	properties?: SystemComponentProperty[];
	position: CanvasPoint;
	designId?: string;
	/** The owning Service. Omitted or null places the Component at system scope. */
	serviceId?: string | null;
};

export type SystemComponentChanges = Partial<Pick<SystemComponent, "kind" | "name" | "technology" | "description" | "properties" | "designId" | "serviceId">>;

export type SystemServiceInput = {
	id: string;
	name?: string;
	position: CanvasPoint;
	size?: SystemServiceSize;
};

export type SystemServiceChanges = Partial<Pick<SystemService, "name">>;

export type SystemGroupInput = {
	id: string;
	name?: string;
	position: CanvasPoint;
	size?: SystemServiceSize;
	memberIds?: string[];
};

export type SystemGroupChanges = Partial<Pick<SystemGroup, "name" | "memberIds">>;

/**
 * The identities a move of one Group carries, each listed once even when
 * memberships overlap or nest. Owned Components of a moved Service move with it.
 */
export type SystemGroupMoveTargets = {
	groupIds: string[];
	serviceIds: string[];
	componentIds: string[];
};

export type SystemConnectionInput = {
	id: string;
	sourceId: string;
	targetId: string;
	label?: string;
	interactionType?: string;
	protocol?: string;
};

export type SystemConnectionChanges = Partial<Pick<SystemConnection, "sourceId" | "targetId" | "label" | "interactionType" | "protocol">>;

/** A Connection that a removal would delete because one of its endpoints is removed. */
export type AffectedSystemConnection = {
	id: string;
	label: string;
	sourceId: string;
	targetId: string;
};

export type SystemComponentRemovalPlan = {
	componentId: string;
	componentName: string;
	connections: AffectedSystemConnection[];
};

export type SystemServiceRemovalPlan = {
	serviceId: string;
	serviceName: string;
	/** Components the removal releases to system scope. They keep their positions and Connections. */
	releasedComponents: { id: string; name: string }[];
	/** Connections whose actual endpoint is this Service. Removing the Service deletes them. */
	connections: AffectedSystemConnection[];
};

export function findSystemService(design: SystemDesign, serviceId: string): SystemService | undefined {
	return design.services.find((service) => service.id === serviceId);
}

export function findSystemComponent(design: SystemDesign, componentId: string): SystemComponent | undefined {
	return design.components.find((component) => component.id === componentId);
}

export function findSystemConnection(design: SystemDesign, connectionId: string): SystemConnection | undefined {
	return design.connections.find((connection) => connection.id === connectionId);
}

export function findSystemGroup(design: SystemDesign, groupId: string): SystemGroup | undefined {
	return design.groups.find((group) => group.id === groupId);
}

export function addSystemService(design: SystemDesign, input: SystemServiceInput): SystemDesign {
	requireIdentity(input.id, "Service id");
	if (findSystemService(design, input.id)) throw new Error(`Service "${input.id}" already exists.`);
	requireUnusedId(design, input.id);
	const service: SystemService = {
		id: input.id,
		name: requireSystemName(input.name ?? nextDefaultName("Service", design.services.map((item) => item.name)), "Service name"),
		position: requirePosition(input.position, "Service position"),
		size: normalizeFrameSize(input.size ?? SYSTEM_SERVICE_DEFAULT_SIZE, SYSTEM_SERVICE_MIN_SIZE),
	};
	return { ...design, services: [...design.services, service] };
}

export function updateSystemService(design: SystemDesign, serviceId: string, changes: SystemServiceChanges): SystemDesign {
	const current = requireSystemService(design, serviceId);
	if (changes.name === undefined) return design;
	const name = requireSystemName(changes.name, "Service name");
	if (name === current.name) return design;
	return replaceService(design, { ...current, name });
}

/**
 * Moves a Service boundary together with the Components it owns, keeping their
 * offsets. Ownership is unchanged. Each member moves once.
 */
export function moveSystemService(design: SystemDesign, serviceId: string, position: CanvasPoint): SystemDesign {
	const current = requireSystemService(design, serviceId);
	const next = requirePosition(position, "Service position");
	const dx = next.x - current.position.x;
	const dy = next.y - current.position.y;
	if (dx === 0 && dy === 0) return design;
	return {
		...design,
		services: design.services.map((service) => (service.id === serviceId ? { ...service, position: next } : service)),
		components: design.components.map((component) => (
			component.serviceId === serviceId
				? { ...component, position: requirePosition({ x: component.position.x + dx, y: component.position.y + dy }) }
				: component
		)),
	};
}

export function resizeSystemService(design: SystemDesign, serviceId: string, size: SystemServiceSize): SystemDesign {
	const current = requireSystemService(design, serviceId);
	const next = normalizeFrameSize(size, SYSTEM_SERVICE_MIN_SIZE);
	if (current.size.width === next.width && current.size.height === next.height) return design;
	return replaceService(design, { ...current, size: next });
}

/** Lists what removing the Service releases and which Connections it deletes, before anything changes. */
export function describeSystemServiceRemoval(design: SystemDesign, serviceId: string): SystemServiceRemovalPlan {
	const service = requireSystemService(design, serviceId);
	return {
		serviceId,
		serviceName: service.name,
		releasedComponents: design.components
			.filter((component) => component.serviceId === serviceId)
			.map(({ id, name }) => ({ id, name })),
		connections: design.connections
			.filter((connection) => connection.sourceId === serviceId || connection.targetId === serviceId)
			.map(({ id, label, sourceId, targetId }) => ({ id, label, sourceId, targetId })),
	};
}

/**
 * Removes the Service boundary. Its owned Components become system-scope
 * resources, keeping their positions and Connections. Connections whose actual
 * endpoint is the Service are deleted; Component-to-Component Connections stay.
 */
export function removeSystemService(design: SystemDesign, serviceId: string): SystemDesign {
	requireSystemService(design, serviceId);
	return {
		...design,
		services: design.services.filter((service) => service.id !== serviceId),
		groups: pruneSystemGroupMemberships(design.groups, serviceId),
		components: design.components.map((component) => (
			component.serviceId === serviceId ? { ...component, serviceId: null } : component
		)),
		connections: design.connections.filter(
			(connection) => connection.sourceId !== serviceId && connection.targetId !== serviceId,
		),
	};
}

export function addSystemGroup(design: SystemDesign, input: SystemGroupInput): SystemDesign {
	requireIdentity(input.id, "Group id");
	if (findSystemGroup(design, input.id)) throw new Error(`Group "${input.id}" already exists.`);
	requireUnusedId(design, input.id);
	const group: SystemGroup = {
		id: input.id,
		name: requireSystemName(input.name ?? nextDefaultName("Group", design.groups.map((item) => item.name)), "Group name"),
		position: requirePosition(input.position, "Group position"),
		size: normalizeFrameSize(input.size ?? SYSTEM_GROUP_DEFAULT_SIZE, SYSTEM_GROUP_MIN_SIZE),
		memberIds: requireGroupMembers(design, input.id, input.memberIds ?? []),
	};
	return { ...design, groups: [...design.groups, group] };
}

/**
 * Renames a Group or replaces its members. Membership is validated as a whole:
 * an unknown member, a Group containing itself, or a nesting cycle refuses the
 * change and leaves the design as it was.
 */
export function updateSystemGroup(design: SystemDesign, groupId: string, changes: SystemGroupChanges): SystemDesign {
	const current = requireSystemGroup(design, groupId);
	const next: SystemGroup = { ...current };
	if (changes.name !== undefined) next.name = requireSystemName(changes.name, "Group name");
	if (changes.memberIds !== undefined) next.memberIds = requireGroupMembers(design, groupId, changes.memberIds);
	if (sameJson(current, next)) return design;
	return replaceGroup(design, next);
}

/**
 * Lists every identity a move of the Group carries. A nested Group contributes its
 * own members transitively; each Component, Service, and child Group is listed
 * once, however many memberships reach it.
 */
export function describeSystemGroupMove(design: SystemDesign, groupId: string): SystemGroupMoveTargets {
	requireSystemGroup(design, groupId);
	const groupIds = new Set<string>();
	const serviceIds = new Set<string>();
	const componentIds = new Set<string>();
	const visit = (id: string) => {
		if (groupIds.has(id)) return;
		groupIds.add(id);
		for (const memberId of requireSystemGroup(design, id).memberIds) {
			if (findSystemGroup(design, memberId)) visit(memberId);
			else if (findSystemService(design, memberId)) serviceIds.add(memberId);
			else if (findSystemComponent(design, memberId)) componentIds.add(memberId);
		}
	};
	visit(groupId);
	for (const component of design.components) {
		if (component.serviceId !== null && serviceIds.has(component.serviceId)) componentIds.add(component.id);
	}
	return { groupIds: [...groupIds], serviceIds: [...serviceIds], componentIds: [...componentIds] };
}

/**
 * Moves a Group frame to a new position and carries every identity it resolves
 * to by the same offset, each exactly once. Ownership and membership are unchanged.
 */
export function moveSystemGroup(design: SystemDesign, groupId: string, position: CanvasPoint): SystemDesign {
	const current = requireSystemGroup(design, groupId);
	const next = requirePosition(position, "Group position");
	const dx = next.x - current.position.x;
	const dy = next.y - current.position.y;
	if (dx === 0 && dy === 0) return design;
	const targets = describeSystemGroupMove(design, groupId);
	const groupSet = new Set(targets.groupIds);
	const serviceSet = new Set(targets.serviceIds);
	const componentSet = new Set(targets.componentIds);
	const shifted = (point: CanvasPoint) => requirePosition({ x: point.x + dx, y: point.y + dy }, "Position");
	return {
		...design,
		groups: design.groups.map((group) => {
			if (group.id === groupId) return { ...group, position: next };
			return groupSet.has(group.id) ? { ...group, position: shifted(group.position) } : group;
		}),
		services: design.services.map((service) => (serviceSet.has(service.id) ? { ...service, position: shifted(service.position) } : service)),
		components: design.components.map((component) => (componentSet.has(component.id) ? { ...component, position: shifted(component.position) } : component)),
	};
}

/** Changes the frame's size only. Drawing or resizing a Group never changes its membership. */
export function resizeSystemGroup(design: SystemDesign, groupId: string, size: SystemServiceSize): SystemDesign {
	const current = requireSystemGroup(design, groupId);
	const next = normalizeFrameSize(size, SYSTEM_GROUP_MIN_SIZE);
	if (current.size.width === next.width && current.size.height === next.height) return design;
	return replaceGroup(design, { ...current, size: next });
}

/**
 * Removes the Group frame. Its members stay where they are with their ownership
 * and Connections; the Group is only removed from any Group that contained it.
 */
export function removeSystemGroup(design: SystemDesign, groupId: string): SystemDesign {
	requireSystemGroup(design, groupId);
	return {
		...design,
		groups: pruneSystemGroupMemberships(design.groups.filter((group) => group.id !== groupId), groupId),
	};
}

/** The Groups that name `id` as a member, so the designer can see every organization it belongs to. */
export function systemGroupsContaining(design: SystemDesign, id: string): SystemGroup[] {
	return design.groups.filter((group) => group.memberIds.includes(id));
}

/**
 * Whether `memberId` may join the Group now: it must exist, not be the Group
 * itself, and not already contain the Group. Used to offer only valid choices.
 */
export function canAddSystemGroupMember(design: SystemDesign, groupId: string, memberId: string): boolean {
	if (memberId === groupId || !isIdentity(design, memberId)) return false;
	return !findSystemGroup(design, memberId) || !reachesGroup(design.groups, memberId, groupId);
}

/**
 * Drops one identity from every Group's members. Used when a Component or Service
 * is removed, so no Group names an item that no longer exists.
 */
export function pruneSystemGroupMemberships(groups: readonly SystemGroup[], removedId: string): SystemGroup[] {
	return groups.map((group) => (
		group.memberIds.includes(removedId)
			? { ...group, memberIds: group.memberIds.filter((id) => id !== removedId) }
			: group
	));
}

/**
 * Drops members that are not in `liveIds`. Assistant Revert uses it after it
 * restores items, so a Group never names an identity the restored design lacks.
 */
export function keepSystemGroupMembers(groups: readonly SystemGroup[], liveIds: ReadonlySet<string>): SystemGroup[] {
	return groups.map((group) => {
		const kept = group.memberIds.filter((id) => liveIds.has(id));
		return kept.length === group.memberIds.length ? group : { ...group, memberIds: kept };
	});
}

export function addSystemComponent(design: SystemDesign, input: SystemComponentInput): SystemDesign {
	requireIdentity(input.id, "Component id");
	if (findSystemComponent(design, input.id)) throw new Error(`Component "${input.id}" already exists.`);
	requireUnusedId(design, input.id);
	const component: SystemComponent = {
		id: input.id,
		kind: requireKind(input.kind ?? "generic"),
		name: requireSystemName(input.name ?? defaultComponentName(design, input.kind ?? "generic"), "Component name"),
		properties: normalizeProperties(input.properties ?? []),
		position: requirePosition(input.position),
		serviceId: requireOwnerService(design, input.serviceId),
		...optionalText("technology", input.technology),
		...optionalText("description", input.description),
		...optionalDesignId(input.designId),
	};
	requireLinkAllowed(component);
	return { ...design, components: [...design.components, component] };
}

export function updateSystemComponent(design: SystemDesign, componentId: string, changes: SystemComponentChanges): SystemDesign {
	const current = requireSystemComponent(design, componentId);
	const next: SystemComponent = { ...current };
	if (changes.kind !== undefined) next.kind = requireKind(changes.kind);
	if (changes.name !== undefined) next.name = requireSystemName(changes.name, "Component name");
	if (changes.properties !== undefined) next.properties = normalizeProperties(changes.properties);
	if ("technology" in changes) setOptionalText(next, "technology", changes.technology);
	if ("description" in changes) setOptionalText(next, "description", changes.description);
	if ("designId" in changes) {
		delete next.designId;
		Object.assign(next, optionalDesignId(changes.designId));
	}
	if ("serviceId" in changes) next.serviceId = requireOwnerService(design, changes.serviceId);
	if (changes.kind !== undefined && changes.kind !== "database" && current.designId !== undefined) {
		throw new Error("Unlink this Component from its database design before changing its kind.");
	}
	requireLinkAllowed(next);
	if (sameJson(current, next)) return design;
	return replaceComponent(design, next);
}

export function moveSystemComponent(design: SystemDesign, componentId: string, position: CanvasPoint): SystemDesign {
	const current = requireSystemComponent(design, componentId);
	const next = { ...current, position: requirePosition(position) };
	if (sameJson(current.position, next.position)) return design;
	return replaceComponent(design, next);
}

/** Lists the Connections that removing the Component would delete. */
export function describeSystemComponentRemoval(design: SystemDesign, componentId: string): SystemComponentRemovalPlan {
	const component = requireSystemComponent(design, componentId);
	return {
		componentId,
		componentName: component.name,
		connections: design.connections
			.filter((connection) => connection.sourceId === componentId || connection.targetId === componentId)
			.map(({ id, label, sourceId, targetId }) => ({ id, label, sourceId, targetId })),
	};
}

/** Removes the Component, its Connections, and its Group memberships. */
export function removeSystemComponent(design: SystemDesign, componentId: string): SystemDesign {
	requireSystemComponent(design, componentId);
	return {
		...design,
		groups: pruneSystemGroupMemberships(design.groups, componentId),
		components: design.components.filter((component) => component.id !== componentId),
		connections: design.connections.filter(
			(connection) => connection.sourceId !== componentId && connection.targetId !== componentId,
		),
	};
}

export function addSystemConnection(design: SystemDesign, input: SystemConnectionInput): SystemDesign {
	requireIdentity(input.id, "Connection id");
	if (findSystemConnection(design, input.id)) throw new Error(`Connection "${input.id}" already exists.`);
	requireDistinctEndpoints(design, input.sourceId, input.targetId);
	const connection: SystemConnection = {
		id: input.id,
		sourceId: input.sourceId,
		targetId: input.targetId,
		label: requireSystemName(input.label ?? DEFAULT_SYSTEM_CONNECTION_LABEL, "Connection label", SYSTEM_CONNECTION_LABEL_LIMIT),
		...optionalText("interactionType", input.interactionType),
		...optionalText("protocol", input.protocol),
	};
	return { ...design, connections: [...design.connections, connection] };
}

export function updateSystemConnection(design: SystemDesign, connectionId: string, changes: SystemConnectionChanges): SystemDesign {
	const current = requireSystemConnection(design, connectionId);
	const next: SystemConnection = { ...current };
	if (changes.sourceId !== undefined) next.sourceId = changes.sourceId;
	if (changes.targetId !== undefined) next.targetId = changes.targetId;
	requireDistinctEndpoints(design, next.sourceId, next.targetId);
	if (changes.label !== undefined) {
		next.label = requireSystemName(changes.label, "Connection label", SYSTEM_CONNECTION_LABEL_LIMIT);
	}
	if ("interactionType" in changes) setOptionalText(next, "interactionType", changes.interactionType);
	if ("protocol" in changes) setOptionalText(next, "protocol", changes.protocol);
	if (sameJson(current, next)) return design;
	return {
		...design,
		connections: design.connections.map((connection) => (connection.id === connectionId ? next : connection)),
	};
}

export function removeSystemConnection(design: SystemDesign, connectionId: string): SystemDesign {
	requireSystemConnection(design, connectionId);
	return { ...design, connections: design.connections.filter((connection) => connection.id !== connectionId) };
}

/**
 * Route offsets for Connections that join the same two endpoints, in either
 * direction. Each one gets a distinct offset centered on zero, so parallel
 * curves never coincide. A reversed Connection needs its own slot: the curve
 * for A to B with an offset equals the curve for B to A with the same offset.
 */
export function systemConnectionRouteOffsets(design: SystemDesign): Map<string, number> {
	const groups = new Map<string, SystemConnection[]>();
	for (const connection of design.connections) {
		const [a, b] = [connection.sourceId, connection.targetId].sort();
		const key = `${a}\u0000${b}`;
		groups.set(key, [...(groups.get(key) ?? []), connection]);
	}
	const offsets = new Map<string, number>();
	for (const group of groups.values()) {
		group.forEach((connection, index) => {
			offsets.set(connection.id, index - (group.length - 1) / 2);
		});
	}
	return offsets;
}

/**
 * Validates a System design loaded from storage. Malformed or dangling
 * identities are rejected so the workspace never edits a corrupt document.
 * Documents saved before Services existed load with no Services and every
 * Component at system scope.
 */
export function normalizeSystemDesign(value: unknown): SystemDesign {
	if (!isRecord(value) || !Array.isArray(value.components) || !Array.isArray(value.connections)) {
		throw new Error("The saved System design is malformed.");
	}
	const rawServices = value.services ?? [];
	const rawGroups = value.groups ?? [];
	if (!Array.isArray(rawServices) || !Array.isArray(rawGroups)) throw new Error("The saved System design is malformed.");

	const services: SystemService[] = [];
	const serviceIds = new Set<string>();
	for (const item of rawServices) {
		if (!isRecord(item)) throw new Error("A saved Service is malformed.");
		const id = requireIdentity(item.id, "Service id");
		if (serviceIds.has(id)) throw new Error(`Service "${id}" is duplicated.`);
		serviceIds.add(id);
		services.push({
			id,
			name: requireSystemName(item.name, "Service name"),
			position: requirePosition(item.position as CanvasPoint, "Service position"),
			size: normalizeFrameSize(isRecord(item.size) ? (item.size as unknown as SystemServiceSize) : SYSTEM_SERVICE_DEFAULT_SIZE, SYSTEM_SERVICE_MIN_SIZE),
		});
	}

	const groups: SystemGroup[] = [];
	const groupIds = new Set<string>();
	for (const item of rawGroups) {
		if (!isRecord(item)) throw new Error("A saved Group is malformed.");
		const id = requireIdentity(item.id, "Group id");
		if (groupIds.has(id)) throw new Error(`Group "${id}" is duplicated.`);
		if (serviceIds.has(id)) throw new Error(`Group "${id}" uses the id of a Service.`);
		groupIds.add(id);
		const rawMembers = item.memberIds ?? [];
		if (!Array.isArray(rawMembers)) throw new Error(`Group "${id}" has malformed members.`);
		groups.push({
			id,
			name: requireSystemName(item.name, "Group name"),
			position: requirePosition(item.position as CanvasPoint, "Group position"),
			size: normalizeFrameSize(isRecord(item.size) ? (item.size as unknown as SystemServiceSize) : SYSTEM_GROUP_DEFAULT_SIZE, SYSTEM_GROUP_MIN_SIZE),
			memberIds: rawMembers.map((memberId) => requireIdentity(memberId, `Group "${id}" member`)),
		});
	}

	const components: SystemComponent[] = [];
	const componentIds = new Set<string>();
	for (const item of value.components) {
		if (!isRecord(item)) throw new Error("A saved Component is malformed.");
		const id = requireIdentity(item.id, "Component id");
		if (componentIds.has(id)) throw new Error(`Component "${id}" is duplicated.`);
		if (serviceIds.has(id)) throw new Error(`Component "${id}" uses the id of a Service.`);
		if (groupIds.has(id)) throw new Error(`Component "${id}" uses the id of a Group.`);
		componentIds.add(id);
		const serviceId = typeof item.serviceId === "string" ? item.serviceId : null;
		if (serviceId !== null && !serviceIds.has(serviceId)) {
			throw new Error(`Component "${id}" belongs to a Service that does not exist.`);
		}
		const component: SystemComponent = {
			id,
			kind: requireKind(item.kind),
			name: requireSystemName(item.name, "Component name"),
			properties: normalizeProperties(Array.isArray(item.properties) ? item.properties : []),
			position: requirePosition(item.position as CanvasPoint),
			serviceId,
			...optionalText("technology", typeof item.technology === "string" ? item.technology : undefined),
			...optionalText("description", typeof item.description === "string" ? item.description : undefined),
			...optionalDesignId(typeof item.designId === "string" ? item.designId : undefined),
		};
		requireLinkAllowed(component);
		components.push(component);
	}

	const endpointIds = new Set([...componentIds, ...serviceIds]);
	const identityIds = new Set([...endpointIds, ...groupIds]);
	for (const group of groups) {
		if (new Set(group.memberIds).size !== group.memberIds.length) throw new Error(`Group "${group.id}" lists a member twice.`);
		for (const memberId of group.memberIds) {
			if (memberId === group.id) throw new Error(`Group "${group.id}" cannot contain itself.`);
			if (!identityIds.has(memberId)) throw new Error(`Group "${group.id}" contains "${memberId}", which does not exist.`);
		}
		if (reachesGroup(groups, group.id, group.id)) throw new Error(`Group "${group.id}" is part of a nesting cycle.`);
	}

	const connections: SystemConnection[] = [];
	const connectionIds = new Set<string>();
	for (const item of value.connections) {
		if (!isRecord(item)) throw new Error("A saved Connection is malformed.");
		const id = requireIdentity(item.id, "Connection id");
		if (connectionIds.has(id)) throw new Error(`Connection "${id}" is duplicated.`);
		connectionIds.add(id);
		const sourceId = requireIdentity(item.sourceId, "Connection source");
		const targetId = requireIdentity(item.targetId, "Connection target");
		if (!endpointIds.has(sourceId) || !endpointIds.has(targetId)) {
			throw new Error(`Connection "${id}" refers to a Component that does not exist.`);
		}
		if (sourceId === targetId) throw new Error(`Connection "${id}" must join two different Components.`);
		connections.push({
			id,
			sourceId,
			targetId,
			label: requireSystemName(item.label, "Connection label", SYSTEM_CONNECTION_LABEL_LIMIT),
			...optionalText("interactionType", typeof item.interactionType === "string" ? item.interactionType : undefined),
			...optionalText("protocol", typeof item.protocol === "string" ? item.protocol : undefined),
		});
	}
	const viewport = isRecord(value.viewport) ? value.viewport : SYSTEM_DEFAULT_VIEWPORT;
	return {
		services,
		groups,
		components,
		connections,
		viewport: {
			x: finiteOr(viewport.x, 0),
			y: finiteOr(viewport.y, 0),
			zoom: finiteOr(viewport.zoom, 1),
		},
	};
}

/** Keeps only the content that Undo and Revert restore; viewport is navigation. */
export function systemDesignContent(design: SystemDesign): SystemContent {
	return { services: design.services, groups: design.groups, components: design.components, connections: design.connections };
}

function replaceComponent(design: SystemDesign, next: SystemComponent): SystemDesign {
	return {
		...design,
		components: design.components.map((component) => (component.id === next.id ? next : component)),
	};
}

function replaceGroup(design: SystemDesign, next: SystemGroup): SystemDesign {
	return {
		...design,
		groups: design.groups.map((group) => (group.id === next.id ? next : group)),
	};
}

function replaceService(design: SystemDesign, next: SystemService): SystemDesign {
	return {
		...design,
		services: design.services.map((service) => (service.id === next.id ? next : service)),
	};
}

function requireSystemService(design: SystemDesign, serviceId: string): SystemService {
	const service = findSystemService(design, serviceId);
	if (!service) throw new Error("That Service could not be found.");
	return service;
}

function requireSystemGroup(design: SystemDesign, groupId: string): SystemGroup {
	const group = findSystemGroup(design, groupId);
	if (!group) throw new Error("That Group could not be found.");
	return group;
}

/**
 * Checks a complete member list for a Group. Members must exist, a Group cannot
 * contain itself, and no member Group may already contain this one, directly or
 * through its own Groups. Duplicates collapse to one membership.
 */
function requireGroupMembers(design: SystemDesign, groupId: string, memberIds: readonly string[]): string[] {
	const members: string[] = [];
	for (const memberId of memberIds) {
		requireIdentity(memberId, "Group member");
		if (members.includes(memberId)) continue;
		if (memberId === groupId) throw new Error("A Group cannot contain itself.");
		if (!isIdentity(design, memberId)) throw new Error(`"${memberId}" does not match a Component, Service, or Group.`);
		members.push(memberId);
	}
	const target = findSystemGroup(design, groupId);
	for (const memberId of members) {
		const member = findSystemGroup(design, memberId);
		if (member && reachesGroup(design.groups, memberId, groupId)) {
			throw new Error(`Nesting "${target?.name ?? groupId}" inside "${member.name}" would create a cycle.`);
		}
	}
	return members;
}

/** True when `targetId` is reachable from `fromId` through member Groups, so `fromId` contains it. */
function reachesGroup(groups: readonly SystemGroup[], fromId: string, targetId: string): boolean {
	const seen = new Set<string>();
	const stack = [fromId];
	while (stack.length > 0) {
		const currentId = stack.pop();
		const group = groups.find((item) => item.id === currentId);
		if (!group) continue;
		for (const memberId of group.memberIds) {
			if (memberId === targetId) return true;
			if (!seen.has(memberId)) {
				seen.add(memberId);
				stack.push(memberId);
			}
		}
	}
	return false;
}

function isIdentity(design: SystemDesign, id: string): boolean {
	return findSystemComponent(design, id) !== undefined
		|| findSystemService(design, id) !== undefined
		|| findSystemGroup(design, id) !== undefined;
}

function requireSystemComponent(design: SystemDesign, componentId: string): SystemComponent {
	const component = findSystemComponent(design, componentId);
	if (!component) throw new Error("That Component could not be found.");
	return component;
}

function requireSystemConnection(design: SystemDesign, connectionId: string): SystemConnection {
	const connection = findSystemConnection(design, connectionId);
	if (!connection) throw new Error("That Connection could not be found.");
	return connection;
}

function isEndpoint(design: SystemDesign, id: string): boolean {
	return findSystemComponent(design, id) !== undefined || findSystemService(design, id) !== undefined;
}

function requireDistinctEndpoints(design: SystemDesign, sourceId: string, targetId: string) {
	if (!isEndpoint(design, sourceId)) throw new Error("The Connection source Component could not be found.");
	if (!isEndpoint(design, targetId)) throw new Error("The Connection target Component could not be found.");
	if (sourceId === targetId) throw new Error("A Connection must join two different Components.");
}

/** Component, Service, and Group ids share one namespace, so a Connection endpoint or Group member is never ambiguous. */
function requireUnusedId(design: SystemDesign, id: string) {
	if (findSystemService(design, id)) throw new Error(`"${id}" is already used by a Service.`);
	if (findSystemComponent(design, id)) throw new Error(`"${id}" is already used by a Component.`);
	if (findSystemGroup(design, id)) throw new Error(`"${id}" is already used by a Group.`);
}

/** Services own Components; a Component names at most one owning Service, or none for system scope. */
function requireOwnerService(design: SystemDesign, serviceId: string | null | undefined): string | null {
	if (serviceId === undefined || serviceId === null) return null;
	if (!findSystemService(design, serviceId)) throw new Error("That Service could not be found.");
	return serviceId;
}

function defaultComponentName(design: SystemDesign, kind: SystemComponentKind): string {
	return nextDefaultName(componentDefaultNameStem(kind), design.components.map((component) => component.name));
}

function nextDefaultName(base: string, names: string[]): string {
	const taken = new Set(names);
	if (!taken.has(base)) return base;
	for (let index = 2; ; index += 1) {
		const candidate = `${base} ${index}`;
		if (!taken.has(candidate)) return candidate;
	}
}

function requireKind(value: unknown): SystemComponentKind {
	if (typeof value !== "string" || !SYSTEM_COMPONENT_KINDS.includes(value as SystemComponentKind)) {
		throw new Error(`Unsupported Component kind "${String(value)}".`);
	}
	return value as SystemComponentKind;
}

function requireIdentity(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
	return value;
}

function requireSystemName(value: unknown, label: string, limit = SYSTEM_COMPONENT_NAME_LIMIT): string {
	if (typeof value !== "string") throw new Error(`${label} is required.`);
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new Error(`${label} is required.`);
	if (trimmed.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
	return trimmed;
}

function requirePosition(point: CanvasPoint, label = "Component position"): CanvasPoint {
	if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error(`${label} must be finite.`);
	return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
}

/** Sizes are whole pixels and never smaller than the minimum that keeps the frame's header readable. */
function normalizeFrameSize(size: SystemServiceSize, minimum: SystemServiceSize): SystemServiceSize {
	if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) throw new Error("Size must be finite.");
	return {
		width: Math.max(minimum.width, Math.round(size.width)),
		height: Math.max(minimum.height, Math.round(size.height)),
	};
}

function normalizeProperties(values: unknown[]): SystemComponentProperty[] {
	if (values.length > SYSTEM_PROPERTY_LIMIT) throw new Error(`A Component can have at most ${SYSTEM_PROPERTY_LIMIT} properties.`);
	const keys = new Set<string>();
	return values.map((item) => {
		if (!isRecord(item)) throw new Error("A Component property is malformed.");
		const key = requireSystemName(item.key, "Property name", 60);
		if (keys.has(key)) throw new Error(`Property "${key}" is duplicated.`);
		keys.add(key);
		if (typeof item.value !== "string") throw new Error(`Property "${key}" needs a text value.`);
		return { key, value: item.value.slice(0, 500) };
	});
}

function optionalText(key: "technology" | "description" | "interactionType" | "protocol", value: string | undefined) {
	const trimmed = value?.trim();
	return trimmed ? { [key]: trimmed.slice(0, 500) } : {};
}

function setOptionalText(target: Record<string, unknown>, key: "technology" | "description" | "interactionType" | "protocol", value: unknown) {
	delete target[key];
	if (typeof value === "string") Object.assign(target, optionalText(key, value));
}

function optionalDesignId(designId: string | undefined) {
	return typeof designId === "string" && designId.length > 0 ? { designId } : {};
}

/** Only a Database component may name a database Design. */
function requireLinkAllowed(component: SystemComponent) {
	if (component.designId !== undefined && component.kind !== "database") {
		throw new Error("Only a Database component can link to a database design.");
	}
}

/**
 * The Components that link one Design. More than one means a Shared schema: the
 * Components are distinct architectural databases that describe one schema.
 */
export function componentsLinkedToDesign(design: SystemDesign, designId: string): SystemComponent[] {
	return design.components.filter((component) => component.designId === designId);
}

function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Public workspace actions for the System design. The React view, RPC, and the
 * Assistant all call these; `assistantTurnId` attributes a change to one
 * Assistant turn in the Project history.
 */
export type SystemAttribution = { assistantTurnId?: string };

export type AddSystemServiceAction = SystemAttribution & { id?: string; name?: string; x: number; y: number };
export type UpdateSystemServiceAction = SystemAttribution & { serviceId: string; changes: SystemServiceChanges };
export type MoveSystemServiceAction = SystemAttribution & { serviceId: string; x: number; y: number };
export type ResizeSystemServiceAction = SystemAttribution & { serviceId: string; width: number; height: number };
export type RemoveSystemServiceAction = SystemAttribution & { serviceId: string };
export type AddSystemGroupAction = SystemAttribution & {
	id?: string;
	name?: string;
	x: number;
	y: number;
	width?: number;
	height?: number;
	memberIds?: string[];
};
export type UpdateSystemGroupAction = SystemAttribution & { groupId: string; changes: SystemGroupChanges };
export type MoveSystemGroupAction = SystemAttribution & { groupId: string; x: number; y: number };
export type ResizeSystemGroupAction = SystemAttribution & { groupId: string; width: number; height: number };
export type RemoveSystemGroupAction = SystemAttribution & { groupId: string };
export type AddSystemComponentAction = Omit<SystemComponentInput, "position"> & SystemAttribution & { x: number; y: number };
export type UpdateSystemComponentAction = SystemAttribution & { componentId: string; changes: SystemComponentChanges };
export type MoveSystemComponentAction = SystemAttribution & { componentId: string; x: number; y: number };
export type RemoveSystemComponentAction = SystemAttribution & { componentId: string };
export type AddSystemConnectionAction = SystemConnectionInput & SystemAttribution;
export type UpdateSystemConnectionAction = SystemAttribution & { connectionId: string; changes: SystemConnectionChanges };
export type RemoveSystemConnectionAction = SystemAttribution & { connectionId: string };
export type SetSystemViewportAction = CanvasViewport;
export type SetActiveViewAction = { view: SystemViewName };
/** Links a Database component to a Design of the Project, or unlinks it with `null`. */
export type LinkSystemDatabaseAction = { componentId: string; designId: string | null };
/** Creates a new database Design for a conceptual Database component and links it. */
export type CreateSystemDatabaseDesignAction = { componentId: string; name?: string };

/** A free spot for a new Component near the middle of what the designer sees. */
export function openSpotNear(design: SystemDesign, center: CanvasPoint): CanvasPoint {
	const step = 40;
	for (let ring = 0; ring < 20; ring += 1) {
		for (let dx = -ring; dx <= ring; dx += 1) {
			for (const dy of [-ring, ring]) {
				const candidate = { x: Math.round(center.x + dx * step), y: Math.round(center.y + dy * step) };
				if (isFree(design, candidate)) return candidate;
			}
		}
	}
	return { x: Math.round(center.x), y: Math.round(center.y) };
}

/** A free top-left spot for a new Service boundary of the default size, clear of other Services. */
export function openServiceSpotNear(design: SystemDesign, center: CanvasPoint): CanvasPoint {
	const step = 40;
	const size = SYSTEM_SERVICE_DEFAULT_SIZE;
	const origin = { x: Math.round(center.x - size.width / 2), y: Math.round(center.y - size.height / 2) };
	for (let ring = 0; ring < 20; ring += 1) {
		for (let dx = -ring; dx <= ring; dx += 1) {
			for (const dy of [-ring, ring]) {
				const candidate = { x: Math.round(origin.x + dx * step), y: Math.round(origin.y + dy * step) };
				if (serviceSpotIsFree(design, candidate, size)) return candidate;
			}
		}
	}
	return origin;
}

function isFree(design: SystemDesign, point: CanvasPoint): boolean {
	return design.components.every((component) => {
		const dx = Math.abs(component.position.x - point.x);
		const dy = Math.abs(component.position.y - point.y);
		return dx >= SYSTEM_COMPONENT_SIZE.width + 16 || dy >= SYSTEM_COMPONENT_SIZE.height + 16;
	});
}

function serviceSpotIsFree(design: SystemDesign, point: CanvasPoint, size: SystemServiceSize): boolean {
	const gap = 16;
	return design.services.every((service) => (
		service.position.x + service.size.width + gap <= point.x
		|| point.x + size.width + gap <= service.position.x
		|| service.position.y + service.size.height + gap <= point.y
		|| point.y + size.height + gap <= service.position.y
	));
}
