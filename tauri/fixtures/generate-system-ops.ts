/**
 * Writes differential fixtures for the System design editing operations.
 *
 * Each session starts from a document and applies a long random sequence of
 * operations through the real functions in src/shared/system-design.ts. Every
 * call is recorded with its result or error message; a successful call becomes
 * the next state. The Rust port replays the same sequence and must agree on every
 * step.
 *
 * Arguments are built from the current document (existing ids, missing ids, blank
 * and oversized names, rounding-tie coordinates, valid and invalid kinds), and they
 * are plain JSON as they would arrive over RPC.
 *
 * Run from the repository root: bun tauri/fixtures/generate-system-ops.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as S from "../../src/shared/system-design";
import { CATALOG_KINDS, CUSTOM_ICONS } from "../../src/shared/component-catalog";
import { seededRng, type Rng } from "./lib/mutate";
import { SYSTEM_DESIGN_EMPTY, SYSTEM_DESIGN_LEGACY, SYSTEM_DESIGN_RICH } from "./lib/bases";

type Design = S.SystemDesign;
type Args = Record<string, unknown>;
type Op = {
	name: string;
	weight: number;
	/** Whether the result is a new design (and so the next state) rather than a plan. */
	design: boolean;
	args: (ctx: Ctx) => Args;
	run: (design: Design, args: any) => unknown;
};

