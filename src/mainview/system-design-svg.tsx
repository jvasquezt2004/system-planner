import { renderToStaticMarkup } from "react-dom/server";
import type { ProofRect } from "../shared/architecture-proof";
import { componentKindLabel, isCatalogKind } from "../shared/component-catalog";
import {
	SYSTEM_COMPONENT_SIZE,
	SYSTEM_SERVICE_COLLAPSED_SIZE,
	componentsLinkedToDesign,
	findSystemComponent,
	findSystemService,
	isComponentHiddenByCollapse,
	isSystemServiceCollapsed,
	systemServiceFocus,
	type SystemDesign,
} from "../shared/system-design";
import { ComponentArtwork } from "./component-artwork";
import {
	GROUP_HEADER_HEIGHT,
	KIND_HEADER_CHARACTER_WIDTH,
	SCHEMA_BADGE_ROOM,
	componentRect,
	connectionGeometries,
	internalConnectionCount,
	labelWidth,
	truncateLabel,
	type ConnectionGeometry,
} from "./system-design-geometry";

export type SystemDesignSvgOptions = {
	/** The name shown as the SVG's accessible title. */
	title: string;
	/** `@font-face` declarations to embed. Callers pass the bundled font so the file renders offline. */
	fontFaceCss?: string;
};

/**
 * The colours the diagram uses, copied from the editorial tokens in index.css.
 * A standalone SVG cannot read the app's CSS variables, so every `var(--color-…)`
 * in the drawing is replaced with its value here. An unknown token fails the export.
 */
const EXPORT_COLORS = {
	"paper-raised": "#faf8f3",
	"paper-tint": "rgba(27, 26, 23, 0.035)",
	ink: "#1b1a17",
	"ink-2": "#47433c",
	"ink-3": "#777166",
	"rule-strong": "rgba(27, 26, 23, 0.3)",
	pencil: "#2c4a96",
} as const satisfies Record<string, string>;

/** The canvas stock the diagram sits on, matching the on-screen canvas. */
const CANVAS_COLOR = "#fcfbf7";
const EXPORT_FONT_FAMILY = "IBM Plex Sans Variable, IBM Plex Sans, Segoe UI, system-ui, sans-serif";
const ARROW_ID = "system-design-export-arrow";
const PADDING = 40;
const FALLBACK_BOUNDS: ProofRect = { x: 0, y: 0, width: 360, height: 240 };

/**
 * Draws one System design view as a standalone SVG document: the overview, or the
 * focused view when `focusedServiceId` names a Service. Services are drawn
 * collapsed or expanded as the design presents them. The output is a pure
 * function of `design`, so a caller that passes a copy taken at click time is
 * unaffected by later edits.
 *
 * The drawing follows the on-screen view's projection and geometry, and the
 * component artwork comes from the catalog registry, so every catalog kind and
 * Custom icon renders without a separate list.
 */
