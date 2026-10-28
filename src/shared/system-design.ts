import type { CanvasPoint, CanvasViewport } from "./design";
import { CATALOG_KINDS, CUSTOM_ICONS, componentDefaultNameStem, type CatalogKind, type CustomIcon } from "./component-catalog";

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

/** "generic" is the one original kind; every other kind is registered in the catalog. */
export type SystemComponentKind = "generic" | CatalogKind;

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
	/** The icon or shape a Custom Component shows. Only a Custom Component stores one; omitted means the rectangle. */
	icon?: CustomIcon;
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

/**
 * A side a Connection attaches to. "auto" is the default, and is stored as an
 * omitted field: the route then picks the side that faces its next point.
 */
export type SystemConnectionSide = "top" | "right" | "bottom" | "left" | "auto";

export const SYSTEM_CONNECTION_SIDES: readonly SystemConnectionSide[] = ["auto", "top", "right", "bottom", "left"];
export const SYSTEM_CONNECTION_BEND_LIMIT = 8;

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
	/** The side of the source endpoint the route leaves from. Omitted means automatic. */
	fromSide?: SystemConnectionSide;
	/** The side of the target endpoint the route arrives at. Omitted means automatic. */
	toSide?: SystemConnectionSide;
	/** Waypoints in canvas space, from source to target. The route passes through each one. */
	bendPoints?: CanvasPoint[];
	/** Offset of the label from the route's midpoint. Omitted means the label sits on the route. */
	labelOffset?: CanvasPoint;
};

export type SystemDesign = {
	services: SystemService[];
	groups: SystemGroup[];
	components: SystemComponent[];
	connections: SystemConnection[];
	/** Presentation only: saved outside Project content history. */
	viewport: CanvasViewport;
	/**
	 * Presentation only: the Services drawn collapsed in the overview. A collapsed
	 * Service hides the Components it owns and projects their Connections onto its
	 * boundary. Every Component, Connection, and endpoint stays as authored.
	 */
	collapsedServiceIds: string[];
	/**
	 * Presentation only: the Service whose focused view was open, or null for the
	 * overview. Focus shows the same identities as the overview, so it never changes
	 * ownership, content, or what Undo reverses.
	 */
	focusedServiceId: string | null;
	/** Presentation only: the camera the focused view was last left at. */
	focusViewport: CanvasViewport;
};

/**
 * The System design content that Undo, Revert, and the Assistant change. The
 * viewport, collapsed Services, and focus are navigation and presentation.
 */
export type SystemContent = Omit<SystemDesign, "viewport" | "collapsedServiceIds" | "focusedServiceId" | "focusViewport">;

export type SystemViewName = "system" | "database";

export const SYSTEM_COMPONENT_KINDS: readonly SystemComponentKind[] = ["generic", ...CATALOG_KINDS];
export const DEFAULT_SYSTEM_CONNECTION_LABEL = "Interaction";
export const SYSTEM_COMPONENT_NAME_LIMIT = 80;
export const SYSTEM_CONNECTION_LABEL_LIMIT = 80;
export const SYSTEM_PROPERTY_LIMIT = 40;
export const SYSTEM_COMPONENT_SIZE = { width: 180, height: 196 } as const;
export const SYSTEM_SERVICE_DEFAULT_SIZE: SystemServiceSize = { width: 420, height: 280 };
export const SYSTEM_SERVICE_MIN_SIZE: SystemServiceSize = { width: 240, height: 160 };
/** The boundary a collapsed Service draws in place of its expanded frame. Its position is unchanged. */
export const SYSTEM_SERVICE_COLLAPSED_SIZE: SystemServiceSize = { width: 210, height: 84 };
export const SYSTEM_GROUP_DEFAULT_SIZE: SystemServiceSize = { width: 360, height: 240 };
export const SYSTEM_GROUP_MIN_SIZE: SystemServiceSize = { width: 160, height: 120 };
export const SYSTEM_DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export function createEmptySystemDesign(): SystemDesign {
	return {
		services: [],
		groups: [],
		components: [],
		connections: [],
		viewport: { ...SYSTEM_DEFAULT_VIEWPORT },
		collapsedServiceIds: [],
		focusedServiceId: null,
		focusViewport: { ...SYSTEM_DEFAULT_VIEWPORT },
	};
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
		collapsedServiceIds: [],
		focusedServiceId: null,
		focusViewport: { ...SYSTEM_DEFAULT_VIEWPORT },
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
	icon?: CustomIcon;
	/** The owning Service. Omitted or null places the Component at system scope. */
	serviceId?: string | null;
};

