/**
 * Differential fixtures for the workspace state machine.
 *
 * Each session drives the real TypeScript workspace through a long random sequence of the calls the
 * view makes. For every call it records the parameters, the outcome (a fingerprint per top-level
 * field of the settled state, or the error message), and the sequence of states the workspace pushed
 * while handling it. Sessions start from an empty database, so a replay is self-contained.
 *
 * The Rust workspace replays the same calls with the same clock and ids and must reproduce every
 * outcome, every push trail, and the contents of the database at the end.
 *
 * Run from the repository root: bun tauri/fixtures/generate-workspace.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesignStore } from "../../src/bun/store";
import { dumpStore } from "./lib/store-dump";
import { canonical, fnv, fingerprints, openDriver, type StepOutcome } from "./lib/workspace-driver";
import { seededRng } from "./lib/mutate";
import { OPERATIONS } from "./lib/workspace-ops";
import { SCRIPTS, transferScript, type Script } from "./lib/workspace-scripts";

type Step = { method: string; params: unknown; outcome: StepOutcome; after?: Record<string, string>; trail: string[] };
type Session = { name: string; steps: Step[]; storeFingerprint: string };

async function runSession(name: string, seed: number, length: number, script?: Script): Promise<Session> {
	const directory = mkdtempSync(join(tmpdir(), `db-planner-workspace-${name}-`));
	try {
		const driver = await openDriver(directory);
		const rng = seededRng(seed);
		const steps: Step[] = [];
		let lastOutcome: StepOutcome | undefined;
		// Every session starts by opening a Project, so the rest has something to edit.
		const first = { method: "createProject", params: { name: "Shop" } };
		const planned = (index: number) => {
			if (script) return script[index]!(driver.workspace.getState(), lastOutcome);
			if (index === 0) return first;
			const state = driver.workspace.getState();
			// Mostly calls that make sense now; a tenth are unconditional so refusals stay covered.
			const sensible = rng() < 0.9 ? OPERATIONS.filter((candidate) => !candidate.when || candidate.when(state)) : OPERATIONS;
			const pool = sensible.length > 0 ? sensible : OPERATIONS;
			let roll = rng() * pool.reduce((sum, operation) => sum + operation.weight, 0);
			const operation = pool.find((candidate) => (roll -= candidate.weight) < 0) ?? pool[0]!;
			return { method: operation.method, params: operation.params(state, rng) };
		};
		for (let index = 0; index < (script?.length ?? length); index += 1) {
			const call = planned(index);
			const { outcome, state, trail } = await driver.run(call.method, JSON.parse(JSON.stringify(call.params)), index);
			const step: Step = { method: call.method, params: JSON.parse(JSON.stringify(call.params)), outcome, trail };
			// After a refusal, or for a plan, what the workspace holds is still part of the contract.
			if ("error" in outcome || "value" in outcome.ok) step.after = fingerprints(state);
			steps.push(step);
			lastOutcome = outcome;
		}
		await driver.close();
		const store = openDesignStore(join(directory, "workspace.sqlite"));
		const storeFingerprint = fnv(canonical(JSON.parse(JSON.stringify(dumpStore(store)))));
		store.close();
		return { name, steps, storeFingerprint };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const started = Date.now();
const seeds = [0x101, 0x202, 0x303, 0x404, 0x505, 0x606, 0x707, 0x808];
const random = seeds.map((seed, index) => runSession(`s${index + 1}`, seed * 7919, 400));
const scripted = Object.entries({ ...SCRIPTS, transfer: await transferScript() }).map(([name, script]) => runSession(`script-${name}`, 0, 0, script));
const sessions = await Promise.all([...random, ...scripted]);

const all = sessions.flatMap((session) => session.steps);
const tally = new Map<string, { ok: number; error: number }>();
for (const step of all) {
	const entry = tally.get(step.method) ?? { ok: 0, error: 0 };
	entry["error" in step.outcome ? "error" : "ok"] += 1;
	tally.set(step.method, entry);
}
const refused = all.filter((step) => "error" in step.outcome).length;
console.log(`workspace: ${sessions.length} sessions, ${all.length} calls, ${refused} refused, ${Math.round((Date.now() - started) / 1000)}s`);
const uncovered = OPERATIONS.filter((operation) => !tally.has(operation.method)).map((operation) => operation.method);
if (uncovered.length > 0) console.log(`  never called: ${uncovered.join(", ")}`);
const thin = [...tally].filter(([, entry]) => entry.ok < 3).map(([method, entry]) => `${method} (${entry.ok} ok, ${entry.error} refused)`);
if (thin.length > 0) console.log(`  thin coverage: ${thin.join(", ")}`);
const trailKinds = new Set(all.flatMap((step) => step.trail.map((entry) => entry.replace(/rev\d+ /, "").replace(/design:\S+/, ""))));
console.log(`  distinct push shapes: ${trailKinds.size}`);

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "workspace-sessions.json"), `${JSON.stringify(sessions)}\n`);