export function systemDesignSvg(design: SystemDesign, options: SystemDesignSvgOptions): string {
	const focusedId = design.focusedServiceId;
	const focus = focusedId !== null && findSystemService(design, focusedId) ? systemServiceFocus(design, focusedId) : null;
	const scene = focus?.scene ?? design;
	const contextIds = focus?.contextIds ?? new Set<string>();
	const geometries = connectionGeometries(scene);
	const serviceNames = new Map(design.services.map((service) => [service.id, service.name]));
	const bounds = contentBounds(scene, geometries) ?? FALLBACK_BOUNDS;
	const viewBox = {
		x: Math.floor(bounds.x - PADDING),
		y: Math.floor(bounds.y - PADDING),
		width: Math.ceil(bounds.width + PADDING * 2),
		height: Math.ceil(bounds.height + PADDING * 2),
	};

	const markup = renderToStaticMarkup(
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
			width={viewBox.width}
			height={viewBox.height}
			role="img"
			aria-label={options.title}
			fontFamily={EXPORT_FONT_FAMILY}
		>
			<title>{options.title}</title>
			<defs>
				{options.fontFaceCss && <style dangerouslySetInnerHTML={{ __html: options.fontFaceCss }} />}
				<marker id={ARROW_ID} viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
					<path d="M 0 1.5 L 9 5 L 0 8.5 z" style={{ fill: "var(--color-ink-2)" }} />
				</marker>
			</defs>
			<rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill={CANVAS_COLOR} />
			{scene.groups.map((group) => (
				<g key={group.id} data-group-id={group.id} transform={`translate(${group.position.x} ${group.position.y})`}>
					<rect
						width={group.size.width}
						height={group.size.height}
						rx={16}
						strokeDasharray="2 4"
						strokeWidth={1}
						style={{ fill: "var(--color-paper-tint)", fillOpacity: 0.55, stroke: "var(--color-ink-3)" }}
					/>
				</g>
			))}
			{scene.services.map((service) => {
				const collapsed = isSystemServiceCollapsed(scene, service.id);
				const context = contextIds.has(service.id);
				const owned = collapsed ? scene.components.filter((component) => component.serviceId === service.id) : [];
				const { width, height } = collapsed ? SYSTEM_SERVICE_COLLAPSED_SIZE : service.size;
				const internal = collapsed ? internalConnectionCount(scene, service.id) : 0;
				const summary = `${owned.length} ${owned.length === 1 ? "component" : "components"}${internal > 0 ? ` · ${internal} internal` : ""}`;
				const compact = collapsed || context;
				const heading = context ? "SERVICE · OUTSIDE" : collapsed ? "SERVICE · COLLAPSED" : "SERVICE";
				return (
					<g key={service.id} data-service-id={service.id} data-collapsed={collapsed ? "true" : "false"} data-context={context ? "true" : undefined} transform={`translate(${service.position.x} ${service.position.y})`}>
						<title>{service.name}</title>
						<rect
							width={width}
							height={height}
							rx={14}
							strokeDasharray="7 5"
							strokeWidth={1.25}
							style={{ fill: "var(--color-paper-tint)", stroke: "var(--color-rule-strong)" }}
						/>
						<text x={16} y={24} fontSize={10} letterSpacing={1.1} style={{ fill: "var(--color-ink-3)" }}>{heading}</text>
						<text x={16} y={46} fontSize={15} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
							{truncateLabel(service.name, compact ? 22 : 32)}
						</text>
						{collapsed && (
							<text x={16} y={66} fontSize={11.5} style={{ fill: "var(--color-ink-2)" }}>{summary}</text>
						)}
					</g>
				);
			})}
			{geometries.map((geometry) => (
				<ConnectionArt key={geometry.connection.id} geometry={geometry} />
			))}
			{scene.groups.map((group) => (
				<g key={`header-${group.id}`} data-group-header={group.id} transform={`translate(${group.position.x} ${group.position.y})`}>
					<rect
						width={group.size.width}
						height={GROUP_HEADER_HEIGHT}
						rx={16}
						strokeWidth={1}
						style={{ fill: "var(--color-paper-raised)", stroke: "var(--color-rule-strong)" }}
					/>
					<text x={14} y={16} fontSize={10} letterSpacing={1.1} style={{ fill: "var(--color-ink-3)" }}>
						{`GROUP · ${group.memberIds.length}`}
					</text>
					<text x={14} y={32} fontSize={13.5} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
						{truncateLabel(group.name, 36)}
					</text>
				</g>
			))}
			{scene.components.filter((component) => !isComponentHiddenByCollapse(scene, component.id)).map((component) => {
				const context = contextIds.has(component.id);
				const designId = component.kind === "database" ? component.designId : undefined;
				const schemaBadged = designId !== undefined;
				const artworkX = SYSTEM_COMPONENT_SIZE.width - 38 - (schemaBadged ? SCHEMA_BADGE_ROOM : 0);
				const kindLabel = `${componentKindLabel(component.kind).toUpperCase()}${context ? " · OUTSIDE" : ""}`;
				const kindHeader = isCatalogKind(component.kind)
					? truncateLabel(kindLabel, Math.max(1, Math.floor((artworkX - 22) / KIND_HEADER_CHARACTER_WIDTH)))
					: kindLabel;
				const ownerId = findSystemComponent(design, component.id)?.serviceId ?? null;
				const owner = ownerId === null ? undefined : serviceNames.get(ownerId);
				return (
					<g key={component.id} data-component-id={component.id} data-kind={component.kind} data-context={context ? "true" : undefined} data-service-id={component.serviceId ?? undefined} transform={`translate(${component.position.x} ${component.position.y})`}>
						<title>{component.name}</title>
						<rect
							width={SYSTEM_COMPONENT_SIZE.width}
							height={SYSTEM_COMPONENT_SIZE.height}
							rx={10}
							strokeDasharray={context ? "5 4" : undefined}
							strokeWidth={1.25}
							style={{ fill: "var(--color-paper-raised)", stroke: "var(--color-rule-strong)" }}
						/>
						<text x={14} y={22} fontSize={10} letterSpacing={1.1} style={{ fill: "var(--color-ink-3)" }}>{kindHeader}</text>
						{isCatalogKind(component.kind) && (
							<ComponentArtwork artwork={component.kind} x={artworkX} y={8} icon={component.icon} />
						)}
						<text x={14} y={44} fontSize={15} fontWeight={600} style={{ fill: "var(--color-ink)" }}>
							{truncateLabel(component.name, 22)}
						</text>
						<text x={14} y={64} fontSize={11.5} style={{ fill: "var(--color-ink-2)" }}>
							{truncateLabel(component.technology ?? component.description ?? "", 28)}
						</text>
						{designId !== undefined && (
							<text x={SYSTEM_COMPONENT_SIZE.width - 14} y={22} textAnchor="end" fontSize={10} style={{ fill: "var(--color-pencil)" }}>
								{componentsLinkedToDesign(design, designId).length > 1 ? "SHARED" : "LINKED"}
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
		</svg>,
	);
	return `<?xml version="1.0" encoding="UTF-8"?>\n${resolveColorTokens(markup)}\n`;
}

/** Rounds a coordinate to a tenth of a pixel, so the file carries no floating-point noise. */
function round(value: number): number {
	return Math.round(value * 10) / 10;
}

/** One Connection: its route, its arrowhead, and its label pill. */
function ConnectionArt({ geometry }: { geometry: ConnectionGeometry }) {
	const { connection, pathString, labelPoint } = geometry;
	const width = labelWidth(connection.label);
	const left = round(-width / 2);
	return (
		<g data-connection-id={connection.id} data-source-id={connection.sourceId} data-target-id={connection.targetId}>
			<path d={pathString} fill="none" strokeWidth={1.5} markerEnd={`url(#${ARROW_ID})`} style={{ stroke: "var(--color-ink-2)" }} />
			<g transform={`translate(${labelPoint.x} ${labelPoint.y})`}>
				<rect x={left} y={-11} width={round(width)} height={22} rx={11} style={{ fill: "var(--color-paper-raised)", stroke: "var(--color-rule-strong)" }} />
				<text textAnchor="middle" dominantBaseline="central" fontSize={11.5} style={{ fill: "var(--color-ink)" }}>
					{truncateLabel(connection.label, 26)}
				</text>
			</g>
		</g>
	);
}

/**
 * The rectangle enclosing everything drawn: frames, endpoints as drawn, and every
 * route point and label, so no bend or label is clipped. Null when nothing is drawn.
 */
function contentBounds(scene: SystemDesign, geometries: ConnectionGeometry[]): ProofRect | null {
	const points: { x: number; y: number }[] = [];
	const addRect = (rect: ProofRect) => {
		points.push({ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height });
	};
	for (const group of scene.groups) addRect({ ...group.position, ...group.size });
	for (const service of scene.services) {
		const size = isSystemServiceCollapsed(scene, service.id) ? SYSTEM_SERVICE_COLLAPSED_SIZE : service.size;
		addRect({ ...service.position, ...size });
	}
	for (const component of scene.components) {
		if (!isComponentHiddenByCollapse(scene, component.id)) addRect(componentRect(component));
	}
	for (const geometry of geometries) {
		for (const segment of geometry.segments) {
			points.push(segment.start, segment.cp1, segment.cp2, segment.end);
		}
		const half = labelWidth(geometry.connection.label) / 2;
		points.push(
			{ x: geometry.labelPoint.x - half, y: geometry.labelPoint.y - 11 },
			{ x: geometry.labelPoint.x + half, y: geometry.labelPoint.y + 11 },
		);
	}
	if (points.length === 0) return null;
	const left = Math.min(...points.map((point) => point.x));
	const top = Math.min(...points.map((point) => point.y));
	const right = Math.max(...points.map((point) => point.x));
	const bottom = Math.max(...points.map((point) => point.y));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

const COLOR_TOKEN = /var\(--color-([a-z0-9-]+)\)/g;

/** Replaces each colour token with its value. An unknown token throws, so a missing colour cannot ship silently. */
function resolveColorTokens(markup: string): string {
	return markup.replace(COLOR_TOKEN, (_match, name: string) => {
		if (!Object.prototype.hasOwnProperty.call(EXPORT_COLORS, name)) {
			throw new Error(`The System design SVG export has no colour for --color-${name}.`);
		}
		return EXPORT_COLORS[name as keyof typeof EXPORT_COLORS];
	});
}

/** Declares the bundled IBM Plex Sans as an embedded font, so the file never fetches a font. */
export function embeddedFontFaceCss(woff2DataUrl: string): string {
	return [
		"@font-face {",
		"font-family: 'IBM Plex Sans Variable';",
		"font-style: normal;",
		"font-weight: 100 700;",
		`src: url("${woff2DataUrl}") format('woff2');`,
		"}",
	].join(" ");
}
