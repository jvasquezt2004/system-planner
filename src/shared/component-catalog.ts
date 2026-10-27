import type { ComponentReactionPreset } from "./component-reactions";

/**
 * The common catalog registry for System design Component kinds. Each catalog
 * kind registers its identity, label, optional descriptive property descriptors,
 * operation presets, artwork key, and reaction preset here. The editor, playback,
 * the Assistant tools, and later exporters consume this one list rather than
 * hard-coding kinds. Entries describe the planned system only: no descriptor or
 * preset configures executable infrastructure (docs/system-components.md).
 */

export const CLIENT_TRAFFIC_KINDS = [
	"person",
	"browser",
	"mobile_app",
	"external_system",
	"dns",
	"cdn",
	"load_balancer",
	"api_gateway",
	"proxy",
] as const;

export type ClientTrafficKind = (typeof CLIENT_TRAFFIC_KINDS)[number];

export const COMPUTE_KINDS = ["application", "api", "worker", "scheduled_job", "serverless_handler"] as const;

export type ComputeKind = (typeof COMPUTE_KINDS)[number];

/** Every kind registered in the catalog, in palette order. */
export const CATALOG_KINDS = [...CLIENT_TRAFFIC_KINDS, ...COMPUTE_KINDS] as const;

export type CatalogKind = (typeof CATALOG_KINDS)[number];

/** A catalog kind's family, used to group the palette. */
export type ComponentFamily = "clients" | "traffic" | "compute";

export const COMPONENT_FAMILY_LABELS: Record<ComponentFamily, string> = {
	clients: "Actors and clients",
	traffic: "Traffic and networking",
	compute: "Compute",
};

/**
 * One optional descriptive property a kind suggests. Its value is stored in the
 * Component's `properties` under `key`, so it saves, undoes, and reads like any
 * other annotation. Nothing here is mandatory or validated against a vendor.
 */
export type ComponentPropertyDescriptor = {
	/** The stored property key, shown as the field label. */
	key: string;
	placeholder: string;
};

/** A visual operation preset a walkthrough step can select, such as "Cache hit". */
export type ComponentOperationPreset = {
	id: string;
	label: string;
};

export type ComponentCatalogEntry = {
	kind: CatalogKind;
	label: string;
	family: ComponentFamily;
	/** Name of the artwork the view draws for this kind. */
	artwork: CatalogKind;
	/** Default name stem for new Components of this kind. */
	defaultName: string;
	descriptors: readonly ComponentPropertyDescriptor[];
	operations: readonly ComponentOperationPreset[];
	reactions: ComponentReactionPreset;
};

function labels(send: string, receive: string, process: string, succeed: string, fail: string): ComponentReactionPreset["labels"] {
	return { send, receive, process, succeed, fail };
}

