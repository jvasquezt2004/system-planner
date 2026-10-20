import { useCallback, useEffect, useState } from "react";
import type {
	AffectedRelationship,
	CanvasPoint,
	CanvasViewport,
	ColumnChanges,
	ProjectSummary,
	RemovalPlan,
	RemovalTarget,
	SandboxState,
	SaveState,
	SqlState,
	WorkspaceState,
} from "../shared/design";
import { relationshipsForTable } from "../shared/relationships";
import { TableCanvas } from "./canvas";
import { TableInspector } from "./table-inspector";
import { workspaceClient } from "./workspace-client";

function App() {
	const [state, setState] = useState<WorkspaceState | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
	const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
	const [selectedRelationshipId, setSelectedRelationshipId] = useState<string | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<{
		target: RemovalTarget;
		plan: RemovalPlan;
	} | null>(null);

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

	/** Layout saves never change the schema, so they skip the busy state. */
	const applyLayout = useCallback(async (action: () => Promise<WorkspaceState>) => {
		setError(null);
		try {
			setState(await action());
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}, []);

	const projectId = state?.project?.id ?? null;

	// Selection belongs to the open project, never to a previously open one.
	useEffect(() => {
		setSelectedTableId(null);
		setSelectedColumnId(null);
		setSelectedRelationshipId(null);
	}, [projectId]);

	useEffect(() => {
		if (!selectedTableId) return;
		const stillExists = state?.design?.tables.some((table) => table.id === selectedTableId);
		if (!stillExists) {
			setSelectedTableId(null);
			setSelectedColumnId(null);
		}
	}, [state, selectedTableId]);

	useEffect(() => {
		if (!selectedColumnId) return;
		const table = state?.design?.tables.find((candidate) => candidate.id === selectedTableId);
		const stillExists = table?.columns.some((column) => column.id === selectedColumnId);
		if (!stillExists) setSelectedColumnId(null);
	}, [state, selectedTableId, selectedColumnId]);

	useEffect(() => {
		if (!selectedRelationshipId) return;
		const stillExists = state?.design?.relationships.some(
			(relationship) => relationship.id === selectedRelationshipId,
		);
		if (!stillExists) setSelectedRelationshipId(null);
	}, [state, selectedRelationshipId]);

	const handleSelectTable = useCallback((tableId: string | null) => {
		setSelectedTableId(tableId);
		setSelectedColumnId(null);
	}, []);

	const handleSelectRelationship = useCallback((relationshipId: string | null) => {
		setSelectedRelationshipId(relationshipId);
	}, []);

	const handleRelateTables = useCallback(
		(referencingTableId: string, referencedTableId: string) => {
			void (async () => {
				setBusy(true);
				setError(null);
				try {
					const next = await workspaceClient.addRelationship(
						referencingTableId,
						referencedTableId,
					);
					setState(next);
					const created =
						next.design?.relationships[next.design.relationships.length - 1];
					if (created) setSelectedRelationshipId(created.id);
					setSelectedTableId(referencingTableId);
					setSelectedColumnId(null);
				} catch (cause) {
					setError(errorMessage(cause));
				} finally {
					setBusy(false);
				}
			})();
		},
		[],
	);

	const handleSetRelationshipRequired = useCallback(
		(relationshipId: string, required: boolean) => {
			void run(() => workspaceClient.updateRelationship(relationshipId, required));
		},
		[run],
	);

	const handleRemoveRelationship = useCallback(
		(relationshipId: string) => {
			setSelectedRelationshipId(null);
			void run(() => workspaceClient.removeRelationship(relationshipId));
		},
		[run],
	);

	/** Deletion first asks the workspace what it would take with it. */
	const requestRemoval = useCallback(async (target: RemovalTarget) => {
		setError(null);
		try {
			const plan = await workspaceClient.describeRemoval(target);
			setPendingRemoval({ target, plan });
		} catch (cause) {
			setError(errorMessage(cause));
		}
	}, []);

	const confirmRemoval = useCallback(() => {
		if (!pendingRemoval) return;
		const target = pendingRemoval.target;
		const tableId = target.tableId;
		const columnId = target.kind === "column" ? target.columnId : null;
		setPendingRemoval(null);
		setSelectedRelationshipId(null);
		setSelectedColumnId(null);
		if (columnId === null) {
			setSelectedTableId(null);
			void run(() => workspaceClient.removeTable(tableId, true));
		} else {
			void run(() => workspaceClient.removeColumn(tableId, columnId, true));
		}
	}, [pendingRemoval, run]);

	const handleAddTable = useCallback((name: string, position: CanvasPoint) => {
		void (async () => {
			setBusy(true);
			setError(null);
			try {
				const next = await workspaceClient.addTable(name, position);
				setState(next);
				const created = next.design?.tables[next.design.tables.length - 1];
				if (created) {
					setSelectedTableId(created.id);
					setSelectedColumnId(null);
				}
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				setBusy(false);
			}
		})();
	}, []);

	const handleAddColumn = useCallback(() => {
		if (!selectedTableId) return;
		void (async () => {
			setBusy(true);
			setError(null);
			try {
				const next = await workspaceClient.addColumn(selectedTableId);
				setState(next);
				const table = next.design?.tables.find(
					(candidate) => candidate.id === selectedTableId,
				);
				const created = table?.columns[table.columns.length - 1];
				if (created) setSelectedColumnId(created.id);
			} catch (cause) {
				setError(errorMessage(cause));
			} finally {
				setBusy(false);
			}
		})();
	}, [selectedTableId]);

	const handleApplyColumn = useCallback(
		(columnId: string, changes: ColumnChanges) => {
			if (!selectedTableId) return;
			void run(() => workspaceClient.updateColumn(selectedTableId, columnId, changes));
		},
		[run, selectedTableId],
	);

	const handleRemoveColumn = useCallback(
		(columnId: string) => {
			if (!selectedTableId) return;
			void requestRemoval({ kind: "column", tableId: selectedTableId, columnId });
		},
		[requestRemoval, selectedTableId],
	);

	const handleMoveTable = useCallback(
		(tableId: string, position: CanvasPoint) => {
			void applyLayout(() => workspaceClient.moveTable(tableId, position));
		},
		[applyLayout],
	);

	const handleViewportChange = useCallback(
		(viewport: CanvasViewport) => {
			void applyLayout(() => workspaceClient.setViewport(viewport));
		},
		[applyLayout],
	);

	const selectedTable =
		state?.design?.tables.find((table) => table.id === selectedTableId) ?? null;
	const inspectorRelationships =
		state?.design && selectedTable
			? relationshipsForTable(state.design, selectedTable.id)
			: [];

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
		<main className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
			<header className="flex shrink-0 flex-wrap items-end justify-between gap-4 border-b border-slate-800 px-5 py-3">
				<div>
					<p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-indigo-400">
						Schema Designer
					</p>
					<div className="mt-0.5 flex items-baseline gap-3">
						<h1 className="text-xl font-semibold">
							{state.project?.name ?? "No project open"}
						</h1>
						{state.project && (
							<span className="text-xs text-slate-500" data-testid="schema-revision">
								schema revision {state.revision}
							</span>
						)}
					</div>
				</div>
				<SaveBadge save={state.save} />
			</header>

			{error && (
				<div
					role="alert"
					className="mx-5 mt-3 shrink-0 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200"
				>
					{error}
				</div>
			)}

			{pendingRemoval && (
				<RemovalDialog
					plan={pendingRemoval.plan}
					busy={busy}
					onConfirm={confirmRemoval}
					onCancel={() => setPendingRemoval(null)}
				/>
			)}

			<div className="flex min-h-0 flex-1">
				<ProjectsPanel
					projects={state.projects}
					activeProjectId={projectId}
					busy={busy}
					onOpen={(id) => run(() => workspaceClient.openProject(id))}
					onCreate={(name) => run(() => workspaceClient.createProject(name))}
				/>

				<section className="relative min-w-0 flex-1">
					{state.project && state.design ? (
						<TableCanvas
							key={state.project.id}
							design={state.design}
							selectedTableId={selectedTableId}
							selectedRelationshipId={selectedRelationshipId}
							onSelectTable={handleSelectTable}
							onSelectRelationship={handleSelectRelationship}
							onRelateTables={handleRelateTables}
							onMoveTable={handleMoveTable}
							onViewportChange={handleViewportChange}
							onAddTable={handleAddTable}
						/>
					) : (
						<div className="flex h-full items-center justify-center bg-slate-950">
							<div className="max-w-sm rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center">
								<h2 className="text-lg font-semibold">Start a design</h2>
								<p className="mt-1 text-sm text-slate-400">
									Create a project to open its design. Every project owns exactly one
									design, saved automatically in local SQLite.
								</p>
							</div>
						</div>
					)}
				</section>

				<aside className="flex w-[23rem] shrink-0 flex-col gap-3 overflow-y-auto border-l border-slate-800 bg-slate-900/40 p-3">
					<TableInspector
						table={selectedTable}
						selectedColumnId={selectedColumnId}
						relationships={inspectorRelationships}
						selectedRelationshipId={selectedRelationshipId}
						sql={state.sql}
						busy={busy}
						onRename={(name) => {
							if (!selectedTable) return;
							void run(() => workspaceClient.renameTable(selectedTable.id, name));
						}}
						onRemove={() => {
							if (!selectedTable) return;
							void requestRemoval({ kind: "table", tableId: selectedTable.id });
						}}
						onSelectColumn={setSelectedColumnId}
						onAddColumn={handleAddColumn}
						onApplyColumn={handleApplyColumn}
						onRemoveColumn={handleRemoveColumn}
						onSelectRelationship={handleSelectRelationship}
						onSetRelationshipRequired={handleSetRelationshipRequired}
						onRemoveRelationship={handleRemoveRelationship}
					/>
					<SqlPanel sql={state.sql} />
					<SandboxPanel sandbox={state.sandbox} />
				</aside>
			</div>
		</main>
	);
}

