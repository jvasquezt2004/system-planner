/**
 * The calls the view makes, as parameter generators over the live workspace state. Parameters are
 * built from what the workspace holds (existing ids, wrong design ids, missing ids, odd names,
 * invalid values) so the recorded sessions cover refusals as much as successes.
 */
import type { WorkspaceState } from "../../../src/shared/design";
import { CATALOG_KINDS, CUSTOM_ICONS } from "../../../src/shared/component-catalog";
import { computeSystemLayout } from "../../../src/shared/system-layout";
import type { Rng } from "./mutate";

export type Operation = {
	method: string;
	weight: number;
	params: (state: WorkspaceState, rng: Rng) => unknown;
	/** What must already exist for the call to make sense; the generator mostly respects it. */
	when?: (state: WorkspaceState) => boolean;
};

class C {
	constructor(
		readonly s: WorkspaceState,
		readonly rng: Rng,
	) {}
	chance(p: number) {
		return this.rng() < p;
	}
	pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.rng() * items.length)]!;
	}
	int(min: number, max: number) {
		return min + Math.floor(this.rng() * (max - min + 1));
	}
	/** The active design mostly, sometimes another one or an unknown one. */
	designId(): string {
		const others = this.s.designs.map((design) => design.id);
		if (this.chance(0.06)) return this.pick(["bogus", ...others]);
		return this.s.activeDesignId ?? "none";
	}
	anyDesignId(): string {
		return this.chance(0.05) ? "bogus" : this.pick(this.s.designs.length ? this.s.designs.map((design) => design.id) : ["none"]);
	}
	tableId(): string {
		const ids = this.s.design?.tables.map((table) => table.id) ?? [];
		return ids.length === 0 || this.chance(0.05) ? "missing-table" : this.pick(ids);
	}
	columnOf(tableId: string): string {
		const table = this.s.design?.tables.find((candidate) => candidate.id === tableId);
		return !table || table.columns.length === 0 || this.chance(0.05) ? "missing-column" : this.pick(table.columns).id;
	}
	tableName(): string {
		return this.pick(["orders", "customers", "Orders", "order items", "reject_me", "boom", "a\"b", " padded ", "", "   ", "x".repeat(70), "select", "events", "users"]);
	}
	columnName(): string {
		return this.pick(["name", "email", "total", "created_at", "Name", "id", "reject_me_col", " padded ", "", "x".repeat(64), "user_id"]);
	}
	columnType(): string {
		return this.chance(0.08) ? "nonsense" : this.pick(["text", "bigint", "integer", "numeric", "uuid", "boolean", "timestamptz", "jsonb", "varchar", "vector", "enum"]);
	}
	point() {
		return { x: this.pick([0, 40, 300, -120.5, 0.005, -0.005, 333.335, this.int(-200, 900)]), y: this.pick([0, 40, 240, -75, 0.025, 480.5, this.int(-200, 900)]) };
	}
	name(): string | undefined {
		return this.chance(0.25) ? undefined : this.pick(["Alpha", "Beta", "  Padded  ", "", " ", "x".repeat(81), "é".repeat(80), "Payments", "Checkout", "Alpha"]);
	}
	text(): string | undefined {
		return this.pick([undefined, "Fastify", "  trimmed  ", "", "y".repeat(501), "A description"]);
	}
	// System design identities.
	service(): string {
		const ids = this.s.systemDesign?.services.map((item) => item.id) ?? [];
		return ids.length === 0 || this.chance(0.06) ? "missing-service" : this.pick(ids);
	}
	component(): string {
		const ids = this.s.systemDesign?.components.map((item) => item.id) ?? [];
		return ids.length === 0 || this.chance(0.06) ? "missing-component" : this.pick(ids);
	}
	group(): string {
		const ids = this.s.systemDesign?.groups.map((item) => item.id) ?? [];
		return ids.length === 0 || this.chance(0.06) ? "missing-group" : this.pick(ids);
	}
	connection(): string {
		const ids = this.s.systemDesign?.connections.map((item) => item.id) ?? [];
		return ids.length === 0 || this.chance(0.06) ? "missing-connection" : this.pick(ids);
	}
	endpoint(): string {
		return this.chance(0.5) ? this.component() : this.service();
	}
	kind(): string {
		if (this.chance(0.08)) return "nonsense";
		// Databases and the other common kinds come up often enough for linking and walkthroughs to happen.
		return this.chance(0.45) ? this.pick(["database", "database", "api", "browser", "queue", "worker"]) : this.pick(["generic", ...CATALOG_KINDS]);
	}
	databaseComponent(): string {
		const ids = this.s.systemDesign?.components.filter((item) => item.kind === "database").map((item) => item.id) ?? [];
		return ids.length === 0 || this.chance(0.06) ? "missing-component" : this.pick(ids);
	}
	members(): string[] {
		const sd = this.s.systemDesign;
		const ids = sd ? [...sd.components, ...sd.services, ...sd.groups].map((item) => item.id) : [];
		const picked = Array.from({ length: this.int(0, 3) }, () => (ids.length ? this.pick(ids) : "missing"));
		if (this.chance(0.07)) picked.push("missing-member");
		return picked;
	}
	// Walkthroughs.
	walkthrough(): string {
		const ids = this.s.walkthroughs?.map((item) => item.id) ?? [];
		return ids.length === 0 || this.chance(0.05) ? "missing-walkthrough" : this.pick(ids);
	}
	steps(walkthroughId: string): string[] {
		const found: string[] = [];
		const visit = (blocks: any[]) => {
			for (const block of blocks) {
				if (block.kind === "step") found.push(block.step.id);
				else for (const sequence of block.kind === "parallel" ? block.branches : [block.body]) visit(sequence);
			}
		};
		const walkthrough = this.s.walkthroughs?.find((item) => item.id === walkthroughId);
		if (walkthrough) visit(walkthrough.blocks);
		return found;
	}
	containers(walkthroughId: string): string[] {
		const found: string[] = [];
		const visit = (blocks: any[]) => {
			for (const block of blocks) {
				if (block.kind === "step") continue;
				found.push(block.id);
				for (const sequence of block.kind === "parallel" ? block.branches : [block.body]) visit(sequence);
			}
		};
		const walkthrough = this.s.walkthroughs?.find((item) => item.id === walkthroughId);
		if (walkthrough) visit(walkthrough.blocks);
		return found;
	}
	step(walkthroughId: string): string {
		const ids = this.steps(walkthroughId);
		return ids.length === 0 || this.chance(0.06) ? "missing-step" : this.pick(ids);
	}
	block(walkthroughId: string): string {
		const ids = this.containers(walkthroughId);
		return ids.length === 0 || this.chance(0.06) ? "missing-block" : this.pick(ids);
	}
	sequence(walkthroughId: string) {
		const roll = this.rng();
		if (roll < 0.4) return undefined;
		if (roll < 0.5) return { blockId: null };
		const sequence: Record<string, unknown> = { blockId: this.block(walkthroughId) };
		if (this.chance(0.5)) sequence.branch = this.pick([0, 1, 2, 5, -1, 1.5]);
		return sequence;
	}
	draft(): Record<string, unknown> {
		const draft: Record<string, unknown> = {};
		const text = (limit: number) => (this.chance(0.1) ? "t".repeat(limit + 1) : this.pick(["", "Short text", "  padded  ", "Explains the hop"]));
		if (this.chance(0.5)) draft.title = text(120);
		if (this.chance(0.4)) draft.explanation = text(2000);
		if (this.chance(0.4)) draft.action = this.chance(0.08) ? "teleport" : this.pick(["send", "receive", "process", "succeed", "fail"]);
		if (this.chance(0.3)) draft.operation = text(40);
		if (this.chance(0.35)) draft.durationMs = this.chance(0.2) ? null : this.chance(0.12) ? this.pick([99, 250.5]) : this.pick([100, 1500, 3000]);
		if (this.chance(0.3)) draft.travelPercent = this.chance(0.2) ? null : this.chance(0.12) ? this.pick([9, 91]) : this.pick([10, 50, 90]);
		return draft;
	}
}

