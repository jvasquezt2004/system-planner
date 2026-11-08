/**
 * Exports the component catalog's identity data from the TypeScript source so
 * the Rust crate embeds it instead of copying it by hand.
 *
 * Run from the repository root: bun tauri/fixtures/export-catalog.ts
 * (also part of `bun run fixtures` in tauri/).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_KINDS, COMPONENT_CATALOG, CUSTOM_ICONS } from "../../src/shared/component-catalog";

const data = {
	kinds: [...CATALOG_KINDS],
	customIcons: [...CUSTOM_ICONS],
	entries: COMPONENT_CATALOG.map((entry) => ({
		kind: entry.kind,
		label: entry.label,
		family: entry.family,
		defaultName: entry.defaultName,
		descriptors: entry.descriptors.map(({ key, placeholder }) => ({ key, placeholder })),
		operations: entry.operations.map(({ id, label }) => ({ id, label })),
	})),
};

const path = join(import.meta.dir, "../src-tauri/crates/domain/data/component-catalog.json");
writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
console.log(`catalog: ${data.kinds.length} kinds, ${data.customIcons.length} icons -> ${path}`);
