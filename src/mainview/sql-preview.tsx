import { Fragment, useState } from "react";
import { Copy, FileDown } from "lucide-react";
import { errorMessage } from "../shared/error-message";
import {
	getDisplayedSqlPreview,
	getLastAppliedSandbox,
	getSqlValidationErrors,
	type SandboxSnapshot,
	type SandboxState,
	type SqlPreviewValidationStatus,
	type SqlState,
} from "../shared/design";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { workspaceClient } from "./workspace-client";

type Tone = "ok" | "warn" | "bad" | "muted";
type Feedback = { tone: "success" | "info" | "error"; message: string };

/** One word for the SQL preview's state, shared by the masthead and the view. */
export function sqlStatusLine(
	sql: SqlState,
	validationStatus: SqlPreviewValidationStatus | null,
): { label: string; tone: Tone } {
	if (validationStatus?.status === "rejected") return { label: "Rejected", tone: "bad" };
	switch (sql.status) {
		case "current":
			return { label: "Current", tone: "ok" };
		case "checking":
			return { label: "Checking…", tone: "warn" };
		case "stale":
			return { label: "Out of date", tone: "warn" };
		case "empty":
			return sql.errors.length > 0
				? { label: "Blocked", tone: "bad" }
				: { label: "Not available", tone: "muted" };
	}
}

/**
 * The SQL preview view, set like a galley proof: the generated PostgreSQL with
 * numbered lines, then the sandbox's verdict on it. It replaces the canvas in
 * the main window, is read-only, and follows the open design live. Copy and
 * export always carry the exact revision on screen, and say how far the
 * sandbox has validated it.
 */
