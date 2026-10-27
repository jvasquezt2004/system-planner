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

export const DATA_KINDS = [
	"database",
	"cache",
	"object_storage_bucket",
	"file_storage",
	"search_index",
] as const;

export type DataKind = (typeof DATA_KINDS)[number];

export const MESSAGING_KINDS = ["queue", "topic", "event_bus", "event_stream"] as const;

export type MessagingKind = (typeof MESSAGING_KINDS)[number];

export const SUPPORTING_KINDS = ["identity_provider", "secrets_store", "configuration", "observability"] as const;

export type SupportingKind = (typeof SUPPORTING_KINDS)[number];

export const CUSTOM_KINDS = ["custom"] as const;

/**
 * The icons or shapes a Custom Component can show. A Custom Component with no
 * chosen icon draws the rectangle. Only a Custom Component stores one.
 */
export const CUSTOM_ICONS = ["rectangle", "hexagon", "diamond", "cylinder", "cloud", "document", "gear"] as const;

export type CustomIcon = (typeof CUSTOM_ICONS)[number];

export const CUSTOM_ICON_LABELS: Record<CustomIcon, string> = {
	rectangle: "Rectangle",
	hexagon: "Hexagon",
	diamond: "Diamond",
	cylinder: "Cylinder",
	cloud: "Cloud",
	document: "Document",
	gear: "Gear",
};

/** Every kind registered in the catalog, in palette order. */
export const CATALOG_KINDS = [
	...CLIENT_TRAFFIC_KINDS,
	...COMPUTE_KINDS,
	...DATA_KINDS,
	...MESSAGING_KINDS,
	...SUPPORTING_KINDS,
	...CUSTOM_KINDS,
] as const;

export type CatalogKind = (typeof CATALOG_KINDS)[number];

/** A catalog kind's family, used to group the palette. */
export type ComponentFamily = "clients" | "traffic" | "compute" | "data" | "messaging" | "supporting" | "custom";