const op = (method: string, weight: number, params: (c: C) => unknown): Operation => ({
	method,
	weight,
	params: (state, rng) => params(new C(state, rng)),
});

/** A text change for a "changes" object: omitted, set, or cleared with null. */
const textPatch = (c: C, key: string, target: Record<string, unknown>) => {
	const roll = c.rng();
	if (roll < 0.5) return;
	target[key] = roll < 0.65 ? null : c.text() ?? "set";
};

export const OPERATIONS: Operation[] = [
	// Projects and designs.
	op("createProject", 1, (c) => ({ name: c.pick(["Shop", "  Blog  ", "", "   ", "Notes", "x".repeat(40)]) })),
	op("openProject", 2, (c) => ({ projectId: c.chance(0.1) ? "no-such-project" : c.pick(c.s.projects.length ? c.s.projects.map((project) => project.id) : ["none"]) })),
	op("setActiveView", 3, (c) => ({ view: c.pick(["system", "database"]) })),
	op("createDesign", 1, (c) => ({ name: c.pick(["", "Reporting", "  Analytics ", "Design 2", "reporting", "x".repeat(30)]) })),
	op("openDesign", 2, (c) => ({ designId: c.anyDesignId() })),
	op("renameDesign", 1, (c) => ({ designId: c.anyDesignId(), name: c.pick(["Renamed", "", "  ", "Reporting", "reporting", "Design 1"]) })),

	// Tables and columns.
	op("addTable", 7, (c) => {
		const params: Record<string, unknown> = { designId: c.designId(), name: c.tableName() };
		if (c.chance(0.4)) params.position = c.point();
		return params;
	}),
	op("renameTable", 3, (c) => ({ designId: c.designId(), tableId: c.tableId(), name: c.tableName() })),
	op("moveTable", 4, (c) => ({ designId: c.designId(), tableId: c.tableId(), position: c.point() })),
	op("addColumn", 9, (c) => {
		const tableId = c.tableId();
		const params: Record<string, unknown> = { designId: c.designId(), tableId };
		if (c.chance(0.7)) params.name = c.columnName();
		if (c.chance(0.6)) params.type = c.columnType();
		return params;
	}),
	op("updateColumn", 8, (c) => {
		const tableId = c.tableId();
		const changes: Record<string, unknown> = {};
		if (c.chance(0.3)) changes.name = c.columnName();
		if (c.chance(0.25)) changes.type = c.columnType();
		if (c.chance(0.25)) changes.nullable = c.chance(0.9) ? c.chance(0.5) : "yes";
		if (c.chance(0.2)) changes.primaryKey = c.chance(0.5);
		if (c.chance(0.2)) changes.unique = c.chance(0.5);
		if (c.chance(0.15)) changes.identity = c.chance(0.5);
		if (c.chance(0.2)) changes.notes = c.pick(["", "  a note  ", "surrogate key"]);
		if (c.chance(0.2)) {
			changes.default = c.pick([
				{ kind: "none" }, { kind: "currentTimestamp" }, { kind: "generateUuid" },
				{ kind: "literal", literalType: "integer", value: " 7 " }, { kind: "literal", literalType: "text", value: "it's" },
				{ kind: "literal", literalType: "boolean", value: "true" }, { kind: "expression", sql: "now()" },
			]);
		}
		if (c.chance(0.1)) changes.typeParameters = c.pick([{ length: 120 }, { precision: 10, scale: 2 }, { dimensions: 3 }, { array: true }, { length: 1.5 }, { bogus: 1 }, {}]);
		return { designId: c.designId(), tableId, columnId: c.columnOf(tableId), changes };
	}),
	op("setViewport", 3, (c) => ({ designId: c.designId(), x: c.pick([0, 12.5, -40]), y: c.pick([0, 33, -8.25]), zoom: c.pick([1, 0.5, 2, 0.01, 99]) })),

	// System design: Services, Groups, Components, Connections.
	op("addSystemService", 5, (c) => {
		const params: Record<string, unknown> = { ...c.point() };
		const name = c.name();
		if (name !== undefined) params.name = name;
		return params;
	}),
	op("updateSystemService", 2, (c) => ({ serviceId: c.service(), changes: c.chance(0.8) ? { name: c.name() ?? "Renamed" } : {} })),
	op("moveSystemService", 3, (c) => ({ serviceId: c.service(), ...c.point() })),
	op("resizeSystemService", 2, (c) => ({ serviceId: c.service(), width: c.pick([0, 240, 400.6, 900]), height: c.pick([0, 160, 301.2, 700]) })),
	op("removeSystemService", 1, (c) => ({ serviceId: c.service() })),
	op("setSystemServiceCollapsed", 2, (c) => ({ serviceId: c.service(), collapsed: c.chance(0.5) })),
	op("setSystemFocus", 2, (c) => {
		const params: Record<string, unknown> = { serviceId: c.chance(0.3) ? null : c.service() };
		if (c.chance(0.5)) params.viewport = { x: c.pick([0, 12]), y: c.pick([0, -4]), zoom: c.pick([1, 0.5, 9]) };
		return params;
	}),
	op("addSystemGroup", 3, (c) => {
		const params: Record<string, unknown> = { ...c.point() };
		const name = c.name();
		if (name !== undefined) params.name = name;
		if (c.chance(0.4)) Object.assign(params, { width: c.pick([100, 360, 500]), height: c.pick([100, 240, 400]) });
		if (c.chance(0.6)) params.memberIds = c.members();
		return params;
	}),
	op("updateSystemGroup", 3, (c) => {
		const changes: Record<string, unknown> = {};
		if (c.chance(0.4)) changes.name = c.name() ?? "Renamed";
		if (c.chance(0.7)) changes.memberIds = c.members();
		return { groupId: c.group(), changes };
	}),
	op("moveSystemGroup", 2, (c) => ({ groupId: c.group(), ...c.point() })),
	op("resizeSystemGroup", 1, (c) => ({ groupId: c.group(), width: c.pick([100, 360, 500]), height: c.pick([100, 240]) })),
	op("removeSystemGroup", 1, (c) => ({ groupId: c.group() })),
	op("addSystemComponent", 9, (c) => {
		const params: Record<string, unknown> = { ...c.point() };
		if (c.chance(0.8)) params.kind = c.kind();
		const name = c.name();
		if (name !== undefined) params.name = name;
		const technology = c.text();
		if (technology !== undefined && c.chance(0.4)) params.technology = technology;
		if (params.kind === "database" && c.chance(0.5)) params.designId = c.pick(c.s.designs.length ? c.s.designs.map((design) => design.id) : ["design-1"]);
		else if (c.chance(0.05)) params.designId = "design-1";
		if (c.chance(0.2)) params.icon = c.chance(0.15) ? "star" : c.pick(CUSTOM_ICONS);
		if (c.chance(0.4)) params.serviceId = c.chance(0.15) ? null : c.service();
		return params;
	}),
	op("updateSystemComponent", 6, (c) => {
		const changes: Record<string, unknown> = {};
		if (c.chance(0.25)) changes.kind = c.kind();
		if (c.chance(0.35)) changes.name = c.name() ?? "Renamed";
		textPatch(c, "technology", changes);
		textPatch(c, "description", changes);
		if (c.chance(0.25)) changes.serviceId = c.chance(0.3) ? null : c.service();
		if (c.chance(0.15)) changes.designId = c.chance(0.3) ? null : c.anyDesignId();
		if (c.chance(0.15)) changes.icon = c.chance(0.3) ? null : c.pick(CUSTOM_ICONS);
		return { componentId: c.component(), changes };
	}),
	op("arrangeSystemLayout", 3, (c) => {
		// The view computes the arrangement and sends it; some are for a few Components, some are corrupted.
		const design = c.s.systemDesign!;
		const ids = c.chance(0.4) ? design.components.filter(() => c.chance(0.6)).map((item) => item.id) : undefined;
		const placement = JSON.parse(JSON.stringify(computeSystemLayout(design, ids)));
		const roll = c.rng();
		if (roll < 0.08 && placement.components.length) placement.components[0].id = "ghost";
		else if (roll < 0.14 && placement.components.length) placement.components[0].position = { x: null, y: 0 };
		else if (roll < 0.2 && placement.services.length) placement.services[0].size.width = null;
		else if (roll < 0.25 && placement.groups.length) placement.groups[0].id = "ghost-group";
		else if (roll < 0.3) placement.services.push({ id: "ghost-service", position: { x: 1, y: 1 }, size: { width: 300, height: 200 } });
		return { placement };
	}),
	op("moveSystemComponent", 5, (c) => ({ componentId: c.component(), ...c.point() })),
	op("removeSystemComponent", 2, (c) => ({ componentId: c.component() })),
	op("addSystemConnection", 8, (c) => {
		const params: Record<string, unknown> = { sourceId: c.endpoint(), targetId: c.endpoint() };
		const label = c.name();
		if (label !== undefined) params.label = label;
		const protocol = c.text();
		if (protocol !== undefined && c.chance(0.4)) params.protocol = protocol;
		return params;
	}),
	op("updateSystemConnection", 6, (c) => {
		const changes: Record<string, unknown> = {};
		if (c.chance(0.2)) changes.sourceId = c.endpoint();
		if (c.chance(0.2)) changes.targetId = c.endpoint();
		if (c.chance(0.35)) changes.label = c.name() ?? "Relabelled";
		textPatch(c, "interactionType", changes);
		for (const key of ["fromSide", "toSide"]) if (c.chance(0.25)) changes[key] = c.chance(0.2) ? null : c.pick(["auto", "top", "right", "bottom", "left", "diagonal"]);
		if (c.chance(0.2)) changes.bendPoints = Array.from({ length: c.int(0, 3) }, () => c.point());
		if (c.chance(0.15)) changes.labelOffset = c.chance(0.3) ? null : c.point();
		return { connectionId: c.connection(), changes };
	}),
	op("removeSystemConnection", 2, (c) => ({ connectionId: c.connection() })),
	op("setSystemViewport", 2, (c) => ({ x: c.pick([0, 15]), y: c.pick([0, -9]), zoom: c.pick([1, 0.7, 99]) })),
	op("linkSystemDatabase", 3, (c) => ({ componentId: c.databaseComponent(), designId: c.chance(0.3) ? null : c.anyDesignId() })),
	op("createSystemDatabaseDesign", 2, (c) => {
		const params: Record<string, unknown> = { componentId: c.databaseComponent() };
		if (c.chance(0.5)) params.name = c.pick(["Orders DB", "", "  ", "Design 1", "Orders DB"]);
		return params;
	}),
	op("describeSystemServiceRemoval", 1, (c) => ({ serviceId: c.service() })),
	op("describeSystemComponentRemoval", 1, (c) => ({ componentId: c.component() })),
	op("describeSystemConnectionRemoval", 1, (c) => ({ connectionId: c.connection() })),

	// Walkthroughs.
	op("createWalkthrough", 3, (c) => {
		const params: Record<string, unknown> = {};
		if (c.chance(0.6)) params.name = c.pick(["Checkout", "Refund flow", "  Padded  ", "", "Walkthrough", "x".repeat(81)]);
		return params;
	}),
	op("renameWalkthrough", 1, (c) => ({ walkthroughId: c.walkthrough(), name: c.pick(["Renamed", "", "Checkout", "x".repeat(81)]) })),
	op("removeWalkthrough", 1, (c) => ({ walkthroughId: c.walkthrough() })),
	op("moveWalkthrough", 2, (c) => ({ walkthroughId: c.walkthrough(), toIndex: c.pick([0, 1, 2, -1, 9]) })),
	op("addWalkthroughStep", 16, (c) => {
		const walkthroughId = c.walkthrough();
		const params: Record<string, unknown> = { walkthroughId, connectionId: c.connection(), ...c.draft() };
		const sequence = c.sequence(walkthroughId);
		if (sequence) params.sequence = sequence;
		return params;
	}),
	op("updateWalkthroughStep", 6, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, stepId: c.step(walkthroughId), changes: c.draft() };
	}),
	op("moveWalkthroughStep", 4, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, stepId: c.step(walkthroughId), toIndex: c.pick([0, 1, 2, -1, 9]) };
	}),
	op("removeWalkthroughStep", 3, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, stepId: c.step(walkthroughId) };
	}),
	op("addWalkthroughBlock", 5, (c) => {
		const walkthroughId = c.walkthrough();
		const params: Record<string, unknown> = { walkthroughId, kind: c.pick(["parallel", "repeat"]) };
		const sequence = c.sequence(walkthroughId);
		if (sequence) params.sequence = sequence;
		return params;
	}),
	op("addWalkthroughParallelBranch", 2, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, blockId: c.block(walkthroughId) };
	}),
	op("updateWalkthroughRepeat", 3, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, blockId: c.block(walkthroughId), count: c.pick([1, 2, 5, 10, 0, 11]) };
	}),
	op("moveWalkthroughBlock", 2, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, blockId: c.block(walkthroughId), toIndex: c.pick([0, 1, -1, 9]) };
	}),
	op("removeWalkthroughBlock", 2, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, blockId: c.block(walkthroughId) };
	}),
	op("repairWalkthroughStep", 2, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, stepId: c.step(walkthroughId), connectionId: c.connection() };
	}),
	op("acceptWalkthroughStepRedirection", 2, (c) => {
		const walkthroughId = c.walkthrough();
		return { walkthroughId, stepId: c.step(walkthroughId) };
	}),
];

