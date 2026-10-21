import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, Minus, Plus } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { ColumnBadge } from "./column-badge";
import { ColumnTypeBadge } from "./column-type-badge";

const CARD_WIDTH = 272;
/**
 * Card geometry is fixed and applied to the card markup, so connector anchors,
 * enclosures, and the rows they point at can never drift apart. The card's
 * outline is drawn with a box-shadow ring, which takes no layout space.
 */
const CARD_TOP_RULE = 2;
const CARD_HEADER_HEIGHT = 38;
const CARD_ROW_HEIGHT = 28;
/** Space between a card and its first enclosure, and between nested ones. */
const ENCLOSURE_INSET = 14;
const ENCLOSURE_STEP = 14;
/** Extra headroom per ring so each enclosure's label clears the one inside. */
const ENCLOSURE_LABEL_BAND = 10;
const GRID_SIZE = 24;
const MAJOR_GRID_SIZE = 120;
const VIEWPORT_SAVE_DELAY = 250;

/** Registration marks at major grid intersections, drawn as a repeating tile. */
const REGISTRATION_TILE = `url("data:image/svg+xml,${encodeURIComponent(
	`<svg xmlns='http://www.w3.org/2000/svg' width='${MAJOR_GRID_SIZE}' height='${MAJOR_GRID_SIZE}'><path d='M0 -5V5M-5 0H5M${MAJOR_GRID_SIZE} -5V5M${MAJOR_GRID_SIZE - 5} 0H${MAJOR_GRID_SIZE + 5}M0 ${MAJOR_GRID_SIZE - 5}V${MAJOR_GRID_SIZE + 5}M-5 ${MAJOR_GRID_SIZE}H5M${MAJOR_GRID_SIZE} ${MAJOR_GRID_SIZE - 5}V${MAJOR_GRID_SIZE + 5}M${MAJOR_GRID_SIZE - 5} ${MAJOR_GRID_SIZE}H${MAJOR_GRID_SIZE + 5}' stroke='#1b1a17' stroke-opacity='0.24' stroke-width='1' fill='none'/></svg>`,
)}")`;

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

type Rect = { x: number; y: number; width: number; height: number };