export type SystemComponentChanges = Partial<Pick<SystemComponent, "kind" | "name" | "technology" | "description" | "properties" | "designId" | "serviceId" | "icon">>;

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

/**
 * Route edits. A `null` or "auto" side restores the automatic side, an empty
 * `bendPoints` removes every bend, and a `null` label offset puts the label back
 * on the route. An omitted field is left as it is.
 */
export type SystemConnectionRouteChanges = {
	fromSide?: SystemConnectionSide | null;
	toSide?: SystemConnectionSide | null;
	bendPoints?: CanvasPoint[];
	labelOffset?: CanvasPoint | null;
};

export type SystemConnectionChanges = Partial<Pick<SystemConnection, "sourceId" | "targetId" | "label" | "interactionType" | "protocol">> & SystemConnectionRouteChanges;

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

export type SystemConnectionRemovalPlan = {
	connectionId: string;
	connectionLabel: string;
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

/**
 * Shows the Service collapsed or expanded. This is view presentation only: the
 * Components, Connections, and endpoints are unchanged, and the caller saves it
 * outside Project history.
 */
export function setSystemServiceCollapsed(design: SystemDesign, serviceId: string, collapsed: boolean): SystemDesign {
	requireSystemService(design, serviceId);
	const isCollapsed = design.collapsedServiceIds.includes(serviceId);
	if (isCollapsed === collapsed) return design;
	return {
		...design,
		collapsedServiceIds: collapsed
			? [...design.collapsedServiceIds, serviceId]
			: design.collapsedServiceIds.filter((id) => id !== serviceId),
	};
}

export function isSystemServiceCollapsed(design: Pick<SystemDesign, "collapsedServiceIds">, serviceId: string): boolean {
	return design.collapsedServiceIds.includes(serviceId);
}

/**
 * The endpoint an identity is drawn on. A Component owned by a collapsed Service
 * is drawn on that Service's boundary; every other identity is its own endpoint.
 * The Connection keeps its actual endpoint ids; only its drawn endpoints change.
 */
export function visibleEndpointOf(design: SystemDesign, endpointId: string): string {
	const component = findSystemComponent(design, endpointId);
	if (!component || component.serviceId === null) return endpointId;
	return design.collapsedServiceIds.includes(component.serviceId) ? component.serviceId : endpointId;
}

/** Whether the Component is hidden because its owning Service is collapsed. */
export function isComponentHiddenByCollapse(design: SystemDesign, componentId: string): boolean {
	const component = findSystemComponent(design, componentId);
	return component !== undefined && visibleEndpointOf(design, componentId) !== componentId;
}

/**
 * Opens the focused view of one Service, or returns to the overview when
 * `serviceId` is null. The focused view has its own camera, so returning to the
 * overview leaves the overview camera as it was. Presentation only.
 */
export function setSystemFocus(design: SystemDesign, serviceId: string | null, viewport?: CanvasViewport): SystemDesign {
	if (serviceId !== null) requireSystemService(design, serviceId);
	const focusViewport = viewport ? { ...viewport } : design.focusViewport;
	if (design.focusedServiceId === serviceId && sameJson(focusViewport, design.focusViewport)) return design;
	return { ...design, focusedServiceId: serviceId, focusViewport };
}

/**
 * The projection a focused Service view draws: the Service expanded with the
 * Components it owns, plus the external endpoints of the Connections that reach
 * the Service or those Components. External endpoints keep their ids and
 * positions and are context only: they are not owned by the focused Service, and
 * Connections between two external endpoints are left out. Edits made in the
 * view go to the real design, so the same Component is what the overview shows.
 */
export type SystemServiceFocus = {
	/** A design the overview's drawing code can draw. It is derived, never saved. */
	scene: SystemDesign;
	/** Endpoints outside the focused Service, shown only because their Connections reach it. */
	contextIds: ReadonlySet<string>;
};

export function systemServiceFocus(design: SystemDesign, serviceId: string): SystemServiceFocus {
	const service = requireSystemService(design, serviceId);
	const owned = design.components.filter((component) => component.serviceId === serviceId);
	const inside = new Set<string>([serviceId, ...owned.map((component) => component.id)]);
	const connections = design.connections.filter(
		(connection) => inside.has(connection.sourceId) || inside.has(connection.targetId),
	);
	const contextIds = new Set<string>();
	for (const connection of connections) {
		for (const endpointId of [connection.sourceId, connection.targetId]) {
			if (!inside.has(endpointId)) contextIds.add(endpointId);
		}
	}

	const services: SystemService[] = [{ ...service, size: { ...service.size } }];
	const components: SystemComponent[] = owned.map((component) => ({ ...component }));
	for (const endpointId of contextIds) {
		const external = findSystemService(design, endpointId);
		if (external) {
			// An outside Service is a compact boundary. Its own Components show only when a Connection reaches them.
			services.push({ ...external, size: { ...SYSTEM_SERVICE_COLLAPSED_SIZE } });
			continue;
		}
		// Drawn outside the focused boundary, so no owner is projected onto it. The overview still shows the real owner.
		const component = findSystemComponent(design, endpointId);
		if (component) components.push({ ...component, serviceId: null });
	}

	return {
		scene: {
			services,
			groups: [],
			components,
			connections: connections.map((connection) => ({ ...connection })),
			viewport: design.viewport,
			collapsedServiceIds: [],
			focusedServiceId: serviceId,
			focusViewport: design.focusViewport,
		},
		contextIds,
	};
}

/**
 * Keeps the presentation of the open design when content is restored. Only
 * collapsed Services that still exist stay collapsed, and focus stays only while
 * its Service exists.
 */
export function withSystemPresentation(
	content: SystemContent,
	presentation: Pick<SystemDesign, "viewport" | "collapsedServiceIds" | "focusedServiceId" | "focusViewport">,
): SystemDesign {
	const serviceIds = new Set(content.services.map((service) => service.id));
	return {
		...content,
		viewport: presentation.viewport,
		collapsedServiceIds: presentation.collapsedServiceIds.filter((id) => serviceIds.has(id)),
		focusedServiceId: presentation.focusedServiceId !== null && serviceIds.has(presentation.focusedServiceId)
			? presentation.focusedServiceId
			: null,
		focusViewport: presentation.focusViewport,
	};
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
		collapsedServiceIds: design.collapsedServiceIds.filter((id) => id !== serviceId),
		focusedServiceId: design.focusedServiceId === serviceId ? null : design.focusedServiceId,
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
		...optionalIcon(input.icon),
	};
	requireLinkAllowed(component);
	requireIconAllowed(component);
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
	if ("icon" in changes) {
		delete next.icon;
		Object.assign(next, optionalIcon(changes.icon));
	}
	if (changes.kind !== undefined && changes.kind !== "database" && current.designId !== undefined) {
		throw new Error("Unlink this Component from its database design before changing its kind.");
	}
	// A chosen icon belongs to a Custom Component, so leaving that kind drops it.
	if (changes.kind !== undefined && changes.kind !== "custom") delete next.icon;
	requireLinkAllowed(next);
	requireIconAllowed(next);
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

export function describeSystemConnectionRemoval(design: SystemDesign, connectionId: string): SystemConnectionRemovalPlan {
	const connection = requireSystemConnection(design, connectionId);
	return { connectionId, connectionLabel: connection.label };
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

/** True when the changes adjust how the Connection is drawn rather than what it means. */
export function hasSystemConnectionRouteChange(changes: SystemConnectionChanges): boolean {
	return changes.fromSide !== undefined
		|| changes.toSide !== undefined
		|| changes.bendPoints !== undefined
		|| changes.labelOffset !== undefined;
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
	if (changes.fromSide !== undefined) setOptionalSide(next, "fromSide", changes.fromSide);
	if (changes.toSide !== undefined) setOptionalSide(next, "toSide", changes.toSide);
	if (changes.bendPoints !== undefined) setOptionalBends(next, changes.bendPoints);
	if (changes.labelOffset !== undefined) {
		if (changes.labelOffset === null) delete next.labelOffset;
		else next.labelOffset = requirePosition(changes.labelOffset, "Label offset");
	}
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
 * `drawnEndpointOf` maps each endpoint to the one it is drawn on, so Connections
 * projected onto the same boundary still get distinct offsets.
 */
export function systemConnectionRouteOffsets(
	design: SystemDesign,
	drawnEndpointOf: (endpointId: string) => string = (endpointId) => endpointId,
): Map<string, number> {
	const groups = new Map<string, SystemConnection[]>();
	for (const connection of design.connections) {
		const [a, b] = [drawnEndpointOf(connection.sourceId), drawnEndpointOf(connection.targetId)].sort();
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
			...optionalIcon(item.icon),
		};
		requireLinkAllowed(component);
		requireIconAllowed(component);
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
			...normalizeRouteFields(item),
		});
	}
	const viewport = isRecord(value.viewport) ? value.viewport : SYSTEM_DEFAULT_VIEWPORT;
	// Documents saved before collapsing existed have no collapsed Services. A stale id is dropped, not an error.
	const collapsedServiceIds = Array.isArray(value.collapsedServiceIds)
		? [...new Set(value.collapsedServiceIds.filter((id): id is string => typeof id === "string" && serviceIds.has(id)))]
		: [];
	// Documents saved before focus existed open the overview. A focus on a Service that no longer exists is dropped.
	const focusedServiceId = typeof value.focusedServiceId === "string" && serviceIds.has(value.focusedServiceId)
		? value.focusedServiceId
		: null;
	const focusViewport = isRecord(value.focusViewport) ? value.focusViewport : viewport;
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
		collapsedServiceIds,
		focusedServiceId,
		focusViewport: {
			x: finiteOr(focusViewport.x, 0),
			y: finiteOr(focusViewport.y, 0),
			zoom: finiteOr(focusViewport.zoom, 1),
		},
	};
}

