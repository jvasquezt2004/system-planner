import { Fragment, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { SandboxState, SqlState } from "../shared/design";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { workspaceClient } from "./workspace-client";

/**
 * The SQL preview view, set like a galley proof: the generated PostgreSQL with
 * numbered lines, then the sandbox's verdict on it. It replaces the canvas in
 * the main window, is read-only, and follows the open design live.
 */
export function SqlPreviewView({ sql, sandbox }: { sql: SqlState; sandbox: SandboxState }) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState<string | null>(null);
	const copiedTimer = useRef<number | undefined>(undefined);
	const sqlText = sql.status === "empty" ? "" : sql.sql;

	useEffect(
		() => () => {
			window.clearTimeout(copiedTimer.current);
		},
		[],
	);

	async function copySql() {
		setCopyError(null);
		try {
			try {
				if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
				await navigator.clipboard.writeText(sqlText);
			} catch {
				await workspaceClient.copyText(sqlText);
			}
			setCopied(true);
			window.clearTimeout(copiedTimer.current);
			copiedTimer.current = window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
			setCopyError("Could not copy SQL to the clipboard.");
		}
	}

	return (
		<div data-testid="sql-preview-view" className="h-full overflow-y-auto bg-paper">
			<div className="mx-auto max-w-4xl px-8">
				<header className="flex items-end justify-between gap-6 pt-8">
					<div className="min-w-0">
						<p className="kicker">SQL preview</p>
						<p className="mt-1.5 max-w-xl font-display text-[19px] leading-snug text-ink-2 italic">
							The read-only PostgreSQL generated from this design, and what the
							sandbox made of it.
						</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						data-testid="copy-sql"
						disabled={sql.status === "empty"}
						onClick={copySql}
						className="shrink-0"
					>
						{copied ? <Check /> : <Copy />}
						{copied ? "Copied" : "Copy SQL"}
					</Button>
				</header>
				{copyError && (
					<p
						role="alert"
						className="mt-4 border-l-2 border-proof-red bg-proof-red-wash px-3 py-2 text-[12.5px] text-proof-red"
					>
						{copyError}
					</p>
				)}
				<SqlPreview sql={sql} />
				<SandboxReport sandbox={sandbox} />
			</div>
		</div>
	);
}

function SqlPreview({ sql }: { sql: SqlState }) {
	return (
		<section aria-labelledby="sql-heading" className="pt-8">
			<SectionHead id="sql-heading" title="Generated PostgreSQL">
				<Verdict
					tone={sql.status === "current" ? "ok" : sql.status === "stale" ? "warn" : "muted"}
				>
					{sql.status === "current"
						? "Current"
						: sql.status === "stale"
							? "Out of date"
							: "Not available"}
				</Verdict>
			</SectionHead>

			{sql.status !== "current" && sql.errors.length > 0 && (
				<div className="mt-3 border-l-2 border-ochre bg-ochre-wash px-3 py-2.5">
					<p className="text-[12.5px] text-ink-2">
						{sql.status === "stale"
							? `Showing the last SQL generated, from revision ${sql.revision}. The current draft is blocked by:`
							: "No SQL can be generated yet. The draft is blocked by:"}
					</p>
					<ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[12px] text-ochre">
						{sql.errors.map((message) => (
							<li key={message}>{message}</li>
						))}
					</ul>
				</div>
			)}

			{sql.status === "empty" ? (
				sql.errors.length === 0 && (
					<p className="mt-4 font-display text-[17px] text-ink-3 italic">
						No SQL has been generated yet. Complete the design to produce PostgreSQL.
					</p>
				)
			) : (
				<Galley
					sql={sql.sql}
					testId="sql-preview"
					className={cn("mt-3", sql.status === "stale" && "opacity-70")}
				/>
			)}
		</section>
	);
}

function SandboxReport({ sandbox }: { sandbox: SandboxState }) {
	return (
		<section aria-labelledby="sandbox-heading" className="pt-10 pb-16">
			<SectionHead id="sandbox-heading" title="Sandbox check">
				<Verdict
					tone={
						sandbox.status === "applied"
							? "ok"
							: sandbox.status === "failed"
								? "bad"
								: sandbox.status === "applying"
									? "warn"
									: "muted"
					}
				>
					{sandbox.status === "applied"
						? "Accepted"
						: sandbox.status === "failed"
							? "Rejected"
							: sandbox.status === "applying"
								? "Applying…"
								: "Not run"}
				</Verdict>
			</SectionHead>

			{sandbox.status === "applied" && (
				<>
					<p className="mt-3 text-[12.5px] text-ink-2">
						PGlite applied schema revision{" "}
						<span className="figures font-mono text-[11.5px]">{sandbox.revision}</span>. The
						tables and keys below are what PostgreSQL actually created.
					</p>

					<div className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
						{sandbox.tables.map((table) => (
							<article key={table.name} className="min-w-0">
								<h3 className="border-t-2 border-ink pt-1.5 font-display text-[16px] font-semibold text-ink">
									{table.name}
								</h3>
								<dl className="mt-1 border-t border-rule-strong">
									{table.columns.map((column) => (
										<div
											key={column.name}
											className="flex items-baseline gap-2 border-b border-rule-soft py-1.5 text-[11.5px]"
										>
											<dt className="min-w-0 flex-1 truncate font-mono text-ink">
												{column.name}
											</dt>
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
							</article>
						))}
					</div>

					{sandbox.relationships.length > 0 && (
						<div className="mt-7">
							<h3 className="kicker">Foreign keys</h3>
							<ul data-testid="sandbox-relationships" className="mt-2 border-t border-rule-strong">
								{sandbox.relationships.map((relationship) => (
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
			)}

			{sandbox.status === "applying" && (
				<p className="mt-3 font-display text-[16px] text-ink-3 italic">
					Rebuilding the disposable preview…
				</p>
			)}

			{sandbox.status === "failed" && (
				<>
					<p
						role="alert"
						className="mt-3 border-l-2 border-proof-red bg-proof-red-wash px-3 py-2.5 font-mono text-[12px] leading-relaxed text-proof-red"
					>
						{sandbox.error}
					</p>
					<details className="group mt-4">
						<summary className="kicker cursor-pointer list-none hover:text-ink">
							<span className="inline-block transition-transform group-open:rotate-90">›</span>{" "}
							Attempted SQL · revision {sandbox.revision}
						</summary>
						<Galley sql={sandbox.attemptedSql} className="mt-2" />
					</details>
				</>
			)}

			{sandbox.status === "idle" && (
				<p className="mt-3 font-display text-[16px] text-ink-3 italic">
					The sandbox has not applied this design yet.
				</p>
			)}
		</section>
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
	tone: "ok" | "warn" | "bad" | "muted";
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
