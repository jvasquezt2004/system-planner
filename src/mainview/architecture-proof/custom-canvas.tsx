import { useEffect, useRef, useState } from "react";
import {
	Activity,
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	Download,
	Eye,
	Layers,
	Pause,
	Play,
	RotateCcw,
	ZoomIn,
	ZoomOut,
} from "lucide-react";
import {
	type ProofArchitecture,
	type ProofPoint,
	computeConnectionPath,
	createDefaultProofArchitecture,
	getEndpointAnchor,
	getPlaybackFrame,
	moveGroupDeduplicated,
	scheduleWalkthrough,
} from "../../shared/architecture-proof";
import { generateStandaloneSvg, rasterizeSvgToPng } from "./svg-export";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DragState =
	| { kind: "component"; id: string; startPos: ProofPoint; mouseStart: ProofPoint }
	| { kind: "group"; id: string; startPos: ProofPoint; mouseStart: ProofPoint }
	| { kind: "pan"; mouseStart: ProofPoint; startOffset: ProofPoint };

export function CustomArchitectureCanvas({
	initialArchitecture,
}: {
	initialArchitecture?: ProofArchitecture;
}) {
	const [arch, setArch] = useState<ProofArchitecture>(() => initialArchitecture ?? createDefaultProofArchitecture());
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [focusedServiceId, setFocusedServiceId] = useState<string | null>(null);

	// Pan & Zoom
	const [zoom, setZoom] = useState(1);
	const [offset, setOffset] = useState<ProofPoint>({ x: 20, y: 20 });
	const [dragState, setDragState] = useState<DragState | null>(null);

	// Playback State
	const [currentTimeMs, setCurrentTimeMs] = useState(0);
	const [isPlaying, setIsPlaying] = useState(false);
	const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
	const [reducedMotion, setReducedMotion] = useState(false);
	const [exportStatus, setExportStatus] = useState<string | null>(null);

	const containerRef = useRef<HTMLDivElement>(null);
	const animationFrameRef = useRef<number | null>(null);
	const lastTickRef = useRef<number | null>(null);

	const { scheduledSteps, totalDurationMs } = scheduleWalkthrough(arch.walkthrough);
	const currentFrame = getPlaybackFrame(arch, currentTimeMs, { reducedMotion, focusedServiceId });

	// Playback Loop
	useEffect(() => {
		if (!isPlaying) {
			lastTickRef.current = null;
			if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
			return;
		}

		const tick = (now: number) => {
			if (lastTickRef.current !== null) {
				const delta = (now - lastTickRef.current) * playbackSpeed;
				setCurrentTimeMs((prev) => {
					const next = prev + delta;
					if (next >= totalDurationMs) {
						setIsPlaying(false);
						return totalDurationMs;
					}
					return next;
				});
			}
			lastTickRef.current = now;
			animationFrameRef.current = requestAnimationFrame(tick);
		};

		animationFrameRef.current = requestAnimationFrame(tick);
		return () => {
			if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
		};
	}, [isPlaying, playbackSpeed, totalDurationMs]);

	// Dragging handlers
	const handleMouseDownComponent = (e: React.MouseEvent, compId: string) => {
		e.stopPropagation();
		const comp = arch.components.find((c) => c.id === compId);
		if (!comp) return;
		setSelectedId(compId);
		setDragState({
			kind: "component",
			id: compId,
			startPos: { ...comp.position },
			mouseStart: { x: e.clientX, y: e.clientY },
		});
	};

	const handleMouseDownGroup = (e: React.MouseEvent, grpId: string) => {
		e.stopPropagation();
		const grp = arch.groups.find((g) => g.id === grpId);
		if (!grp) return;
		setSelectedId(grpId);
		setDragState({
			kind: "group",
			id: grpId,
			startPos: { x: grp.bounds.x, y: grp.bounds.y },
			mouseStart: { x: e.clientX, y: e.clientY },
		});
	};

	const handleMouseDownCanvas = (e: React.MouseEvent) => {
		if (e.target === containerRef.current || (e.target as HTMLElement).tagName === "svg") {
			setSelectedId(null);
			setDragState({
				kind: "pan",
				mouseStart: { x: e.clientX, y: e.clientY },
				startOffset: { ...offset },
			});
		}
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (!dragState) return;

		const dx = (e.clientX - dragState.mouseStart.x) / zoom;
		const dy = (e.clientY - dragState.mouseStart.y) / zoom;

		if (dragState.kind === "component") {
			setArch((prev) => ({
				...prev,
				components: prev.components.map((c) =>
					c.id === dragState.id
						? {
								...c,
								position: {
									x: Math.round(dragState.startPos.x + dx),
									y: Math.round(dragState.startPos.y + dy),
								},
						  }
						: c,
				),
			}));
		} else if (dragState.kind === "group") {
			const delta = {
				x: Math.round(dragState.startPos.x + dx) - arch.groups.find((g) => g.id === dragState.id)!.bounds.x,
				y: Math.round(dragState.startPos.y + dy) - arch.groups.find((g) => g.id === dragState.id)!.bounds.y,
			};
			if (delta.x !== 0 || delta.y !== 0) {
				setArch((prev) => moveGroupDeduplicated(prev, dragState.id, delta));
			}
		} else if (dragState.kind === "pan") {
			setOffset({
				x: dragState.startOffset.x + (e.clientX - dragState.mouseStart.x),
				y: dragState.startOffset.y + (e.clientY - dragState.mouseStart.y),
			});
		}
	};

	const handleMouseUp = () => {
		setDragState(null);
	};

	const toggleCollapseService = (serviceId: string) => {
		setArch((prev) => ({
			...prev,
			services: prev.services.map((s) => (s.id === serviceId ? { ...s, isCollapsed: !s.isCollapsed } : s)),
		}));
	};

	const handleExportSvg = () => {
		const { svg } = generateStandaloneSvg(arch);
		const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		setExportStatus("Standalone SVG generated (100% offline, self-contained)");

		const a = document.createElement("a");
		a.href = url;
		a.download = "architecture-proof.svg";
		a.click();
	};

	const handleExportPng = async () => {
		setExportStatus("Generating PNG...");
		try {
			const { svg, width, height } = generateStandaloneSvg(arch);
			const pngUrl = await rasterizeSvgToPng(svg, width, height);
			setExportStatus("PNG rasterized successfully (offline canvas render)");

			const a = document.createElement("a");
			a.href = pngUrl;
			a.download = "architecture-proof.png";
			a.click();
		} catch (err) {
			setExportStatus(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const groupColors: Record<string, { border: string; bg: string; badge: string; text: string }> = {
		vpc: { border: "border-sky-500", bg: "bg-sky-50/40", badge: "bg-sky-600", text: "text-sky-900" },
		compliance: { border: "border-amber-500", bg: "bg-amber-50/40", badge: "bg-amber-600", text: "text-amber-900" },
		region: { border: "border-slate-500", bg: "bg-slate-50/25", badge: "bg-slate-600", text: "text-slate-900" },
		domain: { border: "border-indigo-500", bg: "bg-indigo-50/40", badge: "bg-indigo-600", text: "text-indigo-900" },
	};

	return (
		<div className="flex flex-col h-full bg-[#fcfbf7] text-slate-900 select-none overflow-hidden">
			{/* Top Bar: Focus State & Quick Actions */}
			<div className="flex items-center justify-between px-4 py-2 bg-white border-b border-rule/50 shrink-0">
				<div className="flex items-center gap-3">
					<span className="font-display font-medium text-sm text-ink">
						Architecture Technical Proof (Custom Canvas)
					</span>
					{focusedServiceId && (
						<div data-proof-focus-context="" className="flex items-center gap-1.5 px-2 py-0.5 bg-pencil/10 border border-pencil/30 rounded text-xs text-pencil font-medium">
							<Eye className="size-3" />
							<span>Focusing: {arch.services.find((s) => s.id === focusedServiceId)?.name}</span>
							<button
								type="button"
								onClick={() => setFocusedServiceId(null)}
								className="ml-1 hover:text-ink font-bold"
							>
								×
							</button>
						</div>
					)}
					<span className="text-xs text-ink-3">
						{arch.components.length} components · {arch.services.length} services · {arch.groups.length} groups · {arch.connections.length} connections
					</span>
				</div>

				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={handleExportSvg}
						title="Export self-contained static SVG"
						className="h-7 text-xs gap-1"
					>
						<Download className="size-3" />
						Export SVG
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={handleExportPng}
						title="Rasterize to PNG offline"
						className="h-7 text-xs gap-1"
					>
						<Download className="size-3" />
						Export PNG
					</Button>
					<div className="h-4 w-px bg-rule/50 mx-1" />
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}
						title="Zoom Out"
					>
						<ZoomOut className="size-3.5" />
					</Button>
					<span className="text-xs font-mono w-10 text-center text-ink-3">
						{Math.round(zoom * 100)}%
					</span>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => setZoom((z) => Math.min(2.0, z + 0.15))}
						title="Zoom In"
					>
						<ZoomIn className="size-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => {
							setZoom(1);
							setOffset({ x: 20, y: 20 });
						}}
						title="Reset View"
					>
						<RotateCcw className="size-3.5" />
					</Button>
				</div>
			</div>

			{/* Interactive Viewport */}
			<div data-proof-viewport=""
				ref={containerRef}
				onMouseDown={handleMouseDownCanvas}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				className="relative flex-1 overflow-hidden cursor-grab active:cursor-grabbing bg-[#fcfbf7]"
				style={{
					backgroundImage: `radial-gradient(#1b1a17 0.75px, transparent 0.75px)`,
					backgroundSize: "24px 24px",
					backgroundPosition: `${offset.x}px ${offset.y}px`,
				}}
			>
				{/* Canvas Transform Layer */}
				<div
					className="absolute origin-top-left"
					style={{
						transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
						width: 1400,
						height: 800,
					}}
				>
					{/* 1. GROUPS LAYER (Non-owning organization, independently overlapping/nested) */}
					{arch.groups.map((grp) => {
						const palette = groupColors[grp.kind] ?? groupColors.domain;
						const isSelected = selectedId === grp.id;
						return (
							<div
								key={grp.id}
								data-group-id={grp.id}
								onMouseDown={(e) => handleMouseDownGroup(e, grp.id)}
								style={{
									left: grp.bounds.x,
									top: grp.bounds.y,
									width: grp.bounds.width,
									height: grp.bounds.height,
								}}
								className={cn(
									"absolute border-2 border-dashed rounded-lg transition-shadow cursor-move",
									palette.border,
									palette.bg,
									isSelected && "ring-2 ring-pencil shadow-md",
								)}
							>
								<div
									className={cn(
										"absolute -top-3.5 left-3 flex items-center gap-1.5 px-2 py-0.5 rounded shadow-xs text-[10px] font-bold text-white uppercase tracking-wider select-none",
										palette.badge,
									)}
								>
									<Layers className="size-2.5" />
									{grp.name}
									<span className="opacity-75 font-normal text-[9px] lowercase">
										({grp.kind})
									</span>
								</div>
							</div>
						);
					})}

					{/* 2. SERVICES LAYER (Explicit component ownership boundaries, expandable/collapsible) */}
					{arch.services.map((svc) => {
						const b = svc.isCollapsed ? svc.collapsedBounds : svc.bounds;
						const isFocused = focusedServiceId === svc.id;
						const isDimmed = focusedServiceId !== null && !isFocused;
						const isSelected = selectedId === svc.id;

						return (
							<div
								key={svc.id}
								data-service-id={svc.id}
								data-collapsed={svc.isCollapsed ? "true" : "false"}
								style={{
									left: b.x,
									top: b.y,
									width: b.width,
									height: b.height,
								}}
								className={cn(
									"absolute border-2 rounded-md bg-white/95 shadow-sm transition-all duration-200",
									isFocused ? "border-pencil ring-2 ring-pencil/20" : "border-slate-800",
									isDimmed && "opacity-25",
									isSelected && "ring-2 ring-pencil",
								)}
							>
								{/* Service Header */}
								<div className="flex items-center justify-between px-2.5 py-1 bg-slate-50 border-b border-slate-200 rounded-t-md text-xs">
									<div className="flex items-center gap-1.5 font-semibold text-slate-800 truncate">
										<Button
											variant="ghost"
											size="icon-xs"
											onClick={(e) => {
												e.stopPropagation();
												toggleCollapseService(svc.id);
											}}
											title={svc.isCollapsed ? "Expand Service" : "Collapse Service"}
										>
											{svc.isCollapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
										</Button>
										<span className="truncate">{svc.name}</span>
										{svc.isCollapsed && (
											<span className="text-[10px] text-slate-500 font-normal italic">
												(collapsed endpoint)
											</span>
										)}
									</div>

									<div className="flex items-center gap-1">
										<button
											type="button"
											data-proof-focus=""
											onClick={(e) => {
												e.stopPropagation();
												setFocusedServiceId(isFocused ? null : svc.id);
											}}
											className={cn(
												"px-1.5 py-0.5 rounded text-[10px] font-medium border",
												isFocused
													? "bg-pencil text-white border-pencil"
													: "bg-white text-slate-600 border-slate-300 hover:bg-slate-100",
											)}
										>
											{isFocused ? "Exit Focus" : "Focus"}
										</button>
									</div>
								</div>
							</div>
						);
					})}

					{/* 3. SVG CONNECTIONS & ANIMATION LAYER */}
					<svg
						className="absolute inset-0 pointer-events-none w-full h-full"
						style={{ width: 1400, height: 800 }}
					>
						<defs>
							<marker
								id="arrow-head"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="6"
								markerHeight="6"
								orient="auto-start-reverse"
							>
								<path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#2563eb" />
							</marker>
							<marker
								id="arrow-head-active"
								viewBox="0 0 10 10"
								refX="8"
								refY="5"
								markerWidth="7"
								markerHeight="7"
								orient="auto-start-reverse"
							>
								<path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#d97706" />
							</marker>
						</defs>

						{/* Connection Paths */}
						{arch.connections.map((conn) => {
							const sourceAnchor = getEndpointAnchor(arch, conn.sourceId, focusedServiceId);
							const targetAnchor = getEndpointAnchor(arch, conn.targetId, focusedServiceId);

							if (!sourceAnchor.isVisible && !targetAnchor.isVisible) return null;

							const route = computeConnectionPath(sourceAnchor.rect, targetAnchor.rect, conn.routeOffset);
							const isHighlighted = currentFrame.highlightedConnectionIds.includes(conn.id);
							const isSelected = selectedId === conn.id;

							// Centered label location
							const midX = (route.start.x + route.end.x) / 2 + (route.cp1.x + route.cp2.x - route.start.x - route.end.x) * 0.25;
							const midY = (route.start.y + route.end.y) / 2 + (route.cp1.y + route.cp2.y - route.start.y - route.end.y) * 0.25;

							return (
								<g key={conn.id} className="pointer-events-auto cursor-pointer" onClick={() => setSelectedId(conn.id)}>
									{/* Wide hit area */}
									<path d={route.pathString} fill="none" stroke="transparent" strokeWidth="18" />

									{/* Rendered connector */}
									<path
										data-connection-id={conn.id}
										data-source-id={conn.sourceId}
										data-target-id={conn.targetId}
										d={route.pathString}
										fill="none"
										stroke={isHighlighted ? "#d97706" : isSelected ? "#0f172a" : "#2563eb"}
										strokeWidth={isHighlighted ? "3" : isSelected ? "2.5" : "1.75"}
										strokeDasharray={conn.protocol === "gRPC" ? "4,4" : undefined}
										markerEnd={isHighlighted ? "url(#arrow-head-active)" : "url(#arrow-head)"}
										className="transition-colors duration-200"
									/>

									{/* Label Badge */}
									<g transform={`translate(${midX}, ${midY})`}>
										<rect
											x={-(conn.label.length * 3.4 + 10)}
											y="-10"
											width={conn.label.length * 6.8 + 20}
											height="20"
											rx="4"
											fill="#ffffff"
											stroke={isHighlighted ? "#f59e0b" : "#93c5fd"}
											strokeWidth="1"
											className="shadow-xs"
										/>
										<text
											y="4"
											textAnchor="middle"
											fill={isHighlighted ? "#b45309" : "#1e3a8a"}
											fontFamily="'IBM Plex Mono', monospace"
											fontSize="10"
											fontWeight="600"
										>
											{conn.label}
										</text>
									</g>
								</g>
							);
						})}

						{/* Active Animated Message Particles along paths */}
						{!reducedMotion &&
							currentFrame.activeParticles.map((particle) => (
								<g key={`${particle.connectionId}-${particle.progress}`} data-proof-particle={particle.connectionId} transform={`translate(${particle.point.x}, ${particle.point.y})`}>
									<circle r="7" fill="#d97706" opacity="0.3" className="animate-ping" />
									<circle r="5" fill="#d97706" stroke="#ffffff" strokeWidth="1.5" />
								</g>
							))}
					</svg>

					{/* 4. COMPONENTS LAYER */}
					{arch.components.map((comp) => {
						const owningService = comp.serviceId ? arch.services.find((s) => s.id === comp.serviceId) : null;
						if (owningService && owningService.isCollapsed) return null; // Hidden in collapsed service

						const isDimmed = focusedServiceId !== null && comp.serviceId !== focusedServiceId;
						const isSelected = selectedId === comp.id;
						const reaction = currentFrame.reactions[comp.id];

						return (
							<div
								key={comp.id}
								data-component-id={comp.id}
								data-owner-service-id={comp.serviceId ?? ""}
								onMouseDown={(e) => handleMouseDownComponent(e, comp.id)}
								style={{
									left: comp.position.x,
									top: comp.position.y,
									width: comp.width,
									height: comp.height,
								}}
								className={cn(
									"absolute bg-white rounded-md border p-2 shadow-xs transition-shadow cursor-move flex flex-col justify-between",
									isSelected ? "border-pencil ring-2 ring-pencil" : "border-slate-300 hover:border-slate-500",
									isDimmed && "opacity-25",
									reaction && (reaction.isError ? "ring-2 ring-proof-red shadow-lg" : "ring-2 ring-press-green shadow-lg"),
								)}
							>
								{/* Shared Schema Badge */}
								{comp.isSharedSchema && (
									<div className="absolute -top-2.5 right-2 px-1.5 py-0.2 bg-emerald-600 text-white font-mono text-[8.5px] font-bold rounded shadow-xs">
										SHARED SCHEMA
									</div>
								)}

								{/* Reaction Alert / Badge */}
								{reaction && (
									<div
										className={cn(
											"absolute -bottom-3 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-[10px] font-bold shadow-md whitespace-nowrap animate-bounce",
											reaction.isError ? "bg-proof-red text-white" : "bg-press-green text-white",
										)}
									>
										{reaction.isError ? <AlertTriangle className="size-2.5 inline mr-1" /> : <CheckCircle2 className="size-2.5 inline mr-1" />}
										{reaction.message}
									</div>
								)}

								<div className="flex items-center justify-between gap-1">
									<div className="font-display font-medium text-xs text-slate-900 truncate">
										{comp.name}
									</div>
									<span className="text-[9px] font-mono text-slate-400 uppercase">
										{comp.kind}
									</span>
								</div>

								<div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
									<span className="truncate">{comp.technology ?? comp.kind}</span>
									{comp.serviceId && (
										<span className="text-[9px] text-pencil truncate ml-1">
											owned
										</span>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/* BOTTOM TRANSPORT CONTROLS BAR (Single Authored Clock) */}
			<div className="flex flex-col bg-white border-t border-rule/50 px-4 py-2.5 shrink-0 gap-2">
				{/* Step Progress & Timeline Scrubber */}
				<div className="flex items-center gap-3">
					<Button
						variant="outline"
						size="sm"
						data-proof-play=""
						onClick={() => setIsPlaying((p) => !p)}
						className="h-8 w-20 gap-1.5 font-medium"
					>
						{isPlaying ? <Pause className="size-3.5 fill-current" /> : <Play className="size-3.5 fill-current" />}
						{isPlaying ? "Pause" : "Play"}
					</Button>

					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => {
							setIsPlaying(false);
							setCurrentTimeMs(0);
						}}
						title="Restart Walkthrough"
					>
						<RotateCcw className="size-3.5" />
					</Button>

					{/* Time display */}
					<div className="font-mono text-xs text-ink-3 w-28 shrink-0">
						{(currentTimeMs / 1000).toFixed(2)}s / {(totalDurationMs / 1000).toFixed(2)}s
					</div>

					{/* Scrubber slider */}
					<input
						type="range"
						min="0"
						max={totalDurationMs}
						value={currentTimeMs}
						onChange={(e) => {
							setIsPlaying(false);
							setCurrentTimeMs(Number(e.target.value));
						}}
						className="flex-1 h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-pencil"
					/>

					{/* Playback speed toggle */}
					<div className="flex items-center border border-rule rounded divide-x divide-rule text-xs font-mono">
						{([0.5, 1, 2] as const).map((spd) => (
							<button
								key={spd}
								type="button"
								data-proof-speed={spd}
								onClick={() => setPlaybackSpeed(spd)}
								className={cn(
									"px-2 py-1 transition-colors",
									playbackSpeed === spd ? "bg-pencil text-white font-bold" : "text-slate-600 hover:bg-slate-100",
								)}
							>
								{spd}x
							</button>
						))}
					</div>

					{/* Reduced Motion Toggle */}
					<button
						type="button"
						data-proof-reduced-motion=""
						onClick={() => setReducedMotion((r) => !r)}
						className={cn(
							"px-2.5 py-1 rounded border text-xs font-medium transition-colors flex items-center gap-1.5",
							reducedMotion
								? "bg-amber-100 border-amber-400 text-amber-900"
								: "bg-white border-slate-300 text-slate-700 hover:bg-slate-50",
						)}
						title="Toggle Reduced Motion mode"
					>
						<Activity className="size-3" />
						Reduced Motion: {reducedMotion ? "ON" : "OFF"}
					</button>
				</div>

				{/* Walkthrough Step Bar & Current Explanation */}
				<div className="flex items-center gap-2 overflow-x-auto py-1">
					<span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider shrink-0 mr-1">
						Steps:
					</span>
					{scheduledSteps.map((sched, idx) => {
						const isStepActive =
							currentTimeMs >= sched.startTimeMs &&
							(idx === scheduledSteps.length - 1 ? currentTimeMs <= sched.endTimeMs : currentTimeMs < sched.endTimeMs);

						return (
							<button
								key={sched.step.id}
								data-step-id={sched.step.id}
								type="button"
								onClick={() => {
									setIsPlaying(false);
									setCurrentTimeMs(sched.startTimeMs);
								}}
								className={cn(
									"flex items-center gap-1 px-2.5 py-1 rounded text-xs shrink-0 border transition-all text-left",
									isStepActive
										? "bg-pencil text-white border-pencil shadow-xs font-medium"
										: "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100",
								)}
							>
								<span className="font-mono text-[10px] opacity-75">#{idx + 1}</span>
								<span>{sched.step.title}</span>
								{sched.step.parallelGroupId && (
									<span className="text-[9px] px-1 py-0.2 bg-white/20 rounded font-mono">
										parallel
									</span>
								)}
								{sched.step.repeatCount && sched.step.repeatCount > 1 && (
									<span className="text-[9px] px-1 py-0.2 bg-amber-400 text-slate-900 font-bold rounded font-mono">
										retry ×{sched.step.repeatCount}
									</span>
								)}
							</button>
						);
					})}
				</div>

				{/* Active Step Details & Status line */}
				{currentFrame.activeStep && (
					<div className="flex items-center justify-between text-xs text-slate-700 bg-slate-50 px-3 py-1.5 rounded border border-slate-200">
						<div className="flex items-center gap-2">
							<span className="font-bold text-slate-900">{currentFrame.activeStep.title}:</span>
							<span className="text-slate-600">{currentFrame.activeStep.explanation}</span>
						</div>
						{exportStatus && (
							<span className="text-[11px] font-mono text-pencil italic">
								{exportStatus}
							</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