export const COMPONENT_CATALOG: readonly ComponentCatalogEntry[] = [
	{
		kind: "person",
		label: "Person",
		family: "clients",
		artwork: "person",
		defaultName: "Person",
		descriptors: [
			{ key: "Role", placeholder: "e.g. Customer, administrator" },
			{ key: "Intention", placeholder: "What they are trying to do" },
		],
		operations: [],
		reactions: { kind: "person", labels: labels("Asks", "Receives", "Thinking", "Done", "Gives up") },
	},
	{
		kind: "browser",
		label: "Browser",
		family: "clients",
		artwork: "browser",
		defaultName: "Browser",
		descriptors: [
			{ key: "App", placeholder: "e.g. Storefront web app" },
			{ key: "URL", placeholder: "Optional page or entry point" },
		],
		operations: [],
		reactions: { kind: "browser", labels: labels("Request", "Response", "Rendering", "Loaded", "Failed") },
	},
	{
		kind: "mobile_app",
		label: "Mobile app",
		family: "clients",
		artwork: "mobile_app",
		defaultName: "Mobile app",
		descriptors: [
			{ key: "Platform", placeholder: "e.g. iOS, Android" },
			{ key: "App", placeholder: "e.g. Shopper app" },
		],
		operations: [],
		reactions: { kind: "mobile_app", labels: labels("Request", "Response", "Rendering", "Updated", "Failed") },
	},
	{
		kind: "external_system",
		label: "External system",
		family: "clients",
		artwork: "external_system",
		defaultName: "External system",
		descriptors: [
			{ key: "Provider", placeholder: "e.g. Payment processor" },
			{ key: "Responsibility", placeholder: "What the system is responsible for" },
		],
		operations: [],
		reactions: { kind: "external_system", labels: labels("Calls", "Receives", "Processing", "Responds", "Refuses") },
	},
	{
		kind: "dns",
		label: "DNS",
		family: "traffic",
		artwork: "dns",
		defaultName: "DNS",
		descriptors: [
			{ key: "Zone", placeholder: "e.g. example.com" },
			{ key: "Record description", placeholder: "e.g. A record to the load balancer" },
		],
		operations: [
			{ id: "resolve", label: "Resolve" },
			{ id: "no-record", label: "No record" },
		],
		reactions: { kind: "dns", labels: labels("Queries", "Query", "Resolving", "Resolved", "Fails") },
	},
	{
		kind: "cdn",
		label: "CDN",
		family: "traffic",
		artwork: "cdn",
		defaultName: "CDN",
		descriptors: [
			{ key: "Content", placeholder: "e.g. Static assets, images" },
			{ key: "Cache policy", placeholder: "e.g. Cache for one day" },
		],
		operations: [
			{ id: "cache-hit", label: "Cache hit" },
			{ id: "cache-miss", label: "Cache miss" },
			{ id: "cache-fill", label: "Cache fill" },
		],
		reactions: { kind: "cdn", labels: labels("Requests", "Checks cache", "Fetching origin", "Delivered", "Failed") },
	},
	{
		kind: "load_balancer",
		label: "Load balancer",
		family: "traffic",
		artwork: "load_balancer",
		defaultName: "Load balancer",
		descriptors: [
			{ key: "Routing strategy", placeholder: "e.g. Round robin, least connections" },
			{ key: "Targets", placeholder: "e.g. Web server pool" },
		],
		operations: [
			{ id: "forward", label: "Forward" },
			{ id: "no-target", label: "No target" },
		],
		reactions: { kind: "load_balancer", labels: labels("Sends", "Receives", "Choosing target", "Forwarded", "No target") },
	},
	{
		kind: "api_gateway",
		label: "API gateway",
		family: "traffic",
		artwork: "api_gateway",
		defaultName: "API gateway",
		descriptors: [
			{ key: "Routes", placeholder: "e.g. /orders/* to Orders" },
			{ key: "Protocols", placeholder: "e.g. HTTPS, gRPC" },
			{ key: "Authentication", placeholder: "e.g. Bearer token" },
		],
		operations: [
			{ id: "forward", label: "Forward" },
			{ id: "rejected", label: "Rejected" },
			{ id: "rate-limited", label: "Rate limited" },
		],
		reactions: { kind: "api_gateway", labels: labels("Requests", "Checks", "Forwarding", "Forwarded", "Rejected") },
	},
	{
		kind: "proxy",
		label: "Proxy",
		family: "traffic",
		artwork: "proxy",
		defaultName: "Proxy",
		descriptors: [
			{ key: "Role", placeholder: "e.g. Forward proxy, reverse proxy" },
			{ key: "Protocols", placeholder: "e.g. HTTP, TCP" },
		],
		operations: [{ id: "forward", label: "Forward" }],
		reactions: { kind: "proxy", labels: labels("Sends", "Receives", "Forwarding", "Returned", "Failed") },
	},
	{
		kind: "application",
		label: "Application",
		family: "compute",
		artwork: "application",
		defaultName: "Application",
		descriptors: [{ key: "Responsibility", placeholder: "What the application is responsible for" }],
		operations: [],
		reactions: { kind: "application", labels: labels("Calls", "Receives", "Processing", "Completed", "Failed") },
	},
	{
		kind: "api",
		label: "API",
		family: "compute",
		artwork: "api",
		defaultName: "API",
		descriptors: [
			{ key: "Operations", placeholder: "e.g. GET /orders, create order" },
			{ key: "Protocols", placeholder: "e.g. HTTPS, gRPC" },
		],
		operations: [
			{ id: "respond", label: "Respond" },
			{ id: "error-response", label: "Error response" },
		],
		reactions: { kind: "api", labels: labels("Calls", "Request", "Processing", "Responds", "Error") },
	},
	{
		kind: "worker",
		label: "Worker",
		family: "compute",
		artwork: "worker",
		defaultName: "Worker",
		descriptors: [{ key: "Job type", placeholder: "e.g. Send receipts, resize images" }],
		operations: [{ id: "retry", label: "Retry" }],
		reactions: { kind: "worker", labels: labels("Sends", "Job received", "Processing", "Completed", "Failed") },
	},
	{
		kind: "scheduled_job",
		label: "Scheduled job",
		family: "compute",
		artwork: "scheduled_job",
		defaultName: "Scheduled job",
		descriptors: [
			{ key: "Schedule description", placeholder: "e.g. Every night at 02:00" },
			{ key: "Job type", placeholder: "e.g. Expire stale sessions" },
		],
		operations: [],
		reactions: { kind: "scheduled_job", labels: labels("Sends", "Triggered", "Running", "Completed", "Failed") },
	},
	{
		kind: "serverless_handler",
		label: "Serverless handler",
		family: "compute",
		artwork: "serverless_handler",
		defaultName: "Serverless handler",
		descriptors: [
			{ key: "Trigger", placeholder: "e.g. HTTP request, storage upload" },
			{ key: "Runtime description", placeholder: "e.g. Node.js function, 512 MB" },
		],
		operations: [],
		reactions: { kind: "serverless_handler", labels: labels("Calls", "Activated", "Processing", "Returned", "Failed") },
	},
];