/**
 * Shows what a destructive edit would take with it. Cancelling changes nothing;
 * confirming removes only the target and the relationships listed here.
 */
function RemovalDialog({
	plan,
	busy,
	onConfirm,
	onCancel,
}: {
	plan: RemovalPlan;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	useEffect(() => {
		const cancelOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") onCancel();
		};
		window.addEventListener("keydown", cancelOnEscape);
		return () => window.removeEventListener("keydown", cancelOnEscape);
	}, [onCancel]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="removal-heading"
				data-testid="removal-confirmation"
				className="w-full max-w-md rounded-xl border border-red-500/40 bg-slate-900 p-4 shadow-2xl"
			>
				<h2 id="removal-heading" className="text-sm font-semibold text-red-200">
					Remove {plan.target}?
				</h2>
				{plan.relationships.length === 0 ? (
					<p className="mt-2 text-xs text-slate-400">
						No relationships depend on it.
					</p>
				) : (
					<>
						<p className="mt-2 text-xs text-slate-300">
							These relationships are affected and will be removed too. Their
							columns stay, and other tables and columns are untouched.
						</p>
						<ul
							data-testid="affected-relationships"
							className="mt-2 space-y-1"
						>
							{plan.relationships.map((relationship: AffectedRelationship) => (
								<li
									key={relationship.relationshipId}
									className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-300"
								>
									{relationship.referencingTable}.
									{relationship.referencingColumn} →{" "}
									{relationship.referencedTable}.
									{relationship.referencedColumn ?? "(no primary key)"}
								</li>
							))}
						</ul>
					</>
				)}
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						data-testid="cancel-removal"
						onClick={onCancel}
						className="rounded-md border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500"
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="confirm-removal"
						onClick={onConfirm}
						disabled={busy}
						className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Remove
					</button>
				</div>
			</div>
		</div>
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
		<aside className="flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-slate-800 bg-slate-900/40 p-3">
			<section aria-labelledby="projects-heading">
				<header className="flex items-center justify-between">
					<h2
						id="projects-heading"
						className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
					>
						Projects
					</h2>
					<span className="text-[10px] text-slate-500" data-testid="project-count">
						{projects.length === 0 ? "none saved" : `${projects.length} saved`}
					</span>
				</header>
				<ul className="mt-2 flex flex-col gap-1" data-testid="project-list">
					{projects.length === 0 ? (
						<li className="rounded border border-dashed border-slate-800 px-2 py-3 text-xs text-slate-500">
							No saved projects yet.
						</li>
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
												? "flex w-full items-center justify-between rounded-md border border-indigo-500/60 bg-indigo-500/15 px-2.5 py-1.5 text-left text-sm text-indigo-200"
												: "flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-950 px-2.5 py-1.5 text-left text-sm text-slate-300 hover:border-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
										}
									>
										<span className="truncate">{project.name}</span>
										{active && (
											<span className="ml-2 shrink-0 text-[9px] uppercase tracking-wide text-indigo-300">
												open
											</span>
										)}
									</button>
								</li>
							);
						})
					)}
				</ul>
			</section>

			<form
				className="flex flex-col gap-2 border-t border-slate-800 pt-3"
				onSubmit={(event) => {
					event.preventDefault();
					if (name.trim().length === 0) return;
					onCreate(name);
					setName("");
				}}
			>
				<label
					htmlFor="new-project-name"
					className="text-[11px] font-semibold uppercase tracking-wide text-slate-400"
				>
					New project
				</label>
				<input
					id="new-project-name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					aria-label="New project name"
					placeholder="Library"
					className="rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-sm outline-none focus:border-indigo-500"
				/>
				<button
					type="submit"
					disabled={busy || name.trim().length === 0}
					className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
				>
					New project
				</button>
			</form>

			<p className="mt-auto text-[11px] leading-relaxed text-slate-500">
				Table cards describe structure, not stored records. Layout is saved with the design
				and never changes the schema.
			</p>
		</aside>
	);
}

