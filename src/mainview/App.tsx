import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, FileCode2, Plus, X } from "lucide-react";
import type {
	AffectedRelationship,
	CanvasPoint,
	CanvasViewport,
	ColumnChanges,
	ProjectSummary,
	RelationshipCardinality,
	RemovalPlan,
	RemovalTarget,
	SandboxState,
	SaveState,
	SqlState,
	WorkspaceState,
} from "../shared/design";
import { relationshipsForTable } from "../shared/relationships";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
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
	const [relating, setRelating] = useState(false);
	const [creatingProject, setCreatingProject] = useState(false);
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

	const designRef = useRef(state?.design ?? null);
	designRef.current = state?.design ?? null;

	const handleSelectTable = useCallback((tableId: string | null) => {
		setSelectedTableId(tableId);
		setSelectedColumnId(null);
		// A relationship stays selected only while one of its tables is open.
		setSelectedRelationshipId((current) => {
			if (!current || !tableId) return null;
			const relationship = designRef.current?.relationships.find(
				(candidate) => candidate.id === current,
			);
			return relationship?.referencingTableId === tableId ||
				relationship?.referencedTableId === tableId
				? current
				: null;
		});
	}, []);

	const handleSelectRelationship = useCallback((relationshipId: string | null) => {
		setSelectedRelationshipId(relationshipId);
	}, []);

	/** A relationship picked on the canvas opens the table that stores it. */
	const handleCanvasSelectRelationship = useCallback(
		(relationshipId: string, referencingTableId: string) => {
			setSelectedTableId(referencingTableId);
			setSelectedColumnId(null);
			setSelectedRelationshipId(relationshipId);
		},
		[],
	);

	const handleRelateTables = useCallback(
		(
			referencingTableId: string,
			referencedTableId: string,
			cardinality: RelationshipCardinality,
		) => {
			void (async () => {
				setBusy(true);
				setError(null);
				try {
					const next = await workspaceClient.addRelationship(
						referencingTableId,
						referencedTableId,
						cardinality,
					);
					setState(next);
					const created =
						next.design?.relationships[next.design.relationships.length - 1];
					setSelectedTableId(referencingTableId);
					setSelectedColumnId(null);
					if (created) setSelectedRelationshipId(created.id);
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
			void run(() => workspaceClient.updateRelationship(relationshipId, { required }));
		},
		[run],
	);

	const handleSetRelationshipCardinality = useCallback(
		(relationshipId: string, cardinality: RelationshipCardinality) => {
			void run(() => workspaceClient.updateRelationship(relationshipId, { cardinality }));
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
					setSelectedRelationshipId(null);
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

	const openSqlPreview = useCallback(() => {
		workspaceClient.openSqlWindow().catch((cause: unknown) => {
			setError(errorMessage(cause));
		});
	}, []);

	const createProject = useCallback(
		(name: string) => {
			setCreatingProject(false);
			void run(() => workspaceClient.createProject(name));
		},
		[run],
	);

	const selectedTable =
		state?.design?.tables.find((table) => table.id === selectedTableId) ?? null;
	const inspectorRelationships =
		state?.design && selectedTable
			? relationshipsForTable(state.design, selectedTable.id)
			: [];

	if (!state) {
		return (
			<main className="flex h-screen items-center justify-center bg-paper">
				<p className="font-display text-[18px] text-ink-3 italic">
					Opening the design workspace…
				</p>
			</main>
		);
	}

	return (
		<main className="flex h-screen flex-col overflow-hidden bg-paper text-ink">
			<Masthead
				state={state}
				busy={busy}
				onOpenProject={(id) => run(() => workspaceClient.openProject(id))}
				onNewProject={() => setCreatingProject(true)}
				onOpenSqlPreview={openSqlPreview}
			/>

			{error && (
				<div
					role="alert"
					className="flex shrink-0 items-start gap-3 border-b border-proof-red/25 bg-proof-red-wash px-6 py-2 text-[12.5px] text-proof-red"
				>
					<span className="kicker text-proof-red! pt-px">Error</span>
					<p className="min-w-0 flex-1">{error}</p>
					<button
						type="button"
						aria-label="Dismiss error"
						onClick={() => setError(null)}
						className="rounded-sm p-0.5 hover:bg-proof-red-wash"
					>
						<X className="size-3.5" />
					</button>
				</div>
			)}

			<section className="relative min-h-0 flex-1">
				{state.project && state.design ? (
					<TableCanvas
						key={state.project.id}
						design={state.design}
						selectedTableId={selectedTableId}
						selectedRelationshipId={selectedRelationshipId}
						onSelectTable={handleSelectTable}
						onSelectRelationship={handleCanvasSelectRelationship}
						onRelateTables={handleRelateTables}
						onRelatingChange={setRelating}
						onMoveTable={handleMoveTable}
						onViewportChange={handleViewportChange}
						onAddTable={handleAddTable}
					/>
				) : (
					<ProjectIndex
						projects={state.projects}
						busy={busy}
						onOpen={(id) => run(() => workspaceClient.openProject(id))}
						onCreate={createProject}
					/>
				)}
			</section>

			{/*
			 * The inspector appears only while a table is selected. It is non-modal,
			 * so the canvas stays live beside it: clicking another card switches the
			 * table, and clicking empty canvas closes it. It steps aside while
			 * relating, so every card on the canvas can be picked as the target.
			 */}
			<Sheet
				open={selectedTable !== null && !relating}
				modal={false}
				onOpenChange={(open) => {
					if (!open) handleSelectTable(null);
				}}
			>
				<SheetContent
					side="right"
					data-testid="inspector-sheet"
					className="top-[var(--masthead-height)] bottom-0 h-auto w-[440px] gap-0 sm:max-w-[440px]"
					onOpenAutoFocus={(event) => event.preventDefault()}
					onInteractOutside={(event) => event.preventDefault()}
				>
					{selectedTable && (
						<>
							<SheetTitle className="sr-only">{selectedTable.name}</SheetTitle>
							<SheetDescription className="sr-only">
								Columns and relationships of the selected table.
							</SheetDescription>
							<ScrollArea className="min-h-0 flex-1">
								<TableInspector
									table={selectedTable}
									selectedColumnId={selectedColumnId}
									relationships={inspectorRelationships}
									selectedRelationshipId={selectedRelationshipId}
									sql={state.sql}
									busy={busy}
									onRename={(name) =>
										void run(() => workspaceClient.renameTable(selectedTable.id, name))
									}
									onRemove={() =>
										void requestRemoval({ kind: "table", tableId: selectedTable.id })
									}
									onSelectColumn={setSelectedColumnId}
									onAddColumn={handleAddColumn}
									onApplyColumn={handleApplyColumn}
									onRemoveColumn={handleRemoveColumn}
									onSelectRelationship={handleSelectRelationship}
									onSetRelationshipRequired={handleSetRelationshipRequired}
									onSetRelationshipCardinality={handleSetRelationshipCardinality}
									onRemoveRelationship={handleRemoveRelationship}
								/>
							</ScrollArea>
						</>
					)}
				</SheetContent>
			</Sheet>

			<RemovalDialog
				plan={pendingRemoval?.plan ?? null}
				busy={busy}
				onConfirm={confirmRemoval}
				onCancel={() => setPendingRemoval(null)}
			/>

			<NewProjectDialog
				open={creatingProject}
				busy={busy}
				onCreate={createProject}
				onCancel={() => setCreatingProject(false)}
			/>
		</main>
	);
}

/**
 * The page head: which design is open, how its saved and validated state
 * stands, and the way into the SQL preview window. A double rule closes it.
 */
function Masthead({
	state,
	busy,
	onOpenProject,
	onNewProject,
	onOpenSqlPreview,
}: {
	state: WorkspaceState;
	busy: boolean;
	onOpenProject: (projectId: string) => void;
	onNewProject: () => void;
	onOpenSqlPreview: () => void;
}) {
	const project = state.project;
	return (
		<header
			className="double-rule flex shrink-0 items-center justify-between gap-6 bg-paper px-6"
			style={{ height: "var(--masthead-height)" }}
		>
			<div className="flex min-w-0 items-center gap-5">
				<p className="kicker hidden shrink-0 leading-tight text-ink-2! sm:block">
					Schema
					<br />
					Designer
				</p>
				<span className="hidden h-8 w-px bg-rule sm:block" aria-hidden="true" />
				<DropdownMenu>
					<h1 className="min-w-0">
						<DropdownMenuTrigger
							disabled={busy}
							className="group flex max-w-full min-w-0 items-baseline gap-2 rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-pencil/30"
						>
							<span
								className={cn(
									"truncate font-display text-[26px] leading-none font-medium tracking-[-0.015em]",
									project ? "text-ink" : "text-ink-3 italic",
								)}
							>
								{project?.name ?? "No project open"}
							</span>
							<ChevronDown className="size-4 shrink-0 self-center text-ink-3 group-hover:text-ink" />
						</DropdownMenuTrigger>
					</h1>
					<DropdownMenuContent align="start" className="w-64">
						<DropdownMenuLabel className="flex items-center justify-between">
							<span className="kicker">Projects</span>
							<span className="figures font-mono text-[10px] text-ink-4" data-testid="project-count">
								{state.projects.length === 0 ? "none saved" : `${state.projects.length} saved`}
							</span>
						</DropdownMenuLabel>
						<div data-testid="project-list">
							{state.projects.map((candidate) => {
								const active = candidate.id === project?.id;
								return (
									<DropdownMenuItem
										key={candidate.id}
										data-testid="project-option"
										aria-current={active ? "true" : undefined}
										disabled={active}
										onSelect={() => onOpenProject(candidate.id)}
										className="justify-between font-display text-[15px] data-[disabled]:opacity-100"
									>
										<span className="truncate">{candidate.name}</span>
										{active && <span className="kicker text-pencil!">open</span>}
									</DropdownMenuItem>
								);
							})}
						</div>
						<DropdownMenuSeparator />
						<DropdownMenuItem onSelect={onNewProject}>
							<Plus />
							New project…
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				{project && (
					<span className="figures hidden shrink-0 font-mono text-[11px] text-ink-3 md:inline" data-testid="schema-revision">
						rev. {state.revision}
					</span>
				)}
			</div>

			<div className="flex shrink-0 items-center gap-5">
				{project && (
					<dl className="hidden items-center gap-5 lg:flex">
						<StatusLine label="Saved">
							<SaveStatus save={state.save} />
						</StatusLine>
						<StatusLine label="Sandbox">
							<SandboxStatus sandbox={state.sandbox} />
						</StatusLine>
						<StatusLine label="SQL">
							<SqlStatus sql={state.sql} />
						</StatusLine>
					</dl>
				)}
				<Button
					variant="outline"
					size="sm"
					data-testid="open-sql-preview"
					onClick={onOpenSqlPreview}
					disabled={!project}
				>
					<FileCode2 />
					SQL preview
				</Button>
			</div>
		</header>
	);
}

function StatusLine({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="kicker text-[9.5px]! text-ink-4!">{label}</dt>
			<dd className="flex items-center gap-1.5 text-[12px] leading-none">{children}</dd>
		</div>
	);
}

/** A small square of ink: the only colour a status line carries. */
function Mark({ tone }: { tone: "ok" | "warn" | "bad" | "muted" }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"size-1.5 shrink-0",
				tone === "ok" && "bg-press-green",
				tone === "warn" && "bg-ochre",
				tone === "bad" && "bg-proof-red",
				tone === "muted" && "bg-ink-4",
			)}
		/>
	);
}

function SaveStatus({ save }: { save: SaveState }) {
	return (
		<span className="flex items-center gap-1.5" data-testid="save-status">
			<Mark tone={save.status === "failed" ? "bad" : save.status === "saved" ? "ok" : "muted"} />
			{save.status === "saved" && (
				<span className="figures font-mono text-[11px] text-ink-2">
					{new Date(save.savedAt).toLocaleTimeString()}
				</span>
			)}
			{save.status === "saving" && <span className="text-ink-3 italic">Saving…</span>}
			{save.status === "idle" && <span className="text-ink-3">Not saved</span>}
			{save.status === "failed" && (
				<span className="max-w-56 truncate text-proof-red" data-testid="save-error" title={save.error}>
					Failed — {save.error}
				</span>
			)}
		</span>
	);
}

function SandboxStatus({ sandbox }: { sandbox: SandboxState }) {
	if (sandbox.status === "applied") {
		return (
			<>
				<Mark tone="ok" />
				<span className="text-ink-2">
					Accepted <span className="figures font-mono text-[11px] text-ink-3">rev. {sandbox.revision}</span>
				</span>
			</>
		);
	}
	if (sandbox.status === "failed") {
		return (
			<>
				<Mark tone="bad" />
				<span className="text-proof-red">
					Rejected <span className="figures font-mono text-[11px]">rev. {sandbox.revision}</span>
				</span>
			</>
		);
	}
	if (sandbox.status === "applying") {
		return (
			<>
				<Mark tone="warn" />
				<span className="text-ink-3 italic">Applying…</span>
			</>
		);
	}
	return (
		<>
			<Mark tone="muted" />
			<span className="text-ink-3">Not run</span>
		</>
	);
}

function SqlStatus({ sql }: { sql: SqlState }) {
	if (sql.status === "current") {
		return (
			<>
				<Mark tone="ok" />
				<span className="text-ink-2">Current</span>
			</>
		);
	}
	if (sql.status === "stale") {
		return (
			<>
				<Mark tone="warn" />
				<span className="text-ochre" title={sql.errors.join("\n")}>
					Out of date
				</span>
			</>
		);
	}
	return (
		<>
			<Mark tone="muted" />
			<span className="text-ink-3">Not available</span>
		</>
	);
}

/**
 * The opening page when no project is open: a table of contents of saved
 * projects with dotted leaders, and a line to start a new one.
 */
function ProjectIndex({
	projects,
	busy,
	onOpen,
	onCreate,
}: {
	projects: ProjectSummary[];
	busy: boolean;
	onOpen: (projectId: string) => void;
	onCreate: (name: string) => void;
}) {
	const [name, setName] = useState("");
	return (
		<ScrollArea className="h-full">
			<div className="mx-auto max-w-xl px-6 pt-16 pb-24">
				<p className="kicker">Contents</p>
				<h2 className="mt-2 font-display text-[44px] leading-[1.05] font-normal tracking-[-0.02em] text-ink">
					Plan a database the way you would set a page.
				</h2>
				<p className="mt-4 max-w-md text-[13.5px] leading-relaxed text-ink-2">
					Every project owns exactly one design, saved automatically on this machine.
					Open one to continue, or start a new one below.
				</p>

				<section aria-labelledby="projects-heading" className="mt-12">
					<header className="flex items-baseline justify-between border-b border-ink pb-1.5">
						<h3 id="projects-heading" className="kicker text-ink!">
							Projects
						</h3>
						<span className="figures font-mono text-[10.5px] text-ink-3" data-testid="project-count">
							{projects.length === 0 ? "none saved" : `${projects.length} saved`}
						</span>
					</header>
					<ol data-testid="project-list">
						{projects.length === 0 ? (
							<li className="border-b border-rule py-4 font-display text-[16px] text-ink-3 italic">
								No saved projects yet.
							</li>
						) : (
							projects.map((project, index) => (
								<li key={project.id} className="border-b border-rule-soft">
									<button
										type="button"
										onClick={() => onOpen(project.id)}
										disabled={busy}
										data-testid="project-option"
										className="group flex w-full items-baseline gap-3 py-3 text-left outline-none disabled:opacity-40"
									>
										<span className="figures w-6 shrink-0 font-mono text-[11px] text-ink-4">
											{String(index + 1).padStart(2, "0")}
										</span>
										<span className="font-display text-[19px] text-ink group-hover:text-pencil group-focus-visible:text-pencil">
											{project.name}
										</span>
										<span
											aria-hidden="true"
											className="mb-1 min-w-6 flex-1 border-b border-dotted border-ink-4"
										/>
										<span className="kicker group-hover:text-pencil!">Open</span>
									</button>
								</li>
							))
						)}
					</ol>
				</section>

				<form
					className="mt-10 flex items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim().length === 0) return;
						onCreate(name.trim());
						setName("");
					}}
				>
					<div className="flex min-w-0 flex-1 flex-col gap-1">
						<label htmlFor="new-project-name" className="kicker">
							New project
						</label>
						<Input
							id="new-project-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							aria-label="New project name"
							placeholder="Library"
						/>
					</div>
					<Button type="submit" disabled={busy || name.trim().length === 0}>
						<Plus />
						New project
					</Button>
				</form>
			</div>
		</ScrollArea>
	);
}

