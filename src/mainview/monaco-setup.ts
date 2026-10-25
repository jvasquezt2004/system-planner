import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import EditorWorker from "../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker";
import TsWorker from "../../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";

const monacoEnvironment = globalThis as typeof globalThis & {
	MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
};
monacoEnvironment.MonacoEnvironment = {
	getWorker: (_moduleId, label) =>
		label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
};

loader.config({ monaco });

/** TypeScript's `ModuleResolutionKind.Bundler`; Monaco's exported enum only lists Classic and NodeJs. */
const BUNDLER_MODULE_RESOLUTION = 100 as monaco.typescript.ModuleResolutionKind;
/** TypeScript's `ModuleDetectionKind.Force` (3); forces top-level await to be treated as a module. */
const FORCE_MODULE_DETECTION = 3;


/**
 * Configures the TypeScript language service shared by the Scenario and Edge
 * function editors. Monaco 0.57 exposes it as the top-level `typescript`
 * namespace; `languages.typescript` is only a deprecated, empty stub at runtime.
 */
export function configureTypeScript(paths: Record<string, string[]>, libraries: Array<[content: string, uri: string]>) {
	const { typescriptDefaults, ScriptTarget, ModuleKind } = monaco.typescript;
	typescriptDefaults.setCompilerOptions({
		target: ScriptTarget.ESNext,
		module: ModuleKind.ESNext,
		moduleResolution: BUNDLER_MODULE_RESOLUTION,
		moduleDetection: FORCE_MODULE_DETECTION,
		baseUrl: "/",
		paths,
		strict: true,
		noEmit: true,
	});
	for (const [content, uri] of libraries) typescriptDefaults.addExtraLib(content, uri);
}
