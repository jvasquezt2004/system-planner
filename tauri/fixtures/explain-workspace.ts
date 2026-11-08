/**
 * Prints the full state the TypeScript workspace holds after one step of a recorded session, by
 * replaying the session's calls from an empty database. Use it when the Rust replay reports a
 * field that differs; the replay writes its own state beside it for a diff.
 *
 *   bun tauri/fixtures/explain-workspace.ts <session> <step> [output file]
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDriver } from "./lib/workspace-driver";
import { openDesignStore } from "../../src/bun/store";
import { dumpStore } from "./lib/store-dump";

async function storeDump(directory: string, driver: Awaited<ReturnType<typeof openDriver>>) {
	await driver.close();
	const store = openDesignStore(join(directory, "workspace.sqlite"));
	const dump = JSON.parse(JSON.stringify(dumpStore(store)));
	store.close();
	return dump;
}

const [, , name, stepArg, output] = process.argv;
const sessions = JSON.parse(readFileSync(join(import.meta.dir, "data/workspace-sessions.json"), "utf8")) as Array<{ name: string; steps: Array<{ method: string; params: unknown }> }>;
const session = sessions.find((candidate) => candidate.name === name);
if (!session) throw new Error(`No session ${name}; there are ${sessions.map((candidate) => candidate.name).join(", ")}.`);
// "store" replays the whole session and prints the database as the original holds it at the end.
const wantsStore = stepArg === "store";
const target = wantsStore ? session.steps.length - 1 : Number(stepArg);
const directory = mkdtempSync(join(tmpdir(), "db-planner-explain-"));
try {
	const driver = await openDriver(directory);
	let last: unknown;
	for (let index = 0; index <= target; index += 1) {
		const step = session.steps[index]!;
		const { state, trail } = await driver.run(step.method, step.params, index);
		last = index === target ? { call: { method: step.method, params: step.params }, trail, state } : undefined;
	}
	const text = JSON.stringify(wantsStore ? await storeDump(directory, driver) : last, null, 2);
	if (output) writeFileSync(output, text);
	else console.log(text);
	if (!wantsStore) await driver.close();
} finally {
	rmSync(directory, { recursive: true, force: true });
}
