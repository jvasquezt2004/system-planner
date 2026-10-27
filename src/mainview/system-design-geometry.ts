import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, type CanvasPoint, type CanvasViewport } from "../shared/design";
import { computeConnectionPath, sampleCubicBezier, type ProofPoint, type ProofRect } from "../shared/architecture-proof";
import {
	SYSTEM_COMPONENT_SIZE,
	systemConnectionRouteOffsets,
	type SystemComponent,
	type SystemConnection,
	type SystemDesign,
} from "../shared/system-design";

/** Pixel distance a pointer must travel before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 3;

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
	const rectFor = (componentId: string): ProofRect | null => {
		const component = design.components.find((candidate) => candidate.id === componentId);
		if (!component) return null;
		return componentRect({ position: positions?.get(componentId) ?? component.position });
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
