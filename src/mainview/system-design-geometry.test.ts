import { describe, expect, test } from "bun:test";
import {
	addSystemComponent,
	addSystemConnection,
	createEmptySystemDesign,
	moveSystemComponent,
	openSpotNear,
} from "../shared/system-design";
import {
	clampZoom,
	connectionGeometries,
	movedBeyondThreshold,
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
});
