import type { CanvasPoint } from "./design";
import {
	SYSTEM_COMPONENT_SIZE,
	SYSTEM_GROUP_MIN_SIZE,
	SYSTEM_SERVICE_MIN_SIZE,
	findSystemComponent,
	findSystemGroup,
	findSystemService,
	moveSystemComponent,
	type SystemDesign,
	type SystemServiceSize,
} from "./system-design";

/**
 * An explicit arrangement of the System design. It places Components in layers
 * that follow their Connections, then fits each Service and Group frame around
 * what it owns or contains. Arranging is only done when a designer or the
 * Assistant asks for it: nothing else moves an existing Component.
 */

/** Spacing between layers and rows, sized around one Component card. */
export const SYSTEM_LAYOUT_COLUMN_GAP = 240;
export const SYSTEM_LAYOUT_ROW_GAP = 240;

/** Detect saved layouts whose visible cards need more room, including older compact rows. */
export function systemCardsOverlap(design: SystemDesign): boolean {
	const visible = design.components.filter((component) => component.serviceId === null
		|| !design.collapsedServiceIds.includes(component.serviceId));
	return visible.some((component, index) => visible.slice(index + 1).some((other) =>
		Math.abs(component.position.x - other.position.x) < SYSTEM_COMPONENT_SIZE.width
		&& Math.abs(component.position.y - other.position.y) < SYSTEM_COMPONENT_SIZE.height));
}
/** Space a frame leaves around its contents. The Service and Group header sits above the top padding. */
export const SYSTEM_FRAME_PADDING = 32;
export const SYSTEM_FRAME_HEADER = 48;
/** Space between one Service's frame and the next band's frame. */
export const SYSTEM_LAYOUT_BAND_GAP = 24;

export type SystemFramePlacement = {
	id: string;
	position: CanvasPoint;
	size: SystemServiceSize;
};

/** The positions one layout arrangement produces. Only the listed items change. */
export type SystemLayoutPlacement = {
	components: { id: string; position: CanvasPoint }[];
	services: SystemFramePlacement[];
	groups: SystemFramePlacement[];
};

export type SystemLayoutAction = { assistantTurnId?: string } & { placement: SystemLayoutPlacement };

/**
 * Computes a layered arrangement of `componentIds`, or of every Component when
 * omitted. Layers flow left to right along the Connections between arranged
 * Components. Each Service's Components form their own band of rows, stacked
 * top to bottom, so Service boundaries never overlap; system-scope Components
 * go in a final band. The arranged area starts at the smallest x and y the
 * Components already had. Cycles are broken where the walk first closes them.
 * Frames of Services and Groups that hold an arranged Component are refitted;
 * others keep their place.
 */
