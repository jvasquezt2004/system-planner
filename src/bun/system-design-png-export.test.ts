import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemDesignPngExports, decodePng } from "./system-design-png-export";
import { systemDesignSvgFileName } from "./system-design-svg-export";

const directories: string[] = [];
const NOW = new Date("2026-10-26T21:00:00.000Z");

/** A PNG with a signature, an IHDR chunk for the given size, and the IEND trailer. Pixel data is omitted. */
function pngBytes(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
		return Buffer.concat([Buffer.from([0, 0, 0, data.length]), body, crc]);
	};
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

const PNG = pngBytes(640, 360);
const PNG_BASE64 = PNG.toString("base64");

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-png-export-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("System design PNG export", () => {
	test("writes the rasterized bytes unchanged to a new PNG file in the picked folder", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignPngExports({ chooseExportDirectory: async () => folder, now: () => NOW });

		const result = await exports.export({ png: PNG_BASE64, projectName: "Shop" });

		const expectedName = "shop-system-design-2026-10-26T21-00-00-000Z.png";
		expect(result).toEqual({ status: "saved", path: join(folder, expectedName) });
		expect(readFileSync(join(folder, expectedName)).equals(PNG)).toBe(true);
	});

	test("the written file has a PNG signature and the rasterized dimensions in its header", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignPngExports({ chooseExportDirectory: async () => folder, now: () => NOW });

		const result = await exports.export({ png: pngBytes(1280, 720).toString("base64"), projectName: "Shop" });

		if (result.status !== "saved") throw new Error("expected a saved export");
		const written = readFileSync(result.path);
		expect(written.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
		expect(written.subarray(12, 16).toString("latin1")).toBe("IHDR");
		expect(written.readUInt32BE(16)).toBe(1280);
		expect(written.readUInt32BE(20)).toBe(720);
	});

	test("file names use the PNG extension and never collide with the SVG name for the same moment", () => {
		expect(systemDesignSvgFileName("Shop", NOW).endsWith(".svg")).toBe(true);
		expect(systemDesignSvgFileName("Shop", NOW).replace(/\.svg$/, "")).toBe("shop-system-design-2026-10-26T21-00-00-000Z");
	});

	test("cancelling the picker writes nothing and reports cancellation", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignPngExports({ chooseExportDirectory: async () => null, now: () => NOW });

		expect(await exports.export({ png: PNG_BASE64, projectName: "Shop" })).toEqual({ status: "cancelled" });
		expect(readdirSync(folder)).toHaveLength(0);
	});

	test("bytes that are not a complete PNG are refused before the picker opens", async () => {
		let pickerOpened = false;
		const exports = createSystemDesignPngExports({
			chooseExportDirectory: async () => {
				pickerOpened = true;
				return temporaryDirectory();
			},
			now: () => NOW,
		});
		const truncated = PNG.subarray(0, PNG.length - 4).toString("base64");
		const notPng = Buffer.from("<svg></svg>").toString("base64");
		const zeroWidth = pngBytes(0, 10).toString("base64");

		for (const png of ["", "   ", notPng, truncated, zeroWidth]) {
			const result = await exports.export({ png, projectName: "Shop" });
			expect(result.status).toBe("failed");
		}
		expect(pickerOpened).toBe(false);
	});

	test("decodePng accepts a complete PNG and rejects missing or damaged structure", () => {
		expect(decodePng(PNG_BASE64).equals(PNG)).toBe(true);
		expect(() => decodePng(Buffer.from("not an image").toString("base64"))).toThrow("not a complete PNG");
		expect(() => decodePng(PNG.subarray(0, PNG.length - 1).toString("base64"))).toThrow("not a complete PNG");
		expect(() => decodePng(pngBytes(10, 0).toString("base64"))).toThrow("not a complete PNG");
	});

	test("a picker that cannot open fails without a partial file", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignPngExports({
			chooseExportDirectory: async () => {
				throw new Error("The folder picker is unavailable.");
			},
			now: () => NOW,
		});

		expect(await exports.export({ png: PNG_BASE64, projectName: "Shop" })).toEqual({
			status: "failed",
			error: "The folder picker is unavailable.",
		});
		expect(readdirSync(folder)).toHaveLength(0);
	});

	test("an empty folder choice fails without writing", async () => {
		const exports = createSystemDesignPngExports({ chooseExportDirectory: async () => "   ", now: () => NOW });

		expect((await exports.export({ png: PNG_BASE64, projectName: "Shop" })).status).toBe("failed");
	});

	test("never overwrites an existing PNG of the same name", async () => {
		const folder = temporaryDirectory();
		const name = "shop-system-design-2026-10-26T21-00-00-000Z.png";
		writeFileSync(join(folder, name), "earlier export");
		const exports = createSystemDesignPngExports({ chooseExportDirectory: async () => folder, now: () => NOW });

		const result = await exports.export({ png: PNG_BASE64, projectName: "Shop" });

		expect(result.status).toBe("failed");
		expect(readFileSync(join(folder, name), "utf8")).toBe("earlier export");
		expect(readdirSync(folder)).toEqual([name]);
	});

	test("a folder that does not exist fails and leaves nothing behind", async () => {
		const parent = temporaryDirectory();
		const missing = join(parent, "missing");
		const exports = createSystemDesignPngExports({ chooseExportDirectory: async () => missing, now: () => NOW });

		expect((await exports.export({ png: PNG_BASE64, projectName: "Shop" })).status).toBe("failed");
		expect(existsSync(missing)).toBe(false);
		expect(readdirSync(parent)).toHaveLength(0);
	});
});
