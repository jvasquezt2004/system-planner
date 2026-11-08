/**
 * Writes differential fixtures for the SQLite store.
 *
 * 1. `store-ops.json`: a scripted sequence of store calls with each call's result
 *    (including the errors), then a full dump. The Rust store replays the script
 *    against an empty database and must agree on every step and on the dump.
 * 2. `store-legacy.json`: for each SQL file in tauri/fixtures/legacy, the dump the
 *    TypeScript store reads after migrating that database.
 *
 * Run from the repository root: bun tauri/fixtures/generate-store.ts
 */
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesignStore, type DesignStore } from "../../src/bun/store";
import { dumpStore, normalizeUuids } from "./lib/store-dump";
import { DESIGN_LEGACY, DESIGN_RICH } from "./lib/design-bases";
import { SYSTEM_DESIGN_RICH, WALKTHROUGHS_RICH } from "./lib/bases";

type Step = { op: string; args: Record<string, unknown>; note?: string };
type Recorded = Step & { result: { ok: unknown } | { error: string } };

const clone = <T>(value: T): T => structuredClone(value);
const save = (revision: number, documentRevision: number, savedAt: number) => ({ revision, documentRevision, savedAt });
const edit = <T>(value: T, change: (draft: any) => void): T => {
	const draft = clone(value) as any;
	change(draft);
	return draft;
};

const designA = DESIGN_RICH;
const designB = edit(DESIGN_LEGACY, (draft) => (draft.tables[0].name = "renamed"));
const scenarios = (...names: string[]) => names.map((name, index) => ({ id: `sc-${name}`, name, source: `// ${name} ${index}` }));
const edgeFunctions = (...names: string[]) => names.map((name) => ({ id: `ef-${name}`, name, source: `export default () => "${name}"` }));

