import { FileText, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ProjectTransferResult } from "./shared/project-portability";
import type { ProjectFileSummary } from "./shared/project-files";

export type ProjectFilesApi = {
	listProjectFiles(projectId: string): Promise<ProjectFileSummary[]>;
	attachProjectFiles(): Promise<ProjectTransferResult>;
	removeProjectFile(projectId: string, fileId: string): Promise<boolean>;
};

export function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files the designer attached to the Project. The Assistant reads them as background for a feature. */
export function ProjectFilesPanel({ projectId, api }: { projectId: string; api: ProjectFilesApi }) {
	const [files, setFiles] = useState<ProjectFileSummary[]>([]);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try { setFiles(await api.listProjectFiles(projectId)); }
		catch (cause) { setMessage(String(cause)); }
	}, [api, projectId]);

	useEffect(() => { setMessage(null); void refresh(); }, [refresh]);

	async function attach() {
		setBusy(true);
		setMessage(null);
		try {
			const result = await api.attachProjectFiles();
			if (result.status === "failed") setMessage(result.error);
			else if (result.status === "attached" && result.skipped.length > 0) {
				setMessage(`Not attached: ${result.skipped.map((entry) => `${entry.name} (${entry.reason})`).join("; ")}`);
			}
			await refresh();
		} catch (cause) {
			setMessage(String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function remove(file: ProjectFileSummary) {
		try {
			await api.removeProjectFile(projectId, file.id);
			await refresh();
		} catch (cause) {
			setMessage(String(cause));
		}
	}

	return (
		<div className="mb-2 text-xs" data-testid="project-files">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-ink-3">
					Project files{files.length > 0 ? ` · ${files.length}` : ""}
				</span>
				<button
					type="button"
					aria-label="Attach files"
					title="Attach files the Assistant can read for background, such as a specification or PDF"
					disabled={busy}
					onClick={() => void attach()}
					className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-ink/5 disabled:opacity-40"
				>
					<Paperclip className="size-3.5" />
					{busy ? "Choosing…" : "Attach"}
				</button>
			</div>
			{files.length > 0 && (
				<ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
					{files.map((file) => (
						<li key={file.id} className="flex items-center gap-1.5 rounded bg-ink/5 px-1.5 py-1" title={file.note ?? (file.pages ? `${file.pages} pages` : undefined)}>
							<FileText className="size-3.5 shrink-0 text-ink-3" />
							<span className="min-w-0 flex-1 truncate">{file.name}</span>
							{!file.hasText && <span className="shrink-0 text-[10px] text-ochre" title={file.note}>no text</span>}
							<span className="shrink-0 text-[10px] text-ink-3">{formatFileSize(file.size)}</span>
							<button type="button" aria-label={`Remove ${file.name}`} onClick={() => void remove(file)} className="shrink-0 rounded p-0.5 hover:bg-ink/10">
								<X className="size-3" />
							</button>
						</li>
					))}
				</ul>
			)}
			{message && <p role="status" className="mt-1 text-[11px] text-proof-red">{message}</p>}
		</div>
	);
}
