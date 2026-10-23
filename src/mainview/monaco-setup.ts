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
