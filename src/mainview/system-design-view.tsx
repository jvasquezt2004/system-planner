import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Link2, Minus, Plus, Trash2, X } from "lucide-react";
import type { CanvasPoint, CanvasViewport, WorkspaceState } from "../shared/design";
import {
	DEFAULT_SYSTEM_CONNECTION_LABEL,
	SYSTEM_COMPONENT_KINDS,
	SYSTEM_COMPONENT_SIZE,
	describeSystemComponentRemoval,
	openSpotNear,
	findSystemComponent,
	findSystemConnection,
	type SystemComponent,
	type SystemComponentKind,
	type SystemComponentRemovalPlan,
	type SystemConnection,
	type SystemDesign,
} from "../shared/system-design";
import type { workspaceClient } from "./workspace-client";
import { selectedWalkthroughHighlight } from "../shared/walkthrough";
import { WalkthroughEditor, type WalkthroughSelection } from "./walkthrough-editor";
import {
	connectionGeometries,
	labelWidth,
	movedBeyondThreshold,
	screenToWorld,
	truncateLabel,
	zoomAroundPoint,
} from "./system-design-geometry";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Client = typeof workspaceClient;
type Selection = { kind: "component"; id: string } | { kind: "connection"; id: string } | null;
type Drag = {
	componentId: string;
	pointerStart: CanvasPoint;
	originWorld: CanvasPoint;
	current: CanvasPoint;
	moved: boolean;
};
type Pan = { pointerStart: CanvasPoint; viewportStart: CanvasViewport; moved: boolean };

const KIND_LABELS: Record<SystemComponentKind, string> = {
	generic: "Component",
	database: "Database",
};

const SAVE_DEBOUNCE_MS = 400;
const ARROW_ID = "system-design-arrow";

export type SystemDesignViewProps = {
	state: WorkspaceState;
	client: Client;
	/** Runs a content action: busy state, error reporting, and state replacement. */
	onApply: (action: () => Promise<WorkspaceState>) => void;
	/** Runs a navigation or layout save without the busy state. */
	onLayout: (action: () => Promise<WorkspaceState>) => void;
	onOpenDatabase: () => void;
};

/**
 * The architecture overview: generic Components and directed, labeled
 * Connections of the Project's System design. Pan, zoom, and drag change the
 * view or one Component; every edit goes through the workspace so it is saved,
 * undoable, and visible to the Assistant the same way.
 */
