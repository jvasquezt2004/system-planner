import { describe, expect, test } from "bun:test";
import {
	addSystemComponent,
	addSystemConnection,
	addSystemGroup,
	addSystemService,
	createEmptySystemDesign,
	moveSystemComponent,
	moveSystemGroup,
	openSpotNear,
	type SystemDesign,
} from "../shared/system-design";
import { sampleCubicBezier } from "../shared/architecture-proof";
import {
	clampZoom,
	connectionGeometries,
	groupFrameAround,
	movedBeyondThreshold,
	playbackRoutes,
	previewScene,
	resizedGroupSize,
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

describe("system design Group geometry", () => {
	function nestedDesign(): SystemDesign {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "worker", name: "Worker", position: { x: 40, y: 60 }, serviceId: "orders" });
		design = addSystemComponent(design, { id: "queue", name: "Queue", position: { x: 300, y: 60 } });
		design = addSystemGroup(design, { id: "domain", name: "Domain", position: { x: 20, y: 20 }, memberIds: ["queue", "orders"] });
		return addSystemGroup(design, { id: "core", name: "Core", position: { x: 0, y: 0 }, memberIds: ["domain", "queue"] });
	}

	test("a live Group drag previews exactly what the saved move will produce, once per identity", () => {
		const design = nestedDesign();
		const preview = previewScene(design, { mode: "group", id: "core", position: { x: 60, y: 10 } });
		expect(preview).toEqual(moveSystemGroup(design, "core", { x: 60, y: 10 }));
		// Offset (60, 10): queue is a member of two Groups but moves once.
		expect(preview.components.find((component) => component.id === "queue")!.position).toEqual({ x: 360, y: 70 });
		expect(preview.components.find((component) => component.id === "worker")!.position).toEqual({ x: 100, y: 70 });
		expect(preview.components.find((component) => component.id === "worker")!.serviceId).toBe("orders");
	});

	test("a Group resize preview changes only the frame size and never its members", () => {
		const design = nestedDesign();
		const preview = previewScene(design, { mode: "group-resize", id: "domain", size: { width: 500, height: 300 } });
		expect(preview.groups.find((group) => group.id === "domain")!.size).toEqual({ width: 500, height: 300 });
		expect(preview.groups.find((group) => group.id === "domain")!.memberIds).toEqual(["queue", "orders"]);
		expect(preview.components).toEqual(design.components);
	});

	test("Group resizing keeps the minimum frame size", () => {
		expect(resizedGroupSize({ width: 360, height: 240 }, -500, -500)).toEqual({ width: 160, height: 120 });
		expect(resizedGroupSize({ width: 360, height: 240 }, 40, 10)).toEqual({ width: 400, height: 250 });
	});

	test("a new Group frame encloses its chosen members, including nested Groups and Services", () => {
		const design = nestedDesign();
		const frame = groupFrameAround(design, ["queue", "orders"])!;
		// Queue spans x 300..480, y 60..144; Orders spans x 0..420, y 0..280.
		expect(frame.position).toEqual({ x: -24, y: -48 });
		expect(frame.size.width).toBeGreaterThanOrEqual(420 + 24 + 24);
		expect(frame.size.height).toBeGreaterThanOrEqual(280 + 48 + 24);
		expect(groupFrameAround(design, [])).toBeNull();
	});
});