/** Keeps only the content that Undo and Revert restore; viewport, collapsed Services, and focus are presentation. */
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

/** Sides, bend points, and label offset of a saved Connection. The automatic choice is stored as an omitted field. */
function normalizeRouteFields(item: Record<string, unknown>): Partial<Pick<SystemConnection, "fromSide" | "toSide" | "bendPoints" | "labelOffset">> {
	const fields: Partial<Pick<SystemConnection, "fromSide" | "toSide" | "bendPoints" | "labelOffset">> = {};
	const fromSide = item.fromSide === undefined || item.fromSide === null ? "auto" : requireSystemSide(item.fromSide);
	const toSide = item.toSide === undefined || item.toSide === null ? "auto" : requireSystemSide(item.toSide);
	if (fromSide !== "auto") fields.fromSide = fromSide;
	if (toSide !== "auto") fields.toSide = toSide;
	if (item.bendPoints !== undefined && item.bendPoints !== null) {
		if (!Array.isArray(item.bendPoints)) throw new Error("A saved Connection has malformed bend points.");
		const bends = normalizeBendPoints(item.bendPoints);
		if (bends.length > 0) fields.bendPoints = bends;
	}
	if (item.labelOffset !== undefined && item.labelOffset !== null) {
		fields.labelOffset = requirePosition(item.labelOffset as CanvasPoint, "Label offset");
	}
	return fields;
}

