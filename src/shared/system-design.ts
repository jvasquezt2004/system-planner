import type { CanvasPoint, CanvasViewport } from "./design";

/**
 * The authoritative System design of one Project: generic Components and the
 * directed, labeled Connections between them. Services, Groups, Walkthroughs,
 * and kind-specific catalogs are added by later tickets; this model holds only
 * what the basic overview edits.
 *
 * Component and Connection `id`s are stable identities. Renames, moves, and
 * edits keep them, and a Connection always names its actual endpoints.
 */

export type SystemComponentKind = "generic" | "database";

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
	 * The linked database Design for a Database component. Several Database
	 * components may name the same Design. Omitted when the component is
	 * conceptual.
	 */
	designId?: string;
};

export type SystemConnection = {
	id: string;
	sourceId: string;
	targetId: string;
	label: string;
	protocol?: string;
};

export type SystemDesign = {
	components: SystemComponent[];
	connections: SystemConnection[];
	/** Presentation only: saved outside Project content history. */
	viewport: CanvasViewport;
};

/** The System design content that Undo, Revert, and the Assistant change; viewport is navigation. */
export type SystemContent = Omit<SystemDesign, "viewport">;

export type SystemViewName = "system" | "database";

export const SYSTEM_COMPONENT_KINDS: readonly SystemComponentKind[] = ["generic", "database"];
export const DEFAULT_SYSTEM_CONNECTION_LABEL = "Interaction";
export const SYSTEM_COMPONENT_NAME_LIMIT = 80;
export const SYSTEM_CONNECTION_LABEL_LIMIT = 80;
export const SYSTEM_PROPERTY_LIMIT = 40;
export const SYSTEM_COMPONENT_SIZE = { width: 180, height: 84 } as const;
export const SYSTEM_DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 };

export function createEmptySystemDesign(): SystemDesign {
	return { components: [], connections: [], viewport: { ...SYSTEM_DEFAULT_VIEWPORT } };
}

/**
 * The system overview of a Project migrated from the single-database model:
 * one system-scope Database component linked to the original Design. No
 * Services, Connections, or Walkthroughs are invented.
 */