export function SqlPreviewView({
	sql,
	sandbox,
	draftRevision,
	validationStatus,
}: {
	sql: SqlState;
	sandbox: SandboxState;
	draftRevision: number;
	validationStatus: SqlPreviewValidationStatus | null;
}) {
	const preview = getDisplayedSqlPreview(sql);
	const [fileName, setFileName] = useState("schema.sql");
	const [action, setAction] = useState<"copy" | "export" | null>(null);
	const [feedback, setFeedback] = useState<Feedback | null>(null);

	async function runSqlAction(kind: "copy" | "export", operation: () => Promise<void>) {
		if (action) return;
		setAction(kind);
		setFeedback(null);
		try {
			await operation();
		} catch (cause) {
			const label = kind === "copy" ? "Copy" : "Export";
			setFeedback({ tone: "error", message: `${label} failed: ${errorMessage(cause)}` });
		} finally {
			setAction(null);
		}
	}

	function transferFeedback(
		kind: "copy" | "export",
		revision: number,
		destination?: string,
	): Feedback {
		const subject =
			kind === "copy"
				? `Copied SQL from revision ${revision}`
				: `Exported SQL from revision ${revision} to ${destination ?? fileName}`;
		const status = validationStatus;
		if (!status) {
			return { tone: "info", message: `${subject}; not yet validated by the sandbox.` };
		}
		if (status.status === "accepted") {
			return status.revision === revision
				? { tone: "success", message: `${subject}; accepted by the sandbox.` }
				: { tone: "info", message: `${subject}; not yet validated by the sandbox.` };
		}
		switch (status.status) {
			case "out-of-date":
				return {
					tone: "info",
					message: `${subject}; out of date because draft revision ${status.draftRevision} is blocked.`,
				};
			case "not-yet-validated": {
				const reason =
					status.reason === "checking"
						? "still being checked"
						: status.reason === "rebuilding"
							? "the sandbox is rebuilding"
							: "sandbox validation has not started";
				return {
					tone: status.tone,
					message: `${subject}; not yet validated for draft revision ${status.draftRevision} (${reason}).`,
				};
			}
			case "sandbox-error":
				return {
					tone: status.tone,
					message: `${subject}; could not be validated by the sandbox: ${status.error}`,
				};
			case "rejected":
				return {
					tone: status.tone,
					message: `${subject}; rejected by PostgreSQL: ${status.error}`,
				};
		}
	}

	async function copyPreview() {
		if (!preview) return;
		await runSqlAction("copy", async () => {
			const result = await workspaceClient.copySqlPreview(preview);
			setFeedback(
				result.status === "copied"
					? transferFeedback("copy", result.revision)
					: { tone: "error", message: `Copy failed: ${result.error}` },
			);
		});
	}

	async function exportPreview() {
		if (!preview) return;
		await runSqlAction("export", async () => {
			const result = await workspaceClient.exportSqlPreview({ preview, fileName });
			setFeedback(
				result.status === "saved"
					? transferFeedback("export", result.revision, fileName)
					: result.status === "cancelled"
						? { tone: "info", message: "Export cancelled." }
						: { tone: "error", message: `Export failed: ${result.error}` },
			);
		});
	}

	return (
		<div data-testid="sql-preview-view" className="h-full overflow-y-auto bg-paper">
			<div className="mx-auto max-w-4xl px-8">
				<header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pt-8">
					<div className="min-w-0">
						<p className="kicker">SQL preview</p>
						<p className="mt-1.5 max-w-md font-display text-[19px] leading-snug text-ink-2 italic">
							The read-only PostgreSQL generated from this design, and what the
							sandbox made of it.
						</p>
					</div>
					<div className="flex flex-col items-end gap-1.5">
						<div className="flex items-end gap-1.5">
							<label className="flex flex-col gap-1">
								<span className="text-[11px] font-medium text-ink-3">File name</span>
								<Input
									aria-label="SQL file name"
									value={fileName}
									onChange={(event) => setFileName(event.target.value)}
									disabled={!preview || action !== null}
									className="h-7 w-40 font-mono text-[12px]"
								/>
							</label>
							<Button
								variant="outline"
								size="sm"
								data-testid="copy-sql"
								onClick={() => void copyPreview()}
								disabled={!preview || action !== null}
							>
								<Copy />
								{action === "copy" ? "Copying…" : "Copy SQL"}
							</Button>
							<Button
								size="sm"
								data-testid="export-sql"
								onClick={() => void exportPreview()}
								disabled={!preview || action !== null}
							>
								<FileDown />
								{action === "export" ? "Exporting…" : "Export SQL"}
							</Button>
						</div>
						<p className="text-[11px] text-ink-4">
							Choose a folder for the export. Existing files are not overwritten.
						</p>
					</div>
				</header>
				{feedback && (
					<p
						role={feedback.tone === "error" ? "alert" : "status"}
						data-testid="sql-action-status"
						className={cn(
							"mt-4 border-l-2 px-3 py-2 text-[12.5px]",
							feedback.tone === "error" && "border-proof-red bg-proof-red-wash text-proof-red",
							feedback.tone === "success" &&
								"border-press-green bg-press-green-wash text-press-green",
							feedback.tone === "info" && "border-rule-strong bg-paper-tint text-ink-2",
						)}
					>
						{feedback.message}
					</p>
				)}
				<SqlPreview sql={sql} validationStatus={validationStatus} />
				<SandboxReport sandbox={sandbox} draftRevision={draftRevision} />
			</div>
		</div>
	);
}