export type TableCanvasProps = {
	design: Design;
	selectedTableId: string | null;
	selectedRelationshipId: string | null;
	onSelectTable: (tableId: string | null) => void;
	/** Selecting a relationship on the canvas also opens its referencing table. */
	onSelectRelationship: (relationshipId: string, referencingTableId: string) => void;
	onRelateTables: (
		referencingTableId: string,
		referencedTableId: string,
		cardinality: RelationshipCardinality,
	) => void;
	onRelatingChange: (relating: boolean) => void;
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
	onRelatingChange,
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
		onRelatingChange(relatingFrom !== null);
	}, [relatingFrom, onRelatingChange]);

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
	// Dots fade as the page zooms out, so a distant view never turns grey.
	const dotAlpha = viewport.zoom < 0.55 ? 0.07 : 0.14;
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
	const enclosures = layoutEnclosures(relationships, positionOf);
	const enclosureByRelationship = new Map(
		enclosures.map((enclosure) => [enclosure.view.relationship.id, enclosure]),
	);
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
			className={cn(
				"relative h-full w-full touch-none overflow-hidden bg-paper",
				relatingFrom ? "cursor-crosshair" : panning ? "cursor-grabbing" : "cursor-grab",
			)}
			style={{
				backgroundImage: [
					REGISTRATION_TILE,
					`radial-gradient(circle, rgba(27, 26, 23, ${dotAlpha}) 0.9px, transparent 1.3px)`,
				].join(", "),
				backgroundSize: `${major}px ${major}px, ${minor}px ${minor}px`,
				backgroundPosition: `${viewport.x}px ${viewport.y}px, ${viewport.x - minor / 2}px ${viewport.y - minor / 2}px`,
			}}
		>
			<div
				className="absolute left-0 top-0 origin-top-left"
				style={{
					transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
				}}
			>
				{/* Connectors sit behind the enclosures and cards. */}
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
							enclosure={enclosureByRelationship.get(view.relationship.id) ?? null}
							positionOf={positionOf}
							selected={view.relationship.id === selectedRelationshipId}
							onSelect={() =>
								onSelectRelationship(view.relationship.id, view.referencingTable.id)
							}
						/>
					))}
				</svg>

				{enclosures.map((enclosure) => (
					<EnclosureFrame
						key={enclosure.view.relationship.id}
						enclosure={enclosure}
						selected={enclosure.view.relationship.id === selectedRelationshipId}
						onSelect={() =>
							onSelectRelationship(
								enclosure.view.relationship.id,
								enclosure.view.referencingTable.id,
							)
						}
					/>
				))}

				{design.tables.map((table) => (
					<TableCard
						key={table.id}
						table={table}
						selected={table.id === selectedTableId}
						dragging={cardDrag?.tableId === table.id}
						relatingSource={table.id === relatingFrom}
						relatingTarget={relatingFrom !== null && table.id !== relatingFrom}
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
					className="absolute left-1/2 top-5 flex max-w-[calc(100%-2rem)] -translate-x-1/2 cursor-default items-center gap-4 rounded-sm border border-pencil-rule border-l-[3px] border-l-pencil bg-paper-raised py-2 pl-3 pr-2 shadow-lift"
				>
					<div className="min-w-0">
						<p className="kicker text-pencil!">Relating</p>
						<p className="mt-0.5 text-[12.5px] text-ink-2">
							<span className="font-display text-[14px] font-semibold text-ink">
								{relatingTable.name}
							</span>{" "}
							will store the reference. Click the table it references.
						</p>
					</div>
					<ToggleGroup
						type="single"
						variant="outline"
						size="sm"
						spacing={0}
						aria-label="Relationship cardinality"
						value={relatingCardinality}
						onValueChange={(value) => {
							if (value === "one-to-many" || value === "one-to-one") {
								setRelatingCardinality(value);
							}
						}}
					>
						<ToggleGroupItem
							value="one-to-many"
							data-testid="relate-cardinality-one-to-many"
						>
							many
						</ToggleGroupItem>
						<ToggleGroupItem
							value="one-to-one"
							data-testid="relate-cardinality-one-to-one"
						>
							one-to-one
						</ToggleGroupItem>
					</ToggleGroup>
					<Button variant="ghost" size="xs" onClick={() => setRelatingFrom(null)}>
						Cancel
						<kbd className="font-mono text-[10px] text-ink-4">Esc</kbd>
					</Button>
				</div>
			)}

			{design.tables.length === 0 && (
				<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
					<div
						onPointerDown={(event) => event.stopPropagation()}
						className="pointer-events-auto max-w-sm cursor-default text-center"
					>
						<p className="kicker">An empty page</p>
						<p className="mt-2 font-display text-[28px] leading-tight font-normal italic text-ink">
							Every schema starts with a single table.
						</p>
						<p className="mx-auto mt-2 max-w-xs text-[12.5px] leading-relaxed text-ink-3">
							Name one in the bar below, or place a first card now. Drag the page to
							pan; use the wheel to zoom.
						</p>
						<Button
							className="mt-5"
							onClick={() =>
								onAddTable(`Table ${design.tables.length + 1}`, centrePosition())
							}
						>
							<Plus />
							Add a table
						</Button>
					</div>
				</div>
			)}

			<div
				data-testid="canvas-toolbar"
				onPointerDown={(event) => event.stopPropagation()}
				className="absolute bottom-4 left-4 flex cursor-default flex-wrap items-center gap-1.5 rounded-sm border border-rule-strong bg-paper-raised p-1.5"
			>
				<form
					className="flex items-center gap-1.5"
					onSubmit={(event) => {
						event.preventDefault();
						if (draftName.trim().length === 0) return;
						onAddTable(draftName.trim(), centrePosition());
						setDraftName("");
					}}
				>
					<Input
						value={draftName}
						onChange={(event) => setDraftName(event.target.value)}
						aria-label="Table name"
						placeholder="Table name"
						className="h-7 w-36"
					/>
					<Button
						type="submit"
						size="sm"
						data-testid="add-table"
						disabled={draftName.trim().length === 0}
					>
						<Plus />
						Add table
					</Button>
				</form>
				<span className="mx-1 h-5 w-px bg-rule" aria-hidden="true" />
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Zoom out"
					data-testid="zoom-out"
					onClick={() => zoomAroundCentre(1 / 1.2)}
				>
					<Minus />
				</Button>
				<button
					type="button"
					aria-label="Reset zoom"
					data-testid="zoom-reset"
					title="Reset zoom to 100%"
					onClick={() => zoomAroundCentre(1 / viewportRef.current.zoom)}
					className="figures h-7 w-12 rounded-sm text-center font-mono text-[11px] text-ink-2 hover:bg-paper-tint"
				>
					<span data-testid="zoom-level">{Math.round(viewport.zoom * 100)}%</span>
				</button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Zoom in"
					data-testid="zoom-in"
					onClick={() => zoomAroundCentre(1.2)}
				>
					<Plus />
				</Button>
				<span className="mx-1 h-5 w-px bg-rule" aria-hidden="true" />
				<span className="figures px-1.5 font-mono text-[11px] text-ink-3">
					{design.tables.length} {design.tables.length === 1 ? "table" : "tables"}
				</span>
			</div>
		</div>
	);
}

