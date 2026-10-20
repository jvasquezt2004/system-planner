import { useCallback, useEffect, useRef, useState } from "react";
import {
	CANVAS_MAX_ZOOM,
	CANVAS_MIN_ZOOM,
	type CanvasPoint,
	type CanvasViewport,
	type Design,
	type DesignColumn,
	type DesignTable,
} from "../shared/design";
import { ColumnBadge } from "./column-badge";
import { ColumnTypeBadge } from "./column-type-badge";

const CARD_WIDTH = 264;
const GRID_SIZE = 24;
const MAJOR_GRID_SIZE = 120;
const VIEWPORT_SAVE_DELAY = 250;

type CardDrag = {
	tableId: string;
	pointerId: number;
	startX: number;
	startY: number;
	zoom: number;
	origin: CanvasPoint;
	current: CanvasPoint;
	moved: boolean;
};

type PanDrag = {
	pointerId: number;
	startX: number;
	startY: number;
	origin: CanvasViewport;
};

export type TableCanvasProps = {
	design: Design;
	selectedTableId: string | null;
	onSelectTable: (tableId: string | null) => void;
	onMoveTable: (tableId: string, position: CanvasPoint) => void;
	onViewportChange: (viewport: CanvasViewport) => void;
	onAddTable: (name: string, position: CanvasPoint) => void;
};

/**
 * Infinite canvas: pan by dragging empty space, zoom with the wheel or the
 * zoom controls, and drag table cards to arrange them. Card positions and the
 * viewport are layout, never database structure.
 */