function SqlPanel({ sql }: { sql: SqlState }) {
	return (
		<section className="rounded-xl border border-slate-800 bg-slate-900/60">
			<header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
				<h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
					SQL preview
				</h2>
				<StatusPill
					tone={sql.status === "current" ? "ok" : sql.status === "stale" ? "warn" : "muted"}
				>
					{sql.status === "current"
						? "Current"
						: sql.status === "stale"
							? "Out of date"
							: "Not available"}
				</StatusPill>
			</header>
			<div className="px-4 py-3">
				{sql.status === "empty" ? (
					<p className="text-sm text-slate-500">
						No SQL has been generated yet. Complete the design to produce PostgreSQL.
					</p>
				) : (
					<pre
						data-testid="sql-preview"
						className="max-h-56 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-emerald-200"
					>
						<code>{sql.sql}</code>
					</pre>
				)}
				{sql.status !== "current" && sql.errors.length > 0 && (
					<ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-amber-300">
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
			<header className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
				<h2 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
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
			<div className="px-4 py-3 text-sm">
				{sandbox.status === "applied" && (
					<div className="space-y-2">
						<p className="text-xs text-slate-400">
							PGlite applied schema revision {sandbox.revision}.
						</p>
						{sandbox.relationships.length > 0 && (
							<div>
								<p className="text-[10px] uppercase tracking-wide text-slate-500">
									Foreign keys
								</p>
								<ul className="mt-1 space-y-1" data-testid="sandbox-relationships">
									{sandbox.relationships.map((relationship) => (
										<li
											key={relationship.name}
											className="rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-slate-300"
										>
											{relationship.referencingTable}.
											{relationship.referencingColumn} →{" "}
											{relationship.referencedTable}.
											{relationship.referencedColumn}
											<span className="ml-1 text-slate-500">
												{relationship.updateRule} / {relationship.deleteRule}
											</span>
										</li>
									))}
								</ul>
							</div>
						)}
						<ul className="space-y-1.5">
							{sandbox.tables.map((table) => (
								<li
									key={table.name}
									className="rounded border border-slate-800 bg-slate-950 p-2"
								>
									<p className="text-xs font-medium text-slate-200">{table.name}</p>
									<ul className="mt-1 space-y-0.5 text-[11px] text-slate-400">
										{table.columns.map((column) => (
											<li key={column.name}>
												{column.name} · {column.dataType}
												{column.isIdentity ? " · identity" : ""}
												{column.defaultExpression && (
													<>
														{" · "}
														<span
															className="break-all text-slate-500"
															title={`Default: ${column.defaultExpression}`}
														>
															default {column.defaultExpression}
														</span>
													</>
												)}
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
					<p className="text-xs text-slate-400">Rebuilding the disposable preview…</p>
				)}
				{sandbox.status === "failed" && (
					<div className="space-y-2">
						<p className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-red-200">
							{sandbox.error}
						</p>
						<details className="text-[11px] text-slate-400">
							<summary className="cursor-pointer text-slate-300">Attempted SQL</summary>
							<pre className="mt-1 max-h-40 overflow-auto rounded bg-slate-950 p-2 text-emerald-200">
								<code>{sandbox.attemptedSql}</code>
							</pre>
						</details>
					</div>
				)}
				{sandbox.status === "idle" && (
					<p className="text-xs text-slate-500">
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
			{save.status === "saved" && <span>{new Date(save.savedAt).toLocaleTimeString()}</span>}
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
		<span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${toneClass}`}>
			{children}
		</span>
	);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export default App;
