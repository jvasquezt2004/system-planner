import { existsSync } from "node:fs";
import { basename, join, normalize, resolve } from "node:path";
import ts from "typescript";
import type { Design, DesignFunction, SandboxAppliedTable } from "../shared/design";
import { generateScenarioDatabaseTypes, scenarioSupabaseTypePaths } from "../shared/scenario-types";
import { edgeFunctionDenoDeclarations, edgeFunctionSupabaseTypePaths } from "../shared/edge-function-types";

export type AssistantCodeKind = "scenario" | "edge-function";

const bundledTypesDirectory = join(import.meta.dir, "assistant-types");
const bundledTypesAvailable = existsSync(join(bundledTypesDirectory, "typescript", "lib", "lib.es5.d.ts"));
const assistantTypesDirectory = bundledTypesAvailable
	? bundledTypesDirectory
	: resolve(import.meta.dir, "../..");
const typescriptLibraryDirectory = join(assistantTypesDirectory, bundledTypesAvailable ? "typescript/lib" : "node_modules/typescript/lib");

/** Type-checks source against the exact declaration generators and module maps used by Monaco. */
export function getAssistantCodeDiagnostics(
	kind: AssistantCodeKind,
	source: string,
	tables: SandboxAppliedTable[],
	enumTypes: Design["enumTypes"] = [],
	functions: DesignFunction[] = [],
): string[] {
	const fileName = `/assistant-source.${kind === "scenario" ? "ts" : "tsx"}`;
	const databaseDeclarations = generateScenarioDatabaseTypes(tables, enumTypes ?? [], functions);
	const declarationFiles: Record<string, string> = {
		[fileName]: source,
		"/assistant-database.d.ts": databaseDeclarations,
	};
	if (kind === "edge-function") declarationFiles["/assistant-deno.d.ts"] = edgeFunctionDenoDeclarations;
	const sourcePaths = kind === "scenario" ? scenarioSupabaseTypePaths : edgeFunctionSupabaseTypePaths;
	const compilerOptions: ts.CompilerOptions = {
		target: ts.ScriptTarget.ESNext,
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		moduleDetection: ts.ModuleDetectionKind.Force,
		baseUrl: assistantTypesDirectory,
		paths: Object.fromEntries(Object.entries(sourcePaths).map(([specifier, targets]) => [
			specifier,
			targets.map((target) => resolve(assistantTypesDirectory, target)),
		])),
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
	};
	const host = ts.createCompilerHost(compilerOptions);
	const originalFileExists = host.fileExists.bind(host);
	const originalReadFile = host.readFile.bind(host);
	const originalGetSourceFile = host.getSourceFile.bind(host);
	const normalizedFiles = new Map(Object.entries(declarationFiles).map(([path, text]) => [normalize(path).replaceAll("\\", "/"), text]));
	host.fileExists = (path) => normalizedFiles.has(normalize(path).replaceAll("\\", "/")) || originalFileExists(path);
	host.readFile = (path) => normalizedFiles.get(normalize(path).replaceAll("\\", "/")) ?? originalReadFile(path);
	host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
		const text = normalizedFiles.get(normalize(path).replaceAll("\\", "/"));
		return text === undefined
			? originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile)
			: ts.createSourceFile(path, text, languageVersion, true);
	};
	host.getDefaultLibLocation = () => typescriptLibraryDirectory;
	host.getDefaultLibFileName = (options) => join(typescriptLibraryDirectory, basename(ts.getDefaultLibFilePath(options)));
	const roots = [fileName, "/assistant-database.d.ts", ...(kind === "edge-function" ? ["/assistant-deno.d.ts"] : [])];
	const program = ts.createProgram(roots, compilerOptions, host);
	return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
		const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
		if (!diagnostic.file || diagnostic.start === undefined) return message;
		const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
		return `${line + 1}:${character + 1} ${message}`;
	});
}
