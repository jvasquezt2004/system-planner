import { describe, expect, test } from "bun:test";
import { createEmptySystemDesign, addSystemComponent, addSystemService } from "../shared/system-design";
import { MAX_PNG_PIXELS, MAX_PNG_SIDE, PNG_EXPORT_SCALE, bytesToBase64, pngRasterSize, svgSize } from "./system-design-png";
import { systemDesignSvg } from "./system-design-svg";

describe("System design PNG rasterization", () => {
	test("reads the drawn size from the SVG the export renders", () => {
		let design = createEmptySystemDesign();
		design = addSystemService(design, { id: "orders", name: "Orders", position: { x: 0, y: 0 } });
		design = addSystemComponent(design, { id: "api", kind: "api", name: "Order API", position: { x: 40, y: 80 }, serviceId: "orders" });

		const svg = systemDesignSvg(design, { title: "Shop" });
		const size = svgSize(svg);

		expect(size.width).toBeGreaterThan(0);
		expect(size.height).toBeGreaterThan(0);
		expect(svg).toContain(`width="${size.width}" height="${size.height}"`);
	});

	test("refuses an SVG without a drawable size", () => {
		expect(() => svgSize("<svg></svg>")).toThrow("no drawable size");
		expect(() => svgSize('<svg width="0" height="10"></svg>')).toThrow("no drawable size");
	});

	test("rasterizes at the export scale for ordinary diagrams", () => {
		expect(pngRasterSize({ width: 640, height: 360 })).toEqual({ width: 640 * PNG_EXPORT_SCALE, height: 360 * PNG_EXPORT_SCALE, scale: PNG_EXPORT_SCALE });
	});

	test("reduces the scale, and never exceeds the canvas limits, for very large diagrams", () => {
		const wide = pngRasterSize({ width: 9000, height: 100 });
		expect(wide.width).toBeLessThanOrEqual(MAX_PNG_SIDE);
		expect(wide.scale).toBeCloseTo(MAX_PNG_SIDE / 9000);

		const large = pngRasterSize({ width: 6000, height: 4000 });
		expect(large.width * large.height).toBeLessThanOrEqual(MAX_PNG_PIXELS);
		expect(large.scale).toBeLessThan(PNG_EXPORT_SCALE);
	});

	test("never rasterizes to less than one pixel on a side", () => {
		const tiny = pngRasterSize({ width: 0.2, height: 0.2 });
		expect(tiny.width).toBeGreaterThanOrEqual(1);
		expect(tiny.height).toBeGreaterThanOrEqual(1);
	});

	test("base64 for the RPC bridge round-trips large byte arrays exactly", () => {
		const bytes = new Uint8Array(300_000).map((_, index) => (index * 31) % 256);
		const decoded = new Uint8Array(Buffer.from(bytesToBase64(bytes), "base64"));
		expect(decoded.length).toBe(bytes.length);
		expect(decoded.every((byte, index) => byte === bytes[index])).toBe(true);
	});
});
