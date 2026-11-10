/**
 * Differential fixtures for the System design layout engine (`system-layout.ts`) and the spot
 * helpers the Assistant's tools use. The designs are the bases and every design the System design
 * fixtures produced; each gets an arrangement of everything, of random subsets, of an unknown
 * Component, and the free spots and frames around members.
 *
 * Run from the repository root (after generate-system-ops.ts): bun tauri/fixtures/generate-layout.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeSystemLayout, frameAroundMembers } from "../../src/shared/system-layout";
import { openServiceSpotNear, openSpotNear } from "../../src/shared/system-design";
import { seededRng } from "./lib/mutate";

const sessions = JSON.parse(readFileSync(join(import.meta.dir, "data/system-ops.json"), "utf8")) as Array<{ base: any; steps: Array<{ result: any }> }>;
const designs = new Map<string, any>();
const add = (design: any) => {
	if (design && Array.isArray(design.components) && Array.isArray(design.services)) designs.set(JSON.stringify(design), design);
};
for (const session of sessions) {
	add(session.base);
	for (const step of session.steps) add(step.result?.ok);
}
const rng = seededRng(99);
const cases: unknown[] = [];
const record = (kind: string, design: any, args: unknown, run: () => unknown) => {
	let result: unknown;
	try { result = { ok: run() ?? null }; } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
	cases.push({ kind, design, args: JSON.parse(JSON.stringify(args ?? null)), result: JSON.parse(JSON.stringify(result)) });
};
for (const design of designs.values()) {
	const ids = [...design.components, ...design.services, ...design.groups].map((item: any) => item.id);
	record("layout", design, null, () => computeSystemLayout(design));
	const components: string[] = design.components.map((item: any) => item.id);
	if (components.length > 0) {
		const subset = components.filter(() => rng() < 0.5);
		record("layout", design, { ids: subset }, () => computeSystemLayout(design, subset));
		record("layout", design, { ids: [components[0], components[0], "nope"] }, () => computeSystemLayout(design, [components[0]!, components[0]!, "nope"]));
		record("layout", design, { ids: [components[0], components[0]] }, () => computeSystemLayout(design, [components[0]!, components[0]!]));
	}
	record("layout", design, { ids: [] }, () => computeSystemLayout(design, []));
	for (const center of [{ x: 120, y: 120 }, { x: 0, y: 0 }, { x: -500.5, y: 33.3 }]) {
		record("spot", design, center, () => openSpotNear(design, center));
		record("serviceSpot", design, center, () => openServiceSpotNear(design, center));
	}
	const members = ids.filter(() => rng() < 0.4);
	record("frame", design, { members }, () => frameAroundMembers(design, members) ?? null);
	record("frame", design, { members: [...members, "ghost"] }, () => frameAroundMembers(design, [...members, "ghost"]) ?? null);
	record("frame", design, { members: ["ghost"] }, () => frameAroundMembers(design, ["ghost"]) ?? null);
}
writeFileSync(join(import.meta.dir, "data/layout.json"), `${JSON.stringify(cases)}\n`);
console.log(`layout: ${designs.size} designs, ${cases.length} cases`);
