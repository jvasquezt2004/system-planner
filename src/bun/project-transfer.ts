import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "../shared/error-message";
import {
	PROJECT_EXPORT_FILE_SUFFIX,
	ProjectImportError,
	type ProjectTransferResult,
} from "../shared/project-portability";
import type { DesignWorkspace } from "./workspace";
import { writeNewFile } from "./sql-preview";

/** Larger files are refused before they are read: a project export is a text document, not an asset. */
export const PROJECT_IMPORT_FILE_LIMIT_BYTES = 64 * 1024 * 1024;

export type ProjectTransferDependencies = {
	workspace: Promise<DesignWorkspace> | DesignWorkspace;
	/** The native folder picker. Null means the designer cancelled. */
	chooseExportDirectory(): Promise<string | null>;
	/** The native file picker. Null means the designer cancelled. */
	chooseImportFile(): Promise<string | null>;
	now(): Date;
};

export type ProjectTransferActions = {
	/** Writes the open Project to a new file in a folder the designer picks. */
	exportProject(): Promise<ProjectTransferResult>;
	/** Creates a new Project from a file the designer picks. The open Project is unchanged unless the import succeeds. */
	importProject(): Promise<ProjectTransferResult>;
};

export function createProjectTransferActions(dependencies: ProjectTransferDependencies): ProjectTransferActions {
	return {
		async exportProject(): Promise<ProjectTransferResult> {
			try {
				const workspace = await dependencies.workspace;
				// Build the document before the picker opens, so a failure never follows a folder choice.
				const document = await workspace.exportProject();
				const directory = await dependencies.chooseExportDirectory();
				if (directory === null) return { status: "cancelled" };
				if (directory.trim().length === 0) throw new Error("No export folder was selected.");
				const fileName = exportFileName(document.project.name, dependencies.now());
				const path = join(directory, fileName);
				await writeNewFile(path, `${JSON.stringify(document, null, 2)}\n`);
				return { status: "exported", path, name: document.project.name };
			} catch (cause) {
				return { status: "failed", error: errorMessage(cause) };
			}
		},
		async importProject(): Promise<ProjectTransferResult> {
			try {
				const path = await dependencies.chooseImportFile();
				if (path === null) return { status: "cancelled" };
				const document = await readProjectFile(path);
				const workspace = await dependencies.workspace;
				const state = await workspace.importProject(document);
				if (!state.project) throw new Error("The imported project could not be opened.");
				return { status: "imported", projectId: state.project.id, name: state.project.name };
			} catch (cause) {
				return { status: "failed", error: errorMessage(cause) };
			}
		},
	};
}

/** "shop-2026-10-26T21-00-00-000Z.schema-designer.json": a new name each export, so a repeat never collides. */
export function exportFileName(projectName: string, now: Date): string {
	const slug = projectName
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
		.slice(0, 60);
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	return `${slug || "project"}-${stamp}${PROJECT_EXPORT_FILE_SUFFIX}`;
}

/** Reads and parses a project file. Structure is checked by the workspace import, which writes nothing on failure. */
async function readProjectFile(path: string): Promise<unknown> {
	const info = await stat(path);
	if (!info.isFile()) throw new ProjectImportError("Choose a project file, not a folder.");
	if (info.size > PROJECT_IMPORT_FILE_LIMIT_BYTES) {
		throw new ProjectImportError("This project file is larger than 64 MB, so it is not a Schema Designer project export.");
	}
	const text = await readFile(path, "utf8");
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new ProjectImportError("The file is not valid JSON. Choose a Schema Designer project export (.schema-designer.json).");
	}
}
