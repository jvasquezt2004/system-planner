import type { ReactNode } from "react";
import type { CatalogKind } from "../shared/component-catalog";

/**
 * Pencil-line artwork for the catalog kinds. Each glyph sits in a 24 by 24 box,
 * strokes with the pencil colour, and leaves fills empty, so it reads like the
 * rest of the sketch. The registry names the artwork per kind; the record below
 * must cover every kind, so a new kind cannot ship without one.
 */
export const COMPONENT_ARTWORK_SIZE = 24;

const ARTWORK: Record<CatalogKind, () => ReactNode> = {
	person: () => (
		<>
			<circle cx={12} cy={8} r={3.5} />
			<path d="M5 20.5c.8-3.6 3.6-5.6 7-5.6s6.2 2 7 5.6" />
		</>
	),
	browser: () => (
		<>
			<rect x={3} y={4.5} width={18} height={15} rx={2} />
			<path d="M3 9h18" />
			<path d="M11 13.5h6M11 16.5h4" />
		</>
	),
	mobile_app: () => (
		<>
			<rect x={7} y={2.5} width={10} height={19} rx={2.2} />
			<path d="M10.5 5.5h3" />
			<path d="M11 18.5h2" />
		</>
	),
	external_system: () => (
		<>
			<rect x={3} y={7} width={12} height={12} rx={1.5} />
			<path d="M11 13h10" />
			<path d="M18 10l3 3-3 3" />
		</>
	),
	dns: () => (
		<>
			<circle cx={12} cy={12} r={9} />
			<ellipse cx={12} cy={12} rx={4} ry={9} />
			<path d="M3 12h18" />
		</>
	),
	cdn: () => (
		<>
			<path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.8 3.7 3.7 0 0 0 7 18.5z" />
			<path d="M9.5 14.5l2 2 3.5-3.5" />
		</>
	),
	load_balancer: () => (
		<>
			<circle cx={5} cy={12} r={2.2} />
			<path d="M7.2 12H11" />
			<path d="M11 12l7-7M11 12h7M11 12l7 7" />
			<circle cx={19.5} cy={5} r={1.5} />
			<circle cx={19.5} cy={12} r={1.5} />
			<circle cx={19.5} cy={19} r={1.5} />
		</>
	),
	api_gateway: () => (
		<>
			<path d="M5 4v16M19 4v16" />
			<path d="M2 12h17" />
			<path d="M15.5 8.5L19 12l-3.5 3.5" />
		</>
	),
	proxy: () => (
		<>
			<path d="M4 8.5h16" />
			<path d="M16.5 5l3.5 3.5-3.5 3.5" />
			<path d="M20 15.5H4" />
			<path d="M7.5 12L4 15.5l3.5 3.5" />
		</>
	),
	application: () => (
		<>
			<rect x={3} y={4.5} width={18} height={15} rx={2} />
			<path d="M3 9h18" />
			<path d="M9.5 12.5L7.5 14.5l2 2M14.5 12.5l2 2-2 2" />
		</>
	),
	api: () => (
		<>
			<path d="M8.5 6L3 12l5.5 6" />
			<path d="M15.5 6L21 12l-5.5 6" />
			<path d="M13.5 4.5l-3 15" />
		</>
	),
	worker: () => (
		<>
			<circle cx={12} cy={12} r={3} />
			<circle cx={12} cy={12} r={7.5} />
			<path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.5 1.5M17.4 17.4l1.5 1.5M5.1 18.9l1.5-1.5M17.4 6.6l1.5-1.5" />
		</>
	),
	scheduled_job: () => (
		<>
			<circle cx={12} cy={12} r={9} />
			<path d="M12 7v5l3.5 2" />
		</>
	),
	serverless_handler: () => (
		<>
			<path d="M13.5 2.5L5 13.5h6l-1 8 8.5-11h-6l1-7.5z" />
		</>
	),
	database: () => (
		<>
			<ellipse cx={12} cy={5.5} rx={8} ry={3} />
			<path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13" />
			<path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3" />
		</>
	),
	cache: () => (
		<>
			<rect x={5} y={5} width={14} height={14} rx={2} />
			<rect x={9} y={9} width={6} height={6} />
			<path d="M9 2.5V5M15 2.5V5M9 19v2.5M15 19v2.5M2.5 9H5M2.5 15H5M19 9h2.5M19 15h2.5" />
		</>
	),
	object_storage_bucket: () => (
		<>
			<ellipse cx={12} cy={7} rx={7.5} ry={2.5} />
			<path d="M4.5 7l1.6 13h11.8l1.6-13" />
			<path d="M9 12.5h6" />
		</>
	),
	file_storage: () => (
		<>
			<path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.5H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
			<path d="M3 11h18" />
		</>
	),
	search_index: () => (
		<>
			<circle cx={10.5} cy={10.5} r={6.5} />
			<path d="M15.5 15.5L21 21" />
		</>
	),
	queue: () => (
		<>
			<rect x={2.5} y={8.5} width={5} height={7} rx={1} />
			<rect x={9.5} y={8.5} width={5} height={7} rx={1} />
			<path d="M17 12h4M19 10l2 2-2 2" />
		</>
	),
	topic: () => (
		<>
			<circle cx={12} cy={12} r={2} />
			<path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7" />
			<path d="M5.5 5.5a9.5 9.5 0 0 0 0 13M18.5 5.5a9.5 9.5 0 0 1 0 13" />
		</>
	),
	event_bus: () => (
		<>
			<path d="M2.5 12h19" />
			<path d="M6 12V5.5M12 12v6.5M18 12V5.5" />
			<circle cx={6} cy={4} r={1.5} />
			<circle cx={12} cy={20} r={1.5} />
			<circle cx={18} cy={4} r={1.5} />
		</>
	),
	event_stream: () => (
		<>
			<circle cx={4} cy={6} r={1.5} />
			<path d="M8 6h12" />
			<circle cx={4} cy={12} r={1.5} />
			<path d="M8 12h9" />
			<circle cx={4} cy={18} r={1.5} />
			<path d="M8 18h12" />
		</>
	),
};

/** Artwork for a catalog kind, placed with its top-left corner at (x, y). */
export function ComponentArtwork({ artwork, x, y }: { artwork: CatalogKind; x: number; y: number }) {
	return (
		<g
			data-testid="component-artwork"
			data-artwork={artwork}
			transform={`translate(${x} ${y})`}
			pointerEvents="none"
			style={{ fill: "none", stroke: "var(--color-pencil)", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" }}
		>
			{ARTWORK[artwork]()}
		</g>
	);
}
