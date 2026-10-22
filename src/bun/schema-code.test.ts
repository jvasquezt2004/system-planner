import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design } from "../shared/design";
import {
	generateOrmSchema,
	isOrmTarget,
	SCHEMA_CODE_FORMATS,
	schemaCodeFormat,
	type SchemaCodeSnapshot,
} from "../shared/schema-code";
import { SCHEMA_CODE_FIXTURES } from "../shared/schema-code/fixtures";
import { createPGliteSandbox } from "./sandbox";
import { generateDesignSql } from "./sql";
import { createSqlPreviewActions } from "./sql-preview";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function exportDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-schema-code-"));
	temporaryDirectories.push(directory);
	return directory;
}

const emptyDesign: Design = {
	tables: [],
	relationships: [],
	manyToManyRelationships: [],
	viewport: { x: 0, y: 0, zoom: 1 },
};

describe("schema code formats", () => {
	test("offers PostgreSQL first and one format per ORM", () => {
		expect(SCHEMA_CODE_FORMATS.map((format) => format.target)).toEqual([
			"sql",
			"prisma",
			"drizzle",
			"sqlalchemy",
			"django",
		]);
		expect(isOrmTarget("sql")).toBe(false);
		expect(isOrmTarget("prisma")).toBe(true);
		expect(isOrmTarget("hibernate")).toBe(false);
		for (const format of SCHEMA_CODE_FORMATS) {
			expect(
				format.fileExtensions.some((extension) =>
					format.defaultFileName.endsWith(extension),
				),
			).toBe(true);
		}
	});

	test("every ORM generator returns a result instead of throwing", () => {
		for (const format of SCHEMA_CODE_FORMATS) {
			if (!isOrmTarget(format.target)) continue;
			const result = generateOrmSchema(format.target, emptyDesign);
			expect(typeof result.ok).toBe("boolean");
		}
	});
});

describe("ORM code transfer", () => {
	const snapshot: SchemaCodeSnapshot = {
		target: "prisma",
		revision: 7,
		code: "model User {\n  id Int @id\n}\n",
	};

	test("copies and exports the exact snapshot on screen", async () => {
		const copied: string[] = [];
		const directory = exportDirectory();
		const actions = createSqlPreviewActions({
			writeClipboardText: (text) => copied.push(text),
			chooseExportDirectory: async () => directory,
		});

		expect(actions.copyCode(snapshot)).toEqual({ status: "copied", revision: 7 });
		expect(copied).toEqual([snapshot.code]);

		const result = await actions.exportCode(snapshot, "schema.prisma");
		expect(result).toEqual({
			status: "saved",
			revision: 7,
			path: join(directory, "schema.prisma"),
		});
		expect(readFileSync(join(directory, "schema.prisma"), "utf8")).toBe(snapshot.code);
	});

	test("requires a file name with the format's own extension", async () => {
		const directory = exportDirectory();
		const actions = createSqlPreviewActions({
			writeClipboardText: () => {},
			chooseExportDirectory: async () => directory,
		});

		const result = await actions.exportCode(snapshot, "schema.sql");
		expect(result).toEqual({
			status: "failed",
			revision: 7,
			error: `Choose a valid Prisma file name ending in ${schemaCodeFormat("prisma").fileExtensions[0]}.`,
		});
		expect(existsSync(join(directory, "schema.sql"))).toBe(false);

		const python = await actions.exportCode(
			{ target: "django", revision: 3, code: "from django.db import models\n" },
			"models.py",
		);
		expect(python.status).toBe("saved");
	});

	test("refuses to copy or export when no code is on screen", async () => {
		const actions = createSqlPreviewActions({
			writeClipboardText: () => {
				throw new Error("should not copy");
			},
			chooseExportDirectory: async () => {
				throw new Error("should not ask for a folder");
			},
		});
		expect(actions.copyCode(null)).toEqual({
			status: "failed",
			revision: 0,
			error: "No generated code is available to copy or export.",
		});
		expect(await actions.exportCode({ ...snapshot, code: "  " }, "schema.prisma")).toEqual({
			status: "failed",
			revision: 7,
			error: "No generated code is available to copy or export.",
		});
	});
});

describe("schema code fixtures", () => {
	for (const [name, fixture] of Object.entries(SCHEMA_CODE_FIXTURES)) {
		test(`${name} is a design PostgreSQL accepts`, async () => {
			const generation = generateDesignSql(fixture);
			if (!generation.ok) throw new Error(generation.errors.join("\n"));
			const sandbox = createPGliteSandbox();
			try {
				const result = await sandbox.apply(generation.sql);
				if (!result.ok) throw new Error(`${result.error}\n\n${generation.sql}`);
				expect(result.tables.map((table) => table.name).sort()).toEqual(
					fixture.tables.map((table) => table.name).sort(),
				);
			} finally {
				await sandbox.dispose();
			}
		});
	}
});
