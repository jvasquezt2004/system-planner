/**
 * Differential fixtures for PostgreSQL identifier naming. The functions count
 * UTF-8 bytes and cut on character boundaries, which is where ports go wrong.
 *
 * Run from the repository root: bun tauri/fixtures/generate-identifiers.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	postgresGeneratedObjectName,
	postgresIdentifierWithSuffix,
	truncatePostgresIdentifier,
	uniquePostgresIdentifier,
} from "../../src/shared/postgres-identifiers";
import { seededRng } from "./lib/mutate";

const rng = seededRng(0x1d3);
const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const ALPHABET = ["a", "b", "c", "x", "_", "1", "é", "ß", "ñ", "世", "界", "あ", "😀", "𝒳", "€", " ", "-"];
const text = (min: number, max: number) => Array.from({ length: min + Math.floor(rng() * (max - min + 1)) }, () => pick(ALPHABET)).join("");
// Lengths that land the cut near the 63-byte limit.
const nearLimit = () => text(20, 70);

type Result = { ok: unknown } | { error: string };
const run = (fn: () => unknown): Result => {
	try {
		return { ok: fn() };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
};

const truncate: Array<{ value: string; maxBytes: number | null; result: Result }> = [];
const withSuffix: Array<{ value: string; suffix: string; result: Result }> = [];
const unique: Array<{ base: string; occupied: string[]; result: Result }> = [];
const generated: Array<{ name1: string; name2: string | null; label: string; result: Result }> = [];

for (let index = 0; index < 220; index += 1) {
	const value = index % 3 === 0 ? text(0, 12) : nearLimit();
	const maxBytes = index % 4 === 0 ? null : pick([0, 1, 2, 3, 4, 5, 10, 31, 62, 63, 64, 100]);
	truncate.push({ value, maxBytes, result: run(() => (maxBytes === null ? truncatePostgresIdentifier(value) : truncatePostgresIdentifier(value, maxBytes))) });
}
for (let index = 0; index < 160; index += 1) {
	const value = nearLimit();
	const suffix = pick(["", "_2", "_10", "_idx", "_é", "_世界", "_😀", "x".repeat(60), "x".repeat(64), "世".repeat(21), "世".repeat(22)]);
	withSuffix.push({ value, suffix, result: run(() => postgresIdentifierWithSuffix(value, suffix)) });
}
for (let index = 0; index < 160; index += 1) {
	const base = index % 2 === 0 ? text(1, 12) : nearLimit();
	// Occupy the base and a run of its suffixed forms so collisions have to be walked past.
	const occupied: string[] = [];
	const taken = Math.floor(rng() * 5);
	for (let n = 1; n <= taken; n += 1) occupied.push(postgresIdentifierWithSuffix(base, n === 1 ? "" : `_${n}`));
	if (rng() < 0.3) occupied.push(text(1, 8));
	unique.push({ base, occupied, result: run(() => uniquePostgresIdentifier(base, new Set(occupied))) });
}
for (let index = 0; index < 220; index += 1) {
	const name1 = index % 3 === 0 ? text(0, 10) : nearLimit();
	const name2 = rng() < 0.25 ? null : index % 3 === 1 ? text(0, 10) : nearLimit();
	const label = pick(["pkey", "key", "fkey", "idx", "seq", "check", "x".repeat(70), "世".repeat(10), ""]);
	generated.push({ name1, name2, label, result: run(() => postgresGeneratedObjectName(name1, name2, label)) });
}

const all = [...truncate, ...withSuffix, ...unique, ...generated];
console.log(`identifiers: ${all.length} cases, ${all.filter((entry) => "error" in entry.result).length} rejected`);
const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "identifiers.json"), `${JSON.stringify({ truncate, withSuffix, unique, generated })}\n`);