export function TableCanvas({
	design,
	selectedTableId,
	onSelectTable,
	onMoveTable,
	onViewportChange,
	onAddTable,
}: TableCanvasProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState<CanvasViewport>(design.viewport);
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;

	const saveTimer = useRef<number | null>(null);
	const pendingViewport = useRef<CanvasViewport | null>(null);

	const scheduleViewportSave = useCallback(
		(next: CanvasViewport) => {
			pendingViewport.current = next;
			if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
			saveTimer.current = window.setTimeout(() => {
				saveTimer.current = null;
				const value = pendingViewport.current;
				pendingViewport.current = null;
				if (value) onViewportChange(value);
			}, VIEWPORT_SAVE_DELAY);
		},
		[onViewportChange],
	);

	const applyViewport = useCallback(
		(next: CanvasViewport) => {
			viewportRef.current = next;
			setViewport(next);
			scheduleViewportSave(next);
		},
		[scheduleViewportSave],
	);

	useEffect(
		() => () => {
			if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
		},
		[],
	);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		const handleWheel = (event: WheelEvent) => {
			event.preventDefault();
			const current = viewportRef.current;
			const rect = element.getBoundingClientRect();
			const pointerX = event.clientX - rect.left;
			const pointerY = event.clientY - rect.top;
			const zoom = clamp(current.zoom * Math.exp(-event.deltaY * 0.0015), CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM);
			if (zoom === current.zoom) return;
			const worldX = (pointerX - current.x) / current.zoom;
			const worldY = (pointerY - current.y) / current.zoom;
			applyViewport({
				x: pointerX - worldX * zoom,
				y: pointerY - worldY * zoom,
				zoom,
			});
		};
		element.addEventListener("wheel", handleWheel, { passive: false });
		return () => element.removeEventListener("wheel", handleWheel);
	}, [applyViewport]);

	const pan = useRef<PanDrag | null>(null);
	const [panning, setPanning] = useState(false);
	const cardDragRef = useRef<CardDrag | null>(null);
	const [cardDrag, setCardDrag] = useState<CardDrag | null>(null);

	function updateCardDrag(next: CardDrag | null) {
		cardDragRef.current = next;
		setCardDrag(next);
	}

	function handleCanvasPointerDown(event: React.PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		const container = event.currentTarget;
		const cardElement = (event.target as HTMLElement).closest<HTMLElement>("[data-table-card]");
		container.setPointerCapture(event.pointerId);

		const tableId = cardElement?.dataset.tableId;
		const table = tableId
			? design.tables.find((candidate) => candidate.id === tableId)
			: undefined;
		if (table) {
			onSelectTable(table.id);
			updateCardDrag({
				tableId: table.id,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				zoom: viewportRef.current.zoom,
				origin: table.position,
				current: table.position,
				moved: false,
			});
			return;
		}

		onSelectTable(null);
		pan.current = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			origin: viewportRef.current,
		};
		setPanning(true);
	}

	function handleCanvasPointerMove(event: React.PointerEvent<HTMLDivElement>) {
		const drag = cardDragRef.current;
		if (drag && drag.pointerId === event.pointerId) {
			const dx = (event.clientX - drag.startX) / drag.zoom;
			const dy = (event.clientY - drag.startY) / drag.zoom;
			updateCardDrag({
				...drag,
				moved: drag.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2,
				current: {
					x: Math.round(drag.origin.x + dx),
					y: Math.round(drag.origin.y + dy),
				},
			});
			return;
		}

		const active = pan.current;
		if (!active || active.pointerId !== event.pointerId) return;
		applyViewport({
			x: active.origin.x + (event.clientX - active.startX),
			y: active.origin.y + (event.clientY - active.startY),
			zoom: active.origin.zoom,
		});
	}

	function handleCanvasPointerUp(event: React.PointerEvent<HTMLDivElement>) {
		const drag = cardDragRef.current;
		if (drag && drag.pointerId === event.pointerId) {
			updateCardDrag(null);
			if (drag.moved) onMoveTable(drag.tableId, drag.current);
			return;
		}

		const active = pan.current;
		if (!active || active.pointerId !== event.pointerId) return;
		pan.current = null;
		setPanning(false);
		scheduleViewportSave(viewportRef.current);
	}

	function zoomAroundCentre(factor: number) {
		const element = containerRef.current;
		if (!element) return;
		const rect = element.getBoundingClientRect();
		const current = viewportRef.current;
		const zoom = clamp(current.zoom * factor, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM);
		if (zoom === current.zoom) return;
		const centreX = rect.width / 2;
		const centreY = rect.height / 2;
		const worldX = (centreX - current.x) / current.zoom;
		const worldY = (centreY - current.y) / current.zoom;
		applyViewport({ x: centreX - worldX * zoom, y: centreY - worldY * zoom, zoom });
	}

	const [draftName, setDraftName] = useState("");

	function centrePosition(): CanvasPoint {
		const element = containerRef.current;
		const current = viewportRef.current;
		if (!element) return { x: 0, y: 0 };
		const rect = element.getBoundingClientRect();
		let x = Math.round((rect.width / 2 - current.x) / current.zoom - CARD_WIDTH / 2);
		let y = Math.round((rect.height / 2 - current.y) / current.zoom - 80);
		// Cascade new cards so two quick additions never land on the same spot.
		for (let attempt = 0; attempt <= design.tables.length; attempt += 1) {
			const occupied = design.tables.some(
				(table) =>
					Math.abs(table.position.x - x) < CARD_WIDTH / 4 &&
					Math.abs(table.position.y - y) < 24,
			);
			if (!occupied) break;
			x += 48;
			y += 44;
		}
		return { x, y };
	}

	const minor = GRID_SIZE * viewport.zoom;
	const major = MAJOR_GRID_SIZE * viewport.zoom;
	const minorLine = "rgba(148, 163, 184, 0.10)";
	const majorLine = "rgba(148, 163, 184, 0.20)";

	return (
		<div
			ref={containerRef}
			data-testid="canvas"
			role="application"
			aria-label="Design canvas"
			onPointerDown={handleCanvasPointerDown}
			onPointerMove={handleCanvasPointerMove}
			onPointerUp={handleCanvasPointerUp}
			onPointerCancel={handleCanvasPointerUp}
			className={`relative h-full w-full touch-none overflow-hidden bg-slate-950 ${
				panning ? "cursor-grabbing" : "cursor-grab"
			}`}
			style={{
				backgroundImage: [
					`linear-gradient(to right, ${minorLine} 1px, transparent 1px)`,
					`linear-gradient(to bottom, ${minorLine} 1px, transparent 1px)`,
					`linear-gradient(to right, ${majorLine} 1px, transparent 1px)`,
					`linear-gradient(to bottom, ${majorLine} 1px, transparent 1px)`,
				].join(", "),
				backgroundSize: `${minor}px ${minor}px, ${minor}px ${minor}px, ${major}px ${major}px, ${major}px ${major}px`,
				backgroundPosition: `${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px`,
			}}
		>
			<div
				className="absolute left-0 top-0 origin-top-left"
				style={{
					transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
				}}
			>
				{design.tables.map((table) => (
					<TableCard
						key={table.id}
						table={table}
						selected={table.id === selectedTableId}
						dragging={cardDrag?.tableId === table.id}
						position={
							cardDrag?.tableId === table.id ? cardDrag.current : table.position
						}
						onSelect={() => onSelectTable(table.id)}
					/>
				))}
			</div>

			{design.tables.length === 0 && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div
						onPointerDown={(event) => event.stopPropagation()}
						className="pointer-events-auto rounded-xl border border-dashed border-slate-700 bg-slate-900/80 px-8 py-6 text-center shadow-xl"
					>
						<p className="text-sm font-medium text-slate-200">Your canvas is empty</p>
						<p className="mt-1 max-w-xs text-xs text-slate-400">
							Name a table in the toolbar below to place its first card. Drag the background
							to pan; use the wheel to zoom.
						</p>
						<button
							type="button"
							onClick={() =>
								onAddTable(`Table ${design.tables.length + 1}`, centrePosition())
							}
							className="mt-4 rounded-md bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400"
						>
							Add a table
						</button>
					</div>
				</div>
			)}

			<div
				data-testid="canvas-toolbar"
				onPointerDown={(event) => event.stopPropagation()}
				className="absolute bottom-4 left-4 flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/95 px-2 py-1.5 text-slate-300 shadow-lg backdrop-blur"
			>
				<form
					className="flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (draftName.trim().length === 0) return;
						onAddTable(draftName.trim(), centrePosition());
						setDraftName("");
					}}
				>
					<input
						value={draftName}
						onChange={(event) => setDraftName(event.target.value)}
						aria-label="Table name"
						placeholder="Table name"
						className="w-32 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none placeholder:text-slate-600 focus:border-indigo-500"
					/>
					<button
						type="submit"
						data-testid="add-table"
						disabled={draftName.trim().length === 0}
						className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Add table
					</button>
				</form>
				<span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
				<button
					type="button"
					aria-label="Zoom out"
					data-testid="zoom-out"
					onClick={() => zoomAroundCentre(1 / 1.2)}
					className="rounded px-2 py-1 text-sm hover:bg-slate-800"
				>
					−
				</button>
				<span
					data-testid="zoom-level"
					className="w-12 text-center text-xs tabular-nums text-slate-400"
				>
					{Math.round(viewport.zoom * 100)}%
				</span>
				<button
					type="button"
					aria-label="Zoom in"
					data-testid="zoom-in"
					onClick={() => zoomAroundCentre(1.2)}
					className="rounded px-2 py-1 text-sm hover:bg-slate-800"
				>
					+
				</button>
				<button
					type="button"
					aria-label="Reset zoom"
					data-testid="zoom-reset"
					onClick={() => zoomAroundCentre(1 / viewportRef.current.zoom)}
					className="rounded px-2 py-1 text-[11px] uppercase tracking-wide text-slate-400 hover:bg-slate-800"
				>
					100%
				</button>
				<span className="mx-1 h-5 w-px bg-slate-700" aria-hidden="true" />
				<span className="px-1 text-[11px] text-slate-500">
					{design.tables.length} {design.tables.length === 1 ? "table" : "tables"}
				</span>
			</div>
		</div>
	);
}

