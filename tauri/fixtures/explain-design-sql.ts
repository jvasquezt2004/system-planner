/**
 * Prints the SQL the TypeScript generator produces for one case of design-sql.json,
 * so a Rust mismatch (which reports a hash) can be diffed against the full text.
 *
 *   bun tauri/fixtures/explain-design-sql.ts <case index> [lenient]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Design } from "../../src/shared/design";
import { generateDesignSql, renderSchemaFile } from "../../src/bun/sql";
import { applyEdit, type Edit } from "./lib/design-mutate";

const [, , indexArg, mode] = process.argv;
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "data/design-sql.json"), "utf8")) as { bases: Design[]; cases: Array<{ base: number; edits: Edit[] }> };
const entry = fixture.cases[Number(indexArg)];
if (!entry) throw new Error(`No case ${indexArg}; there are ${fixture.cases.length}.`);
const design = structuredClone(fixture.bases[entry.base]!);
for (const edit of entry.edits) applyEdit(design as never, edit);
console.log("edits:", JSON.stringify(entry.edits));
console.log(mode === "file" ? renderSchemaFile(design) : JSON.stringify(generateDesignSql(design, { lenient: mode === "lenient" }), null, 2));