const steps: Step[] = [
	{ op: "listProjects", args: {}, note: "empty database" },
	{ op: "createProject", args: { project: { id: "p1", name: "Shop" }, design: designA, save: save(1, 1, 1000), designId: "d1" } },
	{ op: "loadProject", args: { projectId: "p1" } },
	{ op: "loadProject", args: { projectId: "nope" }, note: "unknown project" },
	{ op: "loadSystemDesign", args: { projectId: "p1" }, note: "starts as an empty overview" },
	{ op: "loadWalkthroughs", args: { projectId: "p1" }, note: "none saved yet" },
	{ op: "createProject", args: { project: { id: "p1", name: "Again" }, design: designA, save: save(1, 1, 1001), designId: "d-dup" }, note: "duplicate project id" },
	{ op: "createProject", args: { project: { id: "p2", name: "Blog" }, design: designB, save: save(1, 1, 2000), designId: "d3" } },
	{ op: "createProject", args: { project: { id: "p3", name: "Aardvark" }, design: designB, save: save(1, 1, 2000), designId: "d4" }, note: "same updated_at as p2: ordered by name" },
	{ op: "listProjects", args: {} },
	{ op: "createDesign", args: { projectId: "p1", designId: "d2", name: "Reporting", design: designB, save: save(1, 1, 3000) } },
	{ op: "createDesign", args: { projectId: "ghost", designId: "d9", name: "X", design: designB, save: save(1, 1, 3001) }, note: "unknown project" },
	{ op: "createDesign", args: { projectId: "p1", designId: "d1", name: "Clash", design: designB, save: save(1, 1, 3002) }, note: "duplicate design id" },
	{ op: "listDesigns", args: { projectId: "p1" } },
	{ op: "listProjects", args: {}, note: "creating a design touches its project" },
	{ op: "renameDesign", args: { projectId: "p1", designId: "d2", name: "Analytics", savedAt: 3500 } },
	{ op: "renameDesign", args: { projectId: "p2", designId: "d2", name: "Stolen", savedAt: 3600 }, note: "design of another project" },
	{ op: "loadDesign", args: { designId: "d2" } },
	{ op: "loadDesign", args: { designId: "missing" } },
	// Document revisions order writes; an older or equal one is silently ignored.
	{ op: "saveDesign", args: { projectId: "p1", design: edit(designA, (d) => (d.viewport = { x: 1, y: 2, zoom: 3 })), save: save(1, 2, 4000), designId: "d1" } },
	{ op: "saveDesign", args: { projectId: "p1", design: edit(designA, (d) => (d.viewport = { x: 9, y: 9, zoom: 9 })), save: save(5, 2, 4100), designId: "d1" }, note: "equal document revision: ignored" },
	{ op: "saveDesign", args: { projectId: "p1", design: designB, save: save(5, 1, 4200), designId: "d1" }, note: "older document revision: ignored" },
	{ op: "saveDesign", args: { projectId: "p2", design: designB, save: save(1, 9, 4300), designId: "d1" }, note: "design of another project" },
	{ op: "loadProject", args: { projectId: "p1" } },
	// Scenarios: replaced as a whole, ordered by position, guarded by their own revision.
	{ op: "loadScenarios", args: { projectId: "p1", designId: "d1" }, note: "nothing saved" },
	{ op: "saveScenarios", args: { projectId: "p1", scenarios: scenarios("login", "checkout"), save: { revision: 1, savedAt: 5000 }, designId: "d1" } },
	{ op: "saveScenarios", args: { projectId: "p1", scenarios: scenarios("ignored"), save: { revision: 1, savedAt: 5100 }, designId: "d1" }, note: "same revision: ignored" },
	{ op: "saveScenarios", args: { projectId: "p1", scenarios: scenarios("checkout", "login", "refund"), save: { revision: 2, savedAt: 5200 }, designId: "d1" } },
	{ op: "saveScenarios", args: { projectId: "p1", scenarios: scenarios("analytics"), save: { revision: 1, savedAt: 5300 }, designId: "d2" }, note: "scoped per design" },
	{ op: "saveScenarios", args: { projectId: "p2", scenarios: scenarios("x"), save: { revision: 1, savedAt: 5400 }, designId: "d1" }, note: "design of another project" },
	{ op: "loadScenarios", args: { projectId: "p1", designId: "d1" } },
	{ op: "loadScenarios", args: { projectId: "p1", designId: "d2" } },
	{ op: "loadScenarios", args: { projectId: "p2", designId: "d1" }, note: "design of another project" },
	// Edge functions: names are unique per design, and a failed save keeps the old set.
	{ op: "saveEdgeFunctions", args: { projectId: "p1", edgeFunctions: edgeFunctions("hello", "bye"), save: { revision: 1, savedAt: 6000 }, designId: "d1" } },
	{ op: "saveEdgeFunctions", args: { projectId: "p1", edgeFunctions: [...edgeFunctions("same"), { id: "ef-other", name: "same", source: "x" }], save: { revision: 2, savedAt: 6100 }, designId: "d1" }, note: "duplicate name: rolled back" },
	{ op: "saveEdgeFunctions", args: { projectId: "p1", edgeFunctions: edgeFunctions("hello"), save: { revision: 1, savedAt: 6200 }, designId: "d2" }, note: "same name in another design is fine" },
	{ op: "loadEdgeFunctions", args: { projectId: "p1", designId: "d1" } },
	{ op: "loadEdgeFunctions", args: { projectId: "p1", designId: "d2" } },
	// System design: a stale write is an error here, unlike the design document.
	{ op: "saveSystemDesign", args: { projectId: "p1", document: SYSTEM_DESIGN_RICH, save: save(2, 5, 7000) } },
	{ op: "saveSystemDesign", args: { projectId: "p1", document: SYSTEM_DESIGN_RICH, save: save(3, 5, 7100) }, note: "stale" },
	{ op: "saveSystemDesign", args: { projectId: "ghost", document: SYSTEM_DESIGN_RICH, save: save(1, 1, 7200) }, note: "unknown project" },
	{ op: "saveLastView", args: { projectId: "p1", view: "database" } },
	{ op: "loadSystemDesign", args: { projectId: "p1" } },
	{ op: "saveLastView", args: { projectId: "p1", view: "system" } },
	{ op: "loadSystemDesign", args: { projectId: "p1" } },
	// Walkthroughs.
	{ op: "saveWalkthroughs", args: { projectId: "p1", walkthroughs: WALKTHROUGHS_RICH, save: { revision: 1, savedAt: 8000 } } },
	{ op: "saveWalkthroughs", args: { projectId: "p1", walkthroughs: [], save: { revision: 1, savedAt: 8100 } }, note: "stale" },
	{ op: "saveWalkthroughs", args: { projectId: "p1", walkthroughs: [], save: { revision: 2, savedAt: 8200 } } },
	{ op: "saveWalkthroughs", args: { projectId: "ghost", walkthroughs: [], save: { revision: 1, savedAt: 8300 } }, note: "unknown project" },
	{ op: "loadWalkthroughs", args: { projectId: "p1" } },
	// Several documents at once: all or nothing.
	{
		op: "saveProjectArtifacts",
		args: {
			projectId: "p1",
			designId: "d1",
			design: { design: designB, save: save(6, 10, 9000) },
			scenarios: { scenarios: scenarios("atomic"), save: { revision: 3, savedAt: 9000 } },
			edgeFunctions: { edgeFunctions: edgeFunctions("atomic"), save: { revision: 3, savedAt: 9000 } },
			systemDesign: { systemDesign: SYSTEM_DESIGN_RICH, save: save(3, 6, 9000) },
			walkthroughs: { walkthroughs: WALKTHROUGHS_RICH, save: { revision: 3, savedAt: 9000 } },
		},
	},
	{
		op: "saveProjectArtifacts",
		args: {
			projectId: "p1",
			designId: "d1",
			design: { design: designA, save: save(7, 11, 9100) },
			scenarios: { scenarios: scenarios("must-not-stick"), save: { revision: 3, savedAt: 9100 } },
		},
		note: "stale scenarios abort the whole save, including the design",
	},
	{
		op: "saveProjectArtifacts",
		args: { projectId: "p1", designId: "d1", design: { design: designA, save: save(7, 10, 9200) } },
		note: "stale design document",
	},
	{ op: "saveProjectArtifacts", args: { projectId: "p2", designId: "d1", design: { design: designA, save: save(8, 12, 9300) } }, note: "design of another project" },
	{
		op: "saveProjectArtifacts",
		args: { projectId: "p1", designId: "d1", systemDesign: { systemDesign: SYSTEM_DESIGN_RICH, save: save(4, 6, 9400) }, walkthroughs: { walkthroughs: [], save: { revision: 4, savedAt: 9400 } } },
		note: "stale system design",
	},
	// Import.
	{
		op: "importProject",
		args: {
			prepared: {
				project: { id: "imp", name: "Imported" },
				activeDesignId: "imp-d1",
				activeView: "database",
				designs: [
					{ id: "imp-d1", name: "Main", design: designA, scenarios: scenarios("one", "two"), edgeFunctions: edgeFunctions("fn") },
					{ id: "imp-d2", name: "Second", design: designB, scenarios: [], edgeFunctions: [] },
				],
				systemDesign: SYSTEM_DESIGN_RICH,
				walkthroughs: WALKTHROUGHS_RICH,
			},
			savedAt: 10000,
		},
	},
	{
		op: "importProject",
		args: {
			prepared: {
				project: { id: "imp", name: "Imported twice" },
				activeDesignId: "imp2-d1",
				activeView: "system",
				designs: [{ id: "imp2-d1", name: "Main", design: designA, scenarios: [], edgeFunctions: [] }],
				systemDesign: SYSTEM_DESIGN_RICH,
				walkthroughs: [],
			},
			savedAt: 10100,
		},
		note: "project id already exists: nothing is kept",
	},
	{
		op: "importProject",
		args: {
			prepared: {
				project: { id: "imp3", name: "Clashing designs" },
				activeDesignId: "d1",
				activeView: "system",
				designs: [{ id: "d1", name: "Clash", design: designA, scenarios: [], edgeFunctions: [] }],
				systemDesign: SYSTEM_DESIGN_RICH,
				walkthroughs: [],
			},
			savedAt: 10200,
		},
		note: "design id already exists: the project row is rolled back too",
	},
	{ op: "listProjects", args: {} },
];

