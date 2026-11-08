/**
 * Exports the PostgreSQL index access-method capabilities from the TypeScript
 * source so the Rust crate embeds them instead of copying them by hand.
 *
 * Run from the repository root: bun tauri/fixtures/export-index-methods.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { INDEX_METHOD_DEFINITIONS } from "../../src/shared/index-methods";

const data = INDEX_METHOD_DEFINITIONS.map((definition) => ({
	method: definition.method,
	label: definition.label,
	unique: definition.unique,
	include: definition.include,
	ordering: definition.ordering,
	storageOptions: [...definition.storageOptions],
	defaultTypes: [...definition.defaultTypes],
	arrayDefault: definition.arrayDefault,
	...(definition.arrayTypes ? { arrayTypes: [...definition.arrayTypes] } : {}),
	operatorClasses: Object.fromEntries(Object.entries(definition.operatorClasses).map(([type, classes]) => [type, classes!.map(({ name, default: isDefault }) => ({ name, default: isDefault }))])),
}));
const path = join(import.meta.dir, "../src-tauri/crates/domain/data/index-methods.json");
writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);
console.log(`index methods: ${data.length} methods -> ${path}`);