function TableCard({
	table,
	selected,
	dragging,
	position,
	onSelect,
}: {
	table: DesignTable;
	selected: boolean;
	dragging: boolean;
	position: CanvasPoint;
	onSelect: () => void;
}) {
	return (
		<div
			data-table-card
			data-table-id={table.id}
			data-testid="table-card"
			data-table-name={table.name}
			data-selected={selected ? "true" : undefined}
			role="button"
			tabIndex={0}
			aria-pressed={selected}
			aria-label={`Table ${table.name}`}
			onPointerDown={onSelect}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect();
				}
			}}
			className={`absolute select-none overflow-hidden rounded-lg border bg-slate-900 text-left shadow-xl shadow-black/40 outline-none ${
				dragging ? "cursor-grabbing" : "cursor-grab"
			} ${
				selected || dragging
					? "border-indigo-400 ring-2 ring-indigo-400/60"
					: "border-slate-700 hover:border-slate-500"
			}`}
			style={{
				width: CARD_WIDTH,
				left: position.x,
				top: position.y,
				zIndex: dragging ? 20 : selected ? 10 : 1,
			}}
		>
			<div className="flex items-center justify-between gap-2 border-b border-slate-700 bg-slate-800/90 px-3 py-2">
				<span className="truncate text-sm font-semibold text-slate-100">{table.name}</span>
				<span className="shrink-0 rounded bg-slate-950/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
					{table.columns.length} {table.columns.length === 1 ? "col" : "cols"}
				</span>
			</div>
			<div className="divide-y divide-slate-800">
				{table.columns.map((column, index) => (
					<ColumnRow key={column.id} column={column} index={index} />
				))}
			</div>
		</div>
	);
}

function ColumnRow({ column, index }: { column: DesignColumn; index: number }) {
	return (
		<div className="flex items-center gap-2 px-3 py-1.5 text-xs">
			<span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-slate-600">
				{index + 1}
			</span>
			<ColumnTypeBadge type={column.type} />
			<span className="min-w-0 flex-1 truncate font-medium text-slate-200">
				{column.name}
			</span>
			<span className="shrink-0 text-[11px] text-slate-400">{column.type}</span>
			{column.primaryKey && (
				<ColumnBadge label="PK" className="text-amber-300" title="Primary key" />
			)}
			{column.unique && !column.primaryKey && (
				<ColumnBadge label="UQ" className="text-emerald-300" title="Unique" />
			)}
			{column.identity && (
				<ColumnBadge label="ID" className="text-sky-300" title="Identity generation" />
			)}
			{column.nullable ? (
				<ColumnBadge label="?" className="text-slate-500" title="Nullable" />
			) : (
				<ColumnBadge label="!" className="text-slate-400" title="Required" />
			)}
			{column.notes.length > 0 && (
				<span
					title={column.notes}
					aria-label="Column note"
					className="shrink-0 text-[10px] text-slate-500"
				>
					✎
				</span>
			)}
		</div>
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
