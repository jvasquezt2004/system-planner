import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, type CanvasPoint, type CanvasViewport } from "../shared/design";
import { computeConnectionPath, sampleCubicBezier, type ProofPoint, type ProofRect } from "../shared/architecture-proof";
import type { PlaybackRoute } from "../shared/walkthrough-playback";
import {
	SYSTEM_COMPONENT_SIZE,
	SYSTEM_GROUP_MIN_SIZE,
	SYSTEM_SERVICE_COLLAPSED_SIZE,
	SYSTEM_SERVICE_MIN_SIZE,
	findSystemComponent,
	findSystemGroup,
	findSystemService,
	isSystemServiceCollapsed,
	moveSystemGroup,
	resizeSystemGroup,
	systemConnectionRouteOffsets,
	visibleEndpointOf,
	type SystemComponent,
	type SystemConnection,
	type SystemDesign,
	type SystemServiceSize,
} from "../shared/system-design";

/** Pixel distance a pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 3;

/** A gesture in progress, shown before the workspace saves it. */
export type SceneDrag =
	| { mode: "component"; id: string; position: CanvasPoint }
	| { mode: "service"; id: string; position: CanvasPoint }
	| { mode: "resize"; id: string; size: SystemServiceSize }
	| { mode: "group"; id: string; position: CanvasPoint }
	| { mode: "group-resize"; id: string; size: SystemServiceSize };

/**
 * The design as it will look once the drag is saved. Moving a Service carries
 * the Components it owns by the same offset; moving a Group carries its nested
 * members once each. Ownership and membership never change.
 */
export function previewScene(design: SystemDesign, drag: SceneDrag | null): SystemDesign {
	if (!drag) return design;
	if (drag.mode === "group") {
		return findSystemGroup(design, drag.id) ? moveSystemGroup(design, drag.id, drag.position) : design;
	}
	if (drag.mode === "group-resize") {
		return findSystemGroup(design, drag.id) ? resizeSystemGroup(design, drag.id, drag.size) : design;
	}
	if (drag.mode === "component") {
		return {
			...design,
			components: design.components.map((component) => (
				component.id === drag.id ? { ...component, position: drag.position } : component
			)),
		};
	}
	if (drag.mode === "resize") {
		return {
			...design,
			services: design.services.map((service) => (service.id === drag.id ? { ...service, size: drag.size } : service)),
		};
	}
	const service = design.services.find((candidate) => candidate.id === drag.id);
	if (!service) return design;
	const dx = drag.position.x - service.position.x;
	const dy = drag.position.y - service.position.y;
	return {
		...design,
		services: design.services.map((candidate) => (candidate.id === drag.id ? { ...candidate, position: drag.position } : candidate)),
		components: design.components.map((component) => (
			component.serviceId === drag.id
				? { ...component, position: { x: component.position.x + dx, y: component.position.y + dy } }
				: component
		)),
	};
}

/** The size a frame takes when its corner moves by the pointer offset, never below its minimum. */
export function resizedFrameSize(origin: SystemServiceSize, dx: number, dy: number, minimum: SystemServiceSize): SystemServiceSize {
	return {
		width: Math.max(minimum.width, Math.round(origin.width + dx)),
		height: Math.max(minimum.height, Math.round(origin.height + dy)),
	};
}

/** The size a Service boundary takes when its corner moves by the pointer offset, never below the minimum. */
export function resizedServiceSize(origin: SystemServiceSize, dx: number, dy: number): SystemServiceSize {
	return resizedFrameSize(origin, dx, dy, SYSTEM_SERVICE_MIN_SIZE);
}

/** The size a Group frame takes when its corner moves by the pointer offset, never below its minimum. */
export function resizedGroupSize(origin: SystemServiceSize, dx: number, dy: number): SystemServiceSize {
	return resizedFrameSize(origin, dx, dy, SYSTEM_GROUP_MIN_SIZE);
}

/** Padding between a Group frame and the members it encloses. The top leaves room for the header. */
const GROUP_FRAME_PADDING = { left: 24, right: 24, top: 48, bottom: 24 } as const;

/**
 * The frame that encloses the given members as they are drawn now. Membership
 * comes from the explicit list, not from this geometry; the frame is only a
 * starting layout for a new Group. Returns null when there is nothing to enclose.
 */
export function groupFrameAround(design: SystemDesign, memberIds: readonly string[]): { position: CanvasPoint; size: SystemServiceSize } | null {
	const rects: { x: number; y: number; width: number; height: number }[] = [];
	for (const id of memberIds) {
		const component = design.components.find((item) => item.id === id);
		const service = design.services.find((item) => item.id === id);
		const group = findSystemGroup(design, id);
		if (component) rects.push(componentRect(component));
		else if (service) rects.push({ x: service.position.x, y: service.position.y, width: service.size.width, height: service.size.height });
		else if (group) rects.push({ x: group.position.x, y: group.position.y, width: group.size.width, height: group.size.height });
	}
	if (rects.length === 0) return null;
	const left = Math.min(...rects.map((rect) => rect.x)) - GROUP_FRAME_PADDING.left;
	const top = Math.min(...rects.map((rect) => rect.y)) - GROUP_FRAME_PADDING.top;
	const right = Math.max(...rects.map((rect) => rect.x + rect.width)) + GROUP_FRAME_PADDING.right;
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height)) + GROUP_FRAME_PADDING.bottom;
	return {
		position: { x: Math.round(left), y: Math.round(top) },
		size: resizedGroupSize({ width: right - left, height: bottom - top }, 0, 0),
	};
}