export function createMigratedSystemDesign(databaseDesignId: string, componentId: string, name = "Database"): SystemDesign {
	return {
		components: [{
			id: componentId,
			kind: "database",
			name,
			properties: [],
			position: { x: 120, y: 120 },
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
};

export type SystemComponentChanges = Partial<Pick<SystemComponent, "kind" | "name" | "technology" | "description" | "properties" | "designId">>;

export type SystemConnectionInput = {
	id: string;
	sourceId: string;
	targetId: string;
	label?: string;
	protocol?: string;
};

export type SystemConnectionChanges = Partial<Pick<SystemConnection, "sourceId" | "targetId" | "label" | "protocol">>;

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

export function findSystemComponent(design: SystemDesign, componentId: string): SystemComponent | undefined {
	return design.components.find((component) => component.id === componentId);
}

export function findSystemConnection(design: SystemDesign, connectionId: string): SystemConnection | undefined {
	return design.connections.find((connection) => connection.id === connectionId);
}

export function addSystemComponent(design: SystemDesign, input: SystemComponentInput): SystemDesign {
	requireIdentity(input.id, "Component id");
	if (findSystemComponent(design, input.id)) throw new Error(`Component "${input.id}" already exists.`);
	const component: SystemComponent = {
		id: input.id,
		kind: requireKind(input.kind ?? "generic"),
		name: requireSystemName(input.name ?? defaultComponentName(design, input.kind ?? "generic"), "Component name"),
		properties: normalizeProperties(input.properties ?? []),
		position: requirePosition(input.position),
		...optionalText("technology", input.technology),
		...optionalText("description", input.description),
		...optionalDesignId(input.designId),
	};
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

/** Removes the Component and every Connection that uses it as an endpoint. */
export function removeSystemComponent(design: SystemDesign, componentId: string): SystemDesign {
	requireSystemComponent(design, componentId);
	return {
		...design,
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
 * Route offsets for Connections that join the same two Components, in either
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
 */
export function normalizeSystemDesign(value: unknown): SystemDesign {
	if (!isRecord(value) || !Array.isArray(value.components) || !Array.isArray(value.connections)) {
		throw new Error("The saved System design is malformed.");
	}
	const componentIds = new Set<string>();
	let design: SystemDesign = createEmptySystemDesign();
	for (const item of value.components) {
		if (!isRecord(item)) throw new Error("A saved Component is malformed.");
		const id = requireIdentity(item.id, "Component id");
		if (componentIds.has(id)) throw new Error(`Component "${id}" is duplicated.`);
		componentIds.add(id);
		const component: SystemComponent = {
			id,
			kind: requireKind(item.kind),
			name: requireSystemName(item.name, "Component name"),
			properties: normalizeProperties(Array.isArray(item.properties) ? item.properties : []),
			position: requirePosition(item.position as CanvasPoint),
			...optionalText("technology", typeof item.technology === "string" ? item.technology : undefined),
			...optionalText("description", typeof item.description === "string" ? item.description : undefined),
			...optionalDesignId(typeof item.designId === "string" ? item.designId : undefined),
		};
		design = { ...design, components: [...design.components, component] };
	}
	const connectionIds = new Set<string>();
	for (const item of value.connections) {
		if (!isRecord(item)) throw new Error("A saved Connection is malformed.");
		const id = requireIdentity(item.id, "Connection id");
		if (connectionIds.has(id)) throw new Error(`Connection "${id}" is duplicated.`);
		connectionIds.add(id);
		const sourceId = requireIdentity(item.sourceId, "Connection source");
		const targetId = requireIdentity(item.targetId, "Connection target");
		if (!componentIds.has(sourceId) || !componentIds.has(targetId)) {
			throw new Error(`Connection "${id}" refers to a Component that does not exist.`);
		}
		if (sourceId === targetId) throw new Error(`Connection "${id}" must join two different Components.`);
		const connection: SystemConnection = {
			id,
			sourceId,
			targetId,
			label: requireSystemName(item.label, "Connection label", SYSTEM_CONNECTION_LABEL_LIMIT),
			...optionalText("protocol", typeof item.protocol === "string" ? item.protocol : undefined),
		};
		design = { ...design, connections: [...design.connections, connection] };
	}
	const viewport = isRecord(value.viewport) ? value.viewport : SYSTEM_DEFAULT_VIEWPORT;
	return {
		...design,
		viewport: {
			x: finiteOr(viewport.x, 0),
			y: finiteOr(viewport.y, 0),
			zoom: finiteOr(viewport.zoom, 1),
		},
	};
}

/** Keeps only the content that Undo and Revert restore; viewport is navigation. */
export function systemDesignContent(design: SystemDesign): SystemContent {
	return { components: design.components, connections: design.connections };
}

function replaceComponent(design: SystemDesign, next: SystemComponent): SystemDesign {
	return {
		...design,
		components: design.components.map((component) => (component.id === next.id ? next : component)),
	};
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

function requireDistinctEndpoints(design: SystemDesign, sourceId: string, targetId: string) {
	if (!findSystemComponent(design, sourceId)) throw new Error("The Connection source Component could not be found.");
	if (!findSystemComponent(design, targetId)) throw new Error("The Connection target Component could not be found.");
	if (sourceId === targetId) throw new Error("A Connection must join two different Components.");
}

function defaultComponentName(design: SystemDesign, kind: SystemComponentKind): string {
	const base = kind === "database" ? "Database" : "Component";
	const names = new Set(design.components.map((component) => component.name));
	if (!names.has(base)) return base;
	for (let index = 2; ; index += 1) {
		const candidate = `${base} ${index}`;
		if (!names.has(candidate)) return candidate;
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

function requirePosition(point: CanvasPoint): CanvasPoint {
	if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Component position must be finite.");
	return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
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

function optionalText(key: "technology" | "description" | "protocol", value: string | undefined) {
	const trimmed = value?.trim();
	return trimmed ? { [key]: trimmed.slice(0, 500) } : {};
}

function setOptionalText(target: Record<string, unknown>, key: "technology" | "description" | "protocol", value: unknown) {
	delete target[key];
	if (typeof value === "string") Object.assign(target, optionalText(key, value));
}

function optionalDesignId(designId: string | undefined) {
	return typeof designId === "string" && designId.length > 0 ? { designId } : {};
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

export type AddSystemComponentAction = Omit<SystemComponentInput, "position"> & SystemAttribution & { x: number; y: number };
export type UpdateSystemComponentAction = SystemAttribution & { componentId: string; changes: SystemComponentChanges };
export type MoveSystemComponentAction = SystemAttribution & { componentId: string; x: number; y: number };
export type RemoveSystemComponentAction = SystemAttribution & { componentId: string };
export type AddSystemConnectionAction = SystemConnectionInput & SystemAttribution;
export type UpdateSystemConnectionAction = SystemAttribution & { connectionId: string; changes: SystemConnectionChanges };
export type RemoveSystemConnectionAction = SystemAttribution & { connectionId: string };
export type SetSystemViewportAction = CanvasViewport;
export type SetActiveViewAction = { view: SystemViewName };

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

function isFree(design: SystemDesign, point: CanvasPoint): boolean {
	return design.components.every((component) => {
		const dx = Math.abs(component.position.x - point.x);
		const dy = Math.abs(component.position.y - point.y);
		return dx >= SYSTEM_COMPONENT_SIZE.width + 16 || dy >= SYSTEM_COMPONENT_SIZE.height + 16;
	});
}
