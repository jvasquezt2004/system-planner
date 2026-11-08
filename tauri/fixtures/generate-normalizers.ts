/**
 * Writes differential fixtures for the document normalizers.
 *
 * The TypeScript implementations in src/shared are the oracle. Each case holds an
 * input document and either the normalized output or the error message. The Rust
 * port must reproduce every case.
 *
 * Run from the repository root: bun tauri/fixtures/generate-normalizers.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeSystemDesign } from "../../src/shared/system-design";
import { normalizeWalkthroughs } from "../../src/shared/walkthrough";
import { mutate, seededRng } from "./lib/mutate";
import {
	SYSTEM_DESIGN_EMPTY,
	SYSTEM_DESIGN_LEGACY,
	SYSTEM_DESIGN_RICH,
	WALKTHROUGHS_LEGACY,
	WALKTHROUGHS_RICH,
} from "./lib/bases";

type Case = { name: string; input: unknown; result: { ok: unknown } | { error: string } };

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });

function run(normalize: (value: unknown) => unknown, input: unknown): Case["result"] {
	try {
		// Round-trip through JSON so `undefined` members vanish exactly as they do when stored.
		return { ok: JSON.parse(JSON.stringify(normalize(structuredClone(input)))) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function build(
	label: string,
	normalize: (value: unknown) => unknown,
	bases: Array<{ name: string; doc: unknown }>,
	mutationsPerBase: number,
	seed: number,
): Case[] {
	const rng = seededRng(seed);
	const cases: Case[] = [];
	const seen = new Set<string>();
	const add = (name: string, input: unknown) => {
		const key = JSON.stringify(input) ?? "undefined";
		if (seen.has(key)) return;
		seen.add(key);
		cases.push({ name, input, result: run(normalize, input) });
	};
	for (const base of bases) add(`${base.name} (unmodified)`, base.doc);
	for (const base of bases) {
		for (let index = 0; index < mutationsPerBase; index += 1) {
			const { doc, notes } = mutate(base.doc as never, rng, 1, index % 7 === 0 ? 4 : 2);
			add(`${base.name}: ${notes.join("; ")}`, doc);
		}
	}
	// Non-document inputs.
	for (const [name, value] of [["null", null], ["number", 7], ["string", "x"], ["array", []], ["empty object", {}]] as const) {
		add(`${label} given ${name}`, value);
	}
	const ok = cases.filter((entry) => "ok" in entry.result).length;
	console.log(`${label}: ${cases.length} cases, ${ok} accepted, ${cases.length - ok} rejected`);
	return cases;
}

const systemCases = build(
	"system-design",
	normalizeSystemDesign,
	[
		{ name: "rich", doc: SYSTEM_DESIGN_RICH },
		{ name: "legacy", doc: SYSTEM_DESIGN_LEGACY },
		{ name: "empty", doc: SYSTEM_DESIGN_EMPTY },
	],
	450,
	0x5eed01,
);
const walkthroughCases = build(
	"walkthroughs",
	normalizeWalkthroughs,
	[
		{ name: "rich", doc: WALKTHROUGHS_RICH },
		{ name: "legacy", doc: WALKTHROUGHS_LEGACY },
	],
	600,
	0x5eed02,
);

// Every unmodified base must be accepted; otherwise the corpus would silently test nothing.
for (const entry of [...systemCases, ...walkthroughCases].filter((item) => item.name.endsWith("(unmodified)"))) {
	if ("error" in entry.result) throw new Error(`Base document was rejected: ${entry.name}: ${entry.result.error}`);
}

writeFileSync(join(outDir, "system-design.json"), `${JSON.stringify(systemCases)}\n`);
writeFileSync(join(outDir, "walkthroughs.json"), `${JSON.stringify(walkthroughCases)}\n`);

const messages = new Map<string, number>();
for (const entry of [...systemCases, ...walkthroughCases]) {
	if ("error" in entry.result) messages.set(entry.result.error.replace(/"[^"]*"/g, '"…"'), (messages.get(entry.result.error.replace(/"[^"]*"/g, '"…"')) ?? 0) + 1);
}
console.log(`distinct rejection messages: ${messages.size}`);
