import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BoxSelect, Download, Frame, Link2, Minus, Plus, Trash2, X } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import type { CanvasPoint, CanvasViewport, DatabaseDesignSummary, WorkspaceState } from "../shared/design";
import {
	DEFAULT_SYSTEM_CONNECTION_LABEL,
	componentsLinkedToDesign,
	SYSTEM_CONNECTION_BEND_LIMIT,
	SYSTEM_CONNECTION_SIDES,
	SYSTEM_COMPONENT_KINDS,
	SYSTEM_COMPONENT_SIZE,
	SYSTEM_SERVICE_COLLAPSED_SIZE,
	SYSTEM_SERVICE_MIN_SIZE,
	describeSystemComponentRemoval,
	describeSystemConnectionRemoval,
	describeSystemServiceRemoval,
	canAddSystemGroupMember,
	findSystemComponent,
	findSystemConnection,
	findSystemGroup,
	findSystemService,
	isComponentHiddenByCollapse,
	isSystemServiceCollapsed,
	openServiceSpotNear,
	openSpotNear,
	systemGroupsContaining,
	systemServiceFocus,
	type SystemComponent,
	type SystemComponentKind,
	type SystemComponentRemovalPlan,
	type SystemConnectionRemovalPlan,
	type SystemConnection,
	type SystemConnectionSide,
	type SystemDesign,
	type SystemGroup,
	type SystemService,
	type SystemServiceRemovalPlan,
	type SystemServiceSize,
} from "../shared/system-design";
import {
	COMPONENT_CATALOG,
	COMPONENT_FAMILY_LABELS,
	CUSTOM_ICONS,
	CUSTOM_ICON_LABELS,
	catalogEntryFor,
	componentKindLabel,
	descriptorKeysFor,
	descriptorValue,
	mergeFreeProperties,
	withDescriptorValue,
	type ComponentFamily,
	type CustomIcon,
} from "../shared/component-catalog";
import { ComponentArtwork, componentArtworkTime } from "./system-artwork";
import { computeSystemLayout, systemCardsOverlap } from "../shared/system-layout";
import type { workspaceClient } from "./workspace-client";
import {
	findWalkthrough,
	selectedWalkthroughHighlight,
	type AffectedWalkthroughStep,
	type WalkthroughHighlight,
	walkthroughStepsOnConnections,
} from "../shared/walkthrough";
import { WalkthroughEditor, type WalkthroughSelection } from "./walkthrough-editor";
import { hiddenActivityStep, strongestReaction } from "../shared/walkthrough-playback";
import { usePrefersReducedMotion, useWalkthroughPlayback } from "./use-walkthrough-playback";
import { ReactionRing, ReactionTag, WalkthroughMessageDot } from "./walkthrough-playback-svg";
import {
	GROUP_HEADER_HEIGHT,
	bendInsertionFor,
	connectionGeometries,
	fitViewport,
	followViewport,
	groupFrameAround,
	internalConnectionCount,
	labelWidth,
	movedBeyondThreshold,
	playbackRoutes,
	previewScene,
	resizedGroupSize,
	resizedServiceSize,
	sceneBounds,
	screenToWorld,
	truncateLabel,
	zoomAroundPoint,
	type SceneDrag,
} from "./system-design-geometry";
import { errorMessage } from "../shared/error-message";
import { systemDesignSvgFontDataUrl } from "./system-design-svg-fonts";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Client = typeof workspaceClient;
type Selection =
	| { kind: "component"; id: string }
	| { kind: "service"; id: string }
	| { kind: "group"; id: string }
	| { kind: "connection"; id: string }
	| null;
type Drag = {
	scene: SceneDrag;
	pointerStart: CanvasPoint;
	/** The moved item's position when the press began. */
	origin: CanvasPoint;
	/** The Service's size when the press began; only resizing reads it. */
	originSize: SystemServiceSize;
	moved: boolean;
};
type Pan = { pointerStart: CanvasPoint; viewportStart: CanvasViewport; moved: boolean };
/** The outcome of the last SVG export, shown until the next one starts. */
type DiagramExportStatus = { tone: "saved" | "cancelled" | "failed"; message: string };
/** A removal waiting for confirmation. `walkthroughSteps` are the steps it would leave dangling. */
export type PendingRemoval =
	| { kind: "component"; plan: SystemComponentRemovalPlan; walkthroughSteps: AffectedWalkthroughStep[] }
	| { kind: "service"; plan: SystemServiceRemovalPlan; walkthroughSteps: AffectedWalkthroughStep[] }
	| { kind: "connection"; plan: SystemConnectionRemovalPlan; walkthroughSteps: AffectedWalkthroughStep[] };

const SAVE_DEBOUNCE_MS = 400;
const ARROW_ID = "system-design-arrow";

export type SystemDesignViewProps = {
	state: WorkspaceState;
	client: Client;
	/** Runs a content action: busy state, error reporting, and state replacement. */
	onApply: (action: () => Promise<WorkspaceState>) => void;
	/** Runs a navigation or layout save without the busy state. */
	onLayout: (action: () => Promise<WorkspaceState>) => void;
	/** Opens the linked database Design's workspace. */
	onOpenDatabase: (designId: string) => void;
};

/**
 * The architecture overview: Services that own Components, generic and database
 * Components, and directed, labeled Connections between Components and
 * Services. Pan, zoom, and drag change the view or one item; every edit goes
 * through the workspace so it is saved, undoable, and visible to the Assistant
 * the same way.
 */
