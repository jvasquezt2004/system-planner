import { useCallback, useEffect, useRef, useState } from "react";
import {
	CANVAS_MAX_ZOOM,
	CANVAS_MIN_ZOOM,
	type CanvasPoint,
	type CanvasViewport,
	type Design,
	type DesignColumn,
	type DesignTable,
	type RelationshipCardinality,
} from "../shared/design";
import { describeColumnDefault } from "../shared/column-defaults";
import {
	resolveRelationships,
	type RelationshipView,
} from "../shared/relationships";
import { ColumnBadge } from "./column-badge";
import { ColumnTypeBadge } from "./column-type-badge";

const CARD_WIDTH = 264;
/**
 * Card geometry is fixed and applied to the card markup, so connector anchors
 * and the rows they point at can never drift apart.
 */
const CARD_HEADER_HEIGHT = 37;
const CARD_ROW_HEIGHT = 29;
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
	selectedRelationshipId: string | null;
	onSelectTable: (tableId: string | null) => void;
	onSelectRelationship: (relationshipId: string | null) => void;
	onRelateTables: (
		referencingTableId: string,
		referencedTableId: string,
		cardinality: RelationshipCardinality,
	) => void;
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
	selectedRelationshipId,
	onSelectTable,
	onSelectRelationship,
	onRelateTables,
	onMoveTable,
	onViewportChange,
	onAddTable,
}: TableCanvasProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [viewport, setViewport] = useState<CanvasViewport>(design.viewport);
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;

	// Relating starts on a table card and ends on the table it references. The
	// starting card is always the referencing side that stores the constraint.
	const [relatingFrom, setRelatingFrom] = useState<string | null>(null);
	const [relatingCardinality, setRelatingCardinality] =
		useState<RelationshipCardinality>("one-to-many");
	const relatingFromRef = useRef(relatingFrom);
	relatingFromRef.current = relatingFrom;
	const relatingCardinalityRef = useRef(relatingCardinality);
	relatingCardinalityRef.current = relatingCardinality;

	useEffect(() => {
		if (!relatingFrom) return;
		const cancel = (event: KeyboardEvent) => {
			if (event.key === "Escape") setRelatingFrom(null);
		};
		window.addEventListener("keydown", cancel);
		return () => window.removeEventListener("keydown", cancel);
	}, [relatingFrom]);

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
		const tableId = cardElement?.dataset.tableId;

		// While relating, a click on a card completes the association and never
		// starts a drag or a pan.
		const relating = relatingFromRef.current;
		if (relating) {
			event.preventDefault();
			setRelatingFrom(null);
			if (tableId && tableId !== relating) {
				onRelateTables(relating, tableId, relatingCardinalityRef.current);
			} else {
				onSelectTable(tableId ?? null);
			}
			return;
		}

		container.setPointerCapture(event.pointerId);

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
	const relationships = resolveRelationships(design);
	const foreignKeyColumnIds = new Set(
		design.relationships.map((relationship) => relationship.referencingColumnId),
	);
	// Uniqueness the relationship contributes, never an independent column setting.
	const relationshipUniqueColumnIds = new Set(
		relationships
			.filter((view) => view.ownsUniqueness)
			.map((view) => view.relationship.referencingColumnId),
	);
	const selectedRelationship =
		relationships.find(
			(view) => view.relationship.id === selectedRelationshipId,
		) ?? null;
	// Positions during a drag come from the drag preview, so connectors follow.
	const positionOf = (table: DesignTable): CanvasPoint =>
		cardDrag?.tableId === table.id ? cardDrag.current : table.position;
	const relatingTable = design.tables.find((table) => table.id === relatingFrom);

	function highlightedColumns(tableId: string): Set<string> {
		if (!selectedRelationship) return new Set();
		const columns = new Set<string>();
		if (selectedRelationship.referencingTable.id === tableId) {
			columns.add(selectedRelationship.referencingColumn.id);
		}
		if (selectedRelationship.referencedTable.id === tableId) {
			if (selectedRelationship.referencedColumn) {
				columns.add(selectedRelationship.referencedColumn.id);
			}
		}
		return columns;
	}

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
				{/* Connectors sit behind the cards and carry the cardinality marks. */}
				<svg
					data-testid="relationship-layer"
					aria-hidden="true"
					className="absolute left-0 top-0 overflow-visible"
					style={{ width: 1, height: 1, pointerEvents: "none" }}
				>
					{relationships.map((view) => (
						<RelationshipConnector
							key={view.relationship.id}
							view={view}
							positionOf={positionOf}
							selected={
								view.relationship.id === selectedRelationshipId
							}
							onSelect={() => onSelectRelationship(view.relationship.id)}
						/>
					))}
				</svg>

				{design.tables.map((table) => (
					<TableCard
						key={table.id}
						table={table}
						selected={table.id === selectedTableId}
						dragging={cardDrag?.tableId === table.id}
						relating={table.id === relatingFrom}
						position={positionOf(table)}
						highlightedColumnIds={highlightedColumns(table.id)}
						foreignKeyColumnIds={foreignKeyColumnIds}
						relationshipUniqueColumnIds={relationshipUniqueColumnIds}
						onSelect={() => onSelectTable(table.id)}
						onStartRelate={() => {
							onSelectTable(table.id);
							setRelatingCardinality("one-to-many");
							setRelatingFrom(table.id);
						}}
					/>
				))}
			</div>

			{relatingTable && (
				<div
					data-testid="relate-banner"
					data-cardinality={relatingCardinality}
					onPointerDown={(event) => event.stopPropagation()}
					role="status"
					className="absolute left-1/2 top-4 flex -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg border border-indigo-500/60 bg-indigo-500/15 px-4 py-2 text-xs text-indigo-100 shadow-lg backdrop-blur"
				>
					<span>
						Relating from <strong>“{relatingTable.name}”</strong>, which will store
						the reference. Click the table it references.
					</span>
					<span
						role="group"
						aria-label="Relationship cardinality"
						className="flex items-center gap-1 rounded-md border border-indigo-400/60 p-0.5"
					>
						{(
							[
								["one-to-many", "many"],
								["one-to-one", "one-to-one"],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								type="button"
								data-testid={`relate-cardinality-${value}`}
								aria-pressed={relatingCardinality === value}
								onClick={() => setRelatingCardinality(value)}
								className={`rounded px-2 py-0.5 text-[11px] ${
									relatingCardinality === value
										? "bg-indigo-500 text-white"
										: "text-indigo-100 hover:bg-indigo-500/20"
								}`}
							>
								{label}
							</button>
						))}
					</span>
					<button
						type="button"
						onClick={() => setRelatingFrom(null)}
						className="rounded border border-indigo-400/60 px-2 py-0.5 text-[11px] text-indigo-100 hover:bg-indigo-500/20"
					>
						Cancel
					</button>
				</div>
			)}

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

