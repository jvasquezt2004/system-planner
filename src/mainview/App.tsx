import { useCallback, useEffect, useRef, useState } from "react";
import { Braces, ChevronDown, FileCode2, Network, PenTool, Plus, Redo2, ScrollText, Undo2, X, Zap, Server } from "lucide-react";
import { errorMessage } from "../shared/error-message";
import {
	getLastAppliedSandbox,
	getSqlPreviewValidationStatus,
	getSqlValidationErrors,
	type AffectedRelationship,
	type AffectedTrigger,
	type CanvasPoint,
	type CanvasViewport,
	type ColumnChanges,
	type ProjectSummary,
	type RelationshipCardinality,
	type RelationshipCreationCardinality,
	type RemovalPlan,
	type RemovalTarget,
	type SandboxState,
	type SaveState,
	type SqlPreviewValidationStatus,
	type SqlState,
	type Scenario,
	type WorkspaceState,
} from "../shared/design";
import { SCENARIO_RUN_TIMEOUT_MS, runAllScenarios, type RunAllResult } from "../shared/run-all";
import { createScenarioRunDriver, type ScenarioRunDriver } from "./scenario-run-driver";
import { createAssistantScenarioRunBridge } from "./assistant-scenario-run-bridge";
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { TableCanvas } from "./canvas";
import { SqlPreviewView, sqlStatusLine } from "./sql-preview";
import { TableInspector } from "./table-inspector";
import { workspaceClient } from "./workspace-client";
import { ScenarioView } from "./scenario-view";
import { TriggersView } from "./triggers-view";
import { FunctionsView } from "./functions-view";
import { AssistantSidebar } from "./assistant-sidebar";
import { EdgeFunctionsView } from "./edge-functions-view";
import { ArchitectureProofView } from "./architecture-proof";

type RunAllOperation = { projectId: string; designId: string; generation: number };

/** The main window shows the canvas, SQL preview, or saved Scenarios. */
type WorkspaceView = "canvas" | "sql" | "scenarios" | "edge-functions" | "functions" | "triggers" | "architecture";
type AssistantCodeTarget = { kind: "scenario" | "edge-function" | "function-body"; id: string };