export function SystemDesignView({ state, client, onApply, onLayout, onOpenDatabase }: SystemDesignViewProps) {
	const design = state.systemDesign ?? null;
	const designs = state.designs ?? [];
	const containerRef = useRef<HTMLDivElement>(null);
	/** The Service whose focused view is open, or null for the overview. */
	const focusedServiceId = design?.focusedServiceId ?? null;
	/** The saved camera of the view on screen: the focused view's own camera, or the overview's. */
	const savedViewport = design ? (focusedServiceId ? design.focusViewport : design.viewport) : null;
	const [viewport, setViewport] = useState<CanvasViewport>(savedViewport ?? { x: 0, y: 0, zoom: 1 });
	const [selection, setSelection] = useState<Selection>(null);
	const [connectingFrom, setConnectingFrom] = useState<string | null | undefined>(undefined);
	/** The members chosen so far for a new Group, or null when not choosing. */
	const [grouping, setGrouping] = useState<string[] | null>(null);
	const [drag, setDrag] = useState<Drag | null>(null);
	const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
	const [walkthroughsOpen, setWalkthroughsOpen] = useState(false);
	const [diagramExport, setDiagramExport] = useState<DiagramExportStatus | null>(null);
	const [walkthroughSelection, setWalkthroughSelection] = useState<WalkthroughSelection | null>(null);
	/** Optional: center the overview on each step's interaction. Manual pan or zoom turns it off. */
	const [followCamera, setFollowCamera] = useState(false);
	const pan = useRef<Pan | null>(null);
	const interacting = useRef(false);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** The camera waiting to be saved, with the view it was moved in: the overview (null) or a focused Service. */
	const pendingCamera = useRef<{ serviceId: string | null } | null>(null);
	const latestViewport = useRef(viewport);
	/** Updates the viewport at once, so back-to-back wheel events build on each other. */
	function setLocalViewport(next: CanvasViewport) {
		latestViewport.current = next;
		setViewport(next);
	}

	// Server state replaces the local viewport only when no pan or zoom is in progress.
	useEffect(() => {
		if (!interacting.current && savedViewport) setLocalViewport(savedViewport);
	}, [savedViewport]);

	useEffect(() => () => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
	}, []);

	// The focused view is a projection of the same design: its Service, owned Components, and outside endpoints of their Connections.
	const focus = useMemo(
		() => (design && focusedServiceId && findSystemService(design, focusedServiceId) ? systemServiceFocus(design, focusedServiceId) : null),
		[design, focusedServiceId],
	);
	// The drawn scene is what is shown, with any gesture in progress applied.
	const shown = focus?.scene ?? design;
	const scene = useMemo(() => (shown ? previewScene(shown, drag?.scene ?? null) : null), [shown, drag]);
	const cardsOverlap = useMemo(() => scene ? systemCardsOverlap(scene) : false, [scene]);
	const geometries = useMemo(() => (scene ? connectionGeometries(scene) : []), [scene]);
	const routes = useMemo(() => playbackRoutes(geometries), [geometries]);
	const reducedMotion = usePrefersReducedMotion();
	const selectedWalkthrough = walkthroughSelection
		? findWalkthrough(state.walkthroughs ?? [], walkthroughSelection.walkthroughId) ?? null
		: null;
	// Playback runs on the drawn scene, so a dragged Component's route moves with the message.
	// Playback compiles against the whole overview, so a Walkthrough is valid in any focused view. Routes come from the drawn
	// scene: a step whose Connection the focused view does not show has no message to draw, and its reactions still play.
	const playback = useWalkthroughPlayback({ walkthrough: selectedWalkthrough, design, routes, reducedMotion });
	const frame = playback.active?.frame ?? null;
	const activeStepIndex = frame?.stepIndex ?? null;

	// Follow centers the canvas once when a step starts or the clock seeks to a different step.
	// Routes are not a dependency, so dragging a Component does not keep moving the camera.
	useEffect(() => {
		const container = containerRef.current;
		if (!followCamera || !frame || !container) return;
		const route = routes.get(frame.step.connectionId);
		if (!route) return;
		const rect = container.getBoundingClientRect();
		setLocalViewport(followViewport(latestViewport.current, route, { width: rect.width, height: rect.height }));
	}, [followCamera, activeStepIndex]);

	if (!design || !scene) {
		return (
			<div className="flex h-full items-center justify-center text-ink-3">
				<p className="font-display italic text-[17px]">Opening the system overview…</p>
			</div>
		);
	}

	const selectedComponent = selection?.kind === "component" ? findSystemComponent(design, selection.id) ?? null : null;
	const selectedService = selection?.kind === "service" ? findSystemService(design, selection.id) ?? null : null;
	const selectedConnection = selection?.kind === "connection" ? findSystemConnection(design, selection.id) ?? null : null;
	const selectedGroup = selection?.kind === "group" ? findSystemGroup(design, selection.id) ?? null : null;
	const serviceNames = new Map(design.services.map((service) => [service.id, service.name]));
	/** While a Walkthrough clock is in use it traces the playing step; otherwise the open step is traced. */
	const highlight: WalkthroughHighlight | null = frame
		? frame.highlight
		: walkthroughSelection?.stepId
			? selectedWalkthroughHighlight(state.walkthroughs ?? [], design, walkthroughSelection.walkthroughId, walkthroughSelection.stepId)
			: null;

	/** Saves the waiting camera to the view it was moved in. Navigation is presentation, so it does not enter Undo. */
	function flushCamera() {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = null;
		interacting.current = false;
		const pending = pendingCamera.current;
		pendingCamera.current = null;
		if (!pending) return;
		const current = latestViewport.current;
		onLayout(() => (pending.serviceId === null
			? client.setSystemViewport(current)
			: client.setSystemFocus(pending.serviceId, current)));
	}

	function scheduleViewportSave(next: CanvasViewport) {
		// A camera moved in another view saves first, so it can never land on this one.
		if (pendingCamera.current && pendingCamera.current.serviceId !== focusedServiceId) flushCamera();
		interacting.current = true;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		pendingCamera.current = { serviceId: focusedServiceId };
		saveTimer.current = setTimeout(flushCamera, SAVE_DEBOUNCE_MS);
		setLocalViewport(next);
	}

	/**
	 * Opens the focused view of one Service, framed so it and the outside endpoints
	 * of its Connections are visible. The Service's content is not copied: the
	 * view draws the same identities the overview draws.
	 */
	function focusService(serviceId: string) {
		const projected = systemServiceFocus(design!, serviceId).scene;
		const bounds = sceneBounds(projected);
		if (!bounds) return;
		const rect = containerRef.current?.getBoundingClientRect();
		const camera = fitViewport(bounds, { width: rect?.width ?? 800, height: rect?.height ?? 600 });
		flushCamera();
		setConnectingFrom(undefined);
		setGrouping(null);
		setFollowCamera(false);
		setSelection(selectionInScene(selection, projected));
		setLocalViewport(camera);
		onLayout(() => client.setSystemFocus(serviceId, camera));
	}

	/** Returns to the overview with its own camera. The focused view's camera is saved first. */
	function leaveFocus() {
		flushCamera();
		setConnectingFrom(undefined);
		setGrouping(null);
		setFollowCamera(false);
		setLocalViewport(design!.viewport);
		onLayout(() => client.setSystemFocus(null));
	}

	/**
	 * Writes the presented view as a standalone SVG or a PNG of the same drawing. Both
	 * are built from a copy taken before the first await, so an edit made while the
	 * picker is open cannot change what is written. The PNG is rasterized before the
	 * picker opens, so a rasterizing failure never leaves a picker or a partial file.
	 * The renderer, font, and rasterizer load only when exporting.
	 */
	async function exportDiagram(format: "svg" | "png") {
		const snapshot = structuredClone(design!);
		const projectName = state.project?.name ?? "System design";
		const label = format.toUpperCase();
		setDiagramExport(null);
		try {
			const [{ embeddedFontFaceCss, systemDesignSvg }, fontDataUrl] = await Promise.all([
				import("./system-design-svg"),
				systemDesignSvgFontDataUrl(),
			]);
			const svg = systemDesignSvg(snapshot, { title: projectName, fontFaceCss: embeddedFontFaceCss(fontDataUrl) });
			const result =
				format === "svg"
					? await client.exportSystemDesignSvg({ svg, projectName })
					: await exportPngFromSvg(svg, projectName);
			if (result.status === "saved") setDiagramExport({ tone: "saved", message: `Exported the System design to ${result.path}` });
			else if (result.status === "cancelled") setDiagramExport({ tone: "cancelled", message: `${label} export cancelled.` });
			else setDiagramExport({ tone: "failed", message: `${label} export failed: ${result.error}` });
		} catch (cause) {
			setDiagramExport({ tone: "failed", message: `${label} export failed: ${errorMessage(cause)}` });
		}
	}

	async function exportPngFromSvg(svg: string, projectName: string) {
		const { bytesToBase64, rasterizeSystemDesignSvg } = await import("./system-design-png");
		const png = bytesToBase64(await rasterizeSystemDesignSvg(svg));
		return client.exportSystemDesignPng({ png, projectName });
	}

	function pointerInContainer(event: { clientX: number; clientY: number }): CanvasPoint {
		const rect = containerRef.current?.getBoundingClientRect();
		return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
	}

	function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
		const point = pointerInContainer(event);
		const factor = Math.exp(-event.deltaY * 0.0015);
		setFollowCamera(false);
		scheduleViewportSave(zoomAroundPoint(latestViewport.current, point, latestViewport.current.zoom * factor));
	}

	function handleBackgroundPointerDown(event: React.PointerEvent<HTMLDivElement>) {
		// Toolbar buttons and overlays sit inside the canvas. Their presses must reach them, not capture the pointer for a pan.
		const onBackground = event.target === event.currentTarget || event.target instanceof SVGElement;
		if (event.button !== 0 || !onBackground) return;
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
			const moved = drag.moved || movedBeyondThreshold(drag.pointerStart, point);
			setDrag({ ...drag, moved, scene: sceneAfterPointer(drag, dx, dy) });
			return;
		}
		const active = pan.current;
		if (active) {
			const moved = active.moved || movedBeyondThreshold(active.pointerStart, point);
			pan.current = { ...active, moved };
			if (!moved) return;
			setFollowCamera(false);
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
			if (finished.moved) commitScene(finished.scene);
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

	/** Saves a finished gesture as one action: a move or resize of one frame or item. */
	function commitScene(gesture: SceneDrag) {
		if (gesture.mode === "component") {
			const { id, position } = gesture;
			onApply(() => client.moveSystemComponent(id, position));
		} else if (gesture.mode === "service") {
			const { id, position } = gesture;
			onApply(() => client.moveSystemService(id, position));
		} else if (gesture.mode === "group") {
			const { id, position } = gesture;
			onApply(() => client.moveSystemGroup(id, position));
		} else if (gesture.mode === "group-resize") {
			const { id, size } = gesture;
			onApply(() => client.resizeSystemGroup(id, size));
		} else if (gesture.mode === "bend" || gesture.mode === "label") {
			// The whole gesture saves once, from the connection as the preview shows it.
			const after = findSystemConnection(previewScene(design!, gesture), gesture.id);
			if (!after) return;
			const changes = gesture.mode === "bend" ? { bendPoints: after.bendPoints ?? [] } : { labelOffset: after.labelOffset ?? null };
			onApply(() => client.updateSystemConnection(gesture.id, changes));
		} else if (gesture.mode === "resize") {
			const { id, size } = gesture;
			onApply(() => client.resizeSystemService(id, size));
		}
	}

	function startDrag(event: React.PointerEvent<SVGElement>, gesture: SceneDrag, origin: CanvasPoint, originSize: SystemServiceSize) {
		event.currentTarget.setPointerCapture(event.pointerId);
		setDrag({ scene: gesture, pointerStart: pointerInContainer(event), origin, originSize, moved: false });
	}

	function handleComponentPointerDown(event: React.PointerEvent<SVGGElement>, component: SystemComponent) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		startDrag(
			event,
			{ mode: "component", id: component.id, position: component.position },
			component.position,
			SYSTEM_SERVICE_MIN_SIZE,
		);
	}

	function handleServicePointerDown(event: React.PointerEvent<SVGGElement>, service: SystemService) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		startDrag(event, { mode: "service", id: service.id, position: service.position }, service.position, service.size);
	}

	function handleResizePointerDown(event: React.PointerEvent<SVGRectElement>, service: SystemService) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		startDrag(event, { mode: "resize", id: service.id, size: service.size }, service.position, service.size);
	}

	function handleGroupPointerDown(event: React.PointerEvent<SVGGElement>, group: SystemGroup) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		startDrag(event, { mode: "group", id: group.id, position: group.position }, group.position, group.size);
	}

	function handleGroupResizePointerDown(event: React.PointerEvent<SVGRectElement>, group: SystemGroup) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		startDrag(event, { mode: "group-resize", id: group.id, size: group.size }, group.position, group.size);
	}

	/** A bend point is dragged from its authored position, so the handle stays under the pointer as the route bends. */
	function handleBendPointerDown(event: React.PointerEvent<SVGCircleElement>, connection: SystemConnection, index: number) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		const point = connection.bendPoints?.[index];
		if (!point) return;
		startDrag(event, { mode: "bend", id: connection.id, index, point }, point, SYSTEM_SERVICE_MIN_SIZE);
	}

	/** Only a selected Connection's label moves, so a press on an unselected label still just selects it. */
	function handleLabelPointerDown(event: React.PointerEvent<SVGGElement>, connection: SystemConnection) {
		event.stopPropagation();
		if (event.button !== 0 || connectingFrom !== undefined) return;
		const offset = connection.labelOffset ?? { x: 0, y: 0 };
		startDrag(event, { mode: "label", id: connection.id, offset }, offset, SYSTEM_SERVICE_MIN_SIZE);
	}

	function handleComponentClick(component: SystemComponent) {
		if (connectingFrom !== undefined) {
			connectEndpoint(component.id);
			return;
		}
		if (grouping !== null) {
			toggleGroupingMember(component.id);
			return;
		}
		setSelection({ kind: "component", id: component.id });
	}

	function handleServiceClick(service: SystemService) {
		if (connectingFrom !== undefined) {
			connectEndpoint(service.id);
			return;
		}
		if (grouping !== null) {
			toggleGroupingMember(service.id);
			return;
		}
		setSelection({ kind: "service", id: service.id });
	}

	function handleGroupClick(group: SystemGroup) {
		if (connectingFrom !== undefined) return;
		if (grouping !== null) {
			toggleGroupingMember(group.id);
			return;
		}
		setSelection({ kind: "group", id: group.id });
	}

	function toggleGroupingMember(id: string) {
		setGrouping((current) => {
			if (current === null) return current;
			return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
		});
	}

	/** Encloses the chosen members in a new Group. The frame only starts the layout; membership is exactly the chosen list. */
	function createGroup() {
		if (grouping === null || grouping.length === 0) return;
		const frame = groupFrameAround(design!, grouping);
		if (!frame) return;
		const id = crypto.randomUUID();
		const memberIds = grouping;
		setGrouping(null);
		setSelection({ kind: "group", id });
		onApply(() => client.addSystemGroup({
			id,
			memberIds,
			x: frame.position.x,
			y: frame.position.y,
			width: frame.size.width,
			height: frame.size.height,
		}));
	}

	/** Connect mode accepts a Component or a Service as either end of the interaction. */
	function connectEndpoint(endpointId: string) {
		if (connectingFrom === undefined) return;
		if (connectingFrom === null) {
			setConnectingFrom(endpointId);
			return;
		}
		if (connectingFrom === endpointId) {
			setConnectingFrom(null);
			return;
		}
		const id = crypto.randomUUID();
		const sourceId = connectingFrom;
		setConnectingFrom(undefined);
		setSelection({ kind: "connection", id });
		onApply(() => client.addSystemConnection({ id, sourceId, targetId: endpointId, label: DEFAULT_SYSTEM_CONNECTION_LABEL }));
	}

	/**
	 * Shows a Service collapsed or expanded. This is view presentation saved with
	 * the design, so it stays out of Undo. A Component that the collapse hides
	 * leaves the selection and any pending Connection.
	 */
	function setServiceCollapsed(serviceId: string, collapsed: boolean) {
		const hidden = collapsed
			? design!.components.filter((component) => component.serviceId === serviceId).map((component) => component.id)
			: [];
		if (selection?.kind === "component" && hidden.includes(selection.id)) setSelection(null);
		if (connectingFrom && hidden.includes(connectingFrom)) setConnectingFrom(undefined);
		onLayout(() => client.setSystemServiceCollapsed(serviceId, collapsed));
	}

	function visibleCenter(): CanvasPoint {
		const rect = containerRef.current?.getBoundingClientRect();
		return screenToWorld({ x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 }, latestViewport.current);
	}

	/** In a focused view a new Component is owned by the focused Service and placed at its center. */
	function addComponent(kind: SystemComponentKind = "generic") {
		const focused = focusedServiceId ? findSystemService(design!, focusedServiceId) : undefined;
		const center = focused
			? { x: focused.position.x + focused.size.width / 2, y: focused.position.y + focused.size.height / 2 }
			: visibleCenter();
		const spot = openSpotNear(design!, center);
		const id = crypto.randomUUID();
		setSelection({ kind: "component", id });
		onApply(() => client.addSystemComponent({ id, kind, x: spot.x, y: spot.y, serviceId: focused?.id ?? null }));
	}

	function addService() {
		const spot = openServiceSpotNear(design!, visibleCenter());
		const id = crypto.randomUUID();
		setSelection({ kind: "service", id });
		onApply(() => client.addSystemService({ id, x: spot.x, y: spot.y }));
	}

	function confirmRemoval() {
		if (!pendingRemoval) return;
		const removal = pendingRemoval;
		setPendingRemoval(null);
		setSelection(null);
		if (removal.kind === "component") {
			const componentId = removal.plan.componentId;
			onApply(() => client.removeSystemComponent(componentId));
		} else if (removal.kind === "service") {
			const serviceId = removal.plan.serviceId;
			onApply(() => client.removeSystemService(serviceId));
		} else {
			const connectionId = removal.plan.connectionId;
			onApply(() => client.removeSystemConnection(connectionId));
		}
	}

	/** Lists what the removal changes in the displayed design; the workspace checks again on confirm. */
	function openComponentRemoval(componentId: string) {
		const plan = describeSystemComponentRemoval(design!, componentId);
		setPendingRemoval({ kind: "component", plan, walkthroughSteps: stepsOnConnections(plan.connections) });
	}

	function openServiceRemoval(serviceId: string) {
		const plan = describeSystemServiceRemoval(design!, serviceId);
		setPendingRemoval({ kind: "service", plan, walkthroughSteps: stepsOnConnections(plan.connections) });
	}

	/** A Connection no Walkthrough plays is removed at once; one that a step plays is confirmed first, because its steps go dangling. */
	function requestConnectionRemoval(connectionId: string) {
		setSelection(null);
		const walkthroughSteps = stepsOnConnections([{ id: connectionId }]);
		if (walkthroughSteps.length === 0) {
			onApply(() => client.removeSystemConnection(connectionId));
			return;
		}
		const plan = describeSystemConnectionRemoval(design!, connectionId);
		setPendingRemoval({ kind: "connection", plan, walkthroughSteps });
	}

	function stepsOnConnections(connections: { id: string }[]): AffectedWalkthroughStep[] {
		return walkthroughStepsOnConnections(state.walkthroughs ?? [], connections.map((connection) => connection.id));
	}

	function handleBackgroundClick() {
		if (connectingFrom !== undefined) setConnectingFrom(undefined);
		setSelection(null);
	}

	function zoomBy(factor: number) {
		setFollowCamera(false);
		const rect = containerRef.current?.getBoundingClientRect();
		const center = { x: (rect?.width ?? 800) / 2, y: (rect?.height ?? 600) / 2 };
		scheduleViewportSave(zoomAroundPoint(latestViewport.current, center, latestViewport.current.zoom * factor));
	}

	function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
		if (isEditingText(event.target)) return;
		if (event.key === "Escape") {
			setConnectingFrom(undefined);
			setGrouping(null);
			setSelection(null);
			return;
		}
		if ((event.key === "Delete" || event.key === "Backspace") && selection) {
			event.preventDefault();
			if (selection.kind === "connection") {
				requestConnectionRemoval(selection.id);
			} else if (selection.kind === "group") {
				// Removing a Group keeps its members, so it needs no confirmation.
				const id = selection.id;
				setSelection(null);
				onApply(() => client.removeSystemGroup(id));
			} else if (selection.kind === "service") {
				openServiceRemoval(selection.id);
			} else {
				openComponentRemoval(selection.id);
			}
		}
	}

	const hasItems = design.components.length > 0 || design.services.length > 0 || design.groups.length > 0;
	// Counts come from what is drawn: a focused view has fewer endpoints, and it has no Groups to enclose.
	const endpointCount = scene.components.length + scene.services.length;
	const memberCount = endpointCount + scene.groups.length;

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
					playback={playback}
					followCamera={{ enabled: followCamera, onChange: setFollowCamera }}
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
						{scene.groups.map((group) => {
							const picked = grouping?.includes(group.id) ?? false;
							const selected = selection?.kind === "group" && selection.id === group.id;
							const emphasized = selected || picked;
							const { width, height } = group.size;
							return (
								<g
									key={group.id}
									data-group-id={group.id}
									data-member-count={group.memberIds.length}
									transform={`translate(${group.position.x} ${group.position.y})`}
									aria-label={`Group: ${group.name}`}
									aria-pressed={grouping !== null ? picked : selected}
								>
									<rect
										width={width}
										height={height}
										rx={16}
										pointerEvents="none"
										strokeDasharray="2 4"
										strokeWidth={emphasized ? 2 : 1}
										style={{
											fill: "var(--color-paper-tint)",
											fillOpacity: 0.55,
											stroke: emphasized ? "var(--color-pencil)" : "var(--color-ink-3)",
										}}
									/>
								</g>
							);
						})}
						{scene.services.map((service) => {
							const selected = selection?.kind === "service" && selection.id === service.id;
							const linking = connectingFrom === service.id;
							const collapsed = isSystemServiceCollapsed(scene, service.id);
							// An outside Service in a focused view is a compact context boundary, not a frame with contents.
							const context = focus?.contextIds.has(service.id) ?? false;
							// A collapsed Service speaks for the Components it hides: they are traced and react on its boundary.
							const owned = collapsed ? scene.components.filter((component) => component.serviceId === service.id) : [];
							const traced = (highlight?.endpointIds.includes(service.id) ?? false)
								|| owned.some((component) => highlight?.endpointIds.includes(component.id));
							// The boundary shows the strongest reaction among itself and the Components it hides, so one parallel step never hides another.
							const reaction = strongestReaction(frame?.reactions ?? {}, [service.id, ...owned.map((component) => component.id)]);
							// An internal step has no drawn route, so while it runs the boundary names it in place of the static summary.
							const hiddenStep = collapsed && frame && playback.timeline
								? hiddenActivityStep(playback.timeline, frame, new Set(owned.map((component) => component.id)))
								: null;
							const { width, height } = collapsed ? SYSTEM_SERVICE_COLLAPSED_SIZE : service.size;
							const internal = collapsed ? internalConnectionCount(scene, service.id) : 0;
							const summary = `${owned.length} ${owned.length === 1 ? "component" : "components"}${internal > 0 ? ` · ${internal} internal` : ""}`;
							const compact = collapsed || context;
							return (
								<g
									key={service.id}
									data-service-id={service.id}
									data-collapsed={collapsed ? "true" : "false"}
									data-context={context ? "true" : undefined}
									transform={`translate(${service.position.x} ${service.position.y})`}
									role="button"
									tabIndex={0}
									aria-label={`Service: ${service.name}`}
									aria-pressed={selected}
									className="cursor-pointer"
									onPointerDown={(event) => handleServicePointerDown(event, service)}
									onClick={(event) => {
										event.stopPropagation();
										handleServiceClick(service);
									}}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											handleServiceClick(service);
										}
									}}
								>
									<title>{service.name}</title>
									{reaction && <ReactionTag reaction={reaction} kind="generic" x={0} y={-12} />}
									{reaction && <ReactionRing reaction={reaction} width={width} height={height} radius={18} />}
									<rect
										width={width}
										height={height}
										rx={14}
										strokeDasharray="7 5"
										strokeWidth={selected || linking || traced ? 2 : 1.25}
										style={{
											fill: "var(--color-paper-tint)",
											stroke: selected || linking || traced ? "var(--color-pencil)" : "var(--color-rule-strong)",
										}}
									/>
									<text x={16} y={24} fontSize={10} letterSpacing={1.1} style={{ fill: "var(--color-ink-3)" }}>
										{context ? "SERVICE · OUTSIDE" : collapsed ? "SERVICE · COLLAPSED" : "SERVICE"}
									</text>
									<text x={16} y={46} fontSize={15} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
										{truncateLabel(service.name, compact ? 22 : 32)}
									</text>
									{collapsed && hiddenStep && (
										<text x={16} y={66} fontSize={11.5} data-testid="collapsed-service-activity" style={{ fill: "var(--color-pencil)" }}>
											{truncateLabel(hiddenStep.title || "Internal step", 30)}
										</text>
									)}
									{collapsed && !hiddenStep && (
										<text x={16} y={66} fontSize={11.5} data-testid="collapsed-service-summary" style={{ fill: "var(--color-ink-2)" }}>
											{summary}
										</text>
									)}
									{!focus && (
										<g
											data-testid="service-focus-button"
											role="button"
											tabIndex={0}
											aria-label={`Focus ${service.name}`}
											transform={`translate(${width - 70} 10)`}
											className="cursor-pointer"
											onPointerDown={(event) => event.stopPropagation()}
											onClick={(event) => {
												event.stopPropagation();
												focusService(service.id);
											}}
											onKeyDown={(event) => {
												if (event.key === "Enter" || event.key === " ") {
													event.preventDefault();
													event.stopPropagation();
													focusService(service.id);
												}
											}}
										>
											<rect width={58} height={20} rx={10} style={{ fill: "var(--color-paper-raised)", stroke: "var(--color-rule-strong)" }} />
											<text x={29} y={10} textAnchor="middle" dominantBaseline="central" fontSize={10} letterSpacing={1} style={{ fill: "var(--color-ink-2)" }}>
												FOCUS
											</text>
										</g>
									)}
									{!compact && (
										<rect
											data-testid="service-resize-handle"
											x={width - 14}
											y={height - 14}
											width={10}
											height={10}
											rx={2}
											className="cursor-nwse-resize"
											style={{ fill: selected ? "var(--color-pencil)" : "var(--color-rule-strong)" }}
											onPointerDown={(event) => handleResizePointerDown(event, service)}
											onClick={(event) => event.stopPropagation()}
										/>
									)}
								</g>
							);
						})}
						{geometries.map(({ connection, pathString, labelPoint, bendPoints }) => {
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
										onPointerDown={(event) => (selected ? handleLabelPointerDown(event, connection) : event.stopPropagation())}
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
									{selected && bendPoints.map((point, index) => (
										<circle
											key={index}
											data-bend-handle={connection.id}
											cx={point.x}
											cy={point.y}
											r={5}
											className="cursor-move"
											onPointerDown={(event) => handleBendPointerDown(event, connection, index)}
											onClick={(event) => event.stopPropagation()}
											style={{ fill: "var(--color-paper-raised)", stroke: "var(--color-pencil)", strokeWidth: 1.5 }}
										/>
									))}
								</g>
							);
						})}
						{scene.groups.map((group) => {
							// Headers and resize handles sit above Services and Components so a frame stays reachable where a boundary overlaps it.
							const selected = selection?.kind === "group" && selection.id === group.id;
							const picked = grouping?.includes(group.id) ?? false;
							const emphasized = selected || picked;
							const { width, height } = group.size;
							return (
								<g
									key={`handles-${group.id}`}
									data-group-handles={group.id}
									transform={`translate(${group.position.x} ${group.position.y})`}
								>
									<g
										role="button"
										tabIndex={0}
										aria-label={`Group: ${group.name}`}
										aria-pressed={grouping !== null ? picked : selected}
										className="cursor-grab active:cursor-grabbing"
										onPointerDown={(event) => handleGroupPointerDown(event, group)}
										onClick={(event) => {
											event.stopPropagation();
											handleGroupClick(group);
										}}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												handleGroupClick(group);
											}
										}}
									>
										<title>{group.name}</title>
										<rect
											width={width}
											height={GROUP_HEADER_HEIGHT}
											rx={16}
											style={{
												fill: "var(--color-paper-raised)",
												stroke: emphasized ? "var(--color-pencil)" : "var(--color-rule-strong)",
											}}
											strokeWidth={emphasized ? 2 : 1}
										/>
										<text x={14} y={16} fontSize={10} letterSpacing={1.1} style={{ fill: "var(--color-ink-3)" }}>
											GROUP · {group.memberIds.length}
										</text>
										<text x={14} y={32} fontSize={13.5} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
											{truncateLabel(group.name, 36)}
										</text>
									</g>
									<rect
										data-testid="group-resize-handle"
										x={width - 14}
										y={height - 14}
										width={10}
										height={10}
										rx={2}
										className="cursor-nwse-resize"
										style={{ fill: selected ? "var(--color-pencil)" : "var(--color-rule-strong)" }}
										onPointerDown={(event) => handleGroupResizePointerDown(event, group)}
										onClick={(event) => event.stopPropagation()}
									/>
								</g>
							);
						})}
						{frame?.messages.map((message, index) => <WalkthroughMessageDot key={`${message.connectionId}:${index}`} message={message} />)}
						{scene.components.filter((component) => !isComponentHiddenByCollapse(scene, component.id)).map((component) => {
							const selected = selection?.kind === "component" && selection.id === component.id;
							const linking = connectingFrom === component.id;
							const traced = highlight?.endpointIds.includes(component.id) ?? false;
							const reaction = frame?.reactions[component.id];
							const detail = component.technology ?? component.description ?? "";
							// Names and metadata sit below the illustration.
							const context = focus?.contextIds.has(component.id) ?? false;
							const kindHeaderText = `${componentKindLabel(component.kind).toUpperCase()}${context ? " · OUTSIDE" : ""}`;
							// The owner is the real one, even where a focused view draws the Component outside its Service.
							const ownerId = findSystemComponent(design, component.id)?.serviceId ?? null;
							const owner = ownerId === null ? undefined : serviceNames.get(ownerId);
							return (
								<g
									key={component.id}
									data-component-id={component.id}
									data-kind={component.kind}
									data-context={context ? "true" : undefined}
									data-service-id={component.serviceId ?? undefined}
									transform={`translate(${component.position.x} ${component.position.y})`}
									role="button"
									tabIndex={0}
									aria-label={`${componentKindLabel(component.kind)}: ${component.name}`}
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
									{reaction && <ReactionTag reaction={reaction} kind={component.kind} x={0} y={-12} />}
									{reaction && (
										<ReactionRing
											reaction={reaction}
											width={SYSTEM_COMPONENT_SIZE.width}
											height={SYSTEM_COMPONENT_SIZE.height}
											radius={14}
										/>
									)}
									<rect
										width={SYSTEM_COMPONENT_SIZE.width}
										height={SYSTEM_COMPONENT_SIZE.height}
										rx={14}
										strokeDasharray={context ? "5 4" : undefined}
										style={{
											fill: "var(--color-paper-raised)",
											stroke: selected || linking || traced ? "var(--color-pencil)" : "var(--color-rule-strong)",
										}}
										strokeWidth={selected || linking || traced ? 2 : 1.25}
									/>
									<text x={14} y={153} fontSize={8.5} letterSpacing={0.4} style={{ fill: "var(--color-ink-3)" }}>
										{kindHeaderText}
									</text>
									<ComponentArtwork artwork={component.kind} icon={component.icon} time={componentArtworkTime(component.id, frame, playback.timeline, reducedMotion)} />
									<text x={14} y={136} fontSize={14} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
										{truncateLabel(component.name, 22)}
									</text>
									<text x={14} y={170} fontSize={11} style={{ fill: "var(--color-ink-2)" }}>
										{truncateLabel(detail, 28)}
									</text>
									{component.kind === "database" && component.designId && (
										<text x={SYSTEM_COMPONENT_SIZE.width - 14} y={22} textAnchor="end" fontSize={10} style={{ fill: "var(--color-pencil)" }} data-testid="schema-link-badge">
											{componentsLinkedToDesign(design, component.designId).length > 1 ? "SHARED" : "LINKED"}
										</text>
									)}
									{owner !== undefined && (
										<text x={SYSTEM_COMPONENT_SIZE.width - 14} y={SYSTEM_COMPONENT_SIZE.height - 10} textAnchor="end" fontSize={10} style={{ fill: "var(--color-ink-3)" }}>
											{truncateLabel(`in ${owner}`, 26)}
										</text>
									)}
								</g>
							);
						})}
					</g>
				</svg>

				{!hasItems && (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
						<div className="max-w-sm">
							<p className="font-display text-[20px] italic text-ink-2">Sketch the system</p>
							<p className="mt-2 text-[13px] text-ink-3">
								Add services and components, then connect them with labeled interactions. Each connection describes one way the parts talk.
							</p>
						</div>
					</div>
				)}

				<div className="absolute left-4 top-4 flex max-w-[calc(100%-2rem)] flex-wrap items-center gap-1.5 rounded-md border border-rule-soft bg-paper-raised/95 p-1.5 shadow-xs">
					{focus ? (
						<>
							<Button type="button" size="sm" variant="outline" onClick={leaveFocus} data-testid="system-focus-back">
								<ArrowLeft className="size-3.5" />
								Overview
							</Button>
							<span
								data-testid="system-focus-name"
								className="max-w-[180px] truncate px-1 text-[12.5px] font-medium text-ink"
								title={serviceNames.get(focusedServiceId!)}
							>
								{serviceNames.get(focusedServiceId!)}
							</span>
						</>
					) : (
						<Button type="button" size="sm" variant="outline" onClick={addService}>
							<Frame className="size-3.5" />
							Add service
						</Button>
					)}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="sm" variant="outline">
								<Plus className="size-3.5" />
								Add component
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-56">
							<DropdownMenuItem onSelect={() => addComponent("generic")}>Component</DropdownMenuItem>
							{(Object.keys(COMPONENT_FAMILY_LABELS) as ComponentFamily[]).map((family) => (
								<DropdownMenuGroup key={family}>
									<DropdownMenuSeparator />
									<DropdownMenuLabel>{COMPONENT_FAMILY_LABELS[family]}</DropdownMenuLabel>
									{COMPONENT_CATALOG.filter((entry) => entry.family === family).map((entry) => (
										<DropdownMenuItem key={entry.kind} data-kind={entry.kind} onSelect={() => addComponent(entry.kind)}>
											{entry.label}
										</DropdownMenuItem>
									))}
								</DropdownMenuGroup>
							))}
						</DropdownMenuContent>
					</DropdownMenu>
					<Button
						type="button"
						size="sm"
						variant={connectingFrom !== undefined ? "pencil" : "outline"}
						aria-pressed={connectingFrom !== undefined}
						onClick={() => {
							setGrouping(null);
							setConnectingFrom(connectingFrom === undefined ? null : undefined);
						}}
						disabled={endpointCount < 2}
					>
						<Link2 className="size-3.5" />
						{connectingFrom === undefined ? "Connect" : connectingFrom === null ? "Choose source" : "Choose target"}
					</Button>
					{/* Groups are drawn and edited in the overview; the focused view shows only one Service and its context. */}
					{!focus && (
						<Button
							type="button"
							size="sm"
							variant={grouping !== null ? "pencil" : "outline"}
							aria-pressed={grouping !== null}
							onClick={() => {
								setConnectingFrom(undefined);
								setGrouping(grouping === null ? [] : null);
							}}
							disabled={memberCount === 0}
						>
							<BoxSelect className="size-3.5" />
							Group
						</Button>
					)}
					<Button
						type="button"
						size="sm"
						variant={walkthroughsOpen ? "pencil" : "outline"}
						aria-pressed={walkthroughsOpen}
						onClick={() => {
							// Closing the panel also ends its selection, so playback cannot run without its controls.
							if (walkthroughsOpen) setWalkthroughSelection(null);
							setWalkthroughsOpen((open) => !open);
						}}
					>
						Walkthroughs
					</Button>
					{!focus && (
						<Button type="button" size="sm" variant="outline" disabled={!design.components.length}
							data-testid="arrange-system-cards"
							title="Space out components and fit their Service and Group boundaries. Can be undone."
							onClick={() => onApply(() => client.arrangeSystemLayout({ placement: computeSystemLayout(design) }))}>
							Arrange
						</Button>
					)}
					<Button type="button" size="sm" variant="outline" onClick={() => void exportDiagram("svg")} disabled={!hasItems} data-testid="export-system-svg">
						<Download className="size-3.5" />
						Export SVG
					</Button>
					<Button type="button" size="sm" variant="outline" onClick={() => void exportDiagram("png")} disabled={!hasItems} data-testid="export-system-png">
						<Download className="size-3.5" />
						Export PNG
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
				{cardsOverlap && !focus && (
					<div role="status" data-testid="system-cards-overlap"
						className="absolute bottom-12 left-4 flex max-w-[calc(100%-2rem)] items-center gap-3 rounded-md bg-paper-raised px-3 py-2 text-[12px] text-ink-2">
						<span>Some cards overlap. Arrange to make room.</span>
						<Button type="button" size="sm" variant="outline"
							onClick={() => onApply(() => client.arrangeSystemLayout({ placement: computeSystemLayout(design) }))}>
							Arrange
						</Button>
					</div>
				)}

				{diagramExport && (
					<p
						role={diagramExport.tone === "failed" ? "alert" : "status"}
						data-testid="system-diagram-export-status"
						className={cn(
							"absolute bottom-12 right-4 max-w-[60%] break-all rounded-md px-3 py-1.5 text-[12px]",
							diagramExport.tone === "failed" ? "bg-proof-red-wash text-proof-red" : "bg-paper-raised/95 text-ink-2 shadow-xs",
						)}
					>
						{diagramExport.message}
					</p>
				)}

				{frame && (
					<div
						role="status"
						aria-live="polite"
						data-testid="walkthrough-caption"
						className="pointer-events-none absolute bottom-4 left-1/2 w-[min(520px,calc(100%-2rem))] -translate-x-1/2 rounded-md border border-rule-soft bg-paper-raised/95 px-4 py-3 shadow-xs"
					>
						<p className="kicker">
							Step {frame.stepIndex + 1} of {playback.timeline?.steps.length ?? 0}
							{frame.complete ? " · Finished" : ""}
						</p>
						<p className="font-medium text-ink">{frame.step.title || "Untitled step"}</p>
						{frame.step.explanation && <p className="text-[13px] text-ink-2">{frame.step.explanation}</p>}
						{frame.step.exampleMessage && <p className="font-mono text-[12px] text-ink-3">{frame.step.exampleMessage}</p>}
					</div>
				)}

				{grouping !== null && (
					<div className="absolute bottom-4 left-4 flex flex-wrap items-center gap-2 rounded-md bg-paper-raised/95 px-3 py-1.5 text-[12px] text-ink-2 shadow-xs">
						<p>
							{grouping.length === 0
								? "Choose the components, services, or groups to enclose. Press Escape to cancel."
								: `${grouping.length} selected. Choose more, then create the group.`}
						</p>
						<Button type="button" size="sm" onClick={createGroup} disabled={grouping.length === 0}>
							Create group
						</Button>
						<Button type="button" size="sm" variant="outline" onClick={() => setGrouping(null)}>
							Cancel
						</Button>
					</div>
				)}

				{connectingFrom !== undefined && (
					<p className="absolute bottom-4 left-4 rounded-md bg-paper-raised/95 px-3 py-1.5 text-[12px] text-ink-2 shadow-xs">
						{connectingFrom === null
							? "Choose the component or service where the interaction starts. Press Escape to cancel."
							: "Choose the component or service the interaction reaches. Press Escape to cancel."}
					</p>
				)}
			</div>

			{(selectedComponent || selectedService || selectedConnection || selectedGroup) && (
				<aside
					aria-label="Selection"
					className="absolute right-4 top-4 bottom-4 flex w-[300px] max-w-[calc(100%-2rem)] flex-col overflow-y-auto rounded-md border border-rule-soft bg-paper-raised p-4 shadow-sm"
				>
					{selectedComponent && (
						<ComponentInspector
							key={`${selectedComponent.id}:${selectedComponent.kind}`}
							component={selectedComponent}
							design={design}
							designs={designs}
							onClose={() => setSelection(null)}
							onApply={onApply}
							client={client}
							onSelectConnection={(id) => setSelection({ kind: "connection", id })}
							onRequestRemove={() => openComponentRemoval(selectedComponent.id)}
							onOpenDatabase={onOpenDatabase}
						/>
					)}
					{selectedService && (
						<ServiceInspector
							key={selectedService.id}
							service={selectedService}
							design={design}
							client={client}
							onApply={onApply}
							onClose={() => setSelection(null)}
							onSelectComponent={(id) => setSelection({ kind: "component", id })}
							onSelectConnection={(id) => setSelection({ kind: "connection", id })}
							onRequestRemove={() => openServiceRemoval(selectedService.id)}
							collapsed={isSystemServiceCollapsed(design, selectedService.id)}
							onSetCollapsed={(collapsed) => setServiceCollapsed(selectedService.id, collapsed)}
							focused={focusedServiceId === selectedService.id}
							onFocus={() => focusService(selectedService.id)}
						/>
					)}
					{selectedGroup && (
						<GroupInspector
							key={selectedGroup.id}
							group={selectedGroup}
							design={design}
							client={client}
							onApply={onApply}
							onClose={() => setSelection(null)}
							onSelect={(kind, id) => setSelection({ kind, id })}
							onRemove={() => {
								const id = selectedGroup.id;
								setSelection(null);
								onApply(() => client.removeSystemGroup(id));
							}}
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
							onRemove={() => requestConnectionRemoval(selectedConnection.id)}
						/>
					)}
				</aside>
			)}

			<Dialog open={pendingRemoval !== null} onOpenChange={(open) => !open && setPendingRemoval(null)}>
				<DialogContent>
					{pendingRemoval && <RemovalSummary removal={pendingRemoval} />}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => setPendingRemoval(null)}>Cancel</Button>
						<Button type="button" variant="destructive" onClick={confirmRemoval}>
							{removalButtonLabel(pendingRemoval)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** Keeps a selection only while the drawn scene still shows it. Groups are not drawn in a focused view. */
function selectionInScene(selection: Selection, scene: SystemDesign): Selection {
	if (!selection) return null;
	if (selection.kind === "component") return scene.components.some((item) => item.id === selection.id) ? selection : null;
	if (selection.kind === "service") return scene.services.some((item) => item.id === selection.id) ? selection : null;
	if (selection.kind === "connection") return scene.connections.some((item) => item.id === selection.id) ? selection : null;
	return null;
}

/** The Service or Component a drag is moving, updated from the pointer's offset since the press. */
function sceneAfterPointer(drag: Drag, dx: number, dy: number): SceneDrag {
	const { scene } = drag;
	if (scene.mode === "resize") {
		return { mode: "resize", id: scene.id, size: resizedServiceSize(drag.originSize, dx, dy) };
	}
	if (scene.mode === "group-resize") {
		return { mode: "group-resize", id: scene.id, size: resizedGroupSize(drag.originSize, dx, dy) };
	}
	if (scene.mode === "bend") {
		return { ...scene, point: { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) } };
	}
	if (scene.mode === "label") {
		return { ...scene, offset: { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) } };
	}
	const position = { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) };
	if (scene.mode === "component") return { mode: "component", id: scene.id, position };
	if (scene.mode === "group") return { mode: "group", id: scene.id, position };
	return { mode: "service", id: scene.id, position };
}

