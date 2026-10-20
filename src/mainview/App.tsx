import { useCallback, useEffect, useState } from "react";
import type {
	ProjectSummary,
	SandboxState,
	SaveState,
	SqlState,
	WorkspaceState,
} from "../shared/design";
import { workspaceClient } from "./workspace-client";

function App() {
	const [state, setState] = useState<WorkspaceState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const unsubscribe = workspaceClient.subscribe((next) => {
			if (active) setState(next);
		});
		workspaceClient
			.load()
			.then((next) => {
				if (active) setState(next);
			})
			.catch((cause: unknown) => {
				if (active) setError(errorMessage(cause));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, []);

	const run = useCallback(async (action: () => Promise<WorkspaceState>) => {
		setBusy(true);
		setError(null);
		try {
			setState(await action());
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}, []);

	if (!state) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-200">
				<p className="animate-pulse text-sm tracking-wide text-slate-400">
					Opening design workspace…
				</p>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-slate-950 text-slate-100">
			<div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
				<header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 pb-5">
					<div>
						<p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-400">
							Schema Designer
						</p>
						<h1 className="mt-1 text-2xl font-semibold">
							{state.project?.name ?? "No project open"}
						</h1>
					</div>
					<SaveBadge save={state.save} />
				</header>

				{error && (
					<div
						role="alert"
						className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
					>
						{error}
					</div>
				)}

				<ProjectsPanel
					projects={state.projects}
					activeProjectId={state.project?.id ?? null}
					busy={busy}
					onOpen={(projectId) => run(() => workspaceClient.openProject(projectId))}
					onCreate={(name) => run(() => workspaceClient.createProject(name))}
				/>

				{!state.project ? (
					<section className="max-w-lg rounded-xl border border-slate-800 bg-slate-900/60 p-6">
						<h2 className="text-lg font-semibold">Start a design</h2>
						<p className="mt-1 text-sm text-slate-400">
							Create a project to open its design. Every project owns exactly one design,
							saved automatically in local SQLite.
						</p>
					</section>
				) : (
					<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
						<section className="flex flex-col gap-5">
							<AddTableForm
								busy={busy}
								onAdd={(name) => run(() => workspaceClient.addTable(name))}
							/>
							<TablesPanel state={state} />
						</section>
						<section className="flex flex-col gap-5">
							<SqlPanel sql={state.sql} />
							<SandboxPanel sandbox={state.sandbox} />
						</section>
					</div>
				)}
			</div>
		</main>
	);
}

function ProjectsPanel({
	projects,
	activeProjectId,
	busy,
	onOpen,
	onCreate,
}: {
	projects: ProjectSummary[];
	activeProjectId: string | null;
	busy: boolean;
	onOpen: (projectId: string) => void;
	onCreate: (name: string) => void;
}) {
	const [name, setName] = useState("");
	return (
		<section
			aria-labelledby="projects-heading"
			className="rounded-xl border border-slate-800 bg-slate-900/60"
		>
			<header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
				<h2
					id="projects-heading"
					className="text-sm font-semibold uppercase tracking-wide text-slate-300"
				>
					Projects
				</h2>
				<span className="text-xs text-slate-500" data-testid="project-count">
					{projects.length === 0
						? "none saved"
						: `${projects.length} saved`}
				</span>
			</header>
			<div className="flex flex-col gap-4 px-5 py-4 lg:flex-row lg:items-start lg:justify-between">
				<ul className="flex flex-wrap gap-2" data-testid="project-list">
					{projects.length === 0 ? (
						<li className="text-sm text-slate-500">No saved projects yet.</li>
					) : (
						projects.map((project) => {
							const active = project.id === activeProjectId;
							return (
								<li key={project.id}>
									<button
										type="button"
										onClick={() => onOpen(project.id)}
										disabled={busy || active}
										aria-current={active ? "true" : undefined}
										data-testid="project-option"
										className={
											active
												? "rounded-md border border-indigo-500/60 bg-indigo-500/15 px-3 py-1.5 text-sm text-indigo-200"
												: "rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-40"
										}
									>
										{project.name}
										{active && (
											<span className="ml-2 text-[10px] uppercase tracking-wide text-indigo-300">
												open
											</span>
										)}
									</button>
								</li>
							);
						})
					)}
				</ul>
				<form
					className="flex w-full gap-2 lg:w-auto"
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim().length === 0) return;
						onCreate(name);
						setName("");
					}}
				>
					<input
						value={name}
						onChange={(event) => setName(event.target.value)}
						aria-label="New project name"
						placeholder="New project name"
						className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-500 lg:w-48"
					/>
					<button
						type="submit"
						disabled={busy || name.trim().length === 0}
						className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
					>
						New project
					</button>
				</form>
			</div>
		</section>
	);
}

function AddTableForm({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => void }) {
	const [name, setName] = useState("");
	return (
		<form
			className="rounded-xl border border-slate-800 bg-slate-900/60 p-5"
			onSubmit={(event) => {
				event.preventDefault();
				if (name.trim().length === 0) return;
				onAdd(name);
				setName("");
			}}
		>
			<h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
				Add a table
			</h2>
			<div className="mt-3 flex gap-2">
				<input
					value={name}
					onChange={(event) => setName(event.target.value)}
					aria-label="Table name"
					placeholder="Books"
					className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none focus:border-indigo-500"
				/>
				<button
					type="submit"
					disabled={busy || name.trim().length === 0}
					className="rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
				>
					Add table
				</button>
			</div>
			<p className="mt-3 text-xs text-slate-500">
				A new table starts with an editable <code className="text-slate-300">id bigint</code>{" "}
				identity primary key.
			</p>
		</form>
	);
}