export const COMPONENT_FAMILY_LABELS: Record<ComponentFamily, string> = {
	clients: "Actors and clients",
	traffic: "Traffic and networking",
	compute: "Compute",
	data: "Data",
	messaging: "Messaging",
	supporting: "Supporting capabilities",
	custom: "Custom",
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
	{
		kind: "database",
		label: "Database",
		family: "data",
		artwork: "database",
		defaultName: "Database",
		descriptors: [
			{ key: "Engine", placeholder: "e.g. PostgreSQL, MongoDB" },
			{ key: "Database kind", placeholder: "e.g. Relational, document, key/value" },
		],
		operations: [
			{ id: "read", label: "Read" },
			{ id: "write", label: "Write" },
		],
		reactions: { kind: "database", labels: labels("Queries", "Query", "Executing", "Returned", "Failed") },
	},
	{
		kind: "cache",
		label: "Cache",
		family: "data",
		artwork: "cache",
		defaultName: "Cache",
		descriptors: [
			{ key: "Engine", placeholder: "e.g. Redis, Memcached" },
			{ key: "Key description", placeholder: "e.g. Product pages by slug" },
			{ key: "Expiry policy", placeholder: "e.g. Expire after 10 minutes" },
		],
		operations: [
			{ id: "hit", label: "Hit" },
			{ id: "miss", label: "Miss" },
			{ id: "set", label: "Set" },
			{ id: "invalidate", label: "Invalidate" },
		],
		reactions: { kind: "cache", labels: labels("Looks up", "Lookup", "Checking", "Returned", "Failed") },
	},
	{
		kind: "object_storage_bucket",
		label: "Object-storage bucket",
		family: "data",
		artwork: "object_storage_bucket",
		defaultName: "Object-storage bucket",
		descriptors: [
			{ key: "Object purpose", placeholder: "e.g. User avatars" },
			{ key: "Prefix", placeholder: "e.g. avatars/" },
			{ key: "Lifecycle description", placeholder: "e.g. Delete after 30 days" },
		],
		operations: [
			{ id: "upload", label: "Upload" },
			{ id: "download", label: "Download" },
			{ id: "delete", label: "Delete" },
		],
		reactions: { kind: "object_storage_bucket", labels: labels("Sends", "Receives", "Storing", "Stored", "Refused") },
	},
	{
		kind: "file_storage",
		label: "File storage",
		family: "data",
		artwork: "file_storage",
		defaultName: "File storage",
		descriptors: [
			{ key: "Volume", placeholder: "e.g. 500 GB shared volume" },
			{ key: "Mount", placeholder: "e.g. /srv/uploads" },
			{ key: "Protocol", placeholder: "e.g. NFS, SMB" },
		],
		operations: [
			{ id: "read", label: "Read" },
			{ id: "write", label: "Write" },
		],
		reactions: { kind: "file_storage", labels: labels("Requests", "Request", "Working", "Returned", "Failed") },
	},
	{
		kind: "search_index",
		label: "Search index",
		family: "data",
		artwork: "search_index",
		defaultName: "Search index",
		descriptors: [
			{ key: "Indexed subject", placeholder: "e.g. Product catalog" },
			{ key: "Indexing approach", placeholder: "e.g. Near real time from the orders queue" },
		],
		operations: [
			{ id: "index", label: "Index" },
			{ id: "search", label: "Search" },
		],
		reactions: { kind: "search_index", labels: labels("Queries", "Query", "Searching", "Results returned", "Failed") },
	},
	{
		kind: "queue",
		label: "Queue",
		family: "messaging",
		artwork: "queue",
		defaultName: "Queue",
		descriptors: [
			{ key: "Message type", placeholder: "e.g. Order placed" },
			{ key: "Delivery and retry", placeholder: "e.g. At least once, retry three times" },
		],
		operations: [
			{ id: "enqueue", label: "Enqueue" },
			{ id: "release", label: "Release" },
			{ id: "acknowledge", label: "Acknowledge" },
			{ id: "retry", label: "Retry" },
		],
		reactions: { kind: "queue", labels: labels("Sends", "Received", "Queued", "Acknowledged", "Released") },
	},
	{
		kind: "topic",
		label: "Topic",
		family: "messaging",
		artwork: "topic",
		defaultName: "Topic",
		descriptors: [
			{ key: "Event type", placeholder: "e.g. Order placed" },
			{ key: "Subscriber description", placeholder: "e.g. Billing and email services" },
		],
		operations: [
			{ id: "publish", label: "Publish" },
			{ id: "deliver", label: "Deliver" },
		],
		reactions: { kind: "topic", labels: labels("Publishes", "Published", "Delivering", "Delivered", "Undelivered") },
	},
	{
		kind: "event_bus",
		label: "Event bus",
		family: "messaging",
		artwork: "event_bus",
		defaultName: "Event bus",
		descriptors: [
			{ key: "Event types", placeholder: "e.g. Order and payment events" },
			{ key: "Routing description", placeholder: "e.g. Route by event type" },
		],
		operations: [
			{ id: "route", label: "Route" },
			{ id: "deliver", label: "Deliver" },
		],
		reactions: { kind: "event_bus", labels: labels("Emits", "Receives", "Routing", "Delivered", "Unrouted") },
	},
	{
		kind: "event_stream",
		label: "Event stream",
		family: "messaging",
		artwork: "event_stream",
		defaultName: "Event stream",
		descriptors: [
			{ key: "Event type", placeholder: "e.g. Click events" },
			{ key: "Partition and retention", placeholder: "e.g. 12 partitions, keep seven days" },
		],
		operations: [
			{ id: "append", label: "Append" },
			{ id: "consume", label: "Consume" },
			{ id: "replay", label: "Replay" },
		],
		reactions: { kind: "event_stream", labels: labels("Appends", "Appended", "Consuming", "Consumed", "Failed") },
	},
	{
		kind: "identity_provider",
		label: "Identity provider",
		family: "supporting",
		artwork: "identity_provider",
		defaultName: "Identity provider",
		descriptors: [
			{ key: "Authentication method", placeholder: "e.g. OpenID Connect, SAML" },
			{ key: "Issuer", placeholder: "e.g. https://login.example.com" },
		],
		operations: [
			{ id: "authenticate", label: "Authenticate" },
			{ id: "issue-token", label: "Issue token" },
			{ id: "deny", label: "Deny" },
		],
		reactions: { kind: "identity_provider", labels: labels("Requests", "Checks", "Authenticating", "Authenticated", "Denied") },
	},
	{
		kind: "secrets_store",
		label: "Secrets store",
		family: "supporting",
		artwork: "secrets_store",
		defaultName: "Secrets store",
		descriptors: [
			{ key: "Secret references", placeholder: "e.g. payments/api-key, db/password" },
			{ key: "Consuming roles", placeholder: "e.g. Orders API, Worker" },
		],
		operations: [
			{ id: "retrieve", label: "Retrieve" },
			{ id: "deny", label: "Deny" },
		],
		reactions: { kind: "secrets_store", labels: labels("Requests", "Request", "Retrieving", "Retrieved", "Denied") },
	},
	{
		kind: "configuration",
		label: "Configuration",
		family: "supporting",
		artwork: "configuration",
		defaultName: "Configuration",
		descriptors: [
			{ key: "Configuration scope", placeholder: "e.g. Production, per service" },
			{ key: "Consumers", placeholder: "e.g. Orders API, Worker" },
		],
		operations: [
			{ id: "fetch", label: "Fetch" },
			{ id: "deliver-update", label: "Deliver update" },
		],
		reactions: { kind: "configuration", labels: labels("Fetches", "Receives", "Loading", "Delivered", "Failed") },
	},
	{
		kind: "observability",
		label: "Observability",
		family: "supporting",
		artwork: "observability",
		defaultName: "Observability",
		descriptors: [
			{ key: "Signals", placeholder: "e.g. Logs, metrics, traces" },
			{ key: "Alert purpose", placeholder: "e.g. Page on-call when checkout fails" },
		],
		operations: [
			{ id: "record", label: "Record" },
			{ id: "alert", label: "Alert" },
		],
		reactions: { kind: "observability", labels: labels("Sends", "Receives", "Recording", "Recorded", "Failed") },
	},
	{
		kind: "custom",
		label: "Custom",
		family: "custom",
		artwork: "custom",
		defaultName: "Custom",
		descriptors: [{ key: "Purpose", placeholder: "e.g. Loyalty points calculator" }],
		operations: [],
		reactions: { kind: "custom", labels: labels("Sends", "Receives", "Processing", "Succeeded", "Failed") },
	},
];

const ENTRY_BY_KIND = new Map<string, ComponentCatalogEntry>(COMPONENT_CATALOG.map((entry) => [entry.kind, entry]));

export function catalogEntryFor(kind: string): ComponentCatalogEntry | undefined {
	return ENTRY_BY_KIND.get(kind);
}

export function isCatalogKind(value: string): value is CatalogKind {
	return ENTRY_BY_KIND.has(value);
}

/** The label for any Component kind; the generic kind is the only one outside the catalog. */
export function componentKindLabel(kind: string): string {
	return ENTRY_BY_KIND.get(kind)?.label ?? "Component";
}

/** Default name stem for a new Component of the given kind. */
export function componentDefaultNameStem(kind: string): string {
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