export function clampZoom(zoom: number): number {
	return Math.min(CANVAS_MAX_ZOOM, Math.max(CANVAS_MIN_ZOOM, zoom));
}

/** Converts a point in the overview's screen space into canvas (world) space. */
export function screenToWorld(point: CanvasPoint, viewport: CanvasViewport): CanvasPoint {
	return { x: (point.x - viewport.x) / viewport.zoom, y: (point.y - viewport.y) / viewport.zoom };
}

/**
 * Zooms around a screen point so the canvas location under the pointer stays
 * under the pointer.
 */
export function zoomAroundPoint(viewport: CanvasViewport, screenPoint: CanvasPoint, nextZoom: number): CanvasViewport {
	const zoom = clampZoom(nextZoom);
	const world = screenToWorld(screenPoint, viewport);
	return {
		x: screenPoint.x - world.x * zoom,
		y: screenPoint.y - world.y * zoom,
		zoom,
	};
}

export function componentRect(component: Pick<SystemComponent, "position">): ProofRect {
	return { x: component.position.x, y: component.position.y, width: SYSTEM_COMPONENT_SIZE.width, height: SYSTEM_COMPONENT_SIZE.height };
}

export type ConnectionGeometry = {
	connection: SystemConnection;
	pathString: string;
	start: ProofPoint;
	cp1: ProofPoint;
	cp2: ProofPoint;
	end: ProofPoint;
	/** The midpoint of the curve, where the label sits. */
	labelPoint: ProofPoint;
};

/**
 * The rectangle an endpoint is drawn with. A Component owned by a collapsed
 * Service is drawn on that Service's collapsed boundary; a collapsed Service
 * uses the collapsed size; anything else keeps its own frame or box. Passing the
 * live positions keeps the drawn rectangle following a drag.
 */
export function drawnEndpointRect(design: SystemDesign, endpointId: string, positions?: Map<string, CanvasPoint>): ProofRect | null {
	const drawnId = visibleEndpointOf(design, endpointId);
	const service = findSystemService(design, drawnId);
	if (service) {
		const position = positions?.get(drawnId) ?? service.position;
		const size = isSystemServiceCollapsed(design, drawnId) ? SYSTEM_SERVICE_COLLAPSED_SIZE : service.size;
		return { x: position.x, y: position.y, width: size.width, height: size.height };
	}
	const component = findSystemComponent(design, endpointId);
	if (!component) return null;
	return componentRect({ position: positions?.get(endpointId) ?? component.position });
}

/**
 * How many Connections stay inside a collapsed Service, between two Components
 * it owns. They have no drawn path while it is collapsed, so the boundary states
 * the count instead of dropping them silently.
 */
export function internalConnectionCount(design: SystemDesign, serviceId: string): number {
	return design.connections.filter((connection) => (
		visibleEndpointOf(design, connection.sourceId) === serviceId
		&& visibleEndpointOf(design, connection.targetId) === serviceId
	)).length;
}

/**
 * Routes every Connection between its drawn endpoints. Dragging a Component
 * changes its rectangle, so passing the live positions keeps the paths following
 * it. Connections whose drawn endpoints coincide stay inside one collapsed
 * Service and are drawn when it expands. Connections that share drawn endpoints
 * get distinct offsets, so projected parallel Connections stay separate and
 * selectable. Connections whose endpoint is missing are skipped.
 */
export function connectionGeometries(design: SystemDesign, positions?: Map<string, CanvasPoint>): ConnectionGeometry[] {
	const drawnEndpointOf = (endpointId: string) => visibleEndpointOf(design, endpointId);
	const offsets = systemConnectionRouteOffsets(design, drawnEndpointOf);
	const result: ConnectionGeometry[] = [];
	for (const connection of design.connections) {
		if (drawnEndpointOf(connection.sourceId) === drawnEndpointOf(connection.targetId)) continue;
		const source = drawnEndpointRect(design, connection.sourceId, positions);
		const target = drawnEndpointRect(design, connection.targetId, positions);
		if (!source || !target) continue;
		const route = computeConnectionPath(source, target, offsets.get(connection.id) ?? 0);
		const labelPoint = sampleCubicBezier(route.start, route.cp1, route.cp2, route.end, 0.5);
		result.push({
			connection,
			pathString: route.pathString,
			start: route.start,
			cp1: route.cp1,
			cp2: route.cp2,
			end: route.end,
			labelPoint,
		});
	}
	return result;
}

/** The curve each drawn Connection follows, keyed by Connection id, for sampling a walkthrough message along it. */
export function playbackRoutes(geometries: ConnectionGeometry[]): Map<string, PlaybackRoute> {
	return new Map(geometries.map((geometry) => [
		geometry.connection.id,
		{ start: geometry.start, cp1: geometry.cp1, cp2: geometry.cp2, end: geometry.end },
	]));
}

/** Estimates the width of a connection label pill from its text. */
export function labelWidth(text: string): number {
	return Math.max(44, Math.min(220, text.length * 6.4 + 18));
}

/** Shortens text for an SVG label without a measured layout. */
export function truncateLabel(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function movedBeyondThreshold(start: CanvasPoint, end: CanvasPoint): boolean {
	return Math.hypot(end.x - start.x, end.y - start.y) > DRAG_THRESHOLD_PX;
}
