import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { errorMessage } from "../shared/error-message";
import {
	PROJECT_FILE_LIMIT_BYTES,
	PROJECT_FILES_PER_PROJECT,
	fileExtension,
	isTextFileName,
	mimeForFileName,
	safeFileName,
	uniqueFileName,
	type ProjectFileSummary,
	type ProjectFilesAddResult,
} from "../shared/project-files";

/** Text kept per file; the rest of a very long document is not searchable by the Assistant. */
const STORED_TEXT_LIMIT = 2_000_000;

export type ExtractedText = { text: string | null; pages?: number; note?: string };

/** The text the Assistant reads for a file, or why there is none. Nothing here executes the file. */
export async function extractFileText(name: string, bytes: Uint8Array): Promise<ExtractedText> {
	const extension = fileExtension(name);
	if (extension === "pdf") {
		try {
			const pdf = await getDocumentProxy(new Uint8Array(bytes));
			try {
				const { text, totalPages } = await extractText(pdf, { mergePages: true });
				const trimmed = text.trim();
				return trimmed
					? { text: trimmed.slice(0, STORED_TEXT_LIMIT), pages: totalPages }
					: { text: null, pages: totalPages, note: "No text found: this PDF looks scanned or is made of images." };
			} finally { await pdf.loadingTask.destroy(); }
		} catch (error) {
			const message = errorMessage(error);
			return { text: null, note: /password/i.test(message) ? "This PDF is password protected." : `The PDF could not be read: ${message}` };
		}
	}
	if (isTextFileName(name)) {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/\u0000/g, "");
		return text.trim() ? { text: text.slice(0, STORED_TEXT_LIMIT) } : { text: null, note: "The file is empty." };
	}
	if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return { text: null, note: "An image: it has no text to read." };
	return { text: null, note: "Text can be read from PDF and plain text files only." };
}

const SCHEMA = `
	PRAGMA foreign_keys = ON;
	CREATE TABLE IF NOT EXISTS project_files (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		mime TEXT NOT NULL,
		size INTEGER NOT NULL,
		added_at INTEGER NOT NULL,
		pages INTEGER,
		note TEXT,
		text TEXT,
		content BLOB NOT NULL
	);
	CREATE INDEX IF NOT EXISTS project_files_project ON project_files(project_id, added_at);
`;

type Row = { id: string; name: string; mime: string; size: number; added_at: number; pages: number | null; note: string | null; has_text: number };

const summarize = (row: Row): ProjectFileSummary => ({
	id: row.id, name: row.name, mime: row.mime, size: row.size, addedAt: row.added_at, hasText: row.has_text === 1,
	...(row.pages !== null ? { pages: row.pages } : {}), ...(row.note ? { note: row.note } : {}),
});

export interface ProjectFileStore {
	list(projectId: string): ProjectFileSummary[];
	add(projectId: string, file: { name: string; bytes: Uint8Array }): Promise<ProjectFileSummary>;
	/** Adds files by path, refusing any that are too large, unreadable, or over the Project's limit. */
	addFromPaths(projectId: string, paths: string[]): Promise<ProjectFilesAddResult>;
	remove(projectId: string, fileId: string): boolean;
	/** The original bytes, for copying into the Project folder. */
	content(fileId: string): Uint8Array | null;
	/** The extracted text, or null. */
	text(projectId: string, name: string): { file: ProjectFileSummary; text: string } | null;
	close(): void;
}

export function openProjectFileStore(databasePath: string, now: () => number = Date.now): ProjectFileStore {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true });
	database.exec(SCHEMA);
	const columns = "id, name, mime, size, added_at, pages, note, text IS NOT NULL AS has_text";
	const list = database.query<Row, [string]>(`SELECT ${columns} FROM project_files WHERE project_id = ? ORDER BY added_at, rowid`);
	const insert = database.query(`INSERT INTO project_files (id, project_id, name, mime, size, added_at, pages, note, text, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	const remove = database.query(`DELETE FROM project_files WHERE project_id = ? AND id = ?`);
	const content = database.query<{ content: Uint8Array }, [string]>(`SELECT content FROM project_files WHERE id = ?`);
	const byName = database.query<Row & { text: string | null }, [string, string]>(`SELECT ${columns}, text FROM project_files WHERE project_id = ? AND lower(name) = lower(?)`);

	const store: ProjectFileStore = {
		list: (projectId) => list.all(projectId).map(summarize),
		async add(projectId, file) {
			const existing = list.all(projectId);
			if (existing.length >= PROJECT_FILES_PER_PROJECT) throw new Error(`A Project holds at most ${PROJECT_FILES_PER_PROJECT} files. Remove one first.`);
			if (file.bytes.byteLength > PROJECT_FILE_LIMIT_BYTES) throw new Error(`${safeFileName(file.name)} is larger than ${PROJECT_FILE_LIMIT_BYTES / 1024 / 1024} MB.`);
			if (file.bytes.byteLength === 0) throw new Error(`${safeFileName(file.name)} is empty.`);
			const name = uniqueFileName(safeFileName(file.name), existing.map((entry) => entry.name));
			const extracted = await extractFileText(name, file.bytes);
			const id = crypto.randomUUID();
			const addedAt = now();
			insert.run(id, projectId, name, mimeForFileName(name), file.bytes.byteLength, addedAt, extracted.pages ?? null, extracted.note ?? null, extracted.text, file.bytes);
			return summarize({ id, name, mime: mimeForFileName(name), size: file.bytes.byteLength, added_at: addedAt, pages: extracted.pages ?? null, note: extracted.note ?? null, has_text: extracted.text === null ? 0 : 1 });
		},
		async addFromPaths(projectId, paths) {
			const result: ProjectFilesAddResult = { added: [], skipped: [] };
			for (const path of paths) {
				const name = basename(path);
				try {
					const info = await stat(path);
					if (!info.isFile()) throw new Error("Choose files, not folders.");
					if (info.size > PROJECT_FILE_LIMIT_BYTES) throw new Error(`Larger than ${PROJECT_FILE_LIMIT_BYTES / 1024 / 1024} MB.`);
					result.added.push(await store.add(projectId, { name, bytes: new Uint8Array(await readFile(path)) }));
				} catch (error) {
					result.skipped.push({ name, reason: errorMessage(error) });
				}
			}
			return result;
		},
		remove: (projectId, fileId) => remove.run(projectId, fileId).changes > 0,
		content: (fileId) => { const row = content.get(fileId); return row ? new Uint8Array(row.content) : null; },
		text(projectId, name) {
			const row = byName.get(projectId, name);
			return row && row.text !== null ? { file: summarize(row), text: row.text } : null;
		},
		close: () => database.close(),
	};
	return store;
}
