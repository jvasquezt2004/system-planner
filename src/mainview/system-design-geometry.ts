import { CANVAS_MAX_ZOOM, CANVAS_MIN_ZOOM, type CanvasPoint, type CanvasViewport } from "../shared/design";
import { computeConnectionPath, sampleCubicBezier, type ProofPoint, type ProofRect } from "../shared/architecture-proof";
import type { PlaybackRoute } from "../shared/walkthrough-playback";
import {
	SYSTEM_COMPONENT_SIZE,
	SYSTEM_SERVICE_MIN_SIZE,
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
	| { mode: "resize"; id: string; size: SystemServiceSize };

/**
 * The design as it will look once the drag is saved. Moving a Service carries
 * the Components it owns by the same offset; ownership itself never changes.
 */
export function previewScene(design: SystemDesign, drag: SceneDrag | null): SystemDesign {
	if (!drag) return design;
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

/** The size a Service boundary takes when its corner moves by the pointer offset, never below the minimum. */
export function resizedServiceSize(origin: SystemServiceSize, dx: number, dy: number): SystemServiceSize {
	return {
		width: Math.max(SYSTEM_SERVICE_MIN_SIZE.width, Math.round(origin.width + dx)),
		height: Math.max(SYSTEM_SERVICE_MIN_SIZE.height, Math.round(origin.height + dy)),
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