export function computeSystemLayout(design: SystemDesign, componentIds?: readonly string[]): SystemLayoutPlacement {
	const scope = componentIds === undefined
		? design.components
		: [...new Set(componentIds)].map((id) => {
			const component = findSystemComponent(design, id);
			if (!component) throw new Error(`"${id}" does not match a Component.`);
			return component;
		});
	if (scope.length === 0) return { components: [], services: [], groups: [] };

	const scopeIds = new Set(scope.map((component) => component.id));
	const layers = layerComponents(design, scope.map((component) => component.id), scopeIds);
	const origin = {
		x: Math.min(...scope.map((component) => component.position.x)),
		y: Math.min(...scope.map((component) => component.position.y)),
	};

	// Each Service takes its own band of rows, stacked top to bottom, so no two
	// Service boundaries overlap. Components at system scope come last, below them.
	// Within a band, each layer is a column that runs left to right.
	const components: SystemLayoutPlacement["components"] = [];
	let bandTop = origin.y;
	const bands: (string | null)[] = [...design.services.map((service) => service.id), null];
	for (const owner of bands) {
		const members = scope.filter((component) => (component.serviceId ?? null) === owner).map((component) => component.id);
		if (members.length === 0) continue;
		const rowsByLayer = new Map<number, string[]>();
		for (const id of members) {
			const layer = layers.get(id) ?? 0;
			rowsByLayer.set(layer, [...(rowsByLayer.get(layer) ?? []), id]);
		}
		let rows = 1;
		for (const [layer, ids] of rowsByLayer) {
			ids.forEach((id, row) => {
				components.push({
					id,
					position: {
						x: origin.x + layer * SYSTEM_LAYOUT_COLUMN_GAP,
						y: bandTop + row * SYSTEM_LAYOUT_ROW_GAP,
					},
				});
			});
			rows = Math.max(rows, ids.length);
		}
		// The next band starts below this band's frame, with its padding, header, and a gap.
		bandTop += (rows - 1) * SYSTEM_LAYOUT_ROW_GAP + SYSTEM_COMPONENT_SIZE.height + SYSTEM_FRAME_PADDING * 2 + SYSTEM_FRAME_HEADER + SYSTEM_LAYOUT_BAND_GAP;
	}

	// The design as it will look once the Components move, used to fit frames around them.
	let arranged = design;
	for (const { id, position } of components) arranged = moveSystemComponent(arranged, id, position);

	const changedIds = new Set(scopeIds);
	const services: SystemFramePlacement[] = [];
	for (const service of design.services) {
		const owned = arranged.components.filter((component) => component.serviceId === service.id);
		if (!owned.some((component) => changedIds.has(component.id))) continue;
		const frame = fitFrame(
			owned.map((component) => ({ x: component.position.x, y: component.position.y, width: SYSTEM_COMPONENT_SIZE.width, height: SYSTEM_COMPONENT_SIZE.height })),
			SYSTEM_SERVICE_MIN_SIZE,
		)
			?? { position: service.position, size: service.size };
		services.push({ id: service.id, ...frame });
		changedIds.add(service.id);
	}
	arranged = applyFramePlacements(arranged, { services, groups: [] });

	const groups: SystemFramePlacement[] = [];
	for (const groupId of groupsInNestingOrder(design)) {
		const group = findSystemGroup(arranged, groupId);
		if (!group) continue;
		const memberIds = group.memberIds;
		if (!memberIds.some((memberId) => changedIds.has(memberId))) continue;
		const frame = fitFrame(memberRects(arranged, memberIds), SYSTEM_GROUP_MIN_SIZE) ?? { position: group.position, size: group.size };
		groups.push({ id: group.id, ...frame });
		changedIds.add(group.id);
		arranged = applyFramePlacements(arranged, { services: [], groups: [{ id: group.id, ...frame }] });
	}

	return { components, services, groups };
}

/** Applies a placement computed for this design. Unknown ids and non-finite positions refuse the whole placement. */
export function applySystemLayout(design: SystemDesign, placement: SystemLayoutPlacement): SystemDesign {
	let next = design;
	for (const { id, position } of placement.components) {
		if (!findSystemComponent(next, id)) throw new Error(`"${id}" does not match a Component.`);
		next = moveSystemComponent(next, id, requireFinitePoint(position));
	}
	return applyFramePlacements(next, placement);
}

function applyFramePlacements(
	design: SystemDesign,
	placement: { services: SystemFramePlacement[]; groups: SystemFramePlacement[] },
): SystemDesign {
	const frames = (items: SystemFramePlacement[], find: (id: string) => boolean, label: string) => {
		for (const item of items) {
			if (!find(item.id)) throw new Error(`"${item.id}" does not match a ${label}.`);
			requireFinitePoint(item.position);
			requireFinitePoint({ x: item.size.width, y: item.size.height });
		}
		return new Map(items.map((item) => [item.id, item]));
	};
	const serviceFrames = frames(placement.services, (id) => findSystemService(design, id) !== undefined, "Service");
	const groupFrames = frames(placement.groups, (id) => findSystemGroup(design, id) !== undefined, "Group");
	return {
		...design,
		services: design.services.map((service) => {
			const frame = serviceFrames.get(service.id);
			return frame ? { ...service, position: { ...frame.position }, size: { ...frame.size } } : service;
		}),
		groups: design.groups.map((group) => {
			const frame = groupFrames.get(group.id);
			return frame ? { ...group, position: { ...frame.position }, size: { ...frame.size } } : group;
		}),
	};
}

/**
 * Layers Components by longest path along Connections inside the scope. A
 * Connection that closes a cycle is ignored for layering, so every Component
 * still gets a layer.
 */