/**
 * A one-to-many relationship drawn as a frame around the "many" table, headed
 * with the "one" table's name: a Campus has many Students, so Students sits
 * inside a frame headed CAMPUS. It is an indicator, not containment — the
 * frame is derived from the relationship and follows the card wherever it is
 * placed. A table with several parents gets one concentric ring per parent.
 */
type Enclosure = {
	view: RelationshipView;
	ring: number;
	rect: Rect;
	/** The same parent frames this table more than once (author and editor). */
	repeatedParent: boolean;
};

function cardHeight(table: DesignTable): number {
	return CARD_TOP_RULE + CARD_HEADER_HEIGHT + table.columns.length * CARD_ROW_HEIGHT;
}

function cardRect(table: DesignTable, position: CanvasPoint): Rect {
	return { x: position.x, y: position.y, width: CARD_WIDTH, height: cardHeight(table) };
}

function layoutEnclosures(
	relationships: RelationshipView[],
	positionOf: (table: DesignTable) => CanvasPoint,
): Enclosure[] {
	const byChild = new Map<string, RelationshipView[]>();
	for (const view of relationships) {
		if (view.oneToOne) continue;
		const list = byChild.get(view.referencingTable.id) ?? [];
		list.push(view);
		byChild.set(view.referencingTable.id, list);
	}
	const enclosures: Enclosure[] = [];
	for (const views of byChild.values()) {
		views.forEach((view, ring) => {
			const card = cardRect(view.referencingTable, positionOf(view.referencingTable));
			const side = ENCLOSURE_INSET + ring * ENCLOSURE_STEP;
			const top = side + ENCLOSURE_LABEL_BAND * (ring + 1);
			enclosures.push({
				view,
				ring,
				rect: {
					x: card.x - side,
					y: card.y - top,
					width: card.width + side * 2,
					height: card.height + top + side,
				},
				repeatedParent:
					views.filter((other) => other.referencedTable.id === view.referencedTable.id)
						.length > 1,
			});
		});
	}
	return enclosures;
}

function EnclosureFrame({
	enclosure,
	selected,
	onSelect,
}: {
	enclosure: Enclosure;
	selected: boolean;
	onSelect: () => void;
}) {
	const { view, rect } = enclosure;
	return (
		<div
			data-testid="enclosure"
			data-relationship-id={view.relationship.id}
			data-selected={selected ? "true" : undefined}
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute rounded-[3px] border",
				selected ? "border-pencil border-[1.5px]" : "border-rule-strong",
			)}
			style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 0 }}
		>
			<button
				type="button"
				tabIndex={-1}
				title={`Each ${view.referencedTable.name} record may have many ${view.referencingTable.name} records through ${view.referencingTable.name}.${view.referencingColumn.name}`}
				onPointerDown={(event) => {
					event.stopPropagation();
					onSelect();
				}}
				className={cn(
					"pointer-events-auto absolute -top-[8px] left-2.5 flex h-[15px] max-w-[calc(100%-20px)] cursor-pointer items-baseline gap-1.5 bg-paper px-1.5 leading-none whitespace-nowrap",
					selected ? "text-pencil" : "text-ink-2 hover:text-ink",
				)}
			>
				<span className="truncate text-[10px] font-semibold tracking-[0.14em] uppercase">
					{view.referencedTable.name}
				</span>
				<span
					className={cn(
						"font-display text-[11.5px] italic",
						selected ? "text-pencil" : "text-ink-3",
					)}
				>
					has many
				</span>
				{enclosure.repeatedParent && (
					<span className="truncate font-mono text-[10px] text-ink-3">
						via {view.referencingColumn.name}
					</span>
				)}
			</button>
		</div>
	);
}

type ConnectorGeometry = {
	path: string;
	/** The referencing end: the enclosure edge, or the card edge for one-to-one. */
	start: CanvasPoint;
	/** The referenced (one) end, where the primary key sits. */
	end: CanvasPoint;
	/** +1 when the referencing end faces right, -1 when it faces left. */
	startDirection: 1 | -1;
	endDirection: 1 | -1;
	/** A short dotted lead from the enclosure edge into the foreign-key row. */
	leader: string | null;
};