function TablesPanel({ state }: { state: WorkspaceState }) {
	const tables = state.design?.tables ?? [];
	return (
		<section className="rounded-xl border border-slate-800 bg-slate-900/60">
			<header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
				<h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
					Tables
				</h2>
				<span className="text-xs text-slate-500">
					{state.revision > 0 ? `revision ${state.revision}` : "unsaved"}
				</span>
			</header>
			{tables.length === 0 ? (
				<p className="px-5 py-6 text-sm text-slate-500">
					No tables yet. Add one to generate SQL.
				</p>
			) : (
				<ul className="divide-y divide-slate-800">
					{tables.map((table) => (
						<li key={table.id} className="px-5 py-4">
							<p className="font-medium text-slate-100">{table.name}</p>
							<ul className="mt-2 flex flex-wrap gap-2">
								{table.columns.map((column) => (
									<li
										key={column.id}
										className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-300"
									>
										<span className="font-medium text-slate-100">{column.name}</span>{" "}
										<span className="text-slate-500">{column.type}</span>
										{column.primaryKey && <span className="ml-1 text-amber-400">PK</span>}
										{column.identity && <span className="ml-1 text-sky-400">identity</span>}
										{column.nullable ? (
											<span className="ml-1 text-slate-500">null</span>
										) : (
											<span className="ml-1 text-slate-500">required</span>
										)}
									</li>
								))}
							</ul>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function SqlPanel({ sql }: { sql: SqlState }) {
	return (
		<section className="rounded-xl border border-slate-800 bg-slate-900/60">
			<header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
				<h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
					SQL preview
				</h2>
				<StatusPill
					tone={sql.status === "current" ? "ok" : sql.status === "stale" ? "warn" : "muted"}
				>
					{sql.status === "current" ? "Current" : sql.status === "stale" ? "Out of date" : "Not available"}
				</StatusPill>
			</header>
			<div className="px-5 py-4">
				{sql.status === "empty" ? (
					<p className="text-sm text-slate-500">
						No SQL has been generated yet. Complete the design to produce PostgreSQL.
					</p>
				) : (
					<pre
						data-testid="sql-preview"
						className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-relaxed text-emerald-200"
					>
						<code>{sql.sql}</code>
					</pre>
				)}
				{sql.status !== "current" && sql.errors.length > 0 && (
					<ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-300">
						{sql.errors.map((message) => (
							<li key={message}>{message}</li>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}

function SandboxPanel({ sandbox }: { sandbox: SandboxState }) {
	return (
		<section className="rounded-xl border border-slate-800 bg-slate-900/60">
			<header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
				<h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">
					Sandbox check
				</h2>
				<StatusPill
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
				</StatusPill>
			</header>
			<div className="px-5 py-4 text-sm">
				{sandbox.status === "applied" && (
					<div className="space-y-3">
						<p className="text-slate-400">
							PGlite applied revision {sandbox.revision} and reported the schema below.
						</p>
						<ul className="space-y-2">
							{sandbox.tables.map((table) => (
								<li key={table.name} className="rounded border border-slate-800 bg-slate-950 p-3">
									<p className="font-medium text-slate-200">{table.name}</p>
									<ul className="mt-1 space-y-1 text-xs text-slate-400">
										{table.columns.map((column) => (
											<li key={column.name}>
												{column.name} · {column.dataType}
												{column.isIdentity ? " · identity" : ""}
												{column.nullable ? " · null" : " · not null"}
											</li>
										))}
									</ul>
								</li>
							))}
						</ul>
					</div>
				)}
				{sandbox.status === "applying" && (
					<p className="text-slate-400">Rebuilding the disposable preview…</p>
				)}
				{sandbox.status === "failed" && (
					<div className="space-y-3">
						<p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-red-200">
							{sandbox.error}
						</p>
						<details className="text-xs text-slate-400">
							<summary className="cursor-pointer text-slate-300">Attempted SQL</summary>
							<pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-950 p-3 text-emerald-200">
								<code>{sandbox.attemptedSql}</code>
							</pre>
						</details>
					</div>
				)}
				{sandbox.status === "idle" && (
					<p className="text-slate-500">
						The sandbox has not applied this design yet.
					</p>
				)}
			</div>
		</section>
	);
}

function SaveBadge({ save }: { save: SaveState }) {
	const tone = save.status === "failed" ? "bad" : save.status === "saved" ? "ok" : "muted";
	const label =
		save.status === "failed"
			? "Save failed"
			: save.status === "saved"
				? "Saved"
				: save.status === "saving"
					? "Saving…"
					: "Not saved";
	return (
		<div className="flex items-center gap-2 text-xs text-slate-400" data-testid="save-status">
			<StatusPill tone={tone}>{label}</StatusPill>
			{save.status === "saved" && (
				<span>{new Date(save.savedAt).toLocaleTimeString()}</span>
			)}
			{save.status === "failed" && (
				<span className="text-red-300" data-testid="save-error">
					{save.error}
				</span>
			)}
		</div>
	);
}

function StatusPill({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone: "ok" | "warn" | "bad" | "muted";
}) {
	const toneClass = {
		ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
		warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
		bad: "border-red-500/40 bg-red-500/10 text-red-300",
		muted: "border-slate-700 bg-slate-800/60 text-slate-400",
	}[tone];
	return (
		<span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass}`}>
			{children}
		</span>
	);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export default App;