const ENTRY_BY_KIND = new Map<string, ComponentCatalogEntry>(COMPONENT_CATALOG.map((entry) => [entry.kind, entry]));

export function catalogEntryFor(kind: string): ComponentCatalogEntry | undefined {
	return ENTRY_BY_KIND.get(kind);
}

export function isCatalogKind(value: string): value is CatalogKind {
	return ENTRY_BY_KIND.has(value);
}

/** The label for any Component kind, including the original generic and database kinds. */
export function componentKindLabel(kind: string): string {
	if (kind === "database") return "Database";
	if (kind === "generic") return "Component";
	return ENTRY_BY_KIND.get(kind)?.label ?? "Component";
}

/** Default name stem for a new Component of the given kind. */
export function componentDefaultNameStem(kind: string): string {
	if (kind === "database") return "Database";
	return ENTRY_BY_KIND.get(kind)?.defaultName ?? "Component";
}

/** The stored value of a descriptor on a Component, or an empty string when unset. */
export function descriptorValue(properties: readonly { key: string; value: string }[], key: string): string {
	return properties.find((property) => property.key === key)?.value ?? "";
}

/**
 * Sets one descriptor's value. A blank value removes the property; any other
 * value is stored as given, and a property with the same key is replaced in
 * place so the list keeps its order. Callers trim when they commit.
 */
export function withDescriptorValue<T extends { key: string; value: string }>(properties: readonly T[], key: string, value: string): T[] {
	const index = properties.findIndex((property) => property.key === key);
	if (value.trim().length === 0) return properties.filter((property) => property.key !== key);
	if (index === -1) return [...properties, { key, value } as T];
	return properties.map((property, position) => (position === index ? { ...property, value } : property));
}

/** Descriptor keys a kind suggests. Other properties are free-form. */
export function descriptorKeysFor(kind: string): string[] {
	return ENTRY_BY_KIND.get(kind)?.descriptors.map((descriptor) => descriptor.key) ?? [];
}

/**
 * Rebuilds a Component's properties from its edited free-form rows, keeping the
 * descriptor-keyed properties the inspector shows separately. A free-form row
 * that reuses a descriptor's key replaces that descriptor, so no key repeats.
 */
export function mergeFreeProperties<T extends { key: string; value: string }>(current: readonly T[], kind: string, freeRows: readonly T[]): T[] {
	const descriptorKeys = new Set(descriptorKeysFor(kind));
	const freeKeys = new Set(freeRows.map((row) => row.key));
	return [...current.filter((property) => descriptorKeys.has(property.key) && !freeKeys.has(property.key)), ...freeRows];
}

/** Normalizes an operation for matching: case, spaces, underscores, and dashes are equivalent. */
export function normalizeOperationKey(value: string): string {
	return value.trim().toLowerCase().replace(/[\s_-]+/g, "-");
}

/** The operation preset a step's free-text operation names on a kind, matched by id or label. */
export function operationPresetFor(kind: string, operation: string | undefined): ComponentOperationPreset | undefined {
	if (operation === undefined) return undefined;
	const key = normalizeOperationKey(operation);
	if (key.length === 0) return undefined;
	return ENTRY_BY_KIND.get(kind)?.operations.find((preset) => normalizeOperationKey(preset.id) === key || normalizeOperationKey(preset.label) === key);
}
