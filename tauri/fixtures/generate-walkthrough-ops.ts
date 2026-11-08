/**
 * Writes differential fixtures for the Walkthrough editing operations.
 *
 * Same method as generate-system-ops.ts: long random sessions through the real
 * functions in src/shared/walkthrough.ts, each call recorded with its result or
 * error, successes becoming the next state. Steps that read the System design
 * pick one of several variants, so steps become dangling or redirected and repair
 * and accept have something to do.
 *
 * Run from the repository root: bun tauri/fixtures/generate-walkthrough-ops.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as S from "../../src/shared/system-design";
import * as W from "../../src/shared/walkthrough";
import { seededRng, type Rng } from "./lib/mutate";
import { SYSTEM_DESIGN_RICH, WALKTHROUGHS_RICH } from "./lib/bases";

type Args = Record<string, unknown>;
type Op = {
	name: string;
	weight: number;
	/** Whether the result is the new list of Walkthroughs (and so the next state). */
	state: boolean;
	args: (ctx: Ctx) => Args;
	run: (walkthroughs: W.Walkthrough[], args: any, designs: S.SystemDesign[]) => unknown;
};

const rich = S.normalizeSystemDesign(structuredClone(SYSTEM_DESIGN_RICH));
const designs: S.SystemDesign[] = [
	rich,
	// A Connection gone: its steps become dangling.
	S.removeSystemConnection(rich, "con-1"),
	// Connections joining different endpoints: steps become redirected.
	S.updateSystemConnection(S.updateSystemConnection(rich, "con-1", { targetId: "cmp-db" }), "con-3", { targetId: "cmp-web" }),
];
const CONNECTIONS = ["con-1", "con-2", "con-3"];

