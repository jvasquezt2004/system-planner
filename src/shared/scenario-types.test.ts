import { describe, expect, test } from "bun:test";
import ts from "typescript";
import type { SandboxAppliedTable } from "./design";
import { generateScenarioDatabaseTypes, scenarioSupabaseTypePaths } from "./scenario-types";
describe("Scenario Database type generation", () => {
	test("emits applied table and column types with insert optionality", () => {
		const tables: SandboxAppliedTable[] = [{
			name: "Library Items",
			columns: [
				{ name: "item_id", dataType: "integer", isIdentity: true, defaultExpression: "generated", nullable: false, primaryKey: true, unique: false },
				{ name: "title", dataType: "text", isIdentity: false, defaultExpression: null, nullable: false, primaryKey: false, unique: false },
				{ name: "published", dataType: "boolean", isIdentity: false, defaultExpression: null, nullable: true, primaryKey: false, unique: false },
			],
		}];
		const generated = generateScenarioDatabaseTypes(tables);
		expect(generated).toContain('"Library Items":');
		expect(generated).toContain("item_id: number;");
		expect(generated).toContain("title: string;");
		expect(generated).toContain("published: boolean | null;");
		expect(generated).toContain("item_id?: number;");
		expect(generated).toContain("title: string;");
		expect(generated).toContain("published?: boolean | null;");
	});

	test("real supabase-js declarations type-check query builders and reject unknown columns", () => {
		const tables: SandboxAppliedTable[] = [{
			name: "Books",
			columns: [
				{ name: "id", dataType: "integer", isIdentity: true, defaultExpression: null, nullable: false, primaryKey: true, unique: false },
				{ name: "title", dataType: "text", isIdentity: false, defaultExpression: null, nullable: false, primaryKey: false, unique: false },
				{ name: "status", dataType: "enum", enumTypeName: "BookStatus", isIdentity: false, defaultExpression: null, nullable: false, primaryKey: false, unique: false },
			],
		}];
		const declarations = generateScenarioDatabaseTypes(
			tables,
			[{ id: "book-status", name: "BookStatus", labels: ["draft", "published"] }],
			[{ id: "book-by-id", name: "book_by_id", arguments: [{ name: "book_id", type: "integer" }], returnType: "Books", returnsSet: false, language: "sql", volatility: "stable", security: "invoker", body: "SELECT *" },
				{ id: "log-book", name: "log_book", arguments: [], returnType: "void", returnsSet: false, language: "plpgsql", volatility: "volatile", security: "invoker", body: "BEGIN RETURN; END" }],
		);
		const compile = (query: string) => {
			const filename = `${process.cwd()}/scenario-typecheck-fixture.ts`;
			const source = `${declarations}\n${query}\n`;
			const options: ts.CompilerOptions = {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.ESNext,
				moduleResolution: ts.ModuleResolutionKind.Bundler,
				baseUrl: process.cwd(),
				paths: scenarioSupabaseTypePaths,
				strict: true,
				skipLibCheck: true,
				noEmit: true,
			};
			const host = ts.createCompilerHost(options);
			const getSourceFile = host.getSourceFile.bind(host);
			const fileExists = host.fileExists.bind(host);
			const readFile = host.readFile.bind(host);
			host.getSourceFile = (path, version, onError, shouldCreateNewSourceFile) =>
				path === filename ? ts.createSourceFile(path, source, version, true) :
					getSourceFile(path, version, onError, shouldCreateNewSourceFile);
			host.fileExists = (path) => path === filename || fileExists(path);
			host.readFile = (path) => path === filename ? source : readFile(path);
			const program = ts.createProgram([filename], options, host);
			return ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === filename);
		};
		const validDiagnostics = compile(`
async function validScenario() {
  await supabase.from("Books").insert({ title: "Dune", status: "published" })
    .select("id,title,status").eq("status", "published").order("title").single();
  await supabase.from("Books").select("id").eq("id", 1).maybeSingle();
  const rpc = await supabase.rpc("book_by_id", { book_id: 1 });
  const row: { id: number; title: string; status: "draft" | "published" } = rpc.data!;
  const voidResult: null = (await supabase.rpc("log_book")).data!;
}`);
		expect(validDiagnostics).toEqual([]);
		const invalidDiagnostics = compile(`
async function invalidScenario() {
  const rows: { unknown_column: unknown }[] =
    (await supabase.from("Books").select("unknown_column")).data!;
  await supabase.rpc("book_by_id", { book_id: "not a number" });
}`);
		expect(invalidDiagnostics.length).toBeGreaterThan(0);
	});
});
