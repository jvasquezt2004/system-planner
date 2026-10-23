import { describe, expect, test } from "bun:test";
import ts from "typescript";
import type { SandboxAppliedTable } from "./design";
import { edgeFunctionDenoDeclarations, edgeFunctionSupabaseTypePaths } from "./edge-function-types";
import { generateScenarioDatabaseTypes } from "./scenario-types";

describe("Edge function editor declarations", () => {
	test("type-check Deno APIs, supported supabase-js imports, and applied Database types", () => {
		const filename = `${process.cwd()}/edge-function-typecheck-fixture.ts`;
		const denoFilename = `${process.cwd()}/edge-function-deno-fixture.d.ts`;
		const databaseFilename = `${process.cwd()}/edge-function-database-fixture.d.ts`;
		const files = new Map([
			[filename, `
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createClient as createNpmClient } from "npm:@supabase/supabase-js@2";
import { createClient as createEsmClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createClient as createBareClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const client: SupabaseClient<Database> = createClient<Database>("http://sandbox.local", "anon");
createNpmClient<Database>("http://sandbox.local", "anon");
createEsmClient<Database>("http://sandbox.local", "anon");
createBareClient<Database>("http://sandbox.local", "anon");
client.from("Books").select("id");
Deno.serve(async (request) => {
  const url: string | undefined = Deno.env.get("SUPABASE_URL");
  const key: string | undefined = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return new Response(request.url + (url ?? key ?? ""));
});
`],
			[denoFilename, edgeFunctionDenoDeclarations],
			[databaseFilename, generateScenarioDatabaseTypes([{
				name: "Books",
				columns: [{ name: "id", dataType: "integer", isIdentity: true, defaultExpression: null, nullable: false, primaryKey: true, unique: false }],
			} satisfies SandboxAppliedTable])],
		]);
		const options: ts.CompilerOptions = {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			baseUrl: process.cwd(),
			paths: edgeFunctionSupabaseTypePaths,
			strict: true,
			skipLibCheck: true,
			noEmit: true,
		};
		const host = ts.createCompilerHost(options);
		const getSourceFile = host.getSourceFile.bind(host);
		const fileExists = host.fileExists.bind(host);
		const readFile = host.readFile.bind(host);
		host.getSourceFile = (path, version, onError, shouldCreateNewSourceFile) => {
			const source = files.get(path);
			return source === undefined
				? getSourceFile(path, version, onError, shouldCreateNewSourceFile)
				: ts.createSourceFile(path, source, version, true);
		};
		host.fileExists = (path) => files.has(path) || fileExists(path);
		host.readFile = (path) => files.get(path) ?? readFile(path);
		const program = ts.createProgram([...files.keys()], options, host);
		const diagnostics = ts.getPreEmitDiagnostics(program).filter(
			(diagnostic) => diagnostic.file?.fileName === filename,
		);
		expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
	});
});