function rowCentreY(table: DesignTable, columnId: string, position: CanvasPoint): number {
	const index = table.columns.findIndex((column) => column.id === columnId);
	const row = index < 0 ? 0 : index;
	return (
		position.y + CARD_TOP_RULE + CARD_HEADER_HEIGHT + row * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2
	);
}

/**
 * A curve between the referenced key row and the referencing side. Facing
 * edges get an S-curve; when the two overlap horizontally (stacked, or a table
 * referencing itself) both ends leave on the right and the curve bows outward,
 * so it never cuts across a card.
 */
function connectorGeometry(
	view: RelationshipView,
	enclosure: Enclosure | null,
	positionOf: (table: DesignTable) => CanvasPoint,
): ConnectorGeometry | null {
	const referencedColumn = view.referencedColumn;
	if (!referencedColumn) return null;
	const toPosition = positionOf(view.referencedTable);
	const fromPosition = positionOf(view.referencingTable);
	const target = cardRect(view.referencedTable, toPosition);
	const source = enclosure?.rect ?? cardRect(view.referencingTable, fromPosition);
	const rowY = rowCentreY(view.referencingTable, view.referencingColumn.id, fromPosition);
	const keyY = rowCentreY(view.referencedTable, referencedColumn.id, toPosition);

	const overlapping =
		target.x < source.x + source.width && target.x + target.width > source.x;
	let startDirection: 1 | -1;
	let endDirection: 1 | -1;
	if (overlapping) {
		startDirection = 1;
		endDirection = 1;
	} else if (target.x + target.width / 2 >= source.x + source.width / 2) {
		startDirection = 1;
		endDirection = -1;
	} else {
		startDirection = -1;
		endDirection = 1;
	}
	const start = {
		x: startDirection === 1 ? source.x + source.width : source.x,
		y: rowY,
	};
	const end = {
		x: endDirection === 1 ? target.x + target.width : target.x,
		y: keyY,
	};
	const bend = overlapping
		? Math.max(48, Math.abs(end.x - start.x) / 2 + 36)
		: Math.max(40, Math.min(180, Math.abs(end.x - start.x) / 2));
	const leader = enclosure
		? `M ${start.x} ${rowY} L ${startDirection === 1 ? fromPosition.x + CARD_WIDTH : fromPosition.x} ${rowY}`
		: null;
	return {
		path: `M ${start.x} ${start.y} C ${start.x + bend * startDirection} ${start.y}, ${end.x + bend * endDirection} ${end.y}, ${end.x} ${end.y}`,
		start,
		end,
		startDirection,
		endDirection,
		leader,
	};
}