class Ctx {
	counter = 0;
	constructor(
		readonly rng: Rng,
		public walkthroughs: W.Walkthrough[],
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
	private containers(only: W.Walkthrough[] = this.walkthroughs): string[] {
		const out: string[] = [];
		const visit = (blocks: W.WalkthroughBlock[]) => {
			for (const block of blocks) {
				if (block.kind === "step") continue;
				out.push(block.id);
				for (const sequence of block.kind === "parallel" ? block.branches : [block.body]) visit(sequence);
			}
		};
		for (const walkthrough of only) visit(walkthrough.blocks);
		return out;
	}
	private steps(only: W.Walkthrough[] = this.walkthroughs): string[] {
		return only.flatMap((walkthrough) => W.walkthroughSteps(walkthrough).map((step) => step.id));
	}
	/** A walkthrough and one of its own steps (or blocks), with an occasional deliberate mismatch. */
	pair(kind: "step" | "block"): { walkthroughId: string; id: string } {
		const walkthroughId = this.walkthroughId();
		const owner = this.walkthroughs.find((walkthrough) => walkthrough.id === walkthroughId);
		const ids = owner ? (kind === "step" ? this.steps([owner]) : this.containers([owner])) : [];
		if (ids.length === 0 || this.chance(0.06)) return { walkthroughId, id: kind === "step" ? this.stepId() : this.blockId() };
		return { walkthroughId, id: this.pick(ids) };
	}
	walkthroughId() {
		return this.walkthroughs.length === 0 || this.chance(0.05) ? this.pick(["missing", ""]) : this.pick(this.walkthroughs).id;
	}
	stepId() {
		const ids = this.steps();
		return ids.length === 0 || this.chance(0.07) ? this.pick(["missing-step", ""]) : this.pick(ids);
	}
	blockId() {
		const ids = this.containers();
		return ids.length === 0 || this.chance(0.07) ? this.pick(["missing-block", ""]) : this.pick(ids);
	}
	connectionId() {
		return this.chance(0.05) ? "no-such-connection" : this.pick(CONNECTIONS);
	}
	newId(): string {
		if (this.chance(0.1)) {
			const taken = [...this.steps(), ...this.containers(), ...this.walkthroughs.map((walkthrough) => walkthrough.id)];
			if (taken.length > 0) return this.pick(taken);
		}
		if (this.chance(0.03)) return this.pick(["", "  "]);
		this.counter += 1;
		return `w${this.counter}`;
	}
	walkthroughName(): string | undefined {
		if (this.chance(0.35)) return undefined;
		const taken = this.walkthroughs.map((walkthrough) => walkthrough.name);
		if (taken.length > 0 && this.chance(0.2)) return this.pick(taken);
		return this.pick(["Checkout", "Refund flow", "  Padded  ", "", " ", "n".repeat(81), "Walkthrough", "Ünï"]);
	}
	text(limit: number): string {
		if (this.chance(0.1)) return "t".repeat(limit + 1);
		return this.pick(["", " ", "Short text", "  padded  ", "t".repeat(limit), "é".repeat(limit), "Explains the hop"]);
	}
	sequence(walkthroughId: string): Args | undefined {
		const roll = this.rng();
		if (roll < 0.35) return undefined;
		if (roll < 0.45) return { blockId: null };
		const owner = this.walkthroughs.find((walkthrough) => walkthrough.id === walkthroughId);
		const inside = owner ? this.containers([owner]) : [];
		const sequence: Args = { blockId: inside.length > 0 && !this.chance(0.06) ? this.pick(inside) : this.blockId() };
		const branchRoll = this.rng();
		if (branchRoll < 0.45) sequence.branch = this.pick([0, 1, 2, 3, 5, -1, 1.5]);
		else if (branchRoll < 0.5) sequence.branch = null;
		return sequence;
	}
	draft(): Args {
		const draft: Args = {};
		if (this.chance(0.5)) draft.title = this.text(120);
		if (this.chance(0.4)) draft.explanation = this.text(2000);
		if (this.chance(0.4)) draft.action = this.chance(0.08) ? "teleport" : this.pick(["send", "receive", "process", "succeed", "fail"]);
		if (this.chance(0.3)) draft.operation = this.text(40);
		if (this.chance(0.35)) draft.durationMs = this.chance(0.2) ? null : this.chance(0.12) ? this.pick([99, 10001, 250.5]) : this.pick([100, 1500, 10000, 3000]);
		if (this.chance(0.3)) draft.travelPercent = this.chance(0.2) ? null : this.chance(0.12) ? this.pick([9, 91, 33.3]) : this.pick([10, 50, 90, 60]);
		if (this.chance(0.25)) draft.exampleMessage = this.text(500);
		if (this.chance(0.25)) draft.examplePayload = this.text(4000);
		return draft;
	}
	toIndex() {
		return this.pick([0, 0, 1, 2, 3, 4, -1, 99, 1.5]);
	}
}

const designAt = (index: number) => designs[index]!;

const ops: Op[] = [
	{ name: "addWalkthrough", weight: 4, state: true, run: (w, a) => W.addWalkthrough(w, a.input),
		args(c) { const input: Args = { id: c.newId() }; const name = c.walkthroughName(); if (name !== undefined) input.name = name; return { input }; } },
	{ name: "renameWalkthrough", weight: 3, state: true, run: (w, a) => W.renameWalkthrough(w, a.walkthroughId, a.name), args: (c) => ({ walkthroughId: c.walkthroughId(), name: c.walkthroughName() ?? "Renamed" }) },
	{ name: "removeWalkthrough", weight: 1, state: true, run: (w, a) => W.removeWalkthrough(w, a.walkthroughId), args: (c) => ({ walkthroughId: c.walkthroughId() }) },
	{ name: "moveWalkthrough", weight: 2, state: true, run: (w, a) => W.moveWalkthrough(w, a.walkthroughId, a.toIndex), args: (c) => ({ walkthroughId: c.walkthroughId(), toIndex: c.toIndex() }) },
	{ name: "addStep", weight: 20, state: true, run: (w, a, d) => W.addWalkthroughStep(w, a.walkthroughId, a.input, designAt(a.designIndex)),
		args(c) {
			const walkthroughId = c.walkthroughId();
			const input: Args = { id: c.newId(), connectionId: c.connectionId(), ...c.draft() };
			const sequence = c.sequence(walkthroughId);
			if (sequence) input.sequence = sequence;
			return { walkthroughId, input, designIndex: c.chance(0.85) ? 0 : c.int(0, 2) };
		} },
	{ name: "addBlock", weight: 10, state: true, run: (w, a) => W.addWalkthroughBlock(w, a.walkthroughId, a.input),
		args(c) { const walkthroughId = c.walkthroughId(); const input: Args = { id: c.newId(), kind: c.pick(["parallel", "repeat"]) }; const sequence = c.sequence(walkthroughId); if (sequence) input.sequence = sequence; return { walkthroughId, input }; } },
	{ name: "addParallelBranch", weight: 3, state: true, run: (w, a) => W.addWalkthroughParallelBranch(w, a.walkthroughId, a.blockId), args: (c) => { const p = c.pair("block"); return { walkthroughId: p.walkthroughId, blockId: p.id }; } },
	{ name: "updateRepeat", weight: 3, state: true, run: (w, a) => W.updateWalkthroughRepeat(w, a.walkthroughId, a.blockId, a.count), args: (c) => { const p = c.pair("block"); return { walkthroughId: p.walkthroughId, blockId: p.id, count: c.pick([1, 2, 5, 10, 0, 11, 2.5]) }; } },
	{ name: "updateStep", weight: 7, state: true, run: (w, a) => W.updateWalkthroughStep(w, a.walkthroughId, a.stepId, a.changes), args: (c) => { const p = c.pair("step"); return { walkthroughId: p.walkthroughId, stepId: p.id, changes: c.draft() }; } },
	{ name: "moveStep", weight: 4, state: true, run: (w, a) => W.moveWalkthroughStep(w, a.walkthroughId, a.stepId, a.toIndex), args: (c) => { const p = c.pair("step"); return { walkthroughId: p.walkthroughId, stepId: p.id, toIndex: c.toIndex() }; } },
	{ name: "moveBlock", weight: 3, state: true, run: (w, a) => W.moveWalkthroughBlock(w, a.walkthroughId, a.blockId, a.toIndex), args: (c) => { const p = c.pair("block"); return { walkthroughId: p.walkthroughId, blockId: p.id, toIndex: c.toIndex() }; } },
	{ name: "removeStep", weight: 3, state: true, run: (w, a) => W.removeWalkthroughStep(w, a.walkthroughId, a.stepId), args: (c) => { const p = c.pair("step"); return { walkthroughId: p.walkthroughId, stepId: p.id }; } },
	{ name: "removeBlock", weight: 2, state: true, run: (w, a) => W.removeWalkthroughBlock(w, a.walkthroughId, a.blockId), args: (c) => { const p = c.pair("block"); return { walkthroughId: p.walkthroughId, blockId: p.id }; } },
	{ name: "repairStep", weight: 4, state: true, run: (w, a) => W.repairWalkthroughStep(w, a.walkthroughId, a.stepId, a.connectionId, designAt(a.designIndex)),
		args: (c) => { const p = c.pair("step"); return { walkthroughId: p.walkthroughId, stepId: p.id, connectionId: c.connectionId(), designIndex: c.pick([0, 1, 2]) }; } },
	{ name: "acceptRedirection", weight: 4, state: true, run: (w, a) => W.acceptWalkthroughStepRedirection(w, a.walkthroughId, a.stepId, designAt(a.designIndex)),
		args: (c) => { const p = c.pair("step"); return { walkthroughId: p.walkthroughId, stepId: p.id, designIndex: c.pick([0, 2, 2]) }; } },
	{ name: "stepsOnConnections", weight: 2, state: false, run: (w, a) => W.walkthroughStepsOnConnections(w, a.connectionIds), args: (c) => ({ connectionIds: Array.from({ length: c.int(0, 3) }, () => c.connectionId()) }) },
	{ name: "stepStatuses", weight: 2, state: false,
		run: (w, a) => w.flatMap((walkthrough) => W.walkthroughSteps(walkthrough).map((step) => ({ stepId: step.id, status: W.walkthroughStepStatus(step, designAt(a.designIndex)) }))),
		args: (c) => ({ designIndex: c.pick([0, 1, 2]) }) },
];

type Step = { op: string; args: Args; result: { ok: unknown } | { error: string } };
type Session = { name: string; base: W.Walkthrough[]; steps: Step[] };

function session(name: string, doc: unknown, seed: number, length: number): Session {
	const base = JSON.parse(JSON.stringify(W.normalizeWalkthroughs(structuredClone(doc)))) as W.Walkthrough[];
	const ctx = new Ctx(seededRng(seed), base);
	const total = ops.reduce((sum, op) => sum + op.weight, 0);
	const steps: Step[] = [];
	for (let index = 0; index < length; index += 1) {
		let roll = ctx.rng() * total;
		const op = ops.find((candidate) => (roll -= candidate.weight) < 0) ?? ops[0]!;
		const args = JSON.parse(JSON.stringify(op.args(ctx))) as Args;
		let result: Step["result"];
		try {
			const output = JSON.parse(JSON.stringify(op.run(structuredClone(ctx.walkthroughs), structuredClone(args), designs)));
			result = { ok: output };
			if (op.state) ctx.walkthroughs = output as W.Walkthrough[];
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		steps.push({ op: op.name, args, result });
	}
	return { name, base, steps };
}

const sessions: Session[] = [];
let seed = 0xfeed;
for (const [label, doc] of [["rich", WALKTHROUGHS_RICH], ["empty", []]] as const) {
	for (let repeat = 0; repeat < 5; repeat += 1) sessions.push(session(`${label} #${repeat + 1}`, doc, (seed += 6469), 160));
}

const all = sessions.flatMap((entry) => entry.steps);
const tally = new Map<string, { ok: number; error: number }>();
for (const step of all) {
	const entry = tally.get(step.op) ?? { ok: 0, error: 0 };
	entry["error" in step.result ? "error" : "ok"] += 1;
	tally.set(step.op, entry);
}
const rejected = all.filter((step) => "error" in step.result);
console.log(`walkthrough ops: ${sessions.length} sessions, ${all.length} steps, ${rejected.length} rejected`);
for (const [name, entry] of tally) if (entry.ok < 5 || (entry.error < 2 && !name.startsWith("step"))) console.log(`  thin coverage: ${name} ok=${entry.ok} error=${entry.error}`);
console.log(`distinct error messages: ${new Set(rejected.map((step) => ("error" in step.result ? step.result.error.replace(/"[^"]*"/g, '"…"') : ""))).size}`);

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "walkthrough-ops.json"), `${JSON.stringify({ designs, sessions })}\n`);
