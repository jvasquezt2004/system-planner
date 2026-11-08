/** A document the designer attached to a Project to give the Assistant background. The Design never depends on it. */
export type ProjectFileSummary = {
	id: string;
	name: string;
	size: number;
	mime: string;
	addedAt: number;
	/** Whether the Assistant can read the file as text. */
	hasText: boolean;
	pages?: number;
	/** Why there is no text, such as an image or a password-protected PDF. */
	note?: string;
};

export const PROJECT_FILE_LIMIT_BYTES = 20 * 1024 * 1024;
export const PROJECT_FILES_PER_PROJECT = 50;
/** What the Assistant is shown of one file in a single read; longer files are read in parts. */
export const PROJECT_FILE_READ_CHARS = 30_000;

export type ProjectFilesAddResult = { added: ProjectFileSummary[]; skipped: Array<{ name: string; reason: string }> };

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "sql", "log", "ts", "tsx", "js", "jsx", "py", "toml", "ini", "env", "rst", "tex"]);

export const fileExtension = (name: string): string => name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
export const isTextFileName = (name: string): boolean => TEXT_EXTENSIONS.has(fileExtension(name));

/** A name that is safe to use as a file in the Project folder: no path parts, no control characters. */
export function safeFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 150);
	return cleaned || "file";
}

/** "spec.pdf" when free, otherwise "spec (2).pdf", "spec (3).pdf"… */
export function uniqueFileName(name: string, taken: Iterable<string>): string {
	const used = new Set([...taken].map((entry) => entry.toLowerCase()));
	if (!used.has(name.toLowerCase())) return name;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	for (let n = 2; ; n++) {
		const candidate = `${stem} (${n})${extension}`;
		if (!used.has(candidate.toLowerCase())) return candidate;
	}
}

const MIME_BY_EXTENSION: Record<string, string> = {
	pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
	md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", xml: "application/xml",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const mimeForFileName = (name: string): string => MIME_BY_EXTENSION[fileExtension(name)] ?? (isTextFileName(name) ? "text/plain" : "application/octet-stream");