function SqlPreview({
	sql,
	validationStatus,
}: {
	sql: SqlState;
	validationStatus: SqlPreviewValidationStatus | null;
}) {
	const errors = getSqlValidationErrors(sql);
	const preview = getDisplayedSqlPreview(sql);
	const status = sqlStatusLine(sql, validationStatus);
	return (
		<section aria-labelledby="sql-heading" className="pt-8">
			<SectionHead id="sql-heading" title="Generated PostgreSQL">
				<Verdict tone={status.tone}>{status.label}</Verdict>
			</SectionHead>

			<p className="mt-3 text-[12.5px] text-ink-2">
				{sql.status === "current"
					? `Generated from design revision ${sql.revision}.`
					: sql.status === "checking"
						? sql.availableRevision === null
							? `Checking draft revision ${sql.draftRevision}; no SQL is available yet.`
							: `Checking draft revision ${sql.draftRevision}; showing SQL from revision ${sql.availableRevision}.`
						: sql.status === "stale"
							? `Showing SQL from revision ${sql.revision}; current draft revision ${sql.draftRevision} is blocked.`
							: errors.length > 0
								? `No SQL is available for draft revision ${sql.draftRevision}.`
								: "No SQL has been generated yet. Complete the design to produce PostgreSQL."}
			</p>

			{errors.length > 0 && (
				<div className="mt-3 border-l-2 border-ochre bg-ochre-wash px-3 py-2.5">
					<p className="kicker text-ochre!">Blocked by validation</p>
					<ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[12px] text-ink-2">
						{errors.map((message) => (
							<li key={message}>{message}</li>
						))}
					</ul>
				</div>
			)}

			{preview === null ? (
				<p className="mt-4 font-display text-[17px] text-ink-3 italic">
					SQL will appear here when the design can generate it.
				</p>
			) : (
				<Galley
					sql={preview.sql}
					testId="sql-preview"
					className={cn("mt-3", sql.status !== "current" && "opacity-70")}
				/>
			)}
		</section>
	);
}

/**
 * The sandbox's verdict for the current draft, and — whenever that draft is
 * not yet accepted — the last successful build, clearly labelled as older.
 */
function SandboxReport({
	sandbox,
	draftRevision,
}: {
	sandbox: SandboxState;
	draftRevision: number;
}) {
	const lastApplied = getLastAppliedSandbox(sandbox);
	const acceptedNow = sandbox.status === "applied" && sandbox.revision === draftRevision;
	const verdict: { label: string; tone: Tone } =
		sandbox.status === "applied"
			? acceptedNow
				? { label: "Accepted", tone: "ok" }
				: { label: "Out of date", tone: "warn" }
			: sandbox.status === "failed"
				? {
						label: sandbox.failure === "sql-rejected" ? "Rejected" : "Sandbox error",
						tone: "bad",
					}
				: sandbox.status === "applying"
					? { label: "Rebuilding…", tone: "warn" }
					: { label: "Not run", tone: "muted" };

	return (
		<section aria-labelledby="sandbox-heading" className="pt-10 pb-16">
			<SectionHead id="sandbox-heading" title="Sandbox check">
				<Verdict tone={verdict.tone}>{verdict.label}</Verdict>
			</SectionHead>

			{sandbox.status === "applying" && (
				<p className="mt-3 font-display text-[16px] text-ink-3 italic">
					Rebuilding the disposable sandbox for draft revision {sandbox.revision}…
				</p>
			)}

			{sandbox.status === "failed" && (
				<>
					<p className="mt-3 text-[12.5px] text-ink-2">
						{sandbox.failure === "sql-rejected"
							? `PostgreSQL rejected the generated SQL for draft revision ${sandbox.revision}.`
							: `The sandbox could not complete validation for draft revision ${sandbox.revision}.`}
					</p>
					<p
						role="alert"
						className="mt-2 border-l-2 border-proof-red bg-proof-red-wash px-3 py-2.5 font-mono text-[12px] leading-relaxed text-proof-red"
					>
						{sandbox.error}
					</p>
					{sandbox.failure === "sql-rejected" && (
						<details className="group mt-4">
							<summary className="kicker cursor-pointer list-none hover:text-ink">
								<span className="inline-block transition-transform group-open:rotate-90">›</span>{" "}
								Attempted SQL · revision {sandbox.revision}
							</summary>
							<Galley sql={sandbox.attemptedSql} className="mt-2" />
						</details>
					)}
				</>
			)}

			{sandbox.status === "idle" && (
				<p className="mt-3 font-display text-[16px] text-ink-3 italic">
					No successful sandbox preview exists for this project yet.
				</p>
			)}

			{lastApplied && (
				<div className="mt-5">
					<p className="text-[12.5px] text-ink-2">
						{acceptedNow ? (
							<>
								PGlite accepted design revision{" "}
								<span className="figures font-mono text-[11.5px]">{lastApplied.revision}</span>.
								The tables and keys below are what PostgreSQL actually created.
							</>
						) : (
							<>
								Last successful sandbox: revision{" "}
								<span className="figures font-mono text-[11.5px]">{lastApplied.revision}</span>;
								current draft: revision{" "}
								<span className="figures font-mono text-[11.5px]">{draftRevision}</span>.
							</>
						)}
					</p>
					{sandbox.status === "applied" ? (
						<SandboxContents snapshot={lastApplied} />
					) : (
						<details className="group mt-3">
							<summary className="kicker cursor-pointer list-none hover:text-ink">
								<span className="inline-block transition-transform group-open:rotate-90">›</span>{" "}
								Inspect last successful sandbox
							</summary>
							<div className="opacity-80">
								<SandboxContents snapshot={lastApplied} />
							</div>
						</details>
					)}
				</div>
			)}

			{(sandbox.status === "applying" || sandbox.status === "failed") &&
				lastApplied === null && (
					<p className="mt-3 text-[12.5px] text-ink-3">
						No previous successful sandbox is available.
					</p>
				)}
		</section>
	);
}

