import { scenarioDatabaseTypeUri } from "../shared/scenario-types";

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


const extraLibraryDisposables: monaco.IDisposable[] = [];

/**
 * Configures the shared TypeScript service for one executable artifact's
 * Design. Monaco's global declarations are replaced, not accumulated, so two
 * Designs never merge incompatible `Database` interfaces.
 */
export function configureTypeScript(
	designId: string,
	paths: Record<string, string[]>,
	libraries: Array<[content: string, uri: string]>,
) {
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
	if (!libraries.some(([, uri]) => uri === scenarioDatabaseTypeUri(designId))) {
		throw new Error("TypeScript declarations do not match the target database Design.");
	}
	for (const disposable of extraLibraryDisposables.splice(0)) disposable.dispose();
	for (const [content, uri] of libraries) {
		extraLibraryDisposables.push(typescriptDefaults.addExtraLib(content, uri));
	}
}
