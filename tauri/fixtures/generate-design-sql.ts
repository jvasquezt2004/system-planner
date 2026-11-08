/**
 * Differential fixtures for SQL generation and relationship handling.
 *
 * Base Designs (the normalized ones from designs.json plus a features Design) are
 * mutated with type-preserving edits (lib/design-mutate.ts). For each mutated
 * Design the real TypeScript computes: generated SQL (strict, and lenient when
 * strict is refused), the schema file, planned object names, the relation-name
 * set, resolved relationships, foreign-key column names, removal plans and index
 * method problems. The Rust port replays the edits on the same base and must agree.
 *
 * Only the edits are stored, not whole documents, which keeps the file small.
 *
 * Run from the repository root: bun tauri/fixtures/generate-design-sql.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Design } from "../../src/shared/design";
import { generateDesignSql, planSchemaObjectNames, postgresSchemaRelationNames, renderSchemaFile } from "../../src/bun/sql";
import { foreignKeyColumnName, removalPlan, resolveRelationships } from "../../src/shared/relationships";
import { indexMethodProblem } from "../../src/shared/index-methods";
import { findColumnTypeInfo } from "../../src/shared/column-types";
import { DESIGN_FEATURES } from "./lib/design-bases";
import { DesignMutator, applyEdit, type Edit } from "./lib/design-mutate";
import { seededRng } from "./lib/mutate";

const dataDir = join(import.meta.dir, "data");
const designCases = JSON.parse(readFileSync(join(dataDir, "designs.json"), "utf8")) as Array<{ name: string; result: { ok?: Design } }>;
const normalized = (name: string) => {
	const entry = designCases.find((candidate) => candidate.name === name);
	if (!entry?.result.ok) throw new Error(`designs.json has no accepted case "${name}"; run generate-designs.ts first`);
	return entry.result.ok;
};

const bases: Array<{ name: string; doc: Design; mutations: number }> = [
	{ name: "rich", doc: normalized("rich (unmodified)"), mutations: 260 },
	{ name: "legacy", doc: normalized("legacy (unmodified)"), mutations: 80 },
	{ name: "features", doc: JSON.parse(JSON.stringify(DESIGN_FEATURES)) as Design, mutations: 400 },
];

/** FNV-1a 64-bit over UTF-8, so a long string can be compared without storing it. */
function fnv(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

type Captured<T> = { ok: T } | { threw: true };
function capture<T>(fn: () => T): Captured<T> {
	try {
		return { ok: JSON.parse(JSON.stringify(fn())) as T };
	} catch {
		// An engine TypeError message is not worth porting; that the call threw is.
		return { threw: true };
	}
}

const sortedEntries = (map: Map<string, string>) => Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Generated SQL is long; a hash and length identify it, and explain-design-sql.ts reprints it for debugging. */
const fingerprint = (text: string) => ({ hash: fnv(text), length: text.length });
type Generation = ReturnType<typeof generateDesignSql>;
const summarize = (generation: Generation) =>
	generation.ok ? { ok: true, sql: fingerprint(generation.sql), warnings: generation.warnings } : { ok: false, errors: generation.errors };

function analyse(design: Design, mutator: DesignMutator) {
	const strictRaw = capture(() => generateDesignSql(design));
	const strict = "ok" in strictRaw ? { ok: summarize(strictRaw.ok as Generation) } : strictRaw;
	const strictFailed = "ok" in strictRaw && !(strictRaw.ok as Generation).ok;
	const entry: Record<string, unknown> = { strict };
	if (strictFailed || "threw" in strictRaw) {
		const lenient = capture(() => generateDesignSql(design, { lenient: true }));
		entry.lenient = "ok" in lenient ? { ok: summarize(lenient.ok as Generation) } : lenient;
	}
	const schemaFile = capture(() => renderSchemaFile(design));
	entry.schemaFile = "ok" in schemaFile ? { hash: fnv(schemaFile.ok as string), length: (schemaFile.ok as string).length } : schemaFile;
	entry.names = capture(() => {
		const names = planSchemaObjectNames(design);
		return {
			foreignKeys: sortedEntries(names.foreignKeys),
			relationshipUniques: sortedEntries(names.relationshipUniques),
			pairConstraints: sortedEntries(names.pairConstraints),
			indexes: sortedEntries(names.indexes),
			uniqueConstraints: sortedEntries(names.uniqueConstraints),
		};
	});
	entry.relationNames = capture(() => [...postgresSchemaRelationNames(design)].sort());
	entry.relationships = capture(() =>
		resolveRelationships(design).map((view) => ({
			id: view.relationship.id,
			referencingTable: view.referencingTable.id,
			referencingColumn: view.referencingColumn.id,
			referencedTable: view.referencedTable.id,
			referencedColumn: view.referencedColumn?.id ?? null,
			required: view.required,
			oneToOne: view.oneToOne,
			ownsUniqueness: view.ownsUniqueness,
			association: view.manyToManyAssociation?.id ?? null,
			foreignKeyColumnName: view.referencedColumn ? foreignKeyColumnName(view.referencingTable, view.referencedTable, view.referencedColumn) : null,
		})),
	);
	// Removal plans for a few targets, some of which do not exist.
	const tables = design.tables;
	const targets: unknown[] = [];
	for (let pick = 0; pick < 2; pick += 1) {
		const table = tables.length > 0 ? tables[Math.floor(mutator.rng() * tables.length)]! : undefined;
		const roll = mutator.rng();
		if (!table || roll < 0.08) targets.push({ kind: "table", tableId: "missing" });
		else if (roll < 0.45) targets.push({ kind: "table", tableId: table.id });
		else if (roll < 0.85 && table.columns.length > 0) targets.push({ kind: "column", tableId: table.id, columnId: table.columns[Math.floor(mutator.rng() * table.columns.length)]!.id });
		else targets.push({ kind: "function", functionId: design.functions?.[0]?.id ?? "missing" });
	}
	entry.removals = targets.map((target) => ({ target, plan: capture(() => removalPlan(design, { ...(target as object), designId: "d" } as never)) }));
	entry.indexProblems = capture(() => {
		const out: Record<string, string | null> = {};
		for (const table of design.tables) {
			for (const index of table.indexes ?? []) {
				const types = index.keys.map((key) => {
					const column = table.columns.find((candidate) => candidate.id === key.columnId);
					return column && findColumnTypeInfo(column.type) ? { type: column.type, array: column.typeParameters?.array, dimensions: column.typeParameters?.dimensions } : undefined;
				});
				// indexMethodProblem skips missing entries; keep positions by passing only fully known types.
				if (types.every(Boolean)) out[index.id] = indexMethodProblem(index, types as never);
			}
		}
		return out;
	});
	return entry;
}

const outputBases = bases.map((base) => base.doc);
const cases: Array<Record<string, unknown>> = [];
const seen = new Set<string>();
bases.forEach((base, baseIndex) => {
	const mutator = new DesignMutator(seededRng(0xdec0de + baseIndex * 977));
	// The unmodified base first, then single and compound mutations.
	for (let index = 0; index <= base.mutations; index += 1) {
		const doc = structuredClone(base.doc);
		const edits: Edit[] = [];
		const count = index === 0 ? 0 : 1 + Math.floor(mutator.rng() * (index % 6 === 0 ? 5 : 3));
		for (let step = 0; step < count; step += 1) {
			const edit = mutator.mutate(doc as never);
			if (edit) edits.push(edit);
		}
		const key = `${baseIndex}:${JSON.stringify(doc)}`;
		if (seen.has(key)) continue;
		seen.add(key);
		cases.push({ base: baseIndex, edits, ...analyse(doc, mutator) });
	}
});

// An unmodified base must be accepted, or the corpus would silently test nothing.
const unmodified = cases.filter((entry) => (entry.edits as unknown[]).length === 0);
for (const entry of unmodified) {
	const strict = entry.strict as Captured<{ ok: boolean; errors?: string[] }>;
	if (!("ok" in strict) || !strict.ok.ok) throw new Error(`Base design ${entry.base} was rejected: ${JSON.stringify(strict)}`);
}

const strictOutcomes = cases.map((entry) => entry.strict as Captured<{ ok: boolean }>);
const accepted = strictOutcomes.filter((outcome) => "ok" in outcome && outcome.ok.ok).length;
const threw = strictOutcomes.filter((outcome) => "threw" in outcome).length;
const errorMessages = new Set(strictOutcomes.flatMap((outcome) => ("ok" in outcome && !outcome.ok.ok ? (outcome.ok as unknown as { errors: string[] }).errors.map((message) => message.replace(/"[^"]*"/g, '"…"')) : [])));
const warnings = new Set(strictOutcomes.flatMap((outcome) => ("ok" in outcome && outcome.ok.ok ? (outcome.ok as unknown as { warnings: string[] }).warnings.map((message) => message.replace(/"[^"]*"/g, '"…"')) : [])));
console.log(`design sql: ${cases.length} cases, ${accepted} accepted, ${cases.length - accepted - threw} refused, ${threw} threw`);
console.log(`  distinct error messages: ${errorMessages.size}, distinct warnings: ${warnings.size}`);

mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "design-sql.json"), `${JSON.stringify({ bases: outputBases, cases })}\n`);