function requireSystemSide(value: unknown): SystemConnectionSide {
	if (typeof value !== "string" || !SYSTEM_CONNECTION_SIDES.includes(value as SystemConnectionSide)) {
		throw new Error("A Connection side must be top, right, bottom, left, or auto.");
	}
	return value as SystemConnectionSide;
}

function normalizeBendPoints(values: readonly unknown[]): CanvasPoint[] {
	if (values.length > SYSTEM_CONNECTION_BEND_LIMIT) {
		throw new Error(`A Connection can have at most ${SYSTEM_CONNECTION_BEND_LIMIT} bend points.`);
	}
	return values.map((value) => requirePosition(value as CanvasPoint, "Bend point"));
}

/** A side is stored only when it is not automatic, so an unchanged route compares equal and leaves no field behind. */
function setOptionalSide(target: SystemConnection, key: "fromSide" | "toSide", value: SystemConnectionSide | null) {
	if (value === null || value === "auto") {
		delete target[key];
		return;
	}
	target[key] = requireSystemSide(value);
}

function setOptionalBends(target: SystemConnection, value: readonly CanvasPoint[]) {
	if (value.length === 0) {
		delete target.bendPoints;
		return;
	}
	target.bendPoints = normalizeBendPoints(value);
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

function optionalIcon(icon: unknown): { icon?: CustomIcon } {
	if (icon === undefined || icon === null) return {};
	if (typeof icon !== "string" || !CUSTOM_ICONS.includes(icon as CustomIcon)) {
		throw new Error(`Unsupported Component icon "${String(icon)}".`);
	}
	return { icon: icon as CustomIcon };
}

/** Only a Custom component may choose an icon or shape. */
function requireIconAllowed(component: SystemComponent) {
	if (component.icon !== undefined && component.kind !== "custom") {
		throw new Error("Only a Custom component can choose an icon or shape.");
	}
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
/** Presentation only: saved outside Project history, so it has no assistant attribution or undo name. */
export type SetSystemServiceCollapsedAction = { serviceId: string; collapsed: boolean };
/** Presentation only: opens a Service's focused view (with its last camera) or returns to the overview when serviceId is null. */
export type SetSystemFocusAction = { serviceId: string | null; viewport?: CanvasViewport };
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