export function App({
	initialState,
	client = workspaceClient,
}: {
	initialState?: WorkspaceState;
	client?: typeof workspaceClient;
} = {}) {
	const [state, setState] = useState<WorkspaceState | null>(() => initialState ?? null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
	const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
	const [selectedRelationshipId, setSelectedRelationshipId] = useState<string | null>(null);
	const [relating, setRelating] = useState(false);
	const [view, setView] = useState<WorkspaceView>(() => new URLSearchParams(window.location.search).has("proofReportUrl") ? "architecture" : "canvas");
	const [assistantCodeTarget, setAssistantCodeTarget] = useState<AssistantCodeTarget | null>(null);
	const [creatingProject, setCreatingProject] = useState(false);
	const [designDialog, setDesignDialog] = useState<DesignDialogState | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<{
		target: RemovalTarget;
		plan: RemovalPlan;
	} | null>(null);
	const [runAllActive, setRunAllActive] = useState(false);
	const [runAllResults, setRunAllResults] = useState<RunAllResult[]>([]);
	const [assistantCollapsed, setAssistantCollapsed] = useState(() => localStorage.getItem("assistant-sidebar-collapsed") === "true");
	const [assistantWidth, setAssistantWidth] = useState(() => {
		const stored = Number(localStorage.getItem("assistant-sidebar-width"));
		return Number.isFinite(stored) && stored >= 280 && stored <= 560 ? stored : 360;
	});
	const assistantDragging = useRef(false);
	useEffect(() => {
		const move = (event: PointerEvent) => {
			if (!assistantDragging.current) return;
			setAssistantWidth(Math.min(560, Math.max(280, window.innerWidth - event.clientX)));
		};
		const up = () => { assistantDragging.current = false; };
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
	}, []);
	useEffect(() => {
		localStorage.setItem("assistant-sidebar-width", String(assistantWidth));
	}, [assistantWidth]);
	useEffect(() => {
		localStorage.setItem("assistant-sidebar-collapsed", String(assistantCollapsed));
	}, [assistantCollapsed]);
	const [scenarioStarting, setScenarioStarting] = useState(false);
	const projectIdRef = useRef<string | null>(null);
	const designIdRef = useRef<string | null>(null);
	const projectGeneration = useRef(0);
	/** Changes whenever the view switches Project or Design; late results from an earlier target are dropped. */
	const targetKeyRef = useRef<string | null>(null);
	const targetVersion = useRef(0);
	const scenarioRunDriver = useRef<ScenarioRunDriver | null>(null);
	const runAllOperation = useRef<RunAllOperation | null>(null);
	const scenarioStartOperation = useRef<object | null>(null);
	const scenarioStateRef = useRef<WorkspaceState | null>(null);
	const assistantScenarioRunBridge = useRef<ReturnType<typeof createAssistantScenarioRunBridge> | null>(null);

	const resetScenarioExecution = useCallback(() => {
		scenarioRunDriver.current?.cancel();
		runAllOperation.current = null;
		scenarioStartOperation.current = null;
		setRunAllActive(false);
		setScenarioStarting(false);
		setRunAllResults([]);
	}, []);
	const receiveWorkspaceState = useCallback((next: WorkspaceState) => {
		const nextProjectId = next.project?.id ?? null;
		const nextDesignId = next.activeDesignId ?? null;
		const nextTargetKey = `${nextProjectId ?? ""}\u0000${nextDesignId ?? ""}`;
		if (targetKeyRef.current !== nextTargetKey) {
			targetKeyRef.current = nextTargetKey;
			targetVersion.current += 1;
			projectIdRef.current = nextProjectId;
			designIdRef.current = nextDesignId;
			projectGeneration.current += 1;
			resetScenarioExecution();
			// Selection names elements of the design that was shown, so it does not carry over.
			setSelectedTableId(null);
			setSelectedColumnId(null);
			setSelectedRelationshipId(null);
			setRelating(false);
			setAssistantCodeTarget(null);
		}
		setState(next);
		scenarioStateRef.current = next;
	}, [resetScenarioExecution]);

	if (!scenarioRunDriver.current) {
		scenarioRunDriver.current = createScenarioRunDriver({
			workspace: {
				beginScenarioRun: (action) => workspaceClient.beginScenarioRun(action),
				handleSandboxApiRequest: ({ runId, request }) =>
					workspaceClient.handleSandboxApiRequest(runId, request),
				finishScenarioRun: (action) => workspaceClient.finishScenarioRun(action),
			},
			createWorker: () => new Worker(new URL("./scenario-worker.ts", import.meta.url), { type: "module" }),
			createEdgeWorker: () => new Worker(new URL("./edge-function-worker.ts", import.meta.url), { type: "module" }),
			timeoutMs: SCENARIO_RUN_TIMEOUT_MS,
			getToken: () => projectGeneration.current,
			onState: receiveWorkspaceState,
		});
	}
	if (!assistantScenarioRunBridge.current && scenarioRunDriver.current) {
		assistantScenarioRunBridge.current = createAssistantScenarioRunBridge({
			driver: scenarioRunDriver.current,
			getWorkspaceState: () => scenarioStateRef.current,
			complete: (requestId, run, error) => {
				void workspaceClient.completeAssistantScenarioRun(requestId, run, error);
			},
		});
	}
	useEffect(() => {
		const bridge = assistantScenarioRunBridge.current;
		if (!bridge) return;
		const unsubscribeRequests = workspaceClient.subscribeAssistantScenarioRuns((request) => bridge.request(request));
		const unsubscribeCancels = workspaceClient.subscribeAssistantScenarioRunCancels((requestId) => bridge.cancel(requestId));
		return () => {
			unsubscribeRequests();
			unsubscribeCancels();
		};
	}, []);

	useEffect(() => {
		if (initialState) return;
		let active = true;
		const unsubscribe = client.subscribe((next) => {
			if (active) receiveWorkspaceState(next);
		});
		client
			.load()
			.then((next) => {
				if (active) receiveWorkspaceState(next);
			})
			.catch((cause: unknown) => {
				if (active) setError(errorMessage(cause));
			});
		return () => {
			active = false;
			unsubscribe();
		};
	}, [client, initialState, receiveWorkspaceState]);


	const run = useCallback(async (action: () => Promise<WorkspaceState>) => {
		const requestTarget = targetVersion.current;
		setBusy(true);
		setError(null);
		try {
			const next = await action();
			// The workspace pushes its current state whenever the target changes, so a
			// result that arrives after a switch is already superseded.
			if (targetVersion.current === requestTarget) receiveWorkspaceState(next);
		} catch (cause) {
			if (targetVersion.current === requestTarget) setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}, [receiveWorkspaceState]);

	/** Layout saves never change the schema, so they skip the busy state. */
	const applyLayout = useCallback(async (action: () => Promise<WorkspaceState>) => {
		const requestTarget = targetVersion.current;
		setError(null);
		try {
			const next = await action();
			if (targetVersion.current === requestTarget) setState(next);
		} catch (cause) {
			if (targetVersion.current === requestTarget) setError(errorMessage(cause));
		}
	}, []);

	const applySavedContent = useCallback(
		async (action: () => Promise<WorkspaceState>) => {
			const requestProjectId = state?.project?.id;
			const requestDesignId = state?.activeDesignId;
			try {
				const next = await action();
				setState((current) =>
					requestProjectId &&
					requestDesignId &&
					current?.project?.id === requestProjectId &&
					current.activeDesignId === requestDesignId &&
					next.project?.id === requestProjectId &&
					next.activeDesignId === requestDesignId
						? next
						: current,
				);
			} catch (cause) {
				setError(errorMessage(cause));
			}
		},
		[state?.activeDesignId, state?.project?.id],
	);
	const projectId = state?.project?.id ?? null;
	const activeScenarioRun = state
		? Object.values(state.scenarioRuns).find((run) => run?.status === "running") ?? null
		: null;
	const scenarioIsRunning = activeScenarioRun !== null;
	const scenarioRunDisabledReason = !state || !getLastAppliedSandbox(state.sandbox)
		? "Apply a valid design revision before running a Scenario."
		: scenarioIsRunning || scenarioStarting
			? "Another Scenario run is already active."
			: runAllActive
				? "Run all is already active."
				: null;
	const stopScenario = useCallback((runId: string) => {
		void scenarioRunDriver.current?.stop(runId).catch((cause: unknown) => {
			setError(errorMessage(cause));
		});
	}, []);
	const runScenario = useCallback(
		(scenario: Scenario) => {
			const designId = designIdRef.current;
			if (!designId) return Promise.resolve(null);
			return scenarioRunDriver.current?.run({ ...scenario, designId }) ?? Promise.resolve(null);
		},
		[],
	);
	const runSingleScenario = useCallback(async (scenario: Scenario) => {
		if (
			!state ||
			state.project?.id !== projectIdRef.current ||
			state.activeDesignId !== designIdRef.current ||
			!getLastAppliedSandbox(state.sandbox) ||
			scenarioIsRunning ||
			scenarioStartOperation.current ||
			runAllOperation.current
		) return;
		const operation = {};
		scenarioStartOperation.current = operation;
		setScenarioStarting(true);
		try {
			await runScenario(scenario);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			if (scenarioStartOperation.current === operation) {
				scenarioStartOperation.current = null;
				setScenarioStarting(false);
			}
		}
	}, [runScenario, scenarioIsRunning, state]);

	const runAll = useCallback(async () => {
		const currentProjectId = projectIdRef.current;
		const currentDesignId = designIdRef.current;
		if (
			!state ||
			!currentProjectId ||
			!currentDesignId ||
			state.project?.id !== currentProjectId ||
			state.activeDesignId !== currentDesignId ||
			!getLastAppliedSandbox(state.sandbox) ||
			scenarioIsRunning ||
			scenarioStarting ||
			scenarioStartOperation.current ||
			runAllOperation.current ||
			state.scenarios.length === 0
		) return;
		const operation: RunAllOperation = {
			projectId: currentProjectId,
			designId: currentDesignId,
			generation: projectGeneration.current,
		};
		const snapshot = state.scenarios.map((scenario) => ({
			...scenario,
			designId: currentDesignId,
		}));
		runAllOperation.current = operation;
		setRunAllActive(true);
		setRunAllResults([]);
		try {
			const results = await runAllScenarios(snapshot, runScenario, () =>
				runAllOperation.current === operation &&
				projectIdRef.current === operation.projectId &&
				designIdRef.current === operation.designId &&
				projectGeneration.current === operation.generation,
			);
			if (runAllOperation.current === operation) setRunAllResults(results);
		} catch (cause) {
			if (runAllOperation.current === operation) setError(errorMessage(cause));
		} finally {
			if (runAllOperation.current === operation) {
				runAllOperation.current = null;
				setRunAllActive(false);
			}
		}
	}, [runScenario, scenarioIsRunning, scenarioStarting, state]);

	useEffect(() => () => {
		assistantScenarioRunBridge.current?.dispose();
		scenarioRunDriver.current?.cancel();
	}, []);

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
			cardinality: RelationshipCreationCardinality,
			junctionPosition?: CanvasPoint,
		) => {
			void (async () => {
				setBusy(true);
				setError(null);
				try {
					const next = await workspaceClient.addRelationship(
						designIdRef.current!,
						referencingTableId,
						referencedTableId,
						cardinality,
						junctionPosition,
					);
					setState(next);
					// A many-to-many relationship opens its new junction table.
					if (cardinality === "many-to-many") {
						const associations = next.design?.manyToManyRelationships ?? [];
						const created = associations[associations.length - 1];
						if (created) {
							setSelectedTableId(created.junctionTableId);
							setSelectedRelationshipId(created.leftRelationshipId);
						}
					} else {
						const created =
							next.design?.relationships[next.design.relationships.length - 1];
						setSelectedTableId(referencingTableId);
						if (created) setSelectedRelationshipId(created.id);
					}
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
			void run(() => workspaceClient.updateRelationship(designIdRef.current!, relationshipId, { required }));
		},
		[run],
	);

	const handleSetRelationshipCardinality = useCallback(
		(relationshipId: string, cardinality: RelationshipCardinality) => {
			void run(() => workspaceClient.updateRelationship(designIdRef.current!, relationshipId, { cardinality }));
		},
		[run],
	);

	const handleRemoveRelationship = useCallback(
		(relationshipId: string) => {
			setSelectedRelationshipId(null);
			void run(() => workspaceClient.removeRelationship(designIdRef.current!, relationshipId));
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
		setPendingRemoval(null);
		setSelectedRelationshipId(null);
		setSelectedColumnId(null);
		if (target.kind === "function") {
			void run(() => workspaceClient.removeFunction({ functionId: target.functionId, confirmed: true, designId: target.designId }));
		} else if (target.kind === "table") {
			setSelectedTableId(null);
			void run(() => workspaceClient.removeTable(target.designId, target.tableId, true));
		} else {
			void run(() => workspaceClient.removeColumn(target.designId, target.tableId, target.columnId, true));
		}
	}, [pendingRemoval, run]);

	const handleAddTable = useCallback((name: string, position: CanvasPoint) => {
		void (async () => {
			setBusy(true);
			setError(null);
			try {
				const next = await workspaceClient.addTable(designIdRef.current!, name, position);
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
				const next = await workspaceClient.addColumn(designIdRef.current!, selectedTableId);
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
			void run(() => workspaceClient.updateColumn(designIdRef.current!, selectedTableId, columnId, changes));
		},
		[run, selectedTableId],
	);

	const handleRemoveColumn = useCallback(
		(columnId: string) => {
			if (!selectedTableId || !state?.activeDesignId) return;
			void requestRemoval({ kind: "column", tableId: selectedTableId, columnId, designId: state.activeDesignId });
		},
		[requestRemoval, selectedTableId, state?.activeDesignId],
	);

	const handleMoveTable = useCallback(
		(tableId: string, position: CanvasPoint) => {
			void applyLayout(() => workspaceClient.moveTable(designIdRef.current!, tableId, position));
		},
		[applyLayout],
	);

	const handleViewportChange = useCallback(
		(viewport: CanvasViewport) => {
			void applyLayout(() => workspaceClient.setViewport(designIdRef.current!, viewport));
		},
		[applyLayout],
	);

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

	if (new URLSearchParams(window.location.search).has("proofReportUrl")) {
		return <main className="h-screen"><ArchitectureProofView /></main>;
	}
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
				onOpenDesign={(id) => run(() => workspaceClient.openDesign(id))}
				onNewDesign={() => setDesignDialog({ mode: "create" })}
				onRenameDesign={() => {
					const active = state.designs.find((design) => design.id === state.activeDesignId);
					if (active) setDesignDialog({ mode: "rename", designId: active.id, name: active.name });
				}}
				onUndo={() => { const designId = designIdRef.current; if (designId) void run(() => workspaceClient.undo(designId)); }}
				onRedo={() => { const designId = designIdRef.current; if (designId) void run(() => workspaceClient.redo(designId)); }}
				view={view}
				onViewChange={setView}
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
					<>
						<div
							className="h-full min-w-0"
							style={{ marginRight: assistantCollapsed ? 40 : assistantWidth }}
						>
						{/*
						 * The canvas stays mounted behind the SQL preview, so its pan, zoom,
						 * and pending layout save survive switching views.
						 */}
						<div className={cn("h-full", view !== "canvas" && "hidden")}>
							<TableCanvas
								key={state.project.id}
								active={view === "canvas"}
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
						</div>
						{view === "sql" && (
							<SqlPreviewView
								key={`${state.project.id}:${state.activeDesignId ?? ""}`}
								design={state.design}
								sql={state.sql}
								sandbox={state.sandbox}
								draftRevision={state.revision}
								validationStatus={getSqlPreviewValidationStatus(state)}
							/>
						)}
						{view === "functions" && (
							<FunctionsView
								key={state.project.id}
								functions={state.design.functions ?? []}
								initialSelectedId={assistantCodeTarget?.kind === "function-body" ? assistantCodeTarget.id : null}
								busy={busy}
								onSave={(functions) => void run(() => workspaceClient.updateFunctions(state.activeDesignId!, functions))}
								onRemove={(functionId) => void requestRemoval({ kind: "function", functionId, designId: state.activeDesignId! })}
							/>
						)}
						{view === "triggers" && (
							<TriggersView
								key={state.project.id}
								triggers={state.design.triggers ?? []}
								tables={state.design.tables}
								functions={state.design.functions ?? []}
								busy={busy}
								onSave={(triggers) => void run(() => workspaceClient.updateTriggers(state.activeDesignId!, triggers))}
								onRemove={(triggerId) =>
									void run(() =>
										workspaceClient.updateTriggers(
											state.activeDesignId!,
											(state.design?.triggers ?? []).filter((trigger) => trigger.id !== triggerId),
										),
									)
								}
							/>
						)}
						{view === "scenarios" && (
							<ScenarioView
								key={`${state.project.id}:${state.activeDesignId}`}
								designId={state.activeDesignId!}
								scenarios={state.scenarios}
								initialSelectedId={assistantCodeTarget?.kind === "scenario" ? assistantCodeTarget.id : null}
								appliedTables={getLastAppliedSandbox(state.sandbox)?.tables ?? []}
								appliedEnums={getLastAppliedSandbox(state.sandbox)?.enumTypes ?? []}
								save={state.scenarioSave}
								appliedFunctions={getLastAppliedSandbox(state.sandbox)?.functions ?? []}
								scenarioRuns={state.scenarioRuns}
								revision={state.revision}
								runDisabledReason={scenarioRunDisabledReason}
								runAllActive={runAllActive}
								runAllResults={runAllResults}
								activeRunId={activeScenarioRun?.id ?? null}
								onRunAll={() => void runAll()}
								onRun={(scenario) => void runSingleScenario(scenario)}
								onStop={stopScenario}
								onCreate={(name) =>
									void applySavedContent(() => workspaceClient.createScenario({ name, designId: state.activeDesignId! }))
								}
								onRename={(scenarioId, name) =>
									void applySavedContent(() =>
										workspaceClient.renameScenario({ scenarioId, name, designId: state.activeDesignId! }),
									)
								}
								onRemove={(scenarioId) =>
									void applySavedContent(() => workspaceClient.removeScenario({ scenarioId, designId: state.activeDesignId! }))
								}
								onUpdateSource={(scenarioId, source) =>
									void applySavedContent(() =>
										workspaceClient.updateScenarioSource({ scenarioId, source, designId: state.activeDesignId! }),
									)
								}
							/>
						)}
						{view === "edge-functions" && (
							<EdgeFunctionsView
								key={`${state.project.id}:${state.activeDesignId}`}
								designId={state.activeDesignId!}
								edgeFunctions={state.edgeFunctions}
								initialSelectedId={assistantCodeTarget?.kind === "edge-function" ? assistantCodeTarget.id : null}
								save={state.edgeFunctionSave}
								appliedTables={getLastAppliedSandbox(state.sandbox)?.tables ?? []}
								appliedEnums={getLastAppliedSandbox(state.sandbox)?.enumTypes ?? []}
								appliedFunctions={getLastAppliedSandbox(state.sandbox)?.functions ?? []}
								onCreate={(name) => void applySavedContent(() => workspaceClient.createEdgeFunction({ name, designId: state.activeDesignId! }))}
								onRename={(edgeFunctionId, name) =>
									void applySavedContent(() => workspaceClient.renameEdgeFunction({ edgeFunctionId, name, designId: state.activeDesignId! }))
								}
								onRemove={(edgeFunctionId) =>
									void applySavedContent(() => workspaceClient.removeEdgeFunction({ edgeFunctionId, designId: state.activeDesignId! }))
								}
								onUpdateSource={(edgeFunctionId, source) =>
									void applySavedContent(() => workspaceClient.updateEdgeFunctionSource({ edgeFunctionId, source, designId: state.activeDesignId! }))
								}
							/>
						)}
						{view === "architecture" && (
							<ArchitectureProofView key={state.project.id} />
						)}
						</div>
					{state.project && (
						<AssistantSidebar
							api={workspaceClient}
							projectId={state.project.id}
							collapsed={assistantCollapsed}
							width={assistantWidth}
							onCollapse={() => setAssistantCollapsed(true)}
							onExpand={() => setAssistantCollapsed(false)}
							onResizeStart={(event) => {
								assistantDragging.current = true;
								event.currentTarget.setPointerCapture(event.pointerId);
							}}
							onSelectTable={(tableId) => { setView("canvas"); handleSelectTable(tableId); }}
							onSelectCodeSource={(kind, id) => {
								setAssistantCodeTarget({ kind, id });
								setView(kind === "scenario" ? "scenarios" : kind === "edge-function" ? "edge-functions" : "functions");
							}}
						/>
					)}
					</>
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
				open={selectedTable !== null && !relating && view === "canvas"}
				modal={false}
				onOpenChange={(open) => {
					if (!open) handleSelectTable(null);
				}}
			>
				<SheetContent
					side="right"
					data-testid="inspector-sheet"
					className="top-[var(--masthead-height)] bottom-0 h-auto w-[440px] gap-0 sm:max-w-[440px]"
					style={{ right: state.project ? (assistantCollapsed ? 40 : assistantWidth) : 0 }}
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
									enumTypes={state.design?.enumTypes ?? []}
									selectedColumnId={selectedColumnId}
									relationships={inspectorRelationships}
									selectedRelationshipId={selectedRelationshipId}
									sql={state.sql}
									busy={busy}
									onRename={(name) =>
										void run(() => workspaceClient.renameTable(state.activeDesignId!, selectedTable.id, name))
									}
									onRemove={() =>
										void requestRemoval({ kind: "table", tableId: selectedTable.id, designId: state.activeDesignId! })
									}
									onSelectColumn={setSelectedColumnId}
									onAddColumn={handleAddColumn}
									onApplyColumn={handleApplyColumn}
									onUpdateIndexes={(indexes) =>
										void run(() => workspaceClient.updateIndexes(state.activeDesignId!, selectedTable.id, indexes))
									}
									onUpdateEnumTypes={(enumTypes) =>
										void run(() => workspaceClient.updateEnumTypes(state.activeDesignId!, enumTypes))
									}
									onUpdateUniqueConstraints={(uniqueConstraints) =>
										void run(() =>
											workspaceClient.updateUniqueConstraints(state.activeDesignId!, selectedTable.id, uniqueConstraints),
										)
									}
									onUpdatePolicies={(rowLevelSecurity, policies) =>
										void run(() => workspaceClient.updatePolicies(state.activeDesignId!, selectedTable.id, rowLevelSecurity, policies))
									}
									onRemoveColumn={handleRemoveColumn}
									onSelectRelationship={handleSelectRelationship}
									onSetRelationshipRequired={handleSetRelationshipRequired}
									onSetRelationshipCardinality={handleSetRelationshipCardinality}
									onSetReferentialAction={(relationshipId, action, value) =>
									void run(() =>
										workspaceClient.updateRelationship(state.activeDesignId!, relationshipId, {
											[action]: value,
										}),
									)
								}
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

			<DesignNameDialog
				dialog={designDialog}
				busy={busy}
				onSubmit={(name) => {
					const current = designDialog;
					setDesignDialog(null);
					if (!current) return;
					if (current.mode === "create") void run(() => workspaceClient.createDesign(name));
					else void run(() => workspaceClient.renameDesign(current.designId, name));
				}}
				onCancel={() => setDesignDialog(null)}
			/>
		</main>
	);
}

/**
 * The page head: which design is open, how its saved and validated state
 * stands, and the switch between the canvas and the SQL preview. A double rule
 * closes it.
 */
export function Masthead({
	state,
	busy,
	onOpenProject,
	onNewProject,
	onOpenDesign,
	onNewDesign,
	onRenameDesign,
	onUndo,
	onRedo,
	view,
	onViewChange,
}: {
	state: WorkspaceState;
	busy: boolean;
	onOpenProject: (projectId: string) => void;
	onNewProject: () => void;
	onOpenDesign: (designId: string) => void;
	onNewDesign: () => void;
	onRenameDesign: () => void;
	onUndo: () => void;
	onRedo: () => void;
	view: WorkspaceView;
	onViewChange: (view: WorkspaceView) => void;
}) {
	const project = state.project;
	return (
		<header
			className="double-rule flex shrink-0 flex-wrap items-center justify-between gap-x-2 sm:gap-x-3 lg:gap-x-4 gap-y-1 bg-paper px-3 sm:px-4 lg:px-6 py-1 md:py-0"
			style={{ minHeight: "var(--masthead-height)" }}
		>
			<div className="flex min-w-0 items-center gap-1.5 sm:gap-2 md:gap-2.5 order-1">
				<p className="kicker hidden shrink-0 leading-tight text-ink-2! md:block">
					Schema
					<br />
					Designer
				</p>
				<span className="hidden h-7 w-px bg-rule md:block" aria-hidden="true" />
				<DropdownMenu>
					<h1 className="min-w-0">
						<DropdownMenuTrigger
							disabled={busy}
							className="group flex max-w-full min-w-0 items-baseline gap-1.5 rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-pencil/30"
						>
							<span
								className={cn(
									"truncate font-display text-[18px] sm:text-[20px] md:text-[21px] xl:text-[24px] leading-none font-medium tracking-[-0.015em]",
									project ? "text-ink" : "text-ink-3 italic",
								)}
							>
								{project?.name ?? "No project open"}
							</span>
							<ChevronDown className="size-3.5 shrink-0 self-center text-ink-3 group-hover:text-ink" />
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
					<>
						<span className="hidden h-7 w-px bg-rule md:block" aria-hidden="true" />
						<DropdownMenu>
							<DropdownMenuTrigger
								disabled={busy}
								data-testid="design-switcher"
								className="group flex max-w-[14rem] min-w-0 items-baseline gap-1.5 rounded-sm px-1 outline-none focus-visible:ring-2 focus-visible:ring-pencil/30"
							>
								<span className="kicker hidden shrink-0 text-ink-3! sm:inline">Design</span>
								<span className="truncate font-mono text-[12px] text-ink-2" data-testid="active-design-name">
									{designLabel(state.designs, state.activeDesignId ?? null)}
								</span>
								<ChevronDown className="size-3 shrink-0 self-center text-ink-3 group-hover:text-ink" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="w-64">
								<DropdownMenuLabel className="flex items-center justify-between">
									<span className="kicker">Designs</span>
									<span className="figures font-mono text-[10px] text-ink-4" data-testid="design-count">
										{state.designs.length} in project
									</span>
								</DropdownMenuLabel>
								<div data-testid="design-list">
									{state.designs.map((candidate, index) => {
										const active = candidate.id === state.activeDesignId;
										return (
											<DropdownMenuItem
												key={candidate.id}
												data-testid="design-option"
												aria-current={active ? "true" : undefined}
												disabled={active}
												onSelect={() => onOpenDesign(candidate.id)}
												className="justify-between font-display text-[15px] data-[disabled]:opacity-100"
											>
												<span className="truncate">{designDisplayName(candidate, index)}</span>
												{active && <span className="kicker text-pencil!">open</span>}
											</DropdownMenuItem>
										);
									})}
								</div>
								<DropdownMenuSeparator />
								<DropdownMenuItem onSelect={onNewDesign}>
									<Plus />
									New design…
								</DropdownMenuItem>
								<DropdownMenuItem onSelect={onRenameDesign}>Rename current design…</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				)}
				{project && (
					<span className="figures hidden shrink-0 font-mono text-[11px] text-ink-3 md:inline" data-testid="schema-revision">
						rev. {state.revision}
					</span>
				)}
				{project && (
					<span className="flex shrink-0 items-center">
						<Button
							variant="ghost"
							size="icon-sm"
							data-testid="undo-button"
							aria-label={state.undoActionName ? `Undo ${state.undoActionName}` : "Undo"}
							title={state.undoActionName ? `Undo ${state.undoActionName}` : "Nothing to undo"}
							disabled={busy || !state.undoRedo.canUndo}
							onClick={onUndo}
						>
							<Undo2 />
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							data-testid="redo-button"
							aria-label={state.redoActionName ? `Redo ${state.redoActionName}` : "Redo"}
							title={state.redoActionName ? `Redo ${state.redoActionName}` : "Nothing to redo"}
							disabled={busy || !state.undoRedo.canRedo}
							onClick={onRedo}
						>
							<Redo2 />
						</Button>
					</span>
				)}
			</div>

			{project && (
				<dl
					className="order-3 2xl:order-2 w-full 2xl:w-auto flex items-center gap-2 sm:gap-2.5 lg:gap-3 2xl:gap-5 py-0.5 2xl:py-0 border-t border-rule/30 2xl:border-0"
					data-testid="status-line"
				>
					<StatusLine label="Saved">
						<SaveStatus save={state.save} />
					</StatusLine>
					<span className="h-3 w-px bg-rule 2xl:hidden" aria-hidden="true" />
					<StatusLine label="Sandbox">
						<SandboxStatus sandbox={state.sandbox} draftRevision={state.revision} />
					</StatusLine>
					<span className="h-3 w-px bg-rule 2xl:hidden" aria-hidden="true" />
					<StatusLine label="SQL">
						<SqlStatus
							sql={state.sql}
							validationStatus={getSqlPreviewValidationStatus(state)}
						/>
					</StatusLine>
					<span className="h-3 w-px bg-rule md:hidden" aria-hidden="true" />
					<span className="figures font-mono text-[11px] text-ink-3 md:hidden">
						rev. {state.revision}
					</span>
				</dl>
			)}

			<div className="flex shrink-0 items-center order-2">
				<ToggleGroup
					type="single"
					variant="outline"
					size="sm"
					spacing={0}
					aria-label="View"
					data-testid="view-switch"
					value={project ? view : ""}
					disabled={!project}
					onValueChange={(next) => {
						if (
							next === "canvas" ||
							next === "sql" ||
							next === "scenarios" ||
							next === "edge-functions" ||
							next === "functions" ||
							next === "triggers" ||
							next === "architecture"
						)
							onViewChange(next);
					}}
					className="shrink-0"
				>
					<ToggleGroupItem
						value="canvas"
						data-testid="view-canvas"
						title="Canvas"
						aria-label="Canvas"
						className="h-7 px-2.5 xl:px-3"
					>
						<PenTool className="size-3.5 shrink-0" />
						<span className="hidden xl:inline">Canvas</span>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="sql"
						data-testid="view-sql"
						title="SQL preview"
						aria-label="SQL preview"
						className="h-7 px-2.5 xl:px-3"
					>
						<FileCode2 className="size-3.5 shrink-0" />
						<span className="hidden xl:inline">SQL preview</span>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="scenarios"
						data-testid="view-scenarios"
						title="Scenarios"
						aria-label="Scenarios"
						className="h-7 px-2.5 xl:px-3"
					>
						<ScrollText className="size-3.5 shrink-0" />
						<span className="hidden xl:inline">Scenarios</span>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="edge-functions"
						data-testid="view-edge-functions"
						title="Edge functions"
						aria-label="Edge functions"
						className="h-7 px-2.5 xl:px-3"
					>
						<Server className="size-3.5 shrink-0" />
						<span className="hidden xl:inline">Edge functions</span>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="functions"
						data-testid="view-functions"
						title="Functions"
						aria-label="Functions"
						className="h-7 px-2.5 xl:px-3"
					>
						<Braces className="size-3.5 shrink-0" />
						<span className="hidden xl:inline">Functions</span>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="triggers"
						data-testid="view-triggers"
						title="Triggers"
						aria-label="Triggers"
						className="h-7 px-2.5 xl:px-3"
					>
						<Zap className="size-3.5 shrink-0" />
						<span className="hidden xl:inline">Triggers</span>
					</ToggleGroupItem>
					<ToggleGroupItem
						value="architecture"
						data-testid="view-canvas-proof"
						title="Canvas Proof (Technical Fixture)"
						aria-label="Canvas Proof (Technical Fixture)"
						className="h-7 px-2.5 xl:px-3 text-pencil font-medium"
					>
						<Network className="size-3.5 shrink-0 text-pencil" />
						<span className="hidden xl:inline">Canvas Proof</span>
					</ToggleGroupItem>
				</ToggleGroup>
			</div>
		</header>
	);
}

function StatusLine({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-row 2xl:flex-col items-center 2xl:items-start gap-1 2xl:gap-0.5">
			<dt className="kicker text-[9.5px]! text-ink-4! hidden 2xl:block">{label}</dt>
			<dd className="flex items-center gap-1.5 text-[11px] 2xl:text-[12px] leading-none">{children}</dd>
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
				<span
					className="figures font-mono text-[11px] text-ink-2"
					title={`Saved at ${new Date(save.savedAt).toLocaleTimeString()}`}
				>
					Saved
					<span className="hidden 2xl:inline text-ink-3 ml-1">
						{new Date(save.savedAt).toLocaleTimeString()}
					</span>
				</span>
			)}
			{save.status === "saving" && <span className="text-ink-3 italic text-[11px]">Saving…</span>}
			{save.status === "idle" && <span className="text-ink-3 text-[11px]">Not saved</span>}
			{save.status === "failed" && (
				<span
					className="inline-block max-w-48 sm:max-w-56 md:max-w-64 truncate text-proof-red text-[11px] font-medium align-bottom"
					data-testid="save-error"
					title={save.error}
				>
					Save failed{save.error ? ` — ${save.error}` : ""}
				</span>
			)}
		</span>
	);
}

/**
 * The sandbox line separates a result for the current draft from an older
 * one: an accepted revision that is not the draft reads as out of date.
 */
function SandboxStatus({
	sandbox,
	draftRevision,
}: {
	sandbox: SandboxState;
	draftRevision: number;
}) {
	if (sandbox.status === "applied") {
		const current = sandbox.revision === draftRevision;
		return (
			<span
				className="flex items-center gap-1.5"
				title={current ? `Sandbox accepted at revision ${sandbox.revision}` : `Sandbox out of date (revision ${sandbox.revision}, draft is ${draftRevision})`}
			>
				<Mark tone={current ? "ok" : "warn"} />
				<span className={cn("text-[11px]", current ? "text-ink-2" : "text-ochre")}>
					{current ? "Accepted" : "Out of date"}{" "}
					<span className="figures font-mono text-ink-3">rev. {sandbox.revision}</span>
				</span>
			</span>
		);
	}
	if (sandbox.status === "failed") {
		return (
			<span
				className="flex items-center gap-1.5"
				title={sandbox.error}
			>
				<Mark tone="bad" />
				<span className="text-proof-red text-[11px]" title={sandbox.error}>
					{sandbox.failure === "sql-rejected" ? "Rejected" : "Sandbox error"}{" "}
					<span className="figures font-mono text-[11px]">rev. {sandbox.revision}</span>
				</span>
			</span>
		);
	}
	if (sandbox.status === "applying") {
		return (
			<span className="flex items-center gap-1.5" title="Rebuilding sandbox…">
				<Mark tone="warn" />
				<span className="text-ink-3 italic text-[11px]">Rebuilding…</span>
			</span>
		);
	}
	return (
		<span className="flex items-center gap-1.5" title="Sandbox not run">
			<Mark tone="muted" />
			<span className="text-ink-3 text-[11px]">Not run</span>
		</span>
	);
}

function SqlStatus({
	sql,
	validationStatus,
}: {
	sql: SqlState;
	validationStatus: SqlPreviewValidationStatus | null;
}) {
	const status = sqlStatusLine(sql, validationStatus);
	const errors = getSqlValidationErrors(sql);
	const errorText = errors.length > 0 ? errors.join("; ") : undefined;
	return (
		<span
			className="flex items-center gap-1.5"
			title={errorText ?? `SQL preview: ${status.label}`}
		>
			<Mark tone={status.tone} />
			<span
				className={cn(
					"text-[11px]",
					status.tone === "ok" && "text-ink-2",
					status.tone === "warn" && "text-ochre",
					status.tone === "bad" && "text-proof-red",
					status.tone === "muted" && "text-ink-3",
				)}
			>
				{status.label}
			</span>
		</span>
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

/** The Design shown in the switcher and listed in its menu. */
function designDisplayName(design: { name: string }, index: number): string {
	return design.name.trim() || `Design ${index + 1}`;
}

function designLabel(designs: { id: string; name: string }[], activeDesignId: string | null): string {
	const index = designs.findIndex((design) => design.id === activeDesignId);
	if (index < 0) return "None";
	return designDisplayName(designs[index]!, index);
}

type DesignDialogState = { mode: "create" } | { mode: "rename"; designId: string; name: string };

/** Names a new Design, or renames the current one. Names are unique within the Project. */
function DesignNameDialog({
	dialog,
	busy,
	onSubmit,
	onCancel,
}: {
	dialog: DesignDialogState | null;
	busy: boolean;
	onSubmit: (name: string) => void;
	onCancel: () => void;
}) {
	const [name, setName] = useState("");
	useEffect(() => {
		if (dialog) setName(dialog.mode === "rename" ? dialog.name : "");
	}, [dialog]);
	const creating = dialog?.mode !== "rename";
	return (
		<Dialog open={dialog !== null} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent className="sm:max-w-sm">
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (name.trim().length === 0) return;
						onSubmit(name.trim());
					}}
					className="flex flex-col gap-4"
				>
					<DialogHeader>
						<p className="kicker">{creating ? "New design" : "Rename design"}</p>
						<DialogTitle>{creating ? "Name the design" : "Rename this design"}</DialogTitle>
						<DialogDescription>
							Each design is its own database, with its own schema, Scenarios, and Edge functions.
						</DialogDescription>
					</DialogHeader>
					<Input
						autoFocus
						value={name}
						onChange={(event) => setName(event.target.value)}
						aria-label="Design name"
						placeholder="Orders"
					/>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onCancel}>
							Cancel
						</Button>
						<Button type="submit" disabled={busy || name.trim().length === 0}>
							{creating ? "Create design" : "Save name"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
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
							A project starts with one design; you can add more later, each saved automatically.
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
								{plan.relationships.length + plan.indexes.length + plan.uniqueConstraints.length + plan.triggers.length === 0
									? "No schema objects depend on it."
									: "The listed relationships, indexes, constraints, and triggers will be adjusted or removed with this change."}
							</DialogDescription>
						</DialogHeader>
						{plan.relationships.length + plan.indexes.length + plan.uniqueConstraints.length + plan.triggers.length > 0 && (
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
											{relationship.cardinality === "many-to-many"
												? `${relationship.referencingTable} ↔ ${relationship.referencedTable} via ${relationship.junctionTable ?? "(missing junction)"}`
													: `${relationship.referencingTable}.${relationship.referencingColumn} → ${relationship.referencedTable}.` +
													(relationship.referencedColumn ?? "(no primary key)")}
										</span>
										<span className="kicker shrink-0">
											{relationship.cardinality === "many-to-many"
												? "2 foreign keys + unique pair"
												: relationship.constraints
														.map((constraint) =>
															constraint === "unique" ? "unique" : "foreign key",
														)
														.join(" + ")}
										</span>
									</li>
								))}
								{plan.indexes.map((index) => (
								<li
									key={index.indexId}
									data-testid="affected-index"
									className="flex items-baseline justify-between gap-3 border-t border-rule-soft py-2 font-mono text-[11.5px] text-ink-2"
								>
										<span>{index.table}.{index.name}</span>
									<span className="kicker">
										{index.removedKeys > 0
											? `${index.removedKeys} key${index.removedKeys === 1 ? "" : "s"}`
											: ""}
										{index.removedKeys > 0 && index.removedIncludes > 0 ? " + " : ""}
										{index.removedIncludes > 0
											? `${index.removedIncludes} INCLUDE`
											: ""}
									</span>
									</li>
								))}
								{plan.uniqueConstraints.map((constraint) => (
									<li
										key={constraint.constraintId}
										data-testid="affected-unique-constraint"
										className="border-t border-rule-soft py-2 font-mono text-[11.5px] text-ink-2"
									>
										{constraint.table}.{constraint.name}
									</li>
								))}
								{plan.triggers.map((trigger: AffectedTrigger) => (
									<li key={trigger.triggerId} data-testid="affected-trigger" className="border-t border-rule-soft py-2 font-mono text-[11.5px] text-ink-2">
										{trigger.table}.{trigger.name}
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

export default App;
