/**
 * Writes differential fixtures for loading a database Design.
 *
 * `normalizeDesign` is private to src/bun/workspace.ts, so the oracle is the real
 * thing: each input document is stored untouched through the TypeScript store,
 * the Project is opened through the real workspace, and the Design the view
 * would receive is recorded.
 *
 * Run from the repository root: bun tauri/fixtures/generate-designs.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design } from "../../src/shared/design";
import { openDesignStore } from "../../src/bun/store";
import { createDesignWorkspace } from "../../src/bun/workspace";
import type { SchemaSandbox } from "../../src/bun/sandbox";
import { DESIGN_LEGACY, DESIGN_RICH } from "./lib/design-bases";

type Case = { name: string; input: unknown; result: { ok: unknown } | { error: string } };

const clone = <T>(value: T): T => structuredClone(value);
const MISSING = Symbol("missing");

/** Sets `key` on every object in `objects`, or removes it for MISSING. */
function setAll(objects: Array<Record<string, unknown>>, key: string, value: unknown) {
	for (const object of objects) {
		if (value === MISSING) delete object[key];
		else object[key] = clone(value);
	}
}

const inputs: Array<{ name: string; doc: unknown }> = [
	{ name: "rich (unmodified)", doc: DESIGN_RICH },
	{ name: "legacy (unmodified)", doc: DESIGN_LEGACY },
];

function variant(label: string, base: Design, edit: (doc: any) => void) {
	const doc = clone(base) as any;
	edit(doc);
	inputs.push({ name: label, doc });
}

const columnsOf = (doc: any) => doc.tables.flatMap((table: any) => table.columns) as Array<Record<string, unknown>>;
const tablesOf = (doc: any) => doc.tables as Array<Record<string, unknown>>;

for (const [label, value] of [
	["missing", MISSING], ["null", null], ["true", true], ["false", false], ["text", "yes"], ["number", 1],
] as const) {
	variant(`column.unique ${label}`, DESIGN_RICH, (doc) => setAll(columnsOf(doc), "unique", value));
	variant(`table.rowLevelSecurity ${label}`, DESIGN_RICH, (doc) => setAll(tablesOf(doc), "rowLevelSecurity", value));
}
for (const [label, value] of [
	["missing", MISSING], ["null", null], ["empty", ""], ["text", "a note"], ["number", 3],
] as const) {
	variant(`column.notes ${label}`, DESIGN_RICH, (doc) => setAll(columnsOf(doc), "notes", value));
}
for (const [label, value] of [
	["missing", MISSING],
	["null", null],
	["none", { kind: "none" }],
	["none with extras", { kind: "none", value: "ignored" }],
	["now", { kind: "currentTimestamp" }],
	["uuid", { kind: "generateUuid", extra: 1 }],
	["integer literal padded", { kind: "literal", literalType: "integer", value: "  42 " }],
	["text literal padded", { kind: "literal", literalType: "text", value: "  keep  " }],
	["json literal padded", { kind: "literal", literalType: "json", value: " {\"a\":1} " }],
	["unknown literal type", { kind: "literal", literalType: "bogus", value: "1" }],
	["literal with number value", { kind: "literal", literalType: "integer", value: 5 }],
	["literal without value", { kind: "literal", literalType: "text" }],
	["unknown kind", { kind: "expression", sql: "now()" }],
	["string", "none"],
	["array", []],
] as const) {
	variant(`column.default ${label}`, DESIGN_RICH, (doc) => setAll(columnsOf(doc), "default", value));
}
for (const [label, value] of [
	["missing", MISSING], ["null", null], ["empty", []],
	["one", [{ id: "pol-x", name: "p", command: "ALL", roles: [], mode: "permissive", using: "true", withCheck: "" }]],
] as const) {
	variant(`table.policies ${label}`, DESIGN_RICH, (doc) => setAll(tablesOf(doc), "policies", value));
}
for (const [label, value] of [
	["missing", MISSING], ["null", null], ["one-to-one", "one-to-one"], ["one-to-many", "one-to-many"],
	["many-to-many", "many-to-many"], ["bogus", "bogus"], ["number", 1], ["empty", ""],
] as const) {
	variant(`relationship.cardinality ${label}`, DESIGN_RICH, (doc) => setAll(doc.relationships, "cardinality", value));
}
for (const [label, value] of [["missing", MISSING], ["null", null], ["empty", []]] as const) {
	variant(`relationships ${label}`, DESIGN_RICH, (doc) => (value === MISSING ? delete doc.relationships : (doc.relationships = clone(value))));
	variant(`manyToManyRelationships ${label}`, DESIGN_RICH, (doc) => (value === MISSING ? delete doc.manyToManyRelationships : (doc.manyToManyRelationships = clone(value))));
}
for (const [label, value] of [
	["missing", MISSING], ["null", null], ["set", { x: 10.5, y: -3, zoom: 0.5 }], ["partial", { x: 1 }], ["empty", {}],
] as const) {
	variant(`viewport ${label}`, DESIGN_RICH, (doc) => (value === MISSING ? delete doc.viewport : (doc.viewport = clone(value))));
}
for (const key of ["enumTypes", "functions", "triggers", "rawStatements"] as const) {
	for (const [label, value] of [["missing", MISSING], ["empty", []], ["null", null]] as const) {
		variant(`${key} ${label}`, DESIGN_RICH, (doc) => (value === MISSING ? delete doc[key] : (doc[key] = clone(value))));
	}
}
for (const [label, value] of [
	["valid before", { id: "r", sql: "CREATE SCHEMA x;", phase: "before" }],
	["valid with links", { id: "r", sql: "CREATE VIEW v AS SELECT 1;", phase: "after", creates: "view:v", attachedTo: "orders" }],
	["extra fields dropped", { id: "r", sql: "SELECT 1;", phase: "after", note: "gone", creates: 5, attachedTo: null }],
	["empty creates kept", { id: "r", sql: "SELECT 1;", phase: "after", creates: "" }],
	["blank sql", { id: "r", sql: "   ", phase: "after" }],
	["empty id", { id: "", sql: "SELECT 1;", phase: "after" }],
	["bad phase", { id: "r", sql: "SELECT 1;", phase: "during" }],
	["no phase", { id: "r", sql: "SELECT 1;" }],
	["non-string sql", { id: "r", sql: 5, phase: "after" }],
	["null entry", null],
	["string entry", "CREATE SCHEMA x;"],
] as const) {
	variant(`rawStatements entry ${label}`, DESIGN_RICH, (doc) => (doc.rawStatements = [clone(value)]));
}
variant("rawStatements not a list", DESIGN_RICH, (doc) => (doc.rawStatements = { id: "r" }));
variant("rawStatements zero", DESIGN_RICH, (doc) => (doc.rawStatements = 0));
variant("rawStatements true", DESIGN_RICH, (doc) => (doc.rawStatements = true));
variant("unknown top-level field is dropped", DESIGN_RICH, (doc) => (doc.futureField = { a: 1 }));
variant("unknown table and column fields are kept", DESIGN_RICH, (doc) => {
	doc.tables[0].futureTableField = [1, 2];
	doc.tables[0].columns[0].futureColumnField = { deep: true };
});
variant("no tables", DESIGN_RICH, (doc) => (doc.tables = []));