export function SystemDesignView({ state, client, onApply, onLayout, onOpenDatabase }: SystemDesignViewProps) {
	const design = state.systemDesign ?? null;
	const containerRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState<CanvasViewport>(design?.viewport ?? { x: 0, y: 0, zoom: 1 });
	const [selection, setSelection] = useState<Selection>(null);
	const [connectingFrom, setConnectingFrom] = useState<string | null | undefined>(undefined);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<SystemComponentRemovalPlan | null>(null);
	const [walkthroughsOpen, setWalkthroughsOpen] = useState(false);
	const [walkthroughSelection, setWalkthroughSelection] = useState<WalkthroughSelection | null>(null);
	const pan = useRef<Pan | null>(null);
	const interacting = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const latestViewport = useRef(viewport);
	/** Updates the viewport at once, so back-to-back wheel events build on each other. */
	function setLocalViewport(next: CanvasViewport) {
		latestViewport.current = next;
		setViewport(next);
	}

	// Server state replaces the local viewport only when no pan or zoom is in progress.
	useEffect(() => {
		if (!interacting.current && design) setLocalViewport(design.viewport);
	}, [design?.viewport]);

	useEffect(() => () => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
	}, []);

	const positions = useMemo(() => {
		if (!drag) return undefined;
		return new Map([[drag.componentId, drag.current]]);
	}, [drag]);
	const geometries = useMemo(() => (design ? connectionGeometries(design, positions) : []), [design, positions]);

	if (!design) {
		return (
			<div className="flex h-full items-center justify-center text-ink-3">
				<p className="font-display italic text-[17px]">Opening the system overview…</p>
			</div>
		);
	}

	const selectedComponent = selection?.kind === "component" ? findSystemComponent(design, selection.id) ?? null : null;
	const selectedConnection = selection?.kind === "connection" ? findSystemConnection(design, selection.id) ?? null : null;
	/** The open walkthrough step's Connection and endpoints, traced in the architecture. */
	const highlight = walkthroughSelection?.stepId
		? selectedWalkthroughHighlight(state.walkthroughs ?? [], design, walkthroughSelection.walkthroughId, walkthroughSelection.stepId)
		: null;

	function scheduleViewportSave(next: CanvasViewport) {
		interacting.current = true;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			saveTimer.current = null;
			interacting.current = false;
			const current = latestViewport.current;
			onLayout(() => client.setSystemViewport(current));
		}, SAVE_DEBOUNCE_MS);
		setLocalViewport(next);
	}

	function pointerInContainer(event: { clientX: number; clientY: number }): CanvasPoint {
		const rect = containerRef.current?.getBoundingClientRect();
		return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
	}

	function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
		const point = pointerInContainer(event);
		const factor = Math.exp(-event.deltaY * 0.0015);
		scheduleViewportSave(zoomAroundPoint(latestViewport.current, point, latestViewport.current.zoom * factor));
	}

	function handleBackgroundPointerDown(event: React.PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		pan.current = {
			pointerStart: pointerInContainer(event),
			viewportStart: latestViewport.current,
			moved: false,
		};
		interacting.current = true;
	}

	function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
		const point = pointerInContainer(event);
		if (drag) {
			const zoom = latestViewport.current.zoom;
			const dx = (point.x - drag.pointerStart.x) / zoom;
			const dy = (point.y - drag.pointerStart.y) / zoom;
			const current = { x: Math.round(drag.originWorld.x + dx), y: Math.round(drag.originWorld.y + dy) };
			const moved = drag.moved || movedBeyondThreshold(drag.pointerStart, point);
			setDrag({ ...drag, current, moved });
			return;
		}
		const active = pan.current;
		if (active) {
			const moved = active.moved || movedBeyondThreshold(active.pointerStart, point);
			pan.current = { ...active, moved };
			if (!moved) return;
			setLocalViewport({
				...active.viewportStart,
				x: active.viewportStart.x + (point.x - active.pointerStart.x),
				y: active.viewportStart.y + (point.y - active.pointerStart.y),
			});
		}
	}

	function handlePointerUp() {
		if (drag) {
			const finished = drag;
			setDrag(null);
			if (finished.moved) {
				onApply(() => client.moveSystemComponent(finished.componentId, finished.current));
			}
		}
		const active = pan.current;
		pan.current = null;
		if (active?.moved) {
			scheduleViewportSave(latestViewport.current);
		} else if (active) {
			interacting.current = false;
			handleBackgroundClick();
		}
	}

	function handleComponentPointerDown(event: React.PointerEvent<SVGGElement>, component: SystemComponent) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		setDrag({
			componentId: component.id,
			pointerStart: pointerInContainer(event),
			originWorld: component.position,
			current: component.position,
			moved: false,
		});
	}

	function handleComponentClick(component: SystemComponent) {
		if (connectingFrom !== undefined) {
			connectComponent(component.id);
			return;
		}
		setSelection({ kind: "component", id: component.id });
	}

	function connectComponent(componentId: string) {
		if (connectingFrom === undefined) return;
		if (connectingFrom === null) {
			setConnectingFrom(componentId);
			return;
		}
		if (connectingFrom === componentId) {
			setConnectingFrom(null);
			return;
		}
		const id = crypto.randomUUID();
		const sourceId = connectingFrom;
		setConnectingFrom(undefined);
		setSelection({ kind: "connection", id });
		onApply(() => client.addSystemConnection({ id, sourceId, targetId: componentId, label: DEFAULT_SYSTEM_CONNECTION_LABEL }));
	}

	function addComponent() {
		const rect = containerRef.current?.getBoundingClientRect();
		const center = screenToWorld(
			{ x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 },
			latestViewport.current,
		);
		const spot = openSpotNear(design!, center);
		const id = crypto.randomUUID();
		setSelection({ kind: "component", id });
		onApply(() => client.addSystemComponent({ id, kind: "generic", x: spot.x, y: spot.y }));
	}

	function confirmComponentRemoval() {
		if (!pendingRemoval) return;
		const componentId = pendingRemoval.componentId;
		setPendingRemoval(null);
		setSelection(null);
		onApply(() => client.removeSystemComponent(componentId));
	}

	/** Lists what the removal deletes from the displayed design; the workspace checks again on confirm. */
	function openRemoval(componentId: string) {
		setPendingRemoval(describeSystemComponentRemoval(design!, componentId));
	}

	function handleBackgroundClick() {
		if (connectingFrom !== undefined) setConnectingFrom(undefined);
		setSelection(null);
	}

	function zoomBy(factor: number) {
		const rect = containerRef.current?.getBoundingClientRect();
		const center = { x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 };
		scheduleViewportSave(zoomAroundPoint(latestViewport.current, center, latestViewport.current.zoom * factor));
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
		if (isEditingText(event.target)) return;
		if (event.key === "Escape") {
			setConnectingFrom(undefined);
			setSelection(null);
			return;
		}
		if ((event.key === "Delete" || event.key === "Backspace") && selection) {
			event.preventDefault();
			if (selection.kind === "connection") {
				const id = selection.id;
				setSelection(null);
				onApply(() => client.removeSystemConnection(id));
			} else {
				openRemoval(selection.id);
			}
		}
	}

	const hasComponents = design.components.length > 0;

	return (
		<div className="relative flex h-full min-h-0 min-w-0 overflow-hidden">
			{walkthroughsOpen && (
				<WalkthroughEditor
					walkthroughs={state.walkthroughs ?? []}
					design={design}
					save={state.walkthroughSave}
					client={client}
					onApply={onApply}
					selection={walkthroughSelection}
					onSelect={setWalkthroughSelection}
					onClose={() => {
						setWalkthroughsOpen(false);
						setWalkthroughSelection(null);
					}}
				/>
			)}
			<div
				ref={containerRef}
				data-testid="system-design-canvas"
				tabIndex={0}
				onKeyDown={handleKeyDown}
				onWheel={handleWheel}
				onPointerDown={handleBackgroundPointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				className={cn(
					"relative min-w-0 flex-1 overflow-hidden bg-[#fcfbf7] outline-none",
					connectingFrom !== undefined ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
				)}
				style={{
					backgroundImage: "radial-gradient(var(--color-ink) 0.75px, transparent 0.75px)",
					backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
					backgroundPosition: `${viewport.x}px ${viewport.y}px`,
				}}
			>
				<svg
					aria-label="System overview"
					role="img"
					className="absolute inset-0 h-full w-full select-none"
				>
					<defs>
						<marker id={ARROW_ID} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
							<path d="M 0 1.5 L 9 5 L 0 8.5 z" style={{ fill: "var(--color-ink-2)" }} />
						</marker>
					</defs>
					<g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
						{geometries.map(({ connection, pathString, labelPoint }) => {
							const selected = selection?.kind === "connection" && selection.id === connection.id;
							const traced = highlight?.connectionId === connection.id;
							const width = labelWidth(connection.label);
							return (
								<g key={connection.id} data-connection-id={connection.id}>
									<path
										d={pathString}
										fill="none"
										stroke="transparent"
										strokeWidth={18}
										pointerEvents="stroke"
										onPointerDown={(event) => event.stopPropagation()}
										onClick={(event) => {
											event.stopPropagation();
											setSelection({ kind: "connection", id: connection.id });
										}}
									>
										<title>{connection.label}</title>
									</path>
									<path
										d={pathString}
										fill="none"
										strokeWidth={selected || traced ? 2.25 : 1.5}
										markerEnd={`url(#${ARROW_ID})`}
										pointerEvents="none"
										style={{ stroke: selected || traced ? "var(--color-pencil)" : "var(--color-ink-2)" }}
									/>
									<g
										transform={`translate(${labelPoint.x} ${labelPoint.y})`}
										pointerEvents="all"
										onPointerDown={(event) => event.stopPropagation()}
										onClick={(event) => {
											event.stopPropagation();
											setSelection({ kind: "connection", id: connection.id });
										}}
										className="cursor-pointer"
									>
										<rect
											x={-width / 2}
											y={-11}
											width={width}
											height={22}
											rx={11}
											style={{
												fill: "var(--color-paper-raised)",
												stroke: selected || traced ? "var(--color-pencil)" : "var(--color-rule-strong)",
											}}
										/>
										<text textAnchor="middle" dominantBaseline="central" fontSize={11.5} style={{ fill: "var(--color-ink)" }}>
											{truncateLabel(connection.label, 26)}
										</text>
									</g>
								</g>
							);
						})}
						{design.components.map((component) => {
							const position = drag?.componentId === component.id ? drag.current : component.position;
							const selected = selection?.kind === "component" && selection.id === component.id;
							const linking = connectingFrom === component.id;
							const traced = highlight?.componentIds.includes(component.id) ?? false;
							const detail = component.technology ?? component.description ?? "";
							return (
								<g
									key={component.id}
									data-component-id={component.id}
									data-kind={component.kind}
									transform={`translate(${position.x} ${position.y})`}
									role="button"
									tabIndex={0}
									aria-label={`${KIND_LABELS[component.kind]}: ${component.name}`}
									aria-pressed={selected}
									className="cursor-pointer"
									onPointerDown={(event) => handleComponentPointerDown(event, component)}
									onClick={(event) => {
										event.stopPropagation();
										handleComponentClick(component);
									}}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											handleComponentClick(component);
										}
									}}
								>
									<title>{component.name}</title>
									<rect
										width={SYSTEM_COMPONENT_SIZE.width}
										height={SYSTEM_COMPONENT_SIZE.height}
										rx={10}
										style={{
											fill: "var(--color-paper-raised)",
											stroke: selected || linking || traced ? "var(--color-pencil)" : "var(--color-rule-strong)",
										}}
										strokeWidth={selected || linking || traced ? 2 : 1.25}
									/>
									<text x={14} y={22} fontSize={10} letterSpacing={1.1} style={{ fill: "var(--color-ink-3)" }}>
										{KIND_LABELS[component.kind].toUpperCase()}
									</text>
									<text x={14} y={44} fontSize={15} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
										{truncateLabel(component.name, 22)}
									</text>
									<text x={14} y={64} fontSize={11.5} style={{ fill: "var(--color-ink-2)" }}>
										{truncateLabel(detail, 28)}
									</text>
									{component.kind === "database" && component.designId && (
										<text x={SYSTEM_COMPONENT_SIZE.width - 14} y={22} textAnchor="end" fontSize={10} style={{ fill: "var(--color-pencil)" }}>
											LINKED
										</text>
									)}
								</g>
							);
						})}
					</g>
				</svg>

				{!hasComponents && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
						<div className="max-w-sm">
							<p className="font-display text-[20px] italic text-ink-2">Sketch the system</p>
							<p className="mt-2 text-[13px] text-ink-3">
								Add components, then connect them with labeled interactions. Each connection describes one way the parts talk.
							</p>
						</div>
					</div>
				)}

				<div className="absolute left-4 top-4 flex flex-wrap items-center gap-1.5 rounded-md border border-rule-soft bg-paper-raised/95 p-1.5 shadow-xs">
					<Button type="button" size="sm" variant="outline" onClick={addComponent}>
						<Plus className="size-3.5" />
						Add component
					</Button>
					<Button
						type="button"
						size="sm"
						variant={connectingFrom !== undefined ? "pencil" : "outline"}
						aria-pressed={connectingFrom !== undefined}
						onClick={() => setConnectingFrom(connectingFrom === undefined ? null : undefined)}
						disabled={design.components.length < 2}
					>
						<Link2 className="size-3.5" />
						{connectingFrom === undefined ? "Connect" : connectingFrom === null ? "Choose source" : "Choose target"}
					</Button>
					<Button
						type="button"
						size="sm"
						variant={walkthroughsOpen ? "pencil" : "outline"}
						aria-pressed={walkthroughsOpen}
						onClick={() => setWalkthroughsOpen((open) => !open)}
					>
						Walkthroughs
					</Button>
					<span className="mx-1 h-5 w-px bg-rule-soft" aria-hidden="true" />
					<Button type="button" size="icon" variant="ghost" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} className="size-7">
						<Minus className="size-3.5" />
					</Button>
					<span className="min-w-10 text-center text-[11.5px] tabular-nums text-ink-3" data-testid="system-zoom">
						{Math.round(viewport.zoom * 100)}%
					</span>
					<Button type="button" size="icon" variant="ghost" aria-label="Zoom in" onClick={() => zoomBy(1.2)} className="size-7">
						<Plus className="size-3.5" />
					</Button>
				</div>

				<SaveLine save={state.systemSave} />

				{connectingFrom !== undefined && (
					<p className="absolute bottom-4 left-4 rounded-md bg-paper-raised/95 px-3 py-1.5 text-[12px] text-ink-2 shadow-xs">
						{connectingFrom === null
							? "Choose the component where the interaction starts. Press Escape to cancel."
							: "Choose the component the interaction reaches. Press Escape to cancel."}
					</p>
				)}
			</div>

			{(selectedComponent || selectedConnection) && (
				<aside
					aria-label="Selection"
					className="absolute right-4 top-4 bottom-4 flex w-[300px] max-w-[calc(100%-2rem)] flex-col overflow-y-auto rounded-md border border-rule-soft bg-paper-raised p-4 shadow-sm"
				>
					{selectedComponent && (
						<ComponentInspector
							key={selectedComponent.id}
							component={selectedComponent}
							design={design}
							onClose={() => setSelection(null)}
							onApply={onApply}
							client={client}
							onSelectConnection={(id) => setSelection({ kind: "connection", id })}
							onRequestRemove={() => openRemoval(selectedComponent.id)}
							onOpenDatabase={onOpenDatabase}
						/>
					)}
					{selectedConnection && (
						<ConnectionInspector
							key={selectedConnection.id}
							connection={selectedConnection}
							design={design}
							onClose={() => setSelection(null)}
							onApply={onApply}
							client={client}
							onRemove={() => {
								const id = selectedConnection.id;
								setSelection(null);
								onApply(() => client.removeSystemConnection(id));
							}}
						/>
					)}
				</aside>
			)}

			<Dialog open={pendingRemoval !== null} onOpenChange={(open) => !open && setPendingRemoval(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove “{pendingRemoval?.componentName}”?</DialogTitle>
						<DialogDescription>
							{pendingRemoval && pendingRemoval.connections.length > 0
								? `This also removes ${pendingRemoval.connections.length} connection${pendingRemoval.connections.length === 1 ? "" : "s"}:`
								: "No connections use this component."}
						</DialogDescription>
					</DialogHeader>
					{pendingRemoval && pendingRemoval.connections.length > 0 && (
						<ul className="max-h-48 space-y-1 overflow-y-auto text-[13px] text-ink-2">
							{pendingRemoval.connections.map((connection) => (
								<li key={connection.id} className="rounded-sm bg-paper-tint px-2 py-1">
									{connection.label}
								</li>
							))}
						</ul>
					)}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setPendingRemoval(null)}>Cancel</Button>
						<Button type="button" variant="destructive" onClick={confirmComponentRemoval}>
							Remove component
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function isEditingText(target: EventTarget): boolean {
	return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function SaveLine({ save }: { save: WorkspaceState["systemSave"] }) {
	if (!save) return null;
	if (save.status === "failed") {
		return (
			<p role="alert" className="absolute bottom-4 right-4 max-w-[60%] rounded-md bg-proof-red-wash px-3 py-1.5 text-[12px] text-proof-red">
				Save failed: {save.error}
			</p>
		);
	}
	return (
		<p className="absolute bottom-4 right-4 text-[11.5px] text-ink-3" aria-live="polite">
			{save.status === "saving" ? "Saving…" : save.status === "saved" ? "Saved" : ""}
		</p>
	);
}

function ComponentInspector({
	component,
	design,
	client,
	onApply,
	onClose,
	onSelectConnection,
	onRequestRemove,
	onOpenDatabase,
}: {
	component: SystemComponent;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onClose: () => void;
	onSelectConnection: (id: string) => void;
	onRequestRemove: () => void;
	onOpenDatabase: () => void;
}) {
	const [name, setName] = useState(component.name);
	const [technology, setTechnology] = useState(component.technology ?? "");
	const [description, setDescription] = useState(component.description ?? "");
	const [properties, setProperties] = useState(component.properties);
	const related = design.connections.filter((connection) => connection.sourceId === component.id || connection.targetId === component.id);

	function commitName() {
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			setName(component.name);
			return;
		}
		if (trimmed !== component.name) onApply(() => client.updateSystemComponent(component.id, { name: trimmed }));
	}
	function commitDetails() {
		const changes = {
			technology: technology.trim() || undefined,
			description: description.trim() || undefined,
		};
		if ((changes.technology ?? "") === (component.technology ?? "") && (changes.description ?? "") === (component.description ?? "")) return;
		onApply(() => client.updateSystemComponent(component.id, changes));
	}
	function commitProperties(next: typeof properties) {
		const cleaned = next.map((item) => ({ key: item.key.trim(), value: item.value }));
		if (cleaned.some((item) => item.key.length === 0)) return;
		if (JSON.stringify(cleaned) === JSON.stringify(component.properties)) return;
		onApply(() => client.updateSystemComponent(component.id, { properties: cleaned }));
	}

	return (
		<div className="flex flex-col gap-3 text-[13px]">
			<div className="flex items-center justify-between">
				<span className="kicker">{KIND_LABELS[component.kind]}</span>
				<Button type="button" size="icon" variant="ghost" aria-label="Close inspector" className="size-7" onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</div>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Name</span>
				<Input
					value={name}
					maxLength={80}
					aria-label="Component name"
					onChange={(event) => setName(event.target.value)}
					onBlur={commitName}
					onKeyDown={(event) => {
						if (event.key === "Enter") (event.target as HTMLInputElement).blur();
					}}
				/>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Kind</span>
				<select
					aria-label="Component kind"
					value={component.kind}
					onChange={(event) => onApply(() => client.updateSystemComponent(component.id, { kind: event.target.value as SystemComponentKind }))}
					className="h-8 rounded-md border border-input bg-paper-raised px-2"
				>
					{SYSTEM_COMPONENT_KINDS.map((kind) => (
						<option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
					))}
				</select>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Technology</span>
				<Input value={technology} maxLength={500} placeholder="Optional, e.g. PostgreSQL" onChange={(event) => setTechnology(event.target.value)} onBlur={commitDetails} />
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Description</span>
				<Textarea value={description} maxLength={500} rows={3} onChange={(event) => setDescription(event.target.value)} onBlur={commitDetails} />
			</label>
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<span className="text-ink-3">Properties</span>
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={() => {
							const next = [...properties, { key: `property ${properties.length + 1}`, value: "" }];
							setProperties(next);
							commitProperties(next);
						}}
					>
						Add property
					</Button>
				</div>
				{properties.map((item, index) => (
					<div key={index} className="flex items-center gap-1">
						<Input
							aria-label={`Property ${index + 1} name`}
							value={item.key}
							maxLength={60}
							className="h-7 w-28"
							onChange={(event) => setProperties(properties.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))}
							onBlur={() => commitProperties(properties)}
						/>
						<Input
							aria-label={`Property ${index + 1} value`}
							value={item.value}
							maxLength={500}
							className="h-7 min-w-0 flex-1"
							onChange={(event) => setProperties(properties.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))}
							onBlur={() => commitProperties(properties)}
						/>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							aria-label={`Remove property ${index + 1}`}
							className="size-7 shrink-0"
							onClick={() => {
								const next = properties.filter((_, i) => i !== index);
								setProperties(next);
								commitProperties(next);
							}}
						>
							<X className="size-3.5" />
						</Button>
					</div>
				))}
			</div>
			{component.kind === "database" && (
				<div className="rounded-md bg-paper-tint p-2.5 text-[12.5px] text-ink-2">
					{component.designId ? (
						<>
							<p>Linked to this Project’s database design.</p>
							<Button type="button" size="sm" variant="outline" className="mt-2" onClick={onOpenDatabase}>
								<ArrowRight className="size-3.5" />
								Open database workspace
							</Button>
						</>
					) : (
						<p>Conceptual: not linked to a database design yet.</p>
					)}
				</div>
			)}
			<div className="flex flex-col gap-1">
				<span className="text-ink-3">Connections ({related.length})</span>
				{related.length === 0 && <p className="text-ink-3">None yet. Use Connect to draw one.</p>}
				{related.map((connection) => (
					<button
						key={connection.id}
						type="button"
						onClick={() => onSelectConnection(connection.id)}
						className="rounded-sm px-2 py-1 text-left hover:bg-paper-tint"
					>
						{connection.sourceId === component.id ? "→" : "←"} {connection.label}
					</button>
				))}
			</div>
			<Button type="button" variant="strike" size="sm" className="mt-1 self-start" onClick={onRequestRemove}>
				<Trash2 className="size-3.5" />
				Remove component
			</Button>
		</div>
	);
}