/** What PostgreSQL created, set like an almanac's tables. */
function SandboxContents({ snapshot }: { snapshot: SandboxSnapshot }) {
	return (
		<>
			<div className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
				{snapshot.tables.map((table) => (
					<article key={table.name} className="min-w-0">
						<h3 className="border-t-2 border-ink pt-1.5 font-display text-[16px] font-semibold text-ink">
							{table.name}
						</h3>
						<dl className="mt-1 border-t border-rule-strong">
							{table.columns.map((column) => (
								<div
									key={column.name}
									className="flex flex-wrap items-baseline gap-x-2 border-b border-rule-soft py-1.5 text-[11.5px]"
								>
									<dt className="min-w-0 flex-1 truncate font-mono text-ink">{column.name}</dt>
									<dd className="shrink-0 font-mono text-ink-3">{column.dataType}</dd>
									<dd className="flex shrink-0 gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.04em] text-ink-3">
										{column.primaryKey && <span className="font-semibold text-ink">pk</span>}
										{column.isIdentity && <span>identity</span>}
										{column.unique && !column.primaryKey && <span>unique</span>}
										<span className={column.nullable ? undefined : "text-ink-4"}>
											{column.nullable ? "null" : "not null"}
										</span>
									</dd>
									{column.defaultExpression && (
										<dd
											className="w-full basis-full truncate pl-3 font-mono text-[10.5px] text-ink-4"
											title={`Default: ${column.defaultExpression}`}
										>
											default {column.defaultExpression}
										</dd>
									)}
								</div>
							))}
						</dl>
						{(table.indexes?.length ?? 0) > 0 && <div className="mt-2" data-testid="sandbox-indexes">
							<p className="kicker">Indexes</p>
							<ul className="mt-1 border-t border-rule-soft">{table.indexes?.map((index) => <li key={index.name} className="truncate border-b border-rule-soft py-1 font-mono text-[10.5px] text-ink-3" title={index.definition}>{index.unique ? "unique " : ""}{index.method} · {index.definition}</li>)}</ul>
						</div>}
					</article>
				))}
			</div>

			{snapshot.relationships.length > 0 && (
				<div className="mt-7">
					<h3 className="kicker">Foreign keys</h3>
					<ul data-testid="sandbox-relationships" className="mt-2 border-t border-rule-strong">
						{snapshot.relationships.map((relationship) => (
							<li
								key={relationship.name}
								className="flex items-baseline gap-3 border-b border-rule-soft py-1.5 font-mono text-[11.5px]"
							>
								<span className="min-w-0 flex-1 truncate text-ink">
									{relationship.referencingTable}.{relationship.referencingColumn}
									<span className="text-ink-4"> → </span>
									{relationship.referencedTable}.{relationship.referencedColumn}
								</span>
								<span className="shrink-0 text-[10px] uppercase tracking-[0.04em] text-ink-3">
									on update {relationship.updateRule.toLowerCase()} · on delete{" "}
									{relationship.deleteRule.toLowerCase()}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}

function SectionHead({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<header className="flex items-center justify-between gap-4 border-b border-ink pb-1.5">
			<h2 id={id} className="kicker text-ink!">
				{title}
			</h2>
			{children}
		</header>
	);
}

/**
 * The press-check verdict, set as a small stamp with a double rule. Its ink is
 * the only colour on the page and always means a status.
 */
function Verdict({
	tone,
	children,
}: {
	tone: Tone;
	children: React.ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 -rotate-[1.5deg] items-center border-[3px] border-double px-2 text-[10px] font-semibold tracking-[0.18em] uppercase",
				tone === "ok" && "border-press-green text-press-green",
				tone === "warn" && "border-ochre text-ochre",
				tone === "bad" && "border-proof-red text-proof-red",
				tone === "muted" && "border-ink-4 text-ink-3",
			)}
		>
			{children}
		</span>
	);
}

const SQL_KEYWORDS = new Set([
	"ADD",
	"ALTER",
	"ALWAYS",
	"AS",
	"BY",
	"CONSTRAINT",
	"CREATE",
	"DEFAULT",
	"DELETE",
	"FOREIGN",
	"GENERATED",
	"IDENTITY",
	"KEY",
	"NO",
	"NOT",
	"NULL",
	"ON",
	"PRIMARY",
	"REFERENCES",
	"TABLE",
	"UNIQUE",
	"UPDATE",
	"ACTION",
]);

/**
 * Generated SQL with numbered lines in the margin. Keywords recede and quoted
 * identifiers stand forward, so the schema's own names are what the eye reads.
 */
function Galley({
	sql,
	testId,
	className,
}: {
	sql: string;
	testId?: string;
	className?: string;
}) {
	const lines = sql.replace(/\n$/, "").split("\n");
	return (
		<pre
			data-testid={testId}
			className={cn(
				"overflow-x-auto rounded-[3px] border border-rule bg-paper-raised py-3 font-mono text-[12px] leading-[1.7]",
				className,
			)}
		>
			<code className="grid grid-cols-[auto_1fr]">
				{lines.map((line, index) => (
					// Lines are positional, so the index is their identity.
					<Fragment key={index}>
						<span
							aria-hidden="true"
							className="figures border-r border-rule-soft pr-3 pl-4 text-right text-[10.5px] text-ink-4 select-none"
						>
							{index + 1}
						</span>
						<span className="pr-5 pl-4 whitespace-pre">{highlight(line)}</span>
					</Fragment>
				))}
			</code>
		</pre>
	);
}

function highlight(line: string): React.ReactNode[] {
	const parts: React.ReactNode[] = [];
	const pattern = /("(?:[^"]|"")*")|('(?:[^']|'')*')|(--.*$)|([A-Za-z_]+)/g;
	let last = 0;
	for (const match of line.matchAll(pattern)) {
		const index = match.index ?? 0;
		if (index > last) parts.push(line.slice(last, index));
		const [text, identifier, literal, comment, word] = match;
		const key = `${index}-${text}`;
		if (identifier) {
			parts.push(
				<span key={key} className="font-medium text-ink">
					{text}
				</span>,
			);
		} else if (literal) {
			parts.push(
				<span key={key} className="text-ink-2">
					{text}
				</span>,
			);
		} else if (comment) {
			parts.push(
				<span key={key} className="text-ink-4 italic">
					{text}
				</span>,
			);
		} else if (word && SQL_KEYWORDS.has(word)) {
			parts.push(
				<span key={key} className="text-ink-3">
					{text}
				</span>,
			);
		} else {
			parts.push(
				<span key={key} className="text-ink-2">
					{text}
				</span>,
			);
		}
		last = index + text.length;
	}
	if (last < line.length) parts.push(line.slice(last));
	return parts;
}
