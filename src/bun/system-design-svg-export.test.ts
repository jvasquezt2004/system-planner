import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemDesignSvgExports, systemDesignSvgFileName } from "./system-design-svg-export";

const directories: string[] = [];
const SVG = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>\n';
const NOW = new Date("2026-10-26T21:00:00.000Z");

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-svg-export-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("System design SVG export", () => {
	test("writes the snapshot's SVG to a new file in the picked folder", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignSvgExports({ chooseExportDirectory: async () => folder, now: () => NOW });

		const result = await exports.export({ svg: SVG, projectName: "Shop" });

		const expectedName = "shop-system-design-2026-10-26T21-00-00-000Z.svg";
		expect(result).toEqual({ status: "saved", path: join(folder, expectedName) });
		expect(readFileSync(join(folder, expectedName), "utf8")).toBe(SVG);
	});

	test("cancelling the picker writes nothing and reports cancellation", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignSvgExports({ chooseExportDirectory: async () => null, now: () => NOW });

		expect(await exports.export({ svg: SVG, projectName: "Shop" })).toEqual({ status: "cancelled" });
		expect(readdirSync(folder)).toHaveLength(0);
	});

	test("an empty folder choice fails without writing", async () => {
		const exports = createSystemDesignSvgExports({ chooseExportDirectory: async () => "   ", now: () => NOW });

		const result = await exports.export({ svg: SVG, projectName: "Shop" });
		expect(result.status).toBe("failed");
	});

	test("a request without a drawn diagram is refused before the picker opens", async () => {
		let pickerOpened = false;
		const exports = createSystemDesignSvgExports({
			chooseExportDirectory: async () => {
				pickerOpened = true;
				return temporaryDirectory();
			},
			now: () => NOW,
		});

		for (const svg of ["", "   ", "plain text", null as unknown as string]) {
			const result = await exports.export({ svg, projectName: "Shop" });
			expect(result.status).toBe("failed");
		}
		expect(pickerOpened).toBe(false);
	});

	test("a picker that cannot open fails without a partial file", async () => {
		const folder = temporaryDirectory();
		const exports = createSystemDesignSvgExports({
			chooseExportDirectory: async () => {
				throw new Error("The folder picker is unavailable.");
			},
			now: () => NOW,
		});

		expect(await exports.export({ svg: SVG, projectName: "Shop" })).toEqual({
			status: "failed",
			error: "The folder picker is unavailable.",
		});
		expect(readdirSync(folder)).toHaveLength(0);
	});

	test("never overwrites an existing file of the same name", async () => {
		const folder = temporaryDirectory();
		const name = systemDesignSvgFileName("Shop", NOW);
		writeFileSync(join(folder, name), "earlier export");
		const exports = createSystemDesignSvgExports({ chooseExportDirectory: async () => folder, now: () => NOW });

		const result = await exports.export({ svg: SVG, projectName: "Shop" });

		expect(result.status).toBe("failed");
		expect(readFileSync(join(folder, name), "utf8")).toBe("earlier export");
		expect(readdirSync(folder)).toEqual([name]);
	});

	test("file names come from the Project name, with a fallback when it has no letters", () => {
		expect(systemDesignSvgFileName("Shop & Cart!", NOW)).toBe("shop-cart-system-design-2026-10-26T21-00-00-000Z.svg");
		expect(systemDesignSvgFileName("  ", NOW)).toBe("project-system-design-2026-10-26T21-00-00-000Z.svg");
		expect(systemDesignSvgFileName("Shop", new Date("2026-10-26T21:00:00.001Z"))).not.toBe(systemDesignSvgFileName("Shop", NOW));
	});

	test("a folder that does not exist fails and leaves nothing behind", async () => {
		const parent = temporaryDirectory();
		const missing = join(parent, "missing");
		const exports = createSystemDesignSvgExports({ chooseExportDirectory: async () => missing, now: () => NOW });

		expect((await exports.export({ svg: SVG, projectName: "Shop" })).status).toBe("failed");
		expect(existsSync(missing)).toBe(false);
	});
});
