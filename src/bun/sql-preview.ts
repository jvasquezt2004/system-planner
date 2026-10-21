import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type {
	DisplayedSqlPreview,
	SqlPreviewCopyResult,
	SqlPreviewExportResult,
} from "../shared/design";
import { errorMessage } from "../shared/error-message";

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
				const safeFileName = requireSqlFileName(fileName);
				const directory = await dependencies.chooseExportDirectory();
				if (directory === null) return { status: "cancelled", revision };
				if (directory.trim().length === 0) {
					throw new Error("No export folder was selected.");
				}
				const path = join(directory, safeFileName);
				await writeNewSqlFile(path, sql);
				return { status: "saved", revision, path };
			} catch (cause) {
				return {
					status: "failed",
					revision,
					error: exportErrorMessage(cause),
				};
			}
		},
	};
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

function requireSqlFileName(fileName: string): string {
	if (
		typeof fileName !== "string" ||
		fileName.length === 0 ||
		fileName !== fileName.trim() ||
		!fileName.toLowerCase().endsWith(".sql") ||
		/[\u0000-\u001f<>:"/\\|?*]/u.test(fileName) ||
		fileName.endsWith(".")
	) {
		throw new Error("Choose a valid SQL file name ending in .sql.");
	}
	return fileName;
}

async function writeNewSqlFile(path: string, sql: string): Promise<void> {
	let file: FileHandle | null = null;
	let created = false;
	try {
		file = await open(path, "wx");
		created = true;
		await file.writeFile(sql, "utf8");
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