function NewProjectDialog({
	open,
	busy,
	onCreate,
	onCancel,
}: {
	open: boolean;
	busy: boolean;
	onCreate: (name: string) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	useEffect(() => {
		if (open) setName("");
	}, [open]);
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent className="sm:max-w-sm">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim().length === 0) return;
						onCreate(name.trim());
					}}
					className="flex flex-col gap-4"
				>
					<DialogHeader>
						<p className="kicker">New project</p>
						<DialogTitle>Name the design</DialogTitle>
						<DialogDescription>
							A project owns exactly one design, saved automatically.
						</DialogDescription>
					</DialogHeader>
					<Input
						autoFocus
						value={name}
						onChange={(event) => setName(event.target.value)}
						aria-label="New project name"
						placeholder="Library"
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || name.trim().length === 0}>
							Create project
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
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
	plan: RemovalPlan | null;
	busy: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	return (
		<Dialog open={plan !== null} onOpenChange={(open) => !open && onCancel()}>
			<DialogContent
				data-testid="removal-confirmation"
				showCloseButton={false}
				className="border-t-[3px] border-t-proof-red sm:max-w-md"
			>
				{plan && (
					<>
						<DialogHeader>
							<p className="kicker text-proof-red!">Remove</p>
							<DialogTitle>
								Remove <span className="font-mono text-[18px]">{plan.target}</span>?
							</DialogTitle>
							<DialogDescription>
								{plan.relationships.length === 0
									? "No relationships depend on it."
									: "These relationships are affected and will be removed too. Their columns stay, and other tables and columns are untouched."}
							</DialogDescription>
						</DialogHeader>
						{plan.relationships.length > 0 && (
							<ul data-testid="affected-relationships" className="border-y border-rule">
								{plan.relationships.map((relationship: AffectedRelationship, index) => (
									<li
										key={relationship.relationshipId}
										data-testid="affected-relationship"
										data-cardinality={relationship.cardinality}
										className={cn(
											"flex items-baseline justify-between gap-3 py-2 font-mono text-[11.5px] text-ink-2",
											index > 0 && "border-t border-rule-soft",
										)}
									>
										<span className="min-w-0 truncate">
											{relationship.referencingTable}.{relationship.referencingColumn} →{" "}
											{relationship.referencedTable}.
											{relationship.referencedColumn ?? "(no primary key)"}
										</span>
										<span className="kicker shrink-0">
											{relationship.constraints
												.map((constraint) =>
													constraint === "unique" ? "unique" : "foreign key",
												)
												.join(" + ")}
										</span>
									</li>
								))}
							</ul>
						)}
						<DialogFooter>
							<Button variant="ghost" data-testid="cancel-removal" onClick={onCancel}>
								Cancel
							</Button>
							<Button
								variant="destructive"
								data-testid="confirm-removal"
								onClick={onConfirm}
								disabled={busy}
							>
								Remove
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export default App;
