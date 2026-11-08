/**
 * Hand-built, valid documents that the differential generators mutate. They are
 * deliberately rich: every optional field, every nesting form, and the legacy
 * shapes older databases still contain.
 */

export const SYSTEM_DESIGN_RICH = {
	services: [
		{ id: "svc-checkout", name: "Checkout", position: { x: 40, y: 60.5 }, size: { width: 480, height: 320 } },
		{ id: "svc-search", name: "Search", position: { x: 640, y: 60 }, size: { width: 300, height: 200 } },
	],
	groups: [
		{ id: "grp-eu", name: "EU region", position: { x: 0, y: 0 }, size: { width: 900, height: 600 }, memberIds: ["svc-checkout", "cmp-db"] },
		{ id: "grp-all", name: "Everything", position: { x: -20, y: -20 }, size: { width: 1200, height: 800 }, memberIds: ["grp-eu", "cmp-web"] },
	],
	components: [
		{ id: "cmp-web", kind: "browser", name: "Storefront", properties: [], position: { x: -200, y: 80 }, serviceId: null },
		{
			id: "cmp-api",
			kind: "api",
			name: "Checkout API",
			technology: "Fastify",
			description: "Handles carts and payments",
			properties: [{ key: "runtime", value: "node" }, { key: "port", value: "8080" }],
			position: { x: 80.25, y: 120.75 },
			serviceId: "svc-checkout",
		},
		{ id: "cmp-db", kind: "database", name: "Orders DB", properties: [], position: { x: 300, y: 140 }, serviceId: null, designId: "design-1" },
		{ id: "cmp-queue", kind: "queue", name: "Payments queue", properties: [], position: { x: 300, y: 260 }, serviceId: "svc-checkout" },
		{ id: "cmp-custom", kind: "custom", name: "Legacy box", properties: [], position: { x: 700, y: 100 }, serviceId: "svc-search", icon: "gear" },
		{ id: "cmp-generic", kind: "generic", name: "Mystery", description: "  padded  ", properties: [], position: { x: 720, y: 160 }, serviceId: null },
	],
	connections: [
		{
			id: "con-1",
			sourceId: "cmp-web",
			targetId: "cmp-api",
			label: "Places order",
			interactionType: "Synchronous request",
			protocol: "HTTPS",
			fromSide: "right",
			toSide: "left",
			bendPoints: [{ x: -100.123, y: 50.456 }, { x: -50, y: 90 }],
			labelOffset: { x: 12, y: -8 },
		},
		{ id: "con-2", sourceId: "cmp-api", targetId: "cmp-db", label: "Writes order" },
		{ id: "con-3", sourceId: "svc-checkout", targetId: "cmp-queue", label: "Emits payment" },
	],
	viewport: { x: -12.5, y: 3, zoom: 1.25 },
	collapsedServiceIds: ["svc-search"],
	focusedServiceId: "svc-checkout",
	focusViewport: { x: 4, y: 5, zoom: 0.75 },
};

/** A document saved before Services, Groups, collapsing, focus, and routes existed. */
export const SYSTEM_DESIGN_LEGACY = {
	components: [
		{ id: "a", kind: "generic", name: "Web", position: { x: 0, y: 0 }, properties: [] },
		{ id: "b", kind: "database", name: "DB", position: { x: 200, y: 0 }, properties: [{ key: "engine", value: "postgres" }] },
	],
	connections: [{ id: "c1", sourceId: "a", targetId: "b", label: "Reads" }],
	viewport: { x: 0, y: 0, zoom: 1 },
};

export const SYSTEM_DESIGN_EMPTY = {
	services: [],
	groups: [],
	components: [],
	connections: [],
	viewport: { x: 0, y: 0, zoom: 1 },
	collapsedServiceIds: [],
	focusedServiceId: null,
	focusViewport: { x: 0, y: 0, zoom: 1 },
};

const step = (id: string, connectionId: string, extra: Record<string, unknown> = {}) => ({
	id,
	connectionId,
	route: { sourceId: "cmp-web", targetId: "cmp-api" },
	title: `Step ${id}`,
	explanation: "Explains the step.",
	action: "send",
	...extra,
});

export const WALKTHROUGHS_RICH = [
	{
		id: "wt-1",
		name: "Place an order",
		blocks: [
			{ kind: "step", step: step("s1", "con-1", { operation: "upload", durationMs: 1200, travelPercent: 60, exampleMessage: "POST /orders", examplePayload: "{\"id\":1}" }) },
			{
				kind: "parallel",
				id: "p1",
				branches: [
					[{ kind: "step", step: step("s2", "con-2", { action: "process" }) }],
					[
						{ kind: "repeat", id: "r1", count: 3, body: [{ kind: "step", step: step("s3", "con-3", { action: "receive" }) }] },
						{ kind: "step", step: step("s4", "con-3", { action: "succeed", title: "" }) },
					],
				],
			},
			{ kind: "step", step: step("s5", "con-1", { action: "fail", durationMs: 100, travelPercent: 10 }) },
		],
	},
	{ id: "wt-2", name: "Empty", blocks: [] },
];

/** The flat `steps` form written before blocks existed. */
export const WALKTHROUGHS_LEGACY = [
	{
		id: "old",
		name: "Old style",
		steps: [step("o1", "con-1"), step("o2", "con-2", { action: "process", operation: "cache hit" })],
	},
];