class Ctx {
	counter = 0;
	constructor(
		readonly rng: Rng,
		public design: Design,
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
	/** An existing id of one of the kinds, or a missing one when none exists or by chance. */
	existing(kind: "service" | "component" | "group" | "connection" | "any"): string {
		const d = this.design;
		const pool: Record<string, string[]> = {
			service: d.services.map((x) => x.id),
			component: d.components.map((x) => x.id),
			group: d.groups.map((x) => x.id),
			connection: d.connections.map((x) => x.id),
		};
		const ids = kind === "any" ? [...pool.service!, ...pool.component!, ...pool.group!] : pool[kind]!;
		if (ids.length === 0 || this.chance(0.07)) return this.pick(["missing", "", "  ", "ghost-id"]);
		return this.pick(ids);
	}
	/** A fresh id usually; sometimes one already in use (any namespace), blank, or padded. */
	newId(): string {
		if (this.chance(0.12)) {
			const d = this.design;
			const all = [...d.services, ...d.components, ...d.groups, ...d.connections].map((x) => x.id);
			if (all.length > 0) return this.pick(all);
		}
		if (this.chance(0.04)) return this.pick(["", "   "]);
		this.counter += 1;
		return `n${this.counter}`;
	}
	name(): string | undefined {
		const roll = this.rng();
		if (roll < 0.3) return undefined;
		return this.pick(["Alpha", "Beta Service", "  Padded  ", "", " ", "x".repeat(80), "x".repeat(81), "é".repeat(80), "💥".repeat(41), "Ünïcode", "Payments"]);
	}
	coordinate(): number {
		return this.pick([0, 1, -1, 10, 40, 120.5, 300, -75, 0.005, -0.005, -0.025, 1.005, 2.675, -2.5, 123.456, 1e6, -1e6, 33.335, this.int(-500, 900)]);
	}
	point() {
		return { x: this.coordinate(), y: this.coordinate() };
	}
	size() {
		return { width: this.pick([0, 50, 160, 239.5, 240, 400.6, 500, 1200, this.int(1, 900)]), height: this.pick([0, 40, 120, 159.5, 160, 301.2, 320, 900, this.int(1, 700)]) };
	}
	text(): string | undefined {
		return this.pick([undefined, "Fastify", "  trimmed  ", "", " ", "y".repeat(501), "ü".repeat(500), "A description\nwith lines"]);
	}
	kind(): string {
		return this.chance(0.1) ? this.pick(["nonsense", "", "Database"]) : this.pick(["generic", ...CATALOG_KINDS]);
	}
	icon(): string {
		return this.chance(0.15) ? "star" : this.pick(CUSTOM_ICONS);
	}
	properties() {
		const list = [{ key: "runtime", value: "node" }, { key: "port", value: "8080" }, { key: "runtime", value: "dup" }, { key: " spaced ", value: "z".repeat(600) }, { key: "", value: "blank key" }, { key: "k".repeat(61), value: "long key" }];
		const count = this.int(0, 3);
		const picked: unknown[] = Array.from({ length: count }, () => this.pick(list));
		if (this.chance(0.04)) picked.push({ key: "bad" }, "string", null);
		if (this.chance(0.02)) return Array.from({ length: 41 }, (_, index) => ({ key: `p${index}`, value: "v" }));
		return picked;
	}
	members(groupId?: string): string[] {
		const d = this.design;
		const ids = [...d.services, ...d.components, ...d.groups].map((x) => x.id).filter((id) => id !== groupId);
		const picked = Array.from({ length: this.int(0, 4) }, () => (ids.length > 0 ? this.pick(ids) : "missing"));
		if (this.chance(0.08) && groupId) picked.push(groupId);
		if (this.chance(0.06)) picked.push("missing-member");
		if (this.chance(0.06) && picked.length > 0) picked.push(picked[0]!);
		if (this.chance(0.03)) picked.push("");
		return picked;
	}
}

const maybe = (ctx: Ctx, key: string, value: unknown, target: Args, p = 0.6) => {
	if (value !== undefined && ctx.chance(p)) target[key] = value;
};

/** A text change: omitted, set, or cleared with null. */
const textPatch = (ctx: Ctx, key: string, target: Args) => {
	const roll = ctx.rng();
	if (roll < 0.45) return;
	target[key] = roll < 0.6 ? null : ctx.text() ?? "set";
};

const ops: Op[] = [
	{ name: "addService", weight: 6, design: true, run: (d, a) => S.addSystemService(d, a.input),
		args(c) { const a: Args = { id: c.newId(), position: c.point() }; maybe(c, "name", c.name(), a); maybe(c, "size", c.size(), a, 0.4); return { input: a }; } },
	{ name: "updateService", weight: 3, design: true, run: (d, a) => S.updateSystemService(d, a.serviceId, a.changes),
		args(c) { const changes: Args = {}; maybe(c, "name", c.name() ?? "Renamed", changes, 0.8); return { serviceId: c.existing("service"), changes }; } },
	{ name: "moveService", weight: 5, design: true, run: (d, a) => S.moveSystemService(d, a.serviceId, a.position), args: (c) => ({ serviceId: c.existing("service"), position: c.point() }) },
	{ name: "resizeService", weight: 3, design: true, run: (d, a) => S.resizeSystemService(d, a.serviceId, a.size), args: (c) => ({ serviceId: c.existing("service"), size: c.size() }) },
	{ name: "setServiceCollapsed", weight: 3, design: true, run: (d, a) => S.setSystemServiceCollapsed(d, a.serviceId, a.collapsed), args: (c) => ({ serviceId: c.existing("service"), collapsed: c.chance(0.5) }) },
	{ name: "setFocus", weight: 3, design: true, run: (d, a) => S.setSystemFocus(d, a.serviceId, a.viewport),
		args(c) { const a: Args = { serviceId: c.chance(0.3) ? null : c.existing("service") }; maybe(c, "viewport", { x: c.coordinate(), y: c.coordinate(), zoom: c.pick([0.5, 1, 1.25, 2]) }, a, 0.5); return a; } },
	{ name: "removeService", weight: 2, design: true, run: (d, a) => S.removeSystemService(d, a.serviceId), args: (c) => ({ serviceId: c.existing("service") }) },
	{ name: "describeServiceRemoval", weight: 2, design: false, run: (d, a) => S.describeSystemServiceRemoval(d, a.serviceId), args: (c) => ({ serviceId: c.existing("service") }) },

	{ name: "addGroup", weight: 5, design: true, run: (d, a) => S.addSystemGroup(d, a.input),
		args(c) { const id = c.newId(); const a: Args = { id, position: c.point() }; maybe(c, "name", c.name(), a); maybe(c, "size", c.size(), a, 0.4); maybe(c, "memberIds", c.members(id), a, 0.7); return { input: a }; } },
	{ name: "updateGroup", weight: 4, design: true, run: (d, a) => S.updateSystemGroup(d, a.groupId, a.changes),
		args(c) { const groupId = c.existing("group"); const changes: Args = {}; maybe(c, "name", c.name() ?? "Renamed group", changes, 0.5); maybe(c, "memberIds", c.members(groupId), changes, 0.7); return { groupId, changes }; } },
	{ name: "moveGroup", weight: 4, design: true, run: (d, a) => S.moveSystemGroup(d, a.groupId, a.position), args: (c) => ({ groupId: c.existing("group"), position: c.point() }) },
	{ name: "resizeGroup", weight: 2, design: true, run: (d, a) => S.resizeSystemGroup(d, a.groupId, a.size), args: (c) => ({ groupId: c.existing("group"), size: c.size() }) },
	{ name: "removeGroup", weight: 2, design: true, run: (d, a) => S.removeSystemGroup(d, a.groupId), args: (c) => ({ groupId: c.existing("group") }) },
	{ name: "describeGroupMove", weight: 2, design: false, run: (d, a) => S.describeSystemGroupMove(d, a.groupId), args: (c) => ({ groupId: c.existing("group") }) },

	{ name: "addComponent", weight: 10, design: true, run: (d, a) => S.addSystemComponent(d, a.input),
		args(c) {
			const a: Args = { id: c.newId(), position: c.point() };
			maybe(c, "kind", c.kind(), a, 0.8);
			maybe(c, "name", c.name(), a);
			maybe(c, "technology", c.text(), a, 0.4);
			maybe(c, "description", c.text(), a, 0.3);
			maybe(c, "properties", c.properties(), a, 0.3);
			if (c.chance(0.25)) a.designId = c.pick(["design-1", "design-2", ""]);
			if (c.chance(0.25)) a.icon = c.icon();
			if (c.chance(0.5)) a.serviceId = c.chance(0.15) ? null : c.existing("service");
			return { input: a };
		} },
	{ name: "updateComponent", weight: 7, design: true, run: (d, a) => S.updateSystemComponent(d, a.componentId, a.changes),
		args(c) {
			const changes: Args = {};
			maybe(c, "kind", c.kind(), changes, 0.3);
			maybe(c, "name", c.name() ?? "Renamed", changes, 0.4);
			maybe(c, "properties", c.properties(), changes, 0.2);
			textPatch(c, "technology", changes);
			textPatch(c, "description", changes);
			if (c.chance(0.2)) changes.designId = c.chance(0.3) ? null : c.pick(["design-1", "design-2", ""]);
			if (c.chance(0.25)) changes.serviceId = c.chance(0.3) ? null : c.existing("service");
			if (c.chance(0.2)) changes.icon = c.chance(0.3) ? null : c.icon();
			return { componentId: c.existing("component"), changes };
		} },
	{ name: "moveComponent", weight: 5, design: true, run: (d, a) => S.moveSystemComponent(d, a.componentId, a.position), args: (c) => ({ componentId: c.existing("component"), position: c.point() }) },
	{ name: "removeComponent", weight: 2, design: true, run: (d, a) => S.removeSystemComponent(d, a.componentId), args: (c) => ({ componentId: c.existing("component") }) },
	{ name: "describeComponentRemoval", weight: 2, design: false, run: (d, a) => S.describeSystemComponentRemoval(d, a.componentId), args: (c) => ({ componentId: c.existing("component") }) },

	{ name: "addConnection", weight: 9, design: true, run: (d, a) => S.addSystemConnection(d, a.input),
		args(c) {
			const a: Args = { id: c.newId(), sourceId: c.existing("any"), targetId: c.chance(0.05) ? undefined : c.existing("any") };
			if (a.targetId === undefined) a.targetId = a.sourceId;
			maybe(c, "label", c.name(), a, 0.7);
			maybe(c, "interactionType", c.text(), a, 0.3);
			maybe(c, "protocol", c.text(), a, 0.3);
			return { input: a };
		} },
	{ name: "updateConnection", weight: 8, design: true, run: (d, a) => S.updateSystemConnection(d, a.connectionId, a.changes),
		args(c) {
			const changes: Args = {};
			if (c.chance(0.2)) changes.sourceId = c.existing("any");
			if (c.chance(0.2)) changes.targetId = c.existing("any");
			maybe(c, "label", c.name() ?? "Relabelled", changes, 0.4);
			textPatch(c, "interactionType", changes);
			textPatch(c, "protocol", changes);
			for (const key of ["fromSide", "toSide"]) {
				if (c.chance(0.3)) changes[key] = c.chance(0.2) ? null : c.pick(["auto", "top", "right", "bottom", "left", "diagonal"]);
			}
			if (c.chance(0.25)) changes.bendPoints = c.chance(0.04) ? Array.from({ length: 9 }, () => c.point()) : Array.from({ length: c.int(0, 3) }, () => c.point());
			if (c.chance(0.2)) changes.labelOffset = c.chance(0.3) ? null : c.point();
			return { connectionId: c.existing("connection"), changes };
		} },
	{ name: "removeConnection", weight: 2, design: true, run: (d, a) => S.removeSystemConnection(d, a.connectionId), args: (c) => ({ connectionId: c.existing("connection") }) },
	{ name: "describeConnectionRemoval", weight: 1, design: false, run: (d, a) => S.describeSystemConnectionRemoval(d, a.connectionId), args: (c) => ({ connectionId: c.existing("connection") }) },
];

const bases: Array<{ name: string; doc: unknown }> = [
	{ name: "rich", doc: SYSTEM_DESIGN_RICH },
	{ name: "legacy", doc: SYSTEM_DESIGN_LEGACY },
	{ name: "empty", doc: SYSTEM_DESIGN_EMPTY },
	{ name: "migrated", doc: S.createMigratedSystemDesign("design-1", "component-1") },
];

type Step = { op: string; args: Args; result: { ok: unknown } | { error: string } };
type Session = { name: string; base: Design; steps: Step[] };

function session(name: string, doc: unknown, seed: number, length: number): Session {
	const base = JSON.parse(JSON.stringify(S.normalizeSystemDesign(structuredClone(doc)))) as Design;
	const ctx = new Ctx(seededRng(seed), base);
	const total = ops.reduce((sum, op) => sum + op.weight, 0);
	const steps: Step[] = [];
	for (let index = 0; index < length; index += 1) {
		let roll = ctx.rng() * total;
		const op = ops.find((candidate) => (roll -= candidate.weight) < 0) ?? ops[0]!;
		const args = JSON.parse(JSON.stringify(op.args(ctx))) as Args;
		let result: Step["result"];
		try {
			const output = op.run(structuredClone(ctx.design), structuredClone(args));
			const json = JSON.parse(JSON.stringify(output));
			result = { ok: json };
			if (op.design) ctx.design = json as Design;
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		steps.push({ op: op.name, args, result });
	}
	return { name, base, steps };
}

const sessions: Session[] = [];
let seed = 0xc0ffee;
for (const base of bases) {
	for (let repeat = 0; repeat < 3; repeat += 1) {
		sessions.push(session(`${base.name} #${repeat + 1}`, base.doc, (seed += 7919), 140));
	}
}

const all = sessions.flatMap((entry) => entry.steps);
const failed = all.filter((step) => "error" in step.result);
const byOp = new Map<string, { ok: number; error: number }>();
for (const step of all) {
	const tally = byOp.get(step.op) ?? { ok: 0, error: 0 };
	tally["error" in step.result ? "error" : "ok"] += 1;
	byOp.set(step.op, tally);
}
console.log(`system ops: ${sessions.length} sessions, ${all.length} steps, ${failed.length} rejected`);
const lopsided = [...byOp].filter(([, tally]) => tally.ok < 5 || tally.error < 2);
for (const [name, tally] of lopsided) console.log(`  thin coverage: ${name} ok=${tally.ok} error=${tally.error}`);
console.log(`distinct error messages: ${new Set(failed.map((step) => ("error" in step.result ? step.result.error.replace(/"[^"]*"/g, '"…"') : ""))).size}`);

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "system-ops.json"), `${JSON.stringify(sessions)}\n`);