const stubSandbox = (): SchemaSandbox => ({
	apply: async () => ({ ok: false, failure: "sandbox-error", error: "stubbed for fixtures" }),
	dispose: async () => {},
});

const directory = mkdtempSync(join(tmpdir(), "db-planner-fixture-designs-"));
try {
	const databasePath = join(directory, "designs.sqlite");
	const store = openDesignStore(databasePath);
	inputs.forEach((entry, index) => {
		// createProject stores JSON.stringify(design) as given: no normalization happens on write.
		store.createProject({ id: `p${index}`, name: `Case ${index}` }, entry.doc as Design, { revision: 1, documentRevision: 1, savedAt: 1000 + index }, `d${index}`);
	});
	store.close();

	const workspace = await createDesignWorkspace({ databasePath, createSandbox: stubSandbox });
	const cases: Case[] = [];
	for (const [index, entry] of inputs.entries()) {
		let result: Case["result"];
		try {
			const state = await workspace.openProject({ projectId: `p${index}` });
			result = { ok: JSON.parse(JSON.stringify(state.design)) };
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		cases.push({ name: entry.name, input: entry.doc, result });
	}
	await workspace.close();

	// A JS engine TypeError would pin an engine-specific message, which is not worth porting.
	const engineErrors = cases.filter((entry) => "error" in entry.result && !/^(Raw SQL|A raw SQL)/.test(entry.result.error));
	if (engineErrors.length > 0) {
		throw new Error(`Unexpected errors:\n${engineErrors.map((entry) => `${entry.name}: ${(entry.result as { error: string }).error}`).join("\n")}`);
	}
	const unmodified = cases.filter((entry) => entry.name.endsWith("(unmodified)"));
	if (unmodified.some((entry) => "error" in entry.result)) throw new Error("A base design was rejected.");

	const outDir = join(import.meta.dir, "data");
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "designs.json"), `${JSON.stringify(cases)}\n`);
	const rejected = cases.filter((entry) => "error" in entry.result).length;
	console.log(`designs: ${cases.length} cases, ${cases.length - rejected} accepted, ${rejected} rejected`);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