const count = (items: unknown[] | undefined | null) => items?.length ?? 0;
const hasStep = (state: WorkspaceState) => (state.walkthroughs ?? []).some((walkthrough) => JSON.stringify(walkthrough.blocks).includes('"kind":"step"'));
const hasContainer = (state: WorkspaceState) => (state.walkthroughs ?? []).some((walkthrough) => /"kind":"(parallel|repeat)"/.test(JSON.stringify(walkthrough.blocks)));
const hasTables = (state: WorkspaceState) => count(state.design?.tables) > 0;
const hasServices = (state: WorkspaceState) => count(state.systemDesign?.services) > 0;
const hasComponents = (state: WorkspaceState) => count(state.systemDesign?.components) > 0;
const hasGroups = (state: WorkspaceState) => count(state.systemDesign?.groups) > 0;
const hasConnections = (state: WorkspaceState) => count(state.systemDesign?.connections) > 0;
const hasProject = (state: WorkspaceState) => state.project !== null;

const NEEDS: Record<string, (state: WorkspaceState) => boolean> = {
	setActiveView: hasProject,
	createDesign: hasProject, openDesign: hasProject, renameDesign: hasProject,
	addTable: hasProject,
	renameTable: hasTables, moveTable: hasTables, addColumn: hasTables, updateColumn: hasTables, setViewport: hasProject,
	addSystemService: hasProject, addSystemGroup: hasProject, addSystemComponent: hasProject, setSystemViewport: hasProject,
	updateSystemService: hasServices, moveSystemService: hasServices, resizeSystemService: hasServices, removeSystemService: hasServices,
	setSystemServiceCollapsed: hasServices, setSystemFocus: hasServices, describeSystemServiceRemoval: hasServices,
	updateSystemGroup: hasGroups, moveSystemGroup: hasGroups, resizeSystemGroup: hasGroups, removeSystemGroup: hasGroups,
	updateSystemComponent: hasComponents, moveSystemComponent: hasComponents, arrangeSystemLayout: hasComponents, removeSystemComponent: hasComponents,
	describeSystemComponentRemoval: hasComponents,
	linkSystemDatabase: (state) => (state.systemDesign?.components ?? []).some((item) => item.kind === "database"),
	createSystemDatabaseDesign: (state) => (state.systemDesign?.components ?? []).some((item) => item.kind === "database" && !item.designId),
	addSystemConnection: (state) => count(state.systemDesign?.components) + count(state.systemDesign?.services) >= 2,
	updateSystemConnection: hasConnections, removeSystemConnection: hasConnections, describeSystemConnectionRemoval: hasConnections,
	createWalkthrough: hasProject,
	renameWalkthrough: (state) => count(state.walkthroughs) > 0, removeWalkthrough: (state) => count(state.walkthroughs) > 0,
	moveWalkthrough: (state) => count(state.walkthroughs) > 1,
	addWalkthroughStep: (state) => count(state.walkthroughs) > 0 && hasConnections(state),
	addWalkthroughBlock: (state) => count(state.walkthroughs) > 0,
	updateWalkthroughStep: hasStep, moveWalkthroughStep: hasStep, removeWalkthroughStep: hasStep,
	repairWalkthroughStep: (state) => hasStep(state) && hasConnections(state), acceptWalkthroughStepRedirection: hasStep,
	addWalkthroughParallelBranch: hasContainer, updateWalkthroughRepeat: hasContainer, moveWalkthroughBlock: hasContainer, removeWalkthroughBlock: hasContainer,
};
for (const operation of OPERATIONS) operation.when = NEEDS[operation.method];