type ConnectorGeometry = {
	path: string;
	/** The referencing (many) end, where the foreign-key column sits. */
	start: CanvasPoint;
	/** The referenced (one) end, where the primary key sits. */
	end: CanvasPoint;
	fromSide: "left" | "right";
};

function columnAnchor(
	table: DesignTable,
	columnId: string | null,
	position: CanvasPoint,
): CanvasPoint {
	const index = columnId
		? table.columns.findIndex((column) => column.id === columnId)
		: 0;
	const row = index < 0 ? 0 : index;
	return {
		x: position.x,
		y: position.y + CARD_HEADER_HEIGHT + row * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2,
	};
}

/**
 * A short horizontal curve between the two participating column rows. The
 * connector leaves and enters on facing card edges, so it stays subtle however
 * the cards are arranged.
 */
function connectorGeometry(
	view: RelationshipView,
	positionOf: (table: DesignTable) => CanvasPoint,
): ConnectorGeometry | null {
	const referencedColumn = view.referencedColumn;
	if (!referencedColumn) return null;
	const fromPosition = positionOf(view.referencingTable);
	const toPosition = positionOf(view.referencedTable);
	const rightwards =
		toPosition.x + CARD_WIDTH / 2 >= fromPosition.x + CARD_WIDTH / 2;
	const start = {
		x: fromPosition.x + (rightwards ? CARD_WIDTH : 0),
		y: columnAnchor(view.referencingTable, view.referencingColumn.id, fromPosition).y,
	};
	const end = {
		x: toPosition.x + (rightwards ? 0 : CARD_WIDTH),
		y: columnAnchor(view.referencedTable, referencedColumn.id, toPosition).y,
	};
	const bend = Math.max(40, Math.min(180, Math.abs(end.x - start.x) / 2));
	const fromDirection = rightwards ? 1 : -1;
	const toDirection = rightwards ? -1 : 1;
	return {
		path: `M ${start.x} ${start.y} C ${start.x + bend * fromDirection} ${start.y}, ${end.x + bend * toDirection} ${end.y}, ${end.x} ${end.y}`,
		start,
		end,
		fromSide: rightwards ? "right" : "left",
	};
}

