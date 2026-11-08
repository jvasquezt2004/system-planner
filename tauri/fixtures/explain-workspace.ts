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

const [, , name, stepArg, output] = process.argv;
const sessions = JSON.parse(readFileSync(join(import.meta.dir, "data/workspace-sessions.json"), "utf8")) as Array<{ name: string; steps: Array<{ method: string; params: unknown }> }>;
const session = sessions.find((candidate) => candidate.name === name);
if (!session) throw new Error(`No session ${name}; there are ${sessions.map((candidate) => candidate.name).join(", ")}.`);
const target = Number(stepArg);
const directory = mkdtempSync(join(tmpdir(), "db-planner-explain-"));
try {
	const driver = await openDriver(directory);
	let last: unknown;
	for (let index = 0; index <= target; index += 1) {
		const step = session.steps[index]!;
		const { state, trail } = await driver.run(step.method, step.params, index);
		last = index === target ? { call: { method: step.method, params: step.params }, trail, state } : undefined;
	}
	const text = JSON.stringify(last, null, 2);
	if (output) writeFileSync(output, text);
	else console.log(text);
	await driver.close();
} finally {
	rmSync(directory, { recursive: true, force: true });
}