function RelationshipConnector({
	view,
	enclosure,
	positionOf,
	selected,
	onSelect,
}: {
	view: RelationshipView;
	enclosure: Enclosure | null;
	positionOf: (table: DesignTable) => CanvasPoint;
	selected: boolean;
	onSelect: () => void;
}) {
	const geometry = connectorGeometry(view, enclosure, positionOf);
	if (!geometry) return null;
	const stroke = selected ? "var(--pencil)" : "var(--rule-strong)";
	const width = selected ? 1.75 : 1;
	// One bar at the referenced end expresses one. A one-to-one reference also
	// carries one bar at its referencing end; a one-to-many reference instead
	// meets its enclosure with a small square port.
	const bar = (point: CanvasPoint, direction: 1 | -1) => {
		const x = point.x + direction * 6;
		return `M ${x} ${point.y - 5} L ${x} ${point.y + 5}`;
	};
	return (
		<g
			data-testid="relationship"
			data-relationship-id={view.relationship.id}
			data-cardinality={view.oneToOne ? "one-to-one" : "one-to-many"}
			data-selected={selected ? "true" : undefined}
		>
			<path d={geometry.path} fill="none" stroke={stroke} strokeWidth={width} />
			{geometry.leader && (
				<path
					d={geometry.leader}
					fill="none"
					stroke={stroke}
					strokeWidth={width}
					strokeDasharray="1.5 2.5"
				/>
			)}
			<path
				d={bar(geometry.end, geometry.endDirection)}
				fill="none"
				stroke={stroke}
				strokeWidth={width + 0.25}
			/>
			{view.oneToOne ? (
				<path
					d={bar(geometry.start, geometry.startDirection)}
					fill="none"
					stroke={stroke}
					strokeWidth={width + 0.25}
				/>
			) : (
				<rect
					x={geometry.start.x - 2.5}
					y={geometry.start.y - 2.5}
					width={5}
					height={5}
					fill={selected ? "var(--pencil)" : "var(--ink-2)"}
				/>
			)}
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
	relatingSource,
	relatingTarget,
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
	relatingSource: boolean;
	relatingTarget: boolean;
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
			className={cn(
				"group/card absolute bg-paper-raised text-left outline-none select-none",
				dragging
					? "cursor-grabbing shadow-lift ring-1 ring-ink-3"
					: relatingTarget
						? "cursor-crosshair ring-1 ring-rule-strong hover:ring-2 hover:ring-pencil"
						: "cursor-grab ring-1 ring-rule-strong hover:ring-ink-4",
				(selected || relatingSource) && !dragging && "ring-2 ring-pencil hover:ring-pencil",
				"focus-visible:ring-2 focus-visible:ring-pencil",
			)}
			style={{
				width: CARD_WIDTH,
				left: position.x,
				top: position.y,
				zIndex: dragging ? 20 : selected ? 10 : 1,
			}}
		>
			<div
				aria-hidden="true"
				className={selected || relatingSource ? "bg-pencil" : "bg-ink"}
				style={{ height: CARD_TOP_RULE }}
			/>
			<div
				className="flex items-center justify-between gap-2 border-b border-rule-strong pl-3 pr-1.5"
				style={{ height: CARD_HEADER_HEIGHT }}
			>
				<span className="truncate font-display text-[16px] leading-none font-semibold tracking-[-0.005em] text-ink">
					{table.name}
				</span>
				<div className="flex shrink-0 items-center gap-1">
					<span
						className="figures font-mono text-[10px] text-ink-4"
						title={`${table.columns.length} ${table.columns.length === 1 ? "column" : "columns"}`}
					>
						{table.columns.length} col
					</span>
					<button
						type="button"
						data-testid="relate-table"
						aria-label={`Relate ${table.name} to another table`}
						title="Relate this table to the table it references"
						onPointerDown={(event) => event.stopPropagation()}
						onClick={onStartRelate}
						className={cn(
							"flex h-6 items-center gap-1 rounded-sm px-1.5 text-[10.5px] font-medium tracking-[0.06em] uppercase transition-colors",
							relatingSource
								? "bg-pencil text-paper-raised"
								: "text-ink-3 hover:bg-pencil-wash hover:text-pencil",
						)}
					>
						<Cable className="size-3" />
						relate
					</button>
				</div>
			</div>
			<div>
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
			className={cn(
				"flex items-center gap-2 pr-2.5 pl-1.5 text-[12px]",
				index > 0 && "border-t border-rule-soft",
				highlighted && "bg-pencil-wash",
			)}
			style={{ height: CARD_ROW_HEIGHT }}
		>
			<span
				className={cn(
					"figures w-4 shrink-0 text-right font-mono text-[9.5px]",
					highlighted ? "text-pencil" : "text-ink-4",
				)}
			>
				{index + 1}
			</span>
			<ColumnTypeBadge type={column.type} />
			<span
				className={cn(
					"min-w-0 flex-1 truncate font-medium",
					highlighted ? "text-pencil" : "text-ink",
				)}
			>
				{column.name}
			</span>
			<span className="shrink-0 font-mono text-[10.5px] text-ink-3">{column.type}</span>
			<span className="flex shrink-0 items-center gap-1">
				{foreignKey && <ColumnBadge label="FK" tone="strong" title="Foreign key" />}
				{column.primaryKey && <ColumnBadge label="PK" tone="key" title="Primary key" />}
				{column.unique && !column.primaryKey && (
					<ColumnBadge label="UQ" tone="strong" title="Unique" />
				)}
				{relationshipUnique && (
					<ColumnBadge
						label="UQ"
						tone="strong"
						title="Unique — at most one record may name the same one"
					/>
				)}
				{column.identity && (
					<ColumnBadge label="ID" tone="quiet" title="Identity generation" />
				)}
				{column.default.kind !== "none" && (
					<ColumnBadge
						label="D"
						tone="quiet"
						title={`Default: ${describeColumnDefault(column.default)}`}
					/>
				)}
				{column.nullable ? (
					<ColumnBadge label="?" tone="quiet" title="Nullable" />
				) : (
					<ColumnBadge label="!" tone="faint" title="Required" />
				)}
				{column.notes.length > 0 && (
					<span
						title={column.notes}
						aria-label="Column note"
						className="font-display text-[12px] leading-none text-ink-3 italic"
					>
						†
					</span>
				)}
			</span>
		</div>
	);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