/** Runs one step against a store. Results are JSON-round-tripped so `undefined` vanishes as it does in storage. */
function execute(store: DesignStore, step: Step): unknown {
	const a = step.args as any;
	switch (step.op) {
		case "listProjects": return store.listProjects();
		case "createProject": return store.createProject(a.project, a.design, a.save, a.designId);
		case "createDesign": return store.createDesign(a.projectId, a.designId, a.name, a.design, a.save);
		case "renameDesign": return store.renameDesign(a.projectId, a.designId, a.name, a.savedAt);
		case "saveDesign": return store.saveDesign(a.projectId, a.design, a.save, a.designId);
		case "saveProjectArtifacts": return store.saveProjectArtifacts(a);
		case "loadProject": return store.loadProject(a.projectId);
		case "listDesigns": return store.listDesigns(a.projectId);
		case "loadDesign": return store.loadDesign(a.designId);
		case "loadSystemDesign": return store.loadSystemDesign(a.projectId);
		case "saveSystemDesign": return store.saveSystemDesign(a.projectId, a.document, a.save);
		case "saveLastView": return store.saveLastView(a.projectId, a.view);
		case "loadWalkthroughs": return store.loadWalkthroughs(a.projectId);
		case "saveWalkthroughs": return store.saveWalkthroughs(a.projectId, a.walkthroughs, a.save);
		case "loadScenarios": return store.loadScenarios(a.projectId, a.designId);
		case "saveScenarios": return store.saveScenarios(a.projectId, a.scenarios, a.save, a.designId);
		case "loadEdgeFunctions": return store.loadEdgeFunctions(a.projectId, a.designId);
		case "saveEdgeFunctions": return store.saveEdgeFunctions(a.projectId, a.edgeFunctions, a.save, a.designId);
		case "importProject": return store.importProject(a.prepared, a.savedAt);
		default: throw new Error(`Unknown op ${step.op}`);
	}
}

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "db-planner-fixture-store-"));
try {
	// 1. The operation script.
	const store = openDesignStore(join(scratch, "ops.sqlite"));
	const recorded: Recorded[] = [];
	for (const step of steps) {
		let result: Recorded["result"];
		try {
			const value = execute(store, step);
			result = { ok: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) };
		}
		recorded.push({ ...step, result });
	}
	const dump = JSON.parse(JSON.stringify(dumpStore(store)));
	store.close();
	writeFileSync(join(outDir, "store-ops.json"), `${JSON.stringify({ steps: recorded, dump })}\n`);
	const failed = recorded.filter((entry) => "error" in entry.result);
	console.log(`store ops: ${recorded.length} steps, ${failed.length} errors`);
	for (const entry of failed) console.log(`  ${entry.op}${entry.note ? ` (${entry.note})` : ""}: ${(entry.result as { error: string }).error}`);

	// 2. Legacy databases, built from plain SQL and migrated by opening them.
	const legacyDir = join(import.meta.dir, "legacy");
	const legacy: Array<{ file: string; dump: unknown }> = [];
	for (const file of readdirSync(legacyDir).filter((name) => name.endsWith(".sql")).sort()) {
		const path = join(scratch, `${file}.sqlite`);
		const raw = new Database(path, { create: true });
		raw.exec(readFileSync(join(legacyDir, file), "utf8"));
		raw.close();
		const migrated = openDesignStore(path);
		legacy.push({ file, dump: normalizeUuids(JSON.parse(JSON.stringify(dumpStore(migrated)))) });
		migrated.close();
	}
	writeFileSync(join(outDir, "store-legacy.json"), `${JSON.stringify(legacy)}\n`);
	console.log(`legacy databases: ${legacy.map((entry) => entry.file).join(", ")}`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