function RelationshipConnector({
	view,
	positionOf,
	selected,
	onSelect,
}: {
	view: RelationshipView;
	positionOf: (table: DesignTable) => CanvasPoint;
	selected: boolean;
	onSelect: () => void;
}) {
	const geometry = connectorGeometry(view, positionOf);
	if (!geometry) return null;
	const stroke = selected ? "#818cf8" : "rgba(148, 163, 184, 0.5)";
	const width = selected ? 2 : 1.25;
	// One mark at an end expresses one; three stacked marks express many.
	const direction = geometry.fromSide === "right" ? 1 : -1;
	const startOffsets = view.oneToOne ? [5] : [4, 10, 16];
	const marks = startOffsets.map((offset) => {
		const x = geometry.start.x + direction * offset;
		return `M ${x} ${geometry.start.y - 6} L ${x} ${geometry.start.y + 6}`;
	});
	marks.push(
		`M ${geometry.end.x - direction * 5} ${geometry.end.y - 6} L ${geometry.end.x - direction * 5} ${geometry.end.y + 6}`,
	);
	return (
		<g
			data-testid="relationship"
			data-relationship-id={view.relationship.id}
			data-cardinality={view.oneToOne ? "one-to-one" : "one-to-many"}
			data-selected={selected ? "true" : undefined}
		>
			<path d={geometry.path} fill="none" stroke={stroke} strokeWidth={width} />
			{marks.map((d) => (
				<path key={d} d={d} fill="none" stroke={stroke} strokeWidth={width} />
			))}
			<path
				d={geometry.path}
				fill="none"
				stroke="transparent"
				strokeWidth={16}
				style={{ pointerEvents: "stroke", cursor: "pointer" }}
				onPointerDown={(event) => {
					event.stopPropagation();
					onSelect();
				}}
			/>
		</g>
	);
}

function TableCard({
	table,
	selected,
	dragging,
	relating,
	position,
	highlightedColumnIds,
	foreignKeyColumnIds,
	relationshipUniqueColumnIds,
	onSelect,
	onStartRelate,
}: {
	table: DesignTable;
	selected: boolean;
	dragging: boolean;
	relating: boolean;
	position: CanvasPoint;
	highlightedColumnIds: Set<string>;
	foreignKeyColumnIds: Set<string>;
	relationshipUniqueColumnIds: Set<string>;
	onSelect: () => void;
	onStartRelate: () => void;
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
				relating || selected || dragging
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
			<div
				className="flex items-center justify-between gap-2 border-b border-slate-700 bg-slate-800/90 px-3"
				style={{ height: CARD_HEADER_HEIGHT }}
			>
				<span className="truncate text-sm font-semibold text-slate-100">{table.name}</span>
				<div className="flex shrink-0 items-center gap-1">
					<button
						type="button"
						data-testid="relate-table"
						aria-label={`Relate ${table.name} to another table`}
						title="Relate this table to the table it references"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={onStartRelate}
						className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-indigo-400 hover:text-indigo-200"
					>
						relate
					</button>
					<span className="rounded bg-slate-950/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
						{table.columns.length} {table.columns.length === 1 ? "col" : "cols"}
					</span>
				</div>
			</div>
			<div className="divide-y divide-slate-800">
				{table.columns.map((column, index) => (
					<ColumnRow
						key={column.id}
						column={column}
						index={index}
						highlighted={highlightedColumnIds.has(column.id)}
						foreignKey={foreignKeyColumnIds.has(column.id)}
						relationshipUnique={relationshipUniqueColumnIds.has(column.id)}
					/>
				))}
			</div>
		</div>
	);
}

function ColumnRow({
	column,
	index,
	highlighted,
	foreignKey,
	relationshipUnique,
}: {
	column: DesignColumn;
	index: number;
	highlighted: boolean;
	foreignKey: boolean;
	relationshipUnique: boolean;
}) {
	return (
		<div
			data-testid="table-column-row"
			data-column-id={column.id}
			data-highlighted={highlighted ? "true" : undefined}
			className={`flex items-center gap-2 px-3 text-xs ${
				highlighted ? "bg-indigo-500/20 ring-1 ring-inset ring-indigo-400/50" : ""
			}`}
			style={{ height: CARD_ROW_HEIGHT }}
		>
			<span className="w-4 shrink-0 text-right text-[10px] tabular-nums text-slate-600">
				{index + 1}
			</span>
			<ColumnTypeBadge type={column.type} />
			<span
				className={`min-w-0 flex-1 truncate font-medium ${
					highlighted ? "text-indigo-100" : "text-slate-200"
				}`}
			>
				{column.name}
			</span>
			<span className="shrink-0 text-[11px] text-slate-400">{column.type}</span>
			{foreignKey && (
				<ColumnBadge label="FK" className="text-cyan-300" title="Foreign key" />
			)}
			{column.primaryKey && (
				<ColumnBadge label="PK" className="text-amber-300" title="Primary key" />
			)}
			{column.unique && !column.primaryKey && (
				<ColumnBadge label="UQ" className="text-emerald-300" title="Unique" />
			)}
			{relationshipUnique && (
				<ColumnBadge
					label="UQ"
					className="text-emerald-300"
					title="Unique — at most one record may name the same one"
				/>
			)}
			{column.identity && (
				<ColumnBadge label="ID" className="text-sky-300" title="Identity generation" />
			)}
			{column.default.kind !== "none" && (
				<ColumnBadge
					label="D"
					className="text-fuchsia-300"
					title={`Default: ${describeColumnDefault(column.default)}`}
				/>
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
