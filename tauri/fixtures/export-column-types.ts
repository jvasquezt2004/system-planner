/**
 * Exports the column type registry from the TypeScript source so the Rust crate
 * embeds it instead of copying 31 definitions by hand.
 *
 * Run from the repository root: bun tauri/fixtures/export-column-types.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLUMN_TYPE_DEFINITIONS, COLUMN_TYPE_FAMILIES } from "../../src/shared/column-types";

const data = {
	families: COLUMN_TYPE_FAMILIES.map(({ id, label, glyph, summary }) => ({ id, label, glyph, summary })),
	definitions: COLUMN_TYPE_DEFINITIONS.map((definition) => ({
		type: definition.type,
		label: definition.label,
		family: definition.family,
		identity: definition.identity,
		defaults: { ...definition.defaults },
		...("parameters" in definition ? { parameters: definition.parameters } : {}),
	})),
};
const path = join(import.meta.dir, "../src-tauri/crates/domain/data/column-types.json");
writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
console.log(`column types: ${data.definitions.length} types, ${data.families.length} families -> ${path}`);
