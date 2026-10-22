import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
	DisplayedSqlPreview,
	SqlPreviewCopyResult,
	SqlPreviewExportResult,
} from "../shared/design";
import { errorMessage } from "../shared/error-message";
import { schemaCodeFormat, type SchemaCodeSnapshot } from "../shared/schema-code";

export type SqlPreviewActionDependencies = {
	writeClipboardText(sql: string): void;
	chooseExportDirectory(): Promise<string | null>;
};

export function createSqlPreviewActions(dependencies: SqlPreviewActionDependencies) {
	return {
		copy(preview: DisplayedSqlPreview | null): SqlPreviewCopyResult {
			const revision = preview?.revision ?? 0;
			try {
				const sql = requireSql(preview);
				dependencies.writeClipboardText(sql);
				return { status: "copied", revision };
			} catch (cause) {
				return {
					status: "failed",
					revision,
					error: errorMessage(cause),
				};
			}
		},
		async export(
			preview: DisplayedSqlPreview | null,
			fileName: string,
		): Promise<SqlPreviewExportResult> {
			const revision = preview?.revision ?? 0;
			try {
				const sql = requireSql(preview);
				const safeFileName = requireFileName(
					fileName,
					[".sql"],
					"Choose a valid SQL file name ending in .sql.",
				);
				return await exportNewFile(revision, safeFileName, sql);
			} catch (cause) {
				return {
					status: "failed",
					revision,
					error: exportErrorMessage(cause),
				};
			}
		},
		/** Copies the ORM code on screen, exactly as the view captured it. */
		copyCode(snapshot: SchemaCodeSnapshot | null): SqlPreviewCopyResult {
			const revision = snapshot?.revision ?? 0;
			try {
				dependencies.writeClipboardText(requireCode(snapshot));
				return { status: "copied", revision };
			} catch (cause) {
				return {
					status: "failed",
					revision,
					error: errorMessage(cause),
				};
			}
		},
		async exportCode(
			snapshot: SchemaCodeSnapshot | null,
			fileName: string,
		): Promise<SqlPreviewExportResult> {
			const revision = snapshot?.revision ?? 0;
			try {
				const code = requireCode(snapshot);
				const format = schemaCodeFormat(snapshot?.target ?? "sql");
				const safeFileName = requireFileName(
					fileName,
					format.fileExtensions,
					`Choose a valid ${format.label} file name ending in ${format.fileExtensions.join(" or ")}.`,
				);
				return await exportNewFile(revision, safeFileName, code);
			} catch (cause) {
				return {
					status: "failed",
					revision,
					error: exportErrorMessage(cause),
				};
			}
		},
	};

	async function exportNewFile(
		revision: number,
		fileName: string,
		contents: string,
	): Promise<SqlPreviewExportResult> {
		const directory = await dependencies.chooseExportDirectory();
		if (directory === null) return { status: "cancelled", revision };
		if (directory.trim().length === 0) {
			throw new Error("No export folder was selected.");
		}
		const path = join(directory, fileName);
		await writeNewFile(path, contents);
		return { status: "saved", revision, path };
	}
}

function exportErrorMessage(cause: unknown): string {
	if (cause instanceof Error && "code" in cause && cause.code === "EEXIST") {
		return "A file with that name already exists. Choose a different name.";
	}
	return errorMessage(cause);
}

function requireSql(preview: DisplayedSqlPreview | null): string {
	if (!preview || typeof preview.sql !== "string" || preview.sql.trim().length === 0) {
		throw new Error("No SQL is available to copy or export.");
	}
	return preview.sql;
}

function requireCode(snapshot: SchemaCodeSnapshot | null): string {
	if (!snapshot || typeof snapshot.code !== "string" || snapshot.code.trim().length === 0) {
		throw new Error("No generated code is available to copy or export.");
	}
	return snapshot.code;
}

function requireFileName(
	fileName: string,
	extensions: readonly string[],
	message: string,
): string {
	if (
		typeof fileName !== "string" ||
		fileName.length === 0 ||
		fileName !== fileName.trim() ||
		!extensions.some((extension) => fileName.toLowerCase().endsWith(extension)) ||
		/[\u0000-\u001f<>:"/\\|?*]/u.test(fileName) ||
		fileName.endsWith(".")
	) {
		throw new Error(message);
	}
	return fileName;
}

async function writeNewFile(path: string, contents: string): Promise<void> {
	let file: FileHandle | null = null;
	let created = false;
	try {
		file = await open(path, "wx");
		created = true;
		await file.writeFile(contents, "utf8");
		await file.sync();
		await file.close();
		file = null;
	} catch (cause) {
		if (file) {
			try {
				await file.close();
			} catch {
				// Preserve the write or close error that made the export fail.
			}
		}
		if (created) {
			try {
				await unlink(path);
			} catch {
				// Preserve the export error; the design remains independent of this file.
			}
		}
		throw cause;
	}
}

