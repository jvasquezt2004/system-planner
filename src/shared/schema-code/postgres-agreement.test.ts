import { describe, expect, test } from "bun:test";
import type { Design } from "../design";
import {
	generateOrmSchema,
	isOrmTarget,
	SCHEMA_CODE_FORMATS,
} from "./index";
import { SCHEMA_CODE_FIXTURES } from "./fixtures";
import { createPGliteSandbox } from "../../test-support/sandbox";
import { generateDesignSql, planSchemaObjectNames } from "../sql";

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
	test("every ORM format names each omitted PostgreSQL logic category and stays silent when none apply", () => {
		const minimal = structuredClone(SCHEMA_CODE_FIXTURES.minimal);
		const tables = (rowLevelSecurity: boolean, includePolicy: boolean) => minimal.tables.map((table) => ({
			...table,
			rowLevelSecurity,
			policies: includePolicy ? [{
				id: "read-rows",
				name: "read_rows",
				command: "SELECT" as const,
				roles: ["anon"],
				mode: "permissive" as const,
				using: "true",
				withCheck: "",
			}] : [],
		}));
		const fn: NonNullable<Design["functions"]>[number] = {
			id: "get-books",
			name: "get_books",
			arguments: [],
			returnType: "integer",
			returnsSet: false,
			language: "sql",
			volatility: "stable",
			security: "invoker",
			body: "SELECT 1",
		};
		const triggerDesign = {
			...minimal,
			tables: tables(false, false),
			functions: [{ ...fn, returnType: "trigger", language: "plpgsql" as const }],
			triggers: [{
				id: "touch-books", name: "touch_books", tableId: minimal.tables[0]!.id,
				timing: "BEFORE" as const, events: [{ event: "INSERT" as const }],
				level: "ROW" as const, functionId: fn.id, when: "",
			}],
		};
		const cases: { name: string; design: Design; expected: string | null }[] = [
			{
				name: "row-level security only",
				design: { ...minimal, tables: tables(true, false), functions: [] },
				expected: "row-level security is not represented",
			},
			{
				name: "policies only",
				design: { ...minimal, tables: tables(false, true), functions: [] },
				expected: "policies are not represented",
			},
			{
				name: "functions only",
				design: { ...minimal, tables: tables(false, false), functions: [fn] },
				expected: "functions are not represented",
			},
			{
				name: "triggers only",
				design: triggerDesign,
				expected: "triggers are not represented",
			},
			{
				name: "no omitted PostgreSQL logic",
				design: { ...minimal, tables: tables(false, false), functions: [], triggers: [] },
				expected: null,
			},
		];
		for (const format of SCHEMA_CODE_FORMATS) {
			if (!isOrmTarget(format.target)) continue;
			for (const scenario of cases) {
				const result = generateOrmSchema(format.target, scenario.design);
				expect(result.ok).toBe(true);
				if (!result.ok) continue;
				const code = result.code.toLowerCase();
				if (scenario.expected) expect(code).toContain(scenario.expected);
				else expect(code).not.toContain("not represented; preserve them in postgresql migrations.");
			}
		}
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

describe("schema object names", () => {
	test("match the names in the generated SQL for every fixture", () => {
		for (const fixture of Object.values(SCHEMA_CODE_FIXTURES)) {
			const generation = generateDesignSql(fixture);
			if (!generation.ok) throw new Error(generation.errors.join("\n"));
			const names = planSchemaObjectNames(fixture);
			const all = [
				...names.foreignKeys.values(),
				...names.relationshipUniques.values(),
				...names.pairConstraints.values(),
				...names.indexes.values(),
				...names.uniqueConstraints.values(),
			];
			for (const name of all) expect(generation.sql).toContain(`"${name}"`);
		}
		const blog = planSchemaObjectNames(SCHEMA_CODE_FIXTURES.blog);
		expect(blog.foreignKeys.size).toBe(7);
		expect(blog.relationshipUniques.size).toBe(1);
		expect(blog.pairConstraints.get("m_posts_tags")).toBe("post_tags_pair_key");
		expect(blog.indexes.get("i_posts_keywords")).toBe("posts_keywords_gin");
		expect(blog.uniqueConstraints.get("u_posts_author_slug")).toBe("posts_author_slug_key");
	});
});
