import { describe, expect, test } from "bun:test";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemService,
	createEmptySystemDesign,
	moveSystemComponent,
	openSpotNear,
	type SystemDesign,
} from "../shared/system-design";
import { sampleCubicBezier } from "../shared/architecture-proof";
import {
	clampZoom,
	connectionGeometries,
	movedBeyondThreshold,
	playbackRoutes,
	previewScene,
	resizedServiceSize,
	screenToWorld,
	truncateLabel,
	zoomAroundPoint,
} from "./system-design-geometry";

describe("system design overview geometry", () => {
	test("zoom keeps the canvas point under the pointer fixed", () => {
		const viewport = { x: 40, y: -20, zoom: 1 };
		const pointer = { x: 300, y: 200 };
		const before = screenToWorld(pointer, viewport);
		const zoomed = zoomAroundPoint(viewport, pointer, 2);
		expect(zoomed.zoom).toBe(2);
		expect(screenToWorld(pointer, zoomed)).toEqual(before);
	});

	test("zoom is clamped to the canvas limits shared with the database canvas", () => {
		expect(clampZoom(10)).toBe(2.5);
		expect(clampZoom(0.01)).toBe(0.3);
		expect(clampZoom(1.25)).toBe(1.25);
	});

	test("parallel Connections between the same endpoints get distinct paths", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "a", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "b", position: { x: 320, y: 0 } });
		design = addSystemConnection(design, { id: "one", sourceId: "a", targetId: "b", label: "Upload" });
		design = addSystemConnection(design, { id: "two", sourceId: "a", targetId: "b", label: "Status" });

		const geometries = connectionGeometries(design);
		expect(geometries).toHaveLength(2);
		expect(geometries[0]!.pathString).not.toBe(geometries[1]!.pathString);
		expect(geometries[0]!.labelPoint).not.toEqual(geometries[1]!.labelPoint);
	});

	test("live positions move the connection path with a dragged Component", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "a", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "b", position: { x: 320, y: 0 } });
		design = addSystemConnection(design, { id: "ab", sourceId: "a", targetId: "b", label: "Calls" });

		const resting = connectionGeometries(design)[0]!;
		const dragged = connectionGeometries(design, new Map([["b", { x: 320, y: 200 }]]))[0]!;
		expect(dragged.end.y).not.toBe(resting.end.y);
		expect(connectionGeometries(moveSystemComponent(design, "b", { x: 320, y: 200 }))[0]!.pathString).toBe(dragged.pathString);
	});

	test("a free spot avoids overlapping existing Components", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "a", position: { x: 0, y: 0 } });
		const spot = openSpotNear(design, { x: 0, y: 0 });
		expect(spot).not.toEqual({ x: 0, y: 0 });
		const overlaps = Math.abs(spot.x - 0) < 180 + 16 && Math.abs(spot.y - 0) < 84 + 16;
		expect(overlaps).toBe(false);
	});

	test("only a press that travels past the threshold counts as a drag", () => {
		expect(movedBeyondThreshold({ x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
		expect(movedBeyondThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(true);
	});

	test("labels are shortened with an ellipsis when they exceed their limit", () => {
		expect(truncateLabel("Short", 10)).toBe("Short");
		expect(truncateLabel("A very long interaction label", 10)).toBe("A very lo…");
	});

	test("moving a Service previews the Components it owns by the same offset and leaves other Components alone", () => {
		const design = ownedServiceDesign();
		const scene = previewScene(design, { mode: "service", id: "orders", position: { x: 100, y: 50 } });
		expect(scene.services[0]!.position).toEqual({ x: 100, y: 50 });
		expect(scene.components.find((component) => component.id === "worker")).toMatchObject({
			position: { x: 140, y: 110 },
			serviceId: "orders",
		});
		expect(scene.components.find((component) => component.id === "queue")!.position).toEqual({ x: 600, y: 60 });
	});

	test("resizing previews the new size, and the minimum holds however far the corner is dragged", () => {
		const design = ownedServiceDesign();
		const shrunk = previewScene(design, { mode: "resize", id: "orders", size: resizedServiceSize({ width: 420, height: 280 }, -400, -300) });
		expect(shrunk.services[0]!.size).toEqual({ width: 240, height: 160 });
		expect(resizedServiceSize({ width: 420, height: 280 }, 80.4, 10)).toEqual({ width: 500, height: 290 });
	});

	test("a Connection from a Service attaches to its boundary, so resizing the boundary reroutes it", () => {
		const design = ownedServiceDesign();
		const before = connectionGeometries(design).find((geometry) => geometry.connection.id === "dispatch")!;
		const widened = previewScene(design, { mode: "resize", id: "orders", size: { width: 900, height: 280 } });
		const after = connectionGeometries(widened).find((geometry) => geometry.connection.id === "dispatch")!;
		expect(after.pathString).not.toBe(before.pathString);
	});

	test("with no gesture in progress the saved design is previewed unchanged", () => {
		const design = ownedServiceDesign();
		expect(previewScene(design, null)).toBe(design);
	});
});

function ownedServiceDesign(): SystemDesign {
	let design = createEmptySystemDesign();
	design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
	design = addSystemComponent(design, { id: "worker", position: { x: 40, y: 60 }, serviceId: "orders" });
	design = addSystemComponent(design, { id: "queue", position: { x: 600, y: 60 } });
	design = addSystemConnection(design, { id: "dispatch", sourceId: "orders", targetId: "queue", label: "Dispatches" });
	return design;
}

describe("Walkthrough playback routes", () => {
	test("a playback route is the curve the overview draws, so a message sampled on it lies on the Connection", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "a", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "b", position: { x: 320, y: 0 } });
		design = addSystemConnection(design, { id: "ab", sourceId: "a", targetId: "b", label: "Calls" });

		const geometry = connectionGeometries(design)[0]!;
		const route = playbackRoutes([geometry]).get("ab")!;
		expect(route.start).toEqual(geometry.start);
		expect(route.end).toEqual(geometry.end);
		expect(sampleCubicBezier(route.start, route.cp1, route.cp2, route.end, 0.5)).toEqual(geometry.labelPoint);
	});

	test("moving a Component changes the route its playback follows, not the rest of the design's routes", () => {
		let design = createEmptySystemDesign();
		design = addSystemComponent(design, { id: "a", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "b", position: { x: 320, y: 0 } });
		design = addSystemComponent(design, { id: "c", position: { x: 0, y: 240 } });
		design = addSystemConnection(design, { id: "ab", sourceId: "a", targetId: "b", label: "Calls" });
		design = addSystemConnection(design, { id: "ac", sourceId: "a", targetId: "c", label: "Stores" });

		const before = playbackRoutes(connectionGeometries(design));
		const after = playbackRoutes(connectionGeometries(moveSystemComponent(design, "b", { x: 320, y: 200 })));
		expect(after.get("ab")!.end).not.toEqual(before.get("ab")!.end);
		expect(after.get("ac")).toEqual(before.get("ac"));
	});
});
