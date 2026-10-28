import type { ReactNode } from "react";
import type { CustomIcon } from "../shared/component-catalog";

/** The shapes a Custom component can show, one glyph per supported icon. */
export const CUSTOM_ICON_ARTWORK: Record<CustomIcon, () => ReactNode> = {
	rectangle: () => <rect x={3} y={5.5} width={18} height={13} rx={1.5} />,
	hexagon: () => <path d="M7 3.5h10l5 8.5-5 8.5H7l-5-8.5z" />,
	diamond: () => <path d="M12 2.5l9.5 9.5-9.5 9.5L2.5 12z" />,
	cylinder: () => (
		<>
			<ellipse cx={12} cy={5.5} rx={7.5} ry={2.5} />
			<path d="M4.5 5.5v13c0 1.38 3.36 2.5 7.5 2.5s7.5-1.12 7.5-2.5v-13" />
		</>
	),
	cloud: () => <path d="M7.5 18.5h9a4.5 4.5 0 0 0 .4-8.98A6 6 0 0 0 5.6 11.2 4 4 0 0 0 7.5 18.5z" />,
	document: () => (
		<>
			<path d="M6 2.5h8.5L19 7v14.5H6z" />
			<path d="M14.5 2.5V7H19" />
			<path d="M9 12h7M9 15.5h7" />
		</>
	),
	gear: () => (
		<>
			<circle cx={12} cy={12} r={3} />
			<circle cx={12} cy={12} r={7.5} />
			<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.1 5.1l2.1 2.1M16.8 16.8l2.1 2.1M5.1 18.9l2.1-2.1M16.8 7.2l2.1-2.1" />
		</>
	),
};
