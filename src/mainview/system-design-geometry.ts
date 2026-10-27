import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, type CanvasPoint, type CanvasViewport } from "../shared/design";
import { computeConnectionPath, sampleCubicBezier, type ProofPoint, type ProofRect } from "../shared/architecture-proof";
import {
	SYSTEM_COMPONENT_SIZE,
	SYSTEM_GROUP_MIN_SIZE,
	SYSTEM_SERVICE_MIN_SIZE,
	findSystemGroup,
	moveSystemGroup,
	resizeSystemGroup,
	systemConnectionRouteOffsets,
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
	end: ProofPoint;
	/** The midpoint of the curve, where the label sits. */
	labelPoint: ProofPoint;
};

/**
 * Routes every Connection between its endpoints' current rectangles. Dragging a
 * Component changes its rectangle, so passing the live positions keeps the
 * paths following it. Connections that share endpoints get distinct offsets.
 * Connections whose endpoint is missing are skipped.
 */
export function connectionGeometries(design: SystemDesign, positions?: Map<string, CanvasPoint>): ConnectionGeometry[] {
	const offsets = systemConnectionRouteOffsets(design);
	const rectFor = (endpointId: string): ProofRect | null => {
		const service = design.services.find((candidate) => candidate.id === endpointId);
		if (service) {
			const position = positions?.get(endpointId) ?? service.position;
			return { x: position.x, y: position.y, width: service.size.width, height: service.size.height };
		}
		const component = design.components.find((candidate) => candidate.id === endpointId);
		if (!component) return null;
		return componentRect({ position: positions?.get(endpointId) ?? component.position });
	};
	const result: ConnectionGeometry[] = [];
	for (const connection of design.connections) {
		const source = rectFor(connection.sourceId);
		const target = rectFor(connection.targetId);
		if (!source || !target) continue;
		const route = computeConnectionPath(source, target, offsets.get(connection.id) ?? 0);
		const labelPoint = sampleCubicBezier(route.start, route.cp1, route.cp2, route.end, 0.5);
		result.push({ connection, pathString: route.pathString, start: route.start, end: route.end, labelPoint });
	}
	return result;
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
