/**
 * Differential fixtures for the Project history (`src/bun/project-history.ts`).
 *
 * Each session records, undoes and redoes random changes to a small JSON document, including
 * Assistant turns that fold manual edits made in between into one entry. After every call the
 * whole history is fingerprinted (each entry's snapshots as serialized text, so key order counts)
 * together with the cursor and the description Undo and Redo show.
 *
 * Run from the repository root: bun tauri/fixtures/generate-history.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createProjectHistory,
	describeProjectHistory,
	recordProjectChange,
	stepProjectHistory,
	type ProjectHistory,
	type ProjectHistoryEntry,
} from "../../src/bun/project-history";
import { fnv } from "./lib/workspace-driver";
import { mutateOnce, seededRng, type Rng } from "./lib/mutate";

const BASE = {
	design: {
		tables: [
			{ id: "t1", name: "orders", columns: [{ id: "c1", name: "id" }, { id: "c2", name: "total" }] },
			{ id: "t2", name: "customers", columns: [{ id: "c3", name: "id" }] },
		],
		note: "",
	},
	scenarios: [{ id: "s1", source: "a" }],
	list: [1, 2, 3],
	system: { components: [{ id: "x", name: "API" }, { id: "y", name: "DB" }], connections: [] as unknown[] },
	walkthroughs: [{ id: "w1", blocks: [{ kind: "step", step: { id: "st1", title: "a" } }, { kind: "repeat", id: "r1", count: 2, body: [] as unknown[] }] }],
};

const entryTuple = (entry: ProjectHistoryEntry<unknown>) => [
	entry.name,
	JSON.stringify(entry.before),
	JSON.stringify(entry.after),
	entry.structural,
	entry.assistantTurnId ?? null,
	entry.coalesceKey ?? null,
	entry.recordedAt,
];

const fingerprint = (history: ProjectHistory<unknown>) => fnv(JSON.stringify([history.cursor, history.entries.map(entryTuple)]));

type Op =
	| { type: "record"; change: Record<string, unknown>; at: number }
	| { type: "step"; direction: "undo" | "redo" };
type Step = { op: Op; state: string; describe: ReturnType<typeof describeProjectHistory>; crossed: string | null };

function runSession(seed: number, length: number): Step[] {
	const rng: Rng = seededRng(seed);
	const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
	const history = createProjectHistory<unknown>();
	let head: unknown = structuredClone(BASE);
	let clock = 10_000;
	const steps: Step[] = [];
	for (let index = 0; index < length; index += 1) {
		const roll = rng();
		let op: Op;
		let crossed: string | null = null;
		if (roll < 0.68) {
			const after = structuredClone(head);
			for (let times = 1 + Math.floor(rng() * 2); times > 0; times -= 1) mutateOnce(after as never, rng);
			const change: Record<string, unknown> = { name: pick(["Edit", "Rename", "Add table", "Move"]), before: head, after, structural: rng() < 0.5 };
			if (rng() < 0.3) change.assistantTurnId = pick(["turn-a", "turn-b"]);
			if (rng() < 0.55) change.coalesceKey = pick(["k1", "k2"]);
			clock += pick([0, 100, 1400, 1500, 1501, 4000]);
			op = { type: "record", change: structuredClone(change), at: clock };
			recordProjectChange(history, change as never, clock);
			head = after;
		} else {
			const direction = rng() < 0.6 ? "undo" : "redo";
			op = { type: "step", direction };
			const entry = stepProjectHistory(history, direction);
			crossed = entry ? fnv(JSON.stringify(entryTuple(entry))) : null;
			if (entry) head = structuredClone(direction === "undo" ? entry.before : entry.after);
		}
		steps.push({ op, state: fingerprint(history), describe: describeProjectHistory(history), crossed });
	}
	return steps;
}

const sessions = Array.from({ length: 30 }, (_, index) => ({ name: `h${index + 1}`, steps: runSession((index + 1) * 40503, 60) }));
const all = sessions.flatMap((session) => session.steps);
const folded = all.filter((step) => step.op.type === "record" && "assistantTurnId" in step.op.change).length;
console.log(`history: ${sessions.length} sessions, ${all.length} calls, ${folded} Assistant changes, ${all.filter((step) => step.crossed).length} steps crossed`);

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "history.json"), `${JSON.stringify(sessions)}\n`);