function layerComponents(design: SystemDesign, ids: readonly string[], scopeIds: ReadonlySet<string>): Map<string, number> {
	const edges = design.connections.filter((connection) => (
		scopeIds.has(connection.sourceId) && scopeIds.has(connection.targetId) && connection.sourceId !== connection.targetId
	));
	const outgoing = new Map<string, string[]>();
	for (const edge of edges) outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge.targetId]);

	const visiting = new Set<string>();
	const finished = new Set<string>();
	const backEdges = new Set<string>();
	const visit = (id: string) => {
		visiting.add(id);
		for (const targetId of outgoing.get(id) ?? []) {
			if (visiting.has(targetId)) backEdges.add(`${id}\u0000${targetId}`);
			else if (!finished.has(targetId)) visit(targetId);
		}
		visiting.delete(id);
		finished.add(id);
	};
	for (const id of ids) if (!finished.has(id)) visit(id);

	const incoming = new Map<string, string[]>();
	for (const edge of edges) {
		if (backEdges.has(`${edge.sourceId}\u0000${edge.targetId}`)) continue;
		incoming.set(edge.targetId, [...(incoming.get(edge.targetId) ?? []), edge.sourceId]);
	}
	const layers = new Map<string, number>();
	const layerOf = (id: string): number => {
		const known = layers.get(id);
		if (known !== undefined) return known;
		const sources = incoming.get(id) ?? [];
		const layer = sources.length === 0 ? 0 : Math.max(...sources.map(layerOf)) + 1;
		layers.set(id, layer);
		return layer;
	};
	for (const id of ids) layerOf(id);
	return layers;
}

/** Groups ordered so every nested Group comes before the Group that contains it. */
function groupsInNestingOrder(design: SystemDesign): string[] {
	const ordered: string[] = [];
	const seen = new Set<string>();
	const visit = (groupId: string) => {
		if (seen.has(groupId)) return;
		seen.add(groupId);
		const group = findSystemGroup(design, groupId);
		for (const memberId of group?.memberIds ?? []) {
			if (findSystemGroup(design, memberId)) visit(memberId);
		}
		ordered.push(groupId);
	};
	for (const group of design.groups) visit(group.id);
	return ordered;
}

/** The rectangles a frame must cover for its members, using their current geometry. */
function memberRects(design: SystemDesign, memberIds: readonly string[]): Rect[] {
	const rects: Rect[] = [];
	for (const memberId of memberIds) {
		const component = findSystemComponent(design, memberId);
		if (component) {
			rects.push({ x: component.position.x, y: component.position.y, width: SYSTEM_COMPONENT_SIZE.width, height: SYSTEM_COMPONENT_SIZE.height });
			continue;
		}
		const service = findSystemService(design, memberId);
		if (service) {
			rects.push({ ...service.position, ...service.size });
			continue;
		}
		const group = findSystemGroup(design, memberId);
		if (group) rects.push({ ...group.position, ...group.size });
	}
	return rects;
}

type Rect = { x: number; y: number; width: number; height: number };

/**
 * The frame that covers the rectangles with padding and a header. Returns
 * undefined when there is nothing to cover, so the caller keeps the frame it has.
 */
function fitFrame(boxes: readonly Rect[], minimum: SystemServiceSize): { position: CanvasPoint; size: SystemServiceSize } | undefined {
	if (boxes.length === 0) return undefined;
	const left = Math.min(...boxes.map((box) => box.x));
	const top = Math.min(...boxes.map((box) => box.y));
	const right = Math.max(...boxes.map((box) => box.x + box.width));
	const bottom = Math.max(...boxes.map((box) => box.y + box.height));
	return {
		position: {
			x: Math.round(left - SYSTEM_FRAME_PADDING),
			y: Math.round(top - SYSTEM_FRAME_PADDING - SYSTEM_FRAME_HEADER),
		},
		size: {
			width: Math.max(minimum.width, Math.round(right - left + SYSTEM_FRAME_PADDING * 2)),
			height: Math.max(minimum.height, Math.round(bottom - top + SYSTEM_FRAME_PADDING * 2 + SYSTEM_FRAME_HEADER)),
		},
	};
}

/**
 * The frame an added Group takes when it is given members and no position: it
 * covers those members as the arrangement would. Undefined when there are none
 * that exist.
 */
export function frameAroundMembers(design: SystemDesign, memberIds: readonly string[]): { position: CanvasPoint; size: SystemServiceSize } | undefined {
	return fitFrame(memberRects(design, memberIds), SYSTEM_GROUP_MIN_SIZE);
}

function requireFinitePoint(point: CanvasPoint): CanvasPoint {
	if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Layout positions must be finite.");
	return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 };
}