function removalButtonLabel(removal: PendingRemoval | null): string {
	if (removal?.kind === "service") return "Remove service";
	if (removal?.kind === "connection") return "Remove connection";
	return "Remove component";
}

export function RemovalSummary({ removal }: { removal: PendingRemoval }) {
	if (removal.kind === "connection") {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Remove “{removal.plan.connectionLabel}”?</DialogTitle>
					<DialogDescription>
						{removal.walkthroughSteps.length} Walkthrough step{removal.walkthroughSteps.length === 1 ? "" : "s"} play this connection.
						They keep their text and become dangling until you repair them.
					</DialogDescription>
				</DialogHeader>
				<WalkthroughStepList steps={removal.walkthroughSteps} />
			</>
		);
	}
	const connections = removal.plan.connections;
	const connectionText = connections.length === 0
		? ""
		: `This also removes ${connections.length} connection${connections.length === 1 ? "" : "s"}:`;
	const stepText = removal.walkthroughSteps.length === 0
		? ""
		: `${removal.walkthroughSteps.length} Walkthrough step${removal.walkthroughSteps.length === 1 ? "" : "s"} will become dangling and keep ${removal.walkthroughSteps.length === 1 ? "its" : "their"} text.`;
	if (removal.kind === "component") {
		return (
			<>
				<DialogHeader>
					<DialogTitle>Remove “{removal.plan.componentName}”?</DialogTitle>
					<DialogDescription>{[connectionText || "No connections use this component.", stepText].filter(Boolean).join(" ")}</DialogDescription>
				</DialogHeader>
				{connections.length > 0 && <ConnectionList connections={connections} />}
				<WalkthroughStepList steps={removal.walkthroughSteps} />
			</>
		);
	}
	const released = removal.plan.releasedComponents;
	const releasedText = released.length === 0
		? "It owns no components."
		: `${released.length} component${released.length === 1 ? "" : "s"} will be released to system scope and keep their positions and connections.`;
	return (
		<>
			<DialogHeader>
				<DialogTitle>Remove “{removal.plan.serviceName}”?</DialogTitle>
				<DialogDescription>{[releasedText, connectionText, stepText].filter(Boolean).join(" ")}</DialogDescription>
			</DialogHeader>
			{released.length > 0 && (
				<ul className="max-h-40 space-y-1 overflow-y-auto text-[13px] text-ink-2" aria-label="Released components">
					{released.map((component) => (
						<li key={component.id} className="rounded-sm bg-paper-tint px-2 py-1">{component.name}</li>
					))}
				</ul>
			)}
			{connections.length > 0 && <ConnectionList connections={connections} />}
			<WalkthroughStepList steps={removal.walkthroughSteps} />
		</>
	);
}