function ConnectionInspector({
	connection,
	design,
	client,
	onApply,
	onClose,
	onRemove,
}: {
	connection: SystemConnection;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onClose: () => void;
	onRemove: () => void;
}) {
	const [label, setLabel] = useState(connection.label);
	const [protocol, setProtocol] = useState(connection.protocol ?? "");
	const source = findSystemComponent(design, connection.sourceId)?.name ?? "Missing";
	const target = findSystemComponent(design, connection.targetId)?.name ?? "Missing";

	function commitLabel() {
		const trimmed = label.trim();
		if (trimmed.length === 0) {
			setLabel(connection.label);
			return;
		}
		if (trimmed !== connection.label) onApply(() => client.updateSystemConnection(connection.id, { label: trimmed }));
	}
	function commitProtocol() {
		const trimmed = protocol.trim();
		if (trimmed === (connection.protocol ?? "")) return;
		onApply(() => client.updateSystemConnection(connection.id, { protocol: trimmed || undefined }));
	}

	return (
		<div className="flex flex-col gap-3 text-[13px]">
			<div className="flex items-center justify-between">
				<span className="kicker">Connection</span>
				<Button type="button" size="icon" variant="ghost" aria-label="Close inspector" className="size-7" onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</div>
			<p className="text-ink-2">
				<span className="font-medium text-ink">{source}</span> <ArrowRight className="inline size-3.5" /> <span className="font-medium text-ink">{target}</span>
			</p>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Label</span>
				<Input
					value={label}
					maxLength={80}
					aria-label="Connection label"
					onChange={(event) => setLabel(event.target.value)}
					onBlur={commitLabel}
					onKeyDown={(event) => {
						if (event.key === "Enter") (event.target as HTMLInputElement).blur();
					}}
				/>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Protocol (optional)</span>
				<Input value={protocol} maxLength={500} placeholder="e.g. HTTPS, AMQP" onChange={(event) => setProtocol(event.target.value)} onBlur={commitProtocol} />
			</label>
			<Button type="button" variant="strike" size="sm" className="self-start" onClick={onRemove}>
				<Trash2 className="size-3.5" />
				Remove connection
			</Button>
		</div>
	);
}