/** The Walkthrough steps a removal leaves dangling, grouped by the Walkthrough they belong to. */
function WalkthroughStepList({ steps }: { steps: AffectedWalkthroughStep[] }) {
	if (steps.length === 0) return null;
	return (
		<ul className="max-h-48 space-y-1 overflow-y-auto text-[13px] text-ink-2" aria-label="Affected Walkthrough steps">
			{steps.map((step) => (
				<li key={`${step.walkthroughId}:${step.stepId}`} className="rounded-sm bg-proof-red-wash px-2 py-1 text-proof-red">
					{step.walkthroughName}: {step.title || "Untitled step"}
				</li>
			))}
		</ul>
	);
}

function ConnectionList({ connections }: { connections: SystemComponentRemovalPlan["connections"] }) {
	return (
		<ul className="max-h-48 space-y-1 overflow-y-auto text-[13px] text-ink-2">
			{connections.map((connection) => (
				<li key={connection.id} className="rounded-sm bg-paper-tint px-2 py-1">
					{connection.label}
				</li>
			))}
		</ul>
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
	designs,
	client,
	onApply,
	onClose,
	onSelectConnection,
	onRequestRemove,
	onOpenDatabase,
}: {
	component: SystemComponent;
	design: SystemDesign;
	designs: DatabaseDesignSummary[];
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onClose: () => void;
	onSelectConnection: (id: string) => void;
	onRequestRemove: () => void;
	onOpenDatabase: (designId: string) => void;
}) {
	const [name, setName] = useState(component.name);
	const [technology, setTechnology] = useState(component.technology ?? "");
	const [description, setDescription] = useState(component.description ?? "");
	/** Free-form rows: the properties that are not this kind's suggested descriptors. */
	const [freeRows, setFreeRows] = useState(() => component.properties.filter((property) => !descriptorKeysFor(component.kind).includes(property.key)));
	/** Unsaved descriptor text, by descriptor key; a missing key shows the saved value. */
	const [descriptorDrafts, setDescriptorDrafts] = useState<Record<string, string>>({});
	const descriptors = catalogEntryFor(component.kind)?.descriptors ?? [];
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
	function commitProperties(next: typeof freeRows) {
		const cleaned = next.map((item) => ({ key: item.key.trim(), value: item.value }));
		if (cleaned.some((item) => item.key.length === 0)) return;
		const merged = mergeFreeProperties(component.properties, component.kind, cleaned);
		if (JSON.stringify(merged) === JSON.stringify(component.properties)) return;
		onApply(() => client.updateSystemComponent(component.id, { properties: merged }));
	}
	function commitDescriptor(key: string) {
		const value = (descriptorDrafts[key] ?? descriptorValue(component.properties, key)).trim();
		setDescriptorDrafts((drafts) => ({ ...drafts, [key]: value }));
		const next = withDescriptorValue(component.properties, key, value);
		if (JSON.stringify(next) === JSON.stringify(component.properties)) return;
		onApply(() => client.updateSystemComponent(component.id, { properties: next }));
	}

	return (
		<div className="flex flex-col gap-3 text-[13px]">
			<div className="flex items-center justify-between">
				<span className="kicker">{componentKindLabel(component.kind)}</span>
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
					disabled={component.designId !== undefined}
					onChange={(event) => onApply(() => client.updateSystemComponent(component.id, { kind: event.target.value as SystemComponentKind }))}
					className="h-8 rounded-md border border-input bg-paper-raised px-2"
				>
					{SYSTEM_COMPONENT_KINDS.map((kind) => (
						<option key={kind} value={kind}>{componentKindLabel(kind)}</option>
					))}
				</select>
			</label>
			{component.kind === "custom" && (
				<label className="flex flex-col gap-1">
					<span className="text-ink-3">Icon or shape</span>
					<select
						aria-label="Custom icon or shape"
						value={component.icon ?? "rectangle"}
						onChange={(event) => onApply(() => client.updateSystemComponent(component.id, { icon: event.target.value as CustomIcon }))}
						className="h-8 rounded-md border border-input bg-paper-raised px-2"
					>
						{CUSTOM_ICONS.map((icon) => (
							<option key={icon} value={icon}>{CUSTOM_ICON_LABELS[icon]}</option>
						))}
					</select>
				</label>
			)}
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Owner</span>
				<select
					aria-label="Owning service"
					value={component.serviceId ?? ""}
					onChange={(event) => onApply(() => client.updateSystemComponent(component.id, { serviceId: event.target.value || null }))}
					className="h-8 rounded-md border border-input bg-paper-raised px-2"
				>
					<option value="">System scope (shared or independent)</option>
					{design.services.map((service) => (
						<option key={service.id} value={service.id}>{service.name}</option>
					))}
				</select>
			</label>
			<GroupMembership design={design} id={component.id} />
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Technology</span>
				<Input value={technology} maxLength={500} placeholder="Optional, e.g. PostgreSQL" onChange={(event) => setTechnology(event.target.value)} onBlur={commitDetails} />
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Description</span>
				<Textarea value={description} maxLength={500} rows={3} onChange={(event) => setDescription(event.target.value)} onBlur={commitDetails} />
			</label>
			{descriptors.map((descriptor) => (
				<label key={descriptor.key} className="flex flex-col gap-1">
					<span className="text-ink-3">{descriptor.key}</span>
					<Input
						aria-label={descriptor.key}
						value={descriptorDrafts[descriptor.key] ?? descriptorValue(component.properties, descriptor.key)}
						maxLength={500}
						placeholder={`Optional. ${descriptor.placeholder}`}
						onChange={(event) => setDescriptorDrafts((drafts) => ({ ...drafts, [descriptor.key]: event.target.value }))}
						onBlur={() => commitDescriptor(descriptor.key)}
					/>
				</label>
			))}
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center justify-between">
					<span className="text-ink-3">Properties</span>
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={() => {
							const next = [...freeRows, { key: `property ${freeRows.length + 1}`, value: "" }];
							setFreeRows(next);
							commitProperties(next);
						}}
					>
						Add property
					</Button>
				</div>
				{freeRows.map((item, index) => (
					<div key={index} className="flex items-center gap-1">
						<Input
							aria-label={`Property ${index + 1} name`}
							value={item.key}
							maxLength={60}
							className="h-7 w-28"
							onChange={(event) => setFreeRows(freeRows.map((entry, i) => (i === index ? { ...entry, key: event.target.value } : entry)))}
							onBlur={() => commitProperties(freeRows)}
						/>
						<Input
							aria-label={`Property ${index + 1} value`}
							value={item.value}
							maxLength={500}
							className="h-7 min-w-0 flex-1"
							onChange={(event) => setFreeRows(freeRows.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)))}
							onBlur={() => commitProperties(freeRows)}
						/>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							aria-label={`Remove property ${index + 1}`}
							className="size-7 shrink-0"
							onClick={() => {
								const next = freeRows.filter((_, i) => i !== index);
								setFreeRows(next);
								commitProperties(next);
							}}
						>
							<X className="size-3.5" />
						</Button>
					</div>
				))}
			</div>
			{component.kind === "database" && (
				<DatabaseLinkSection
					component={component}
					design={design}
					designs={designs}
					client={client}
					onApply={onApply}
					onOpenDatabase={onOpenDatabase}
				/>
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

/**
 * Links a Database component to a database Design. A conceptual component can
 * create a Design or link an existing one; a linked component can open the
 * database workspace or unlink. Several components may link one Design: a
 * Shared schema, which the note names.
 */
function DatabaseLinkSection({
	component,
	design,
	designs,
	client,
	onApply,
	onOpenDatabase,
}: {
	component: SystemComponent;
	design: SystemDesign;
	designs: DatabaseDesignSummary[];
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onOpenDatabase: (designId: string) => void;
}) {
	const linkedDesignId = component.designId;
	if (linkedDesignId === undefined) {
		return (
			<div className="flex flex-col gap-2 rounded-md bg-paper-tint p-2.5 text-[12.5px] text-ink-2" data-testid="database-link">
				<p>Conceptual: not linked to a database design yet.</p>
				<Button type="button" size="sm" variant="outline" className="self-start" onClick={() => onApply(() => client.createSystemDatabaseDesign(component.id))}>
					<Plus className="size-3.5" />
					Create database design
				</Button>
				{designs.length > 0 && (
					<label className="flex flex-col gap-1">
						<span className="text-ink-3">Or link an existing design</span>
						<select
							aria-label="Link an existing design"
							value=""
							onChange={(event) => {
								if (event.target.value) onApply(() => client.linkSystemDatabase(component.id, event.target.value));
							}}
							className="h-8 rounded-md border border-input bg-paper-raised px-2"
						>
							<option value="">Choose a design…</option>
							{designs.map((item) => (
								<option key={item.id} value={item.id}>{item.name}</option>
							))}
						</select>
					</label>
				)}
			</div>
		);
	}
	const linked = designs.find((item) => item.id === linkedDesignId);
	const others = componentsLinkedToDesign(design, linkedDesignId).filter((item) => item.id !== component.id);
	return (
		<div className="flex flex-col gap-2 rounded-md bg-paper-tint p-2.5 text-[12.5px] text-ink-2" data-testid="database-link">
			{linked ? (
				<p>Linked to design “{linked.name}”.</p>
			) : (
				<p>The linked design is missing from this Project. Unlink it to choose another.</p>
			)}
			{others.length > 0 && (
				<p data-testid="shared-schema-note">
					Shared schema with {others.map((item) => item.name).join(", ")}. Schema edits apply to every linked component.
				</p>
			)}
			<div className="flex flex-wrap gap-1.5">
				{linked && (
					<Button type="button" size="sm" variant="outline" onClick={() => onOpenDatabase(linkedDesignId)}>
						<ArrowRight className="size-3.5" />
						Open database workspace
					</Button>
				)}
				<Button type="button" size="sm" variant="ghost" onClick={() => onApply(() => client.linkSystemDatabase(component.id, null))}>
					Unlink
				</Button>
			</div>
		</div>
	);
}

function ServiceInspector({
	service,
	design,
	client,
	onApply,
	onClose,
	onSelectComponent,
	onSelectConnection,
	onRequestRemove,
	collapsed,
	onSetCollapsed,
	focused,
	onFocus,
}: {
	service: SystemService;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onClose: () => void;
	onSelectComponent: (id: string) => void;
	onSelectConnection: (id: string) => void;
	onRequestRemove: () => void;
	collapsed: boolean;
	onSetCollapsed: (collapsed: boolean) => void;
	/** Whether the focused view of this Service is open. */
	focused: boolean;
	onFocus: () => void;
}) {
	const [name, setName] = useState(service.name);
	const owned = design.components.filter((component) => component.serviceId === service.id);
	const assignable = design.components.filter((component) => component.serviceId !== service.id);
	const related = design.connections.filter((connection) => connection.sourceId === service.id || connection.targetId === service.id);
	const serviceNames = new Map(design.services.map((item) => [item.id, item.name]));

	function commitName() {
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			setName(service.name);
			return;
		}
		if (trimmed !== service.name) onApply(() => client.updateSystemService(service.id, { name: trimmed }));
	}

	return (
		<div className="flex flex-col gap-3 text-[13px]">
			<div className="flex items-center justify-between">
				<span className="kicker">Service</span>
				<Button type="button" size="icon" variant="ghost" aria-label="Close inspector" className="size-7" onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</div>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Name</span>
				<Input
					value={name}
					maxLength={80}
					aria-label="Service name"
					onChange={(event) => setName(event.target.value)}
					onBlur={commitName}
					onKeyDown={(event) => {
						if (event.key === "Enter") (event.target as HTMLInputElement).blur();
					}}
				/>
			</label>
			<GroupMembership design={design} id={service.id} />
			{!focused && (
				<Button type="button" variant="outline" size="sm" className="self-start" onClick={onFocus}>
					Focus service
				</Button>
			)}
			{/* A focused Service is always drawn expanded, so the collapse control is for the overview only. */}
			{!focused && (
				<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onSetCollapsed(!collapsed)}>
					{collapsed ? "Expand service" : "Collapse service"}
				</Button>
			)}
			<div className="flex flex-col gap-1.5">
				<span className="text-ink-3">Owns ({owned.length})</span>
				{owned.length === 0 && <p className="text-ink-3">No components yet. Assign one below or from a component’s Owner field.</p>}
				{owned.map((component) => (
					<div key={component.id} className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-paper-tint">
						<button type="button" onClick={() => onSelectComponent(component.id)} className="min-w-0 truncate text-left">
							{component.name}
						</button>
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={() => onApply(() => client.updateSystemComponent(component.id, { serviceId: null }))}
						>
							Release
						</Button>
					</div>
				))}
				{assignable.length > 0 && (
					<label className="flex flex-col gap-1 pt-1">
						<span className="text-ink-3">Assign a component</span>
						<select
							aria-label="Assign a component to this service"
							value=""
							onChange={(event) => {
								const componentId = event.target.value;
								if (componentId) onApply(() => client.updateSystemComponent(componentId, { serviceId: service.id }));
							}}
							className="h-8 rounded-md border border-input bg-paper-raised px-2"
						>
							<option value="">Choose a component…</option>
							{assignable.map((component) => (
								<option key={component.id} value={component.id}>
									{component.serviceId === null
										? `${component.name} (system scope)`
										: `${component.name} (owned by ${serviceNames.get(component.serviceId) ?? "another service"})`}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
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
						{connection.sourceId === service.id ? "→" : "←"} {connection.label}
					</button>
				))}
			</div>
			<Button type="button" variant="strike" size="sm" className="mt-1 self-start" onClick={onRequestRemove}>
				<Trash2 className="size-3.5" />
				Remove service
			</Button>
		</div>
	);
}

/** Lists the Groups that enclose an item. Membership never changes ownership, so this is informational. */
function GroupMembership({ design, id }: { design: SystemDesign; id: string }) {
	const groups = systemGroupsContaining(design, id);
	return (
		<div className="flex flex-col gap-1">
			<span className="text-ink-3">Groups ({groups.length})</span>
			{groups.length === 0 ? (
				<p className="text-ink-3">Not in a group. Use Group to enclose it.</p>
			) : (
				<p className="text-ink-2">{groups.map((group) => group.name).join(", ")}</p>
			)}
		</div>
	);
}

function memberLabel(design: SystemDesign, id: string): { kind: "Component" | "Service" | "Group"; name: string } {
	const component = findSystemComponent(design, id);
	if (component) return { kind: "Component", name: component.name };
	const service = findSystemService(design, id);
	if (service) return { kind: "Service", name: service.name };
	return { kind: "Group", name: findSystemGroup(design, id)?.name ?? "Missing" };
}

/**
 * A Group's name, members, and frame. Members are explicit: removing one here
 * leaves the item itself, its ownership, and its Connections untouched.
 */
function GroupInspector({
	group,
	design,
	client,
	onApply,
	onClose,
	onSelect,
	onRemove,
}: {
	group: SystemGroup;
	design: SystemDesign;
	client: Client;
	onApply: (action: () => Promise<WorkspaceState>) => void;
	onClose: () => void;
	onSelect: (kind: "component" | "service" | "group", id: string) => void;
	onRemove: () => void;
}) {
	const [name, setName] = useState(group.name);
	const candidates = [...design.components, ...design.services, ...design.groups].filter(
		(item) => !group.memberIds.includes(item.id) && canAddSystemGroupMember(design, group.id, item.id),
	);
	const enclosing = systemGroupsContaining(design, group.id);

	function commitName() {
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			setName(group.name);
			return;
		}
		if (trimmed !== group.name) onApply(() => client.updateSystemGroup(group.id, { name: trimmed }));
	}

	function setMembers(memberIds: string[]) {
		onApply(() => client.updateSystemGroup(group.id, { memberIds }));
	}

	return (
		<div className="flex flex-col gap-3 text-[13px]">
			<div className="flex items-center justify-between">
				<span className="kicker">Group</span>
				<Button type="button" size="icon" variant="ghost" aria-label="Close inspector" className="size-7" onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</div>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Name</span>
				<Input
					value={name}
					maxLength={80}
					aria-label="Group name"
					onChange={(event) => setName(event.target.value)}
					onBlur={commitName}
					onKeyDown={(event) => {
						if (event.key === "Enter") (event.target as HTMLInputElement).blur();
					}}
				/>
			</label>
			<div className="flex flex-col gap-1.5">
				<span className="text-ink-3">Members ({group.memberIds.length})</span>
				{group.memberIds.length === 0 && <p className="text-ink-3">No members yet. Add one below.</p>}
				{group.memberIds.map((memberId) => {
					const member = memberLabel(design, memberId);
					const kind = member.kind === "Component" ? "component" : member.kind === "Service" ? "service" : "group";
					return (
						<div key={memberId} className="flex items-center justify-between gap-2 rounded-sm px-2 py-1 hover:bg-paper-tint">
							<button type="button" onClick={() => onSelect(kind, memberId)} className="min-w-0 truncate text-left">
								<span className="text-ink-3">{member.kind} · </span>{member.name}
							</button>
							<Button
								type="button"
								size="xs"
								variant="outline"
								aria-label={`Remove ${member.name} from this group`}
								onClick={() => setMembers(group.memberIds.filter((id) => id !== memberId))}
							>
								Remove
							</Button>
						</div>
					);
				})}
				{candidates.length > 0 && (
					<label className="flex flex-col gap-1 pt-1">
						<span className="text-ink-3">Add a member</span>
						<select
							aria-label="Add a member to this group"
							value=""
							onChange={(event) => {
								const memberId = event.target.value;
								if (memberId) setMembers([...group.memberIds, memberId]);
							}}
							className="h-8 rounded-md border border-input bg-paper-raised px-2"
						>
							<option value="">Choose an item…</option>
							{candidates.map((item) => (
								<option key={item.id} value={item.id}>{memberLabel(design, item.id).kind}: {item.name}</option>
							))}
						</select>
					</label>
				)}
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-ink-3">Inside ({enclosing.length})</span>
				{enclosing.length === 0 ? <p className="text-ink-3">Not nested in another group.</p> : enclosing.map((item) => <p key={item.id} className="text-ink-2">{item.name}</p>)}
			</div>
			<p className="text-[12px] text-ink-3">
				Moving this frame moves its members. Resizing it changes only its size. Neither changes membership or ownership.
			</p>
			<Button type="button" variant="strike" size="sm" className="mt-1 self-start" onClick={onRemove}>
				<Trash2 className="size-3.5" />
				Remove group
			</Button>
		</div>
	);
}

function endpointName(design: SystemDesign, endpointId: string): string {
	return findSystemComponent(design, endpointId)?.name ?? findSystemService(design, endpointId)?.name ?? "Missing";
}

const SIDE_LABELS: Record<SystemConnectionSide, string> = {
	auto: "Automatic",
	top: "Top",
	right: "Right",
	bottom: "Bottom",
	left: "Left",
};

function SideChoice({ label, value, onChange }: { label: string; value: SystemConnectionSide; onChange: (side: SystemConnectionSide) => void }) {
	return (
		<div className="flex items-center justify-between gap-2">
			<span className="text-ink-3">{label}</span>
			<Select value={value} onValueChange={(next) => onChange(next as SystemConnectionSide)}>
				<SelectTrigger aria-label={`${label} side`} className="w-32">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{SYSTEM_CONNECTION_SIDES.map((side) => (
						<SelectItem key={side} value={side}>{SIDE_LABELS[side]}</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}

/** Adds a bend point at the middle of the Connection's longest leg, so it can be dragged into shape on the canvas. */
function addBendPoint(connection: SystemConnection, design: SystemDesign, client: Client, onApply: (action: () => Promise<WorkspaceState>) => void) {
	const geometry = connectionGeometries(design).find((item) => item.connection.id === connection.id);
	if (!geometry) return;
	const { index, point } = bendInsertionFor(geometry);
	const bends = connection.bendPoints ?? [];
	onApply(() => client.updateSystemConnection(connection.id, { bendPoints: [...bends.slice(0, index), point, ...bends.slice(index)] }));
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
	const [interactionType, setInteractionType] = useState(connection.interactionType ?? "");
	const [protocol, setProtocol] = useState(connection.protocol ?? "");
	const source = endpointName(design, connection.sourceId);
	const target = endpointName(design, connection.targetId);
	const bends = connection.bendPoints ?? [];
	const hasRouteEdits = connection.fromSide !== undefined || connection.toSide !== undefined || bends.length > 0 || connection.labelOffset !== undefined;

	function commitLabel() {
		const trimmed = label.trim();
		if (trimmed.length === 0) {
			setLabel(connection.label);
			return;
		}
		if (trimmed !== connection.label) onApply(() => client.updateSystemConnection(connection.id, { label: trimmed }));
	}
	function commitInteractionType() {
		const trimmed = interactionType.trim();
		if (trimmed === (connection.interactionType ?? "")) return;
		onApply(() => client.updateSystemConnection(connection.id, { interactionType: trimmed }));
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
				<span className="text-ink-3">Interaction type (optional)</span>
				<Input
					value={interactionType}
					maxLength={500}
					placeholder="e.g. Synchronous request, Event"
					onChange={(event) => setInteractionType(event.target.value)}
					onBlur={commitInteractionType}
				/>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-ink-3">Protocol (optional)</span>
				<Input value={protocol} maxLength={500} placeholder="e.g. HTTPS, AMQP" onChange={(event) => setProtocol(event.target.value)} onBlur={commitProtocol} />
			</label>
			<div className="flex flex-col gap-2 border-t border-rule pt-3">
				<span className="kicker">Route</span>
				<SideChoice
					label="Leaves from"
					value={connection.fromSide ?? "auto"}
					onChange={(side) => onApply(() => client.updateSystemConnection(connection.id, { fromSide: side }))}
				/>
				<SideChoice
					label="Arrives at"
					value={connection.toSide ?? "auto"}
					onChange={(side) => onApply(() => client.updateSystemConnection(connection.id, { toSide: side }))}
				/>
				<div className="flex items-center justify-between">
					<span className="text-ink-3">Bend points ({bends.length})</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={bends.length >= SYSTEM_CONNECTION_BEND_LIMIT}
						onClick={() => addBendPoint(connection, design, client, onApply)}
					>
						Add bend point
					</Button>
				</div>
				{bends.map((point, index) => (
					<div key={index} className="flex items-center justify-between gap-2 rounded-sm bg-paper-tint px-2 py-1">
						<span className="text-ink-2">Bend {index + 1} · {Math.round(point.x)}, {Math.round(point.y)}</span>
						<Button
							type="button"
							size="icon"
							variant="ghost"
							aria-label={`Remove bend ${index + 1}`}
							className="size-6"
							onClick={() => onApply(() => client.updateSystemConnection(connection.id, { bendPoints: bends.filter((_, other) => other !== index) }))}
						>
							<X className="size-3" />
						</Button>
					</div>
				))}
				<p className="text-[12px] text-ink-3">Drag a bend point or the label on the canvas to shape the route.</p>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="self-start"
					disabled={!hasRouteEdits}
					onClick={() => onApply(() => client.updateSystemConnection(connection.id, { fromSide: null, toSide: null, bendPoints: [], labelOffset: null }))}
				>
					Reset route
				</Button>
			</div>
			<Button type="button" variant="strike" size="sm" className="self-start" onClick={onRemove}>
				<Trash2 className="size-3.5" />
				Remove connection
			</Button>
		</div>
	);
}
