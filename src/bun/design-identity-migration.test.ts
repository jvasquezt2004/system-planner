import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Design } from "../shared/design";
import { openDesignStore } from "./store";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

function createTempDir(prefix = "db-planner-mig-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(dir);
	return dir;
}

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * Creates a raw SQLite database with the legacy schema (pre-#119):
 * - designs has NO id column (project_id is primary key)
 * - scenarios has NO design_id column
 * - edge_functions has NO design_id column
 * - assistant_conversations and assistant_messages exist
 */
function createLegacyDatabase(databasePath: string, options: {
	projectId: string;
	projectName: string;
	design: Design;
	revision: number;
	documentRevision: number;
	scenarios?: Array<{ id: string; name: string; source: string }>;
	edgeFunctions?: Array<{ id: string; name: string; source: string }>;
	conversation?: { id: string; title: string; message: string };
}) {
	const db = new Database(databasePath, { create: true });
	db.exec(`
		PRAGMA journal_mode = WAL;
		PRAGMA foreign_keys = ON;

		CREATE TABLE projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE designs (
			project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			document_revision INTEGER NOT NULL DEFAULT 0,
			document TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE scenarios (
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			id TEXT NOT NULL,
			position INTEGER NOT NULL,
			name TEXT NOT NULL,
			source TEXT NOT NULL,
			PRIMARY KEY (project_id, id)
		);

		CREATE TABLE scenario_documents (
			project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE edge_functions (
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			id TEXT NOT NULL,
			position INTEGER NOT NULL,
			name TEXT NOT NULL,
			source TEXT NOT NULL,
			PRIMARY KEY (project_id, id),
			UNIQUE (project_id, name)
		);

		CREATE TABLE edge_function_documents (
			project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
			revision INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE assistant_conversations (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			title TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE assistant_messages (
			conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
			sequence INTEGER NOT NULL,
			id TEXT,
			role TEXT NOT NULL,
			kind TEXT,
			payload TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (conversation_id, sequence)
		);
	`);

	const now = Date.now();
	db.query("INSERT INTO projects VALUES (?, ?, ?, ?)").run(options.projectId, options.projectName, now, now);
	db.query("INSERT INTO designs VALUES (?, ?, ?, ?, ?)").run(
		options.projectId,
		options.revision,
		options.documentRevision,
		JSON.stringify(options.design),
		now,
	);

	if (options.scenarios && options.scenarios.length > 0) {
		options.scenarios.forEach((s, idx) => {
			db.query("INSERT INTO scenarios VALUES (?, ?, ?, ?, ?)").run(
				options.projectId,
				s.id,
				idx,
				s.name,
				s.source,
			);
		});
		db.query("INSERT INTO scenario_documents VALUES (?, ?, ?)").run(options.projectId, 1, now);
	}

	if (options.edgeFunctions && options.edgeFunctions.length > 0) {
		options.edgeFunctions.forEach((ef, idx) => {
			db.query("INSERT INTO edge_functions VALUES (?, ?, ?, ?, ?)").run(
				options.projectId,
				ef.id,
				idx,
				ef.name,
				ef.source,
			);
		});
		db.query("INSERT INTO edge_function_documents VALUES (?, ?, ?)").run(options.projectId, 1, now);
	}

	if (options.conversation) {
		db.query("INSERT INTO assistant_conversations VALUES (?, ?, ?, ?, ?)").run(
			options.conversation.id,
			options.projectId,
			options.conversation.title,
			now,
			now,
		);
		db.query("INSERT INTO assistant_messages VALUES (?, ?, ?, ?, ?, ?, ?)").run(
			options.conversation.id,
			1,
			"msg-1",
			"user",
			"text",
			JSON.stringify({ text: options.conversation.message }),
			now,
		);
	}

	db.close();
}

describe("ticket #119: explicit design identity and legacy compatibility", () => {
	test("transactionally migrates legacy database, assigning stable design identity and preserving incomplete drafts", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "legacy.sqlite");

		// An incomplete draft: table without columns, invalid/empty state
		const incompleteDraft: Design = {
			tables: [
				{
					id: "tbl-draft",
					name: "UnfinishedTable",
					position: { x: 100, y: 200 },
					columns: [], // incomplete: no primary key, no columns
				},
			],
			relationships: [],
			manyToManyRelationships: [],
			viewport: { x: 10, y: 20, zoom: 1.5 },
		};

		createLegacyDatabase(dbPath, {
			projectId: "proj-legacy-1",
			projectName: "Legacy Project",
			design: incompleteDraft,
			revision: 3,
			documentRevision: 5,
			scenarios: [{ id: "scen-1", name: "User Flow", source: "export default async function() {}" }],
			edgeFunctions: [{ id: "ef-1", name: "webhook", source: "export default function() {}" }],
			conversation: { id: "conv-1", title: "Setup conversation", message: "Initial prompt" },
		});

		// Open with new store
		const store = openDesignStore(dbPath);
		try {
			const projectRecord = store.loadProject("proj-legacy-1");
			expect(projectRecord).not.toBeNull();
			expect(projectRecord!.project.id).toBe("proj-legacy-1");
			expect(projectRecord!.revision).toBe(3);
			expect(projectRecord!.documentRevision).toBe(5);

			// Must have an explicit, non-empty designId
			expect(projectRecord!.designId).toBeDefined();
			expect(typeof projectRecord!.designId).toBe("string");
			expect(projectRecord!.designId.length).toBeGreaterThan(0);
			const firstAssignedDesignId = projectRecord!.designId;

			// Incomplete draft preserved without loss or alteration
			expect(projectRecord!.design.tables).toHaveLength(1);
			expect(projectRecord!.design.tables[0].name).toBe("UnfinishedTable");
			expect(projectRecord!.design.tables[0].columns).toHaveLength(0);
			expect(projectRecord!.design.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 });

			// Scenarios carry the designId
			const scenarioDoc = store.loadScenarios("proj-legacy-1", firstAssignedDesignId);
			expect(scenarioDoc.scenarios).toHaveLength(1);
			expect(scenarioDoc.scenarios[0].name).toBe("User Flow");
			expect(scenarioDoc.designId).toBe(firstAssignedDesignId);

			// Edge functions carry the designId
			const edgeFuncDoc = store.loadEdgeFunctions("proj-legacy-1", firstAssignedDesignId);
			expect(edgeFuncDoc.edgeFunctions).toHaveLength(1);
			expect(edgeFuncDoc.edgeFunctions[0].name).toBe("webhook");
			expect(edgeFuncDoc.designId).toBe(firstAssignedDesignId);

			// Check conversation preserved
			const rawDb = new Database(dbPath);
			const conv = rawDb.query<{ id: string; title: string }, [string]>(
				"SELECT id, title FROM assistant_conversations WHERE id = ?",
			).get("conv-1");
			expect(conv).not.toBeNull();
			expect(conv?.title).toBe("Setup conversation");
			const msg = rawDb.query<{ payload: string }, [string]>(
				"SELECT payload FROM assistant_messages WHERE conversation_id = ?",
			).get("conv-1");
			expect(msg).not.toBeNull();
			expect(JSON.parse(msg!.payload).text).toBe("Initial prompt");
			rawDb.close();

			// Reloading the project preserves the EXACT same stable design identity
			const reloadedRecord = store.loadProject("proj-legacy-1");
			expect(reloadedRecord!.designId).toBe(firstAssignedDesignId);
		} finally {
			store.close();
		}

		// Reopening the store again still yields the EXACT same designId
		const storeReopened = openDesignStore(dbPath);
		try {
			const record = storeReopened.loadProject("proj-legacy-1");
			expect(record!.designId).toBeDefined();
			// Assert stable identity across multiple openings
			const rawDb = new Database(dbPath);
			const designRow = rawDb.query<{ id: string }, [string]>("SELECT id FROM designs WHERE project_id = ?").get("proj-legacy-1");
			expect(designRow?.id).toBe(record!.designId);
			rawDb.close();
		} finally {
			storeReopened.close();
		}
	});

	test("rolls back migration transaction on failure leaving legacy database untouched", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "rollback.sqlite");

		const draft: Design = {
			tables: [],
			relationships: [],
			manyToManyRelationships: [],
			viewport: { x: 0, y: 0, zoom: 1 },
		};

		createLegacyDatabase(dbPath, {
			projectId: "proj-rb",
			projectName: "Rollback Test",
			design: draft,
			revision: 1,
			documentRevision: 1,
		});

		// Verify legacy schema before migration attempt: designs has NO 'id' column
		const preDb = new Database(dbPath);
		const colsBefore = preDb.query<{ name: string }, []>("PRAGMA table_info(designs)").all();
		expect(colsBefore.some((c) => c.name === "id")).toBe(false);
		preDb.close();

		// We can test that a migration that throws rolls back cleanly
		// (We will expose an option or hook in openDesignStore for testing migration failure rollback)
		expect(() => {
			openDesignStore(dbPath, {
				_testSimulateMigrationFailure: true,
			});
		}).toThrow("Simulated migration failure");

		// After failure, DB is STILL in legacy schema and data is unchanged
		const postDb = new Database(dbPath);
		const colsAfter = postDb.query<{ name: string }, []>("PRAGMA table_info(designs)").all();
		expect(colsAfter.some((c) => c.name === "id")).toBe(false);
		const project = postDb.query<{ id: string; name: string }, [string]>("SELECT id, name FROM projects WHERE id = ?").get("proj-rb");
		expect(project?.name).toBe("Rollback Test");
		postDb.close();

		// Subsequent normal open succeeds and migrates cleanly
		const store = openDesignStore(dbPath);
		try {
			const record = store.loadProject("proj-rb");
			expect(record).not.toBeNull();
			expect(record!.designId).toBeDefined();
		} finally {
			store.close();
		}
	});

	test("workspace requires explicit target actions", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "workspace.sqlite");

		const workspace = await createDesignWorkspace({ databasePath: dbPath });
		openWorkspaces.push(workspace);

		await workspace.createProject({ name: "Additive Test" });
		const state = workspace.getState();
		expect(state.activeDesignId).toBeDefined();
		expect(typeof state.activeDesignId).toBe("string");
		const designId = state.activeDesignId!;

		await expect(workspace.addTable({ name: "missing_target" } as never)).rejects.toThrow(/design ID is required/i);
		await expect(workspace.addTable({ designId: "", name: "empty_target" })).rejects.toThrow(/design ID is required/i);
		const stateAfterExplicit = await workspace.addTable({ designId, name: "explicit_table" });
		expect(stateAfterExplicit.design?.tables.some((t) => t.name === "explicit_table")).toBe(true);
		expect(stateAfterExplicit.save).toMatchObject({ status: "saved", designId });
		expect(stateAfterExplicit.sql).toMatchObject({ designId });

		// Action with mismatched/unknown designId is rejected
		await expect(
			workspace.addTable({
				designId: "non-existent-design-id",
				name: "invalid_table",
			}),
		).rejects.toThrow(/design.*not found|not the active/i);

		// Scenario and edge function actions support explicit designId
		const stateWithScenario = await workspace.createScenario({
			designId,
			name: "Explicit Scenario",
		});
		expect(stateWithScenario.scenarios.some((s) => s.name === "Explicit Scenario")).toBe(true);
		expect(stateWithScenario.scenarioSave).toMatchObject({ status: "saved", designId });

		const stateWithEdgeFunc = await workspace.createEdgeFunction({
			designId,
			name: "explicit_edge_func",
		});
		expect(stateWithEdgeFunc.edgeFunctions.some((e) => e.name === "explicit_edge_func")).toBe(true);
		expect(stateWithEdgeFunc.edgeFunctionSave).toMatchObject({ status: "saved", designId });

		// Scenario run carries designId
		const scenario = stateWithScenario.scenarios.find((s) => s.name === "Explicit Scenario")!;
		const runResult = await workspace.beginScenarioRun({ scenarioId: scenario.id, designId });
		expect(runResult.runId).toBeDefined();

		const finishState = await workspace.finishScenarioRun({
			runId: runResult.runId,
			status: "passed",
			console: [],
		});
		const run = finishState.scenarioRuns[scenario.id];
		expect(run).not.toBeNull();
		expect(run?.designId).toBe(designId);
	});

	test("store listDesigns and loadDesign provide explicit design querying", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "store-designs.sqlite");
		const store = openDesignStore(dbPath);
		try {
			const project = { id: "proj-1", name: "Project One" };
			const design: Design = {
				tables: [{ id: "t1", name: "users", position: { x: 0, y: 0 }, columns: [] }],
				relationships: [],
				manyToManyRelationships: [],
				viewport: { x: 0, y: 0, zoom: 1 },
			};
			const explicitDesignId = "custom-design-id-123";
			await store.createProject(project, design, { revision: 1, documentRevision: 1, savedAt: Date.now() }, explicitDesignId);

			const designs = store.listDesigns("proj-1");
			expect(designs).toHaveLength(1);
			expect(designs[0].id).toBe(explicitDesignId);
			expect(designs[0].projectId).toBe("proj-1");

			const record = store.loadDesign(explicitDesignId);
			expect(record).not.toBeNull();
			expect(record!.id).toBe(explicitDesignId);
			expect(record!.projectId).toBe("proj-1");
			expect(record!.design.tables[0].name).toBe("users");

			// Non-existent design returns null
			expect(store.loadDesign("non-existent")).toBeNull();
		} finally {
			store.close();
		}
	});

	test("rejects mismatched designId across all manual schema, routine, and layout actions", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "mismatch.sqlite");

		const workspace = await createDesignWorkspace({ databasePath: dbPath });
		openWorkspaces.push(workspace);

		await workspace.createProject({ name: "Mismatch Test" });
		const activeDesignId = workspace.getState().activeDesignId!;
		const wrongDesignId = "different-design-uuid";

		// Add table with valid designId
		await workspace.addTable({ designId: activeDesignId, name: "orders" });
		const table = workspace.getState().design!.tables.find((t) => t.name === "orders")!;

		// Attempt all actions with wrong designId - each must reject
		await expect(workspace.addTable({ designId: wrongDesignId, name: "bad" })).rejects.toThrow(/not the active/i);
		await expect(workspace.renameTable({ designId: wrongDesignId, tableId: table.id, name: "new_orders" })).rejects.toThrow(/not the active/i);
		await expect(workspace.moveTable({ designId: wrongDesignId, tableId: table.id, position: { x: 50, y: 50 } })).rejects.toThrow(/not the active/i);
		await expect(workspace.addColumn({ designId: wrongDesignId, tableId: table.id, name: "amount", type: "integer" })).rejects.toThrow(/not the active/i);
		await expect(workspace.updateIndexes({ designId: wrongDesignId, tableId: table.id, indexes: [] })).rejects.toThrow(/not the active/i);
		await expect(workspace.updatePolicies({ designId: wrongDesignId, tableId: table.id, rowLevelSecurity: false, policies: [] })).rejects.toThrow(/not the active/i);
		await expect(workspace.updateEnumTypes({ designId: wrongDesignId, enumTypes: [] })).rejects.toThrow(/not the active/i);
		await expect(workspace.updateFunctions({ designId: wrongDesignId, functions: [] })).rejects.toThrow(/not the active/i);
		await expect(workspace.updateTriggers({ designId: wrongDesignId, triggers: [] })).rejects.toThrow(/not the active/i);
		await expect(workspace.updateUniqueConstraints({ designId: wrongDesignId, tableId: table.id, uniqueConstraints: [] })).rejects.toThrow(/not the active/i);
		await expect(workspace.setViewport({ designId: wrongDesignId, x: 10, y: 10, zoom: 1 })).rejects.toThrow(/not the active/i);
		expect(() => workspace.describeRemoval({ designId: wrongDesignId, kind: "table", tableId: table.id })).toThrow(/not the active/i);

		// Valid actions with matching designId succeed
		const renamed = await workspace.renameTable({ designId: activeDesignId, tableId: table.id, name: "renamed_orders" });
		expect(renamed.design?.tables.some((t) => t.name === "renamed_orders")).toBe(true);
	});

	test("attaches target identity and revisions to saves and preview across Project switching", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "switch-targeting.sqlite");

		const workspace = await createDesignWorkspace({ databasePath: dbPath });
		openWorkspaces.push(workspace);

		// Create Project A
		await workspace.createProject({ name: "Project A" });
		const projectA = workspace.getState().project!;
		const designIdA = workspace.getState().activeDesignId!;
		expect(designIdA).toBeDefined();

		// Add table in A
		await workspace.addTable({ designId: designIdA, name: "items" });
		expect(workspace.getState().save).toMatchObject({ status: "saved", designId: designIdA });

		// Create Project B
		await workspace.createProject({ name: "Project B" });
		const projectB = workspace.getState().project!;
		const designIdB = workspace.getState().activeDesignId!;
		expect(designIdB).toBeDefined();
		expect(designIdB).not.toBe(designIdA);

		// Add table in B
		await workspace.addTable({ designId: designIdB, name: "products" });
		expect(workspace.getState().save).toMatchObject({ status: "saved", designId: designIdB });

		// Switch back to Project A
		await workspace.openProject({ projectId: projectA.id });
		expect(workspace.getState().project?.id).toBe(projectA.id);
		expect(workspace.getState().activeDesignId).toBe(designIdA);
		expect(workspace.getState().design?.tables.some((t) => t.name === "items")).toBe(true);
		expect(workspace.getState().save).toMatchObject({ designId: designIdA });

		// Switch back to Project B
		await workspace.openProject({ projectId: projectB.id });
		expect(workspace.getState().project?.id).toBe(projectB.id);
		expect(workspace.getState().activeDesignId).toBe(designIdB);
		expect(workspace.getState().design?.tables.some((t) => t.name === "products")).toBe(true);
		expect(workspace.getState().save).toMatchObject({ designId: designIdB });
	});

	test("migrates genuine minimal legacy database containing only projects and pre-document_revision designs", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "minimal-legacy.sqlite");

		const db = new Database(dbPath, { create: true });
		// Minimal schema from early versions: no document_revision, no scenarios, no edge functions
		db.exec(`
			CREATE TABLE projects (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE designs (
				project_id TEXT PRIMARY KEY REFERENCES projects(id),
				revision INTEGER NOT NULL,
				document TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);
		const testDesign: Design = {
			tables: [{ id: "t1", name: "early_table", position: { x: 0, y: 0 }, columns: [] }],
			relationships: [],
			manyToManyRelationships: [],
			viewport: { x: 0, y: 0, zoom: 1 },
		};
		db.query("INSERT INTO projects VALUES (?, ?, ?, ?)").run("early-proj", "Early App", 1000, 1000);
		db.query("INSERT INTO designs VALUES (?, ?, ?, ?)").run("early-proj", 2, JSON.stringify(testDesign), 1000);
		db.close();

		// Open with store
		const store = openDesignStore(dbPath);
		try {
			const record = store.loadProject("early-proj");
			expect(record).not.toBeNull();
			expect(record!.project.name).toBe("Early App");
			expect(record!.revision).toBe(2);
			expect(record!.documentRevision).toBe(2); // Initialized from revision
			expect(record!.designId).toBeDefined();
			expect(typeof record!.designId).toBe("string");
			expect(record!.design.tables[0].name).toBe("early_table");

			// Verify scenarios and edge functions queries still work cleanly on migrated DB
			const scenarios = store.loadScenarios("early-proj", record!.designId);
			expect(scenarios.scenarios).toHaveLength(0);
			const edgeFunctions = store.loadEdgeFunctions("early-proj", record!.designId);
			expect(edgeFunctions.edgeFunctions).toHaveLength(0);
		} finally {
			store.close();
		}
	});

	test("enforces Project and Design ownership on store operations preventing cross-project corruption", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "ownership-validation.sqlite");
		const store = openDesignStore(dbPath);
		try {
			const baseDesign: Design = {
				tables: [],
				relationships: [],
				manyToManyRelationships: [],
				viewport: { x: 0, y: 0, zoom: 1 },
			};
			store.createProject({ id: "proj-a", name: "A" }, baseDesign, { revision: 1, documentRevision: 1, savedAt: 1 }, "design-a");
			store.createProject({ id: "proj-b", name: "B" }, baseDesign, { revision: 1, documentRevision: 1, savedAt: 1 }, "design-b");

			// Attempt cross-project saveDesign: passing projectId 'proj-a' with designId 'design-b'
			const modifiedA: Design = {
				...baseDesign,
				viewport: { x: 999, y: 999, zoom: 1 },
			};
			expect(() => {
				store.saveDesign("proj-a", modifiedA, { revision: 2, documentRevision: 2, savedAt: 2 }, "design-b");
			}).toThrow(/does not belong to project/i);

			// Design B must be completely untouched
			const loadedB = store.loadDesign("design-b");
			expect(loadedB).not.toBeNull();
			expect(loadedB!.design.viewport.x).toBe(0);

			// Attempt cross-project saveScenarios
			expect(() => {
				store.saveScenarios("proj-a", [{ id: "s1", name: "scen", source: "" }], { revision: 1, savedAt: 1 }, "design-b");
			}).toThrow(/does not belong to project/i);

			// Attempt cross-project saveEdgeFunctions
			expect(() => {
				store.saveEdgeFunctions("proj-a", [{ id: "ef1", name: "ef", source: "" }], { revision: 1, savedAt: 1 }, "design-b");
			}).toThrow(/does not belong to project/i);

			// Attempt cross-project loadScenarios
			expect(() => store.loadScenarios("proj-a", "design-b")).toThrow(/does not belong to project/i);

			// Attempt cross-project loadEdgeFunctions
			expect(() => store.loadEdgeFunctions("proj-a", "design-b")).toThrow(/does not belong to project/i);
		} finally {
			store.close();
		}
	});

	test("compatibility reads and writes deterministically select the primary Design by rowid order when multiple designs exist", async () => {
		const dir = createTempDir();
		const dbPath = join(dir, "deterministic-primary.sqlite");
		const store = openDesignStore(dbPath);
		try {
			const primaryDesign: Design = {
				tables: [{ id: "t1", name: "primary_table", position: { x: 0, y: 0 }, columns: [] }],
				relationships: [],
				manyToManyRelationships: [],
				viewport: { x: 0, y: 0, zoom: 1 },
			};
			const secondaryDesign: Design = {
				tables: [{ id: "t2", name: "secondary_table", position: { x: 100, y: 100 }, columns: [] }],
				relationships: [],
				manyToManyRelationships: [],
				viewport: { x: 50, y: 50, zoom: 2 },
			};

			store.createProject(
				{ id: "proj-multi", name: "Multi Design" },
				primaryDesign,
				{ revision: 1, documentRevision: 1, savedAt: 100 },
				"design-primary",
			);

			// Seed a second design directly in SQLite for the same project
			const rawDb = new Database(dbPath);
			rawDb.query(
				"INSERT INTO designs (id, project_id, name, revision, document_revision, document, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			).run("design-secondary", "proj-multi", "Secondary", 1, 1, JSON.stringify(secondaryDesign), 200);
			rawDb.close();

			// loadProject must deterministically return the primary design (earliest rowid)
			const record = store.loadProject("proj-multi");
			expect(record).not.toBeNull();
			expect(record!.designId).toBe("design-primary");
			expect(record!.design.tables[0].name).toBe("primary_table");

			// Explicitly target the primary Design; the secondary Design stays unchanged.
			const updatedPrimary: Design = {
				...primaryDesign,
				viewport: { x: 999, y: 999, zoom: 1 },
			};
			store.saveDesign("proj-multi", updatedPrimary, { revision: 2, documentRevision: 2, savedAt: 300 }, "design-primary");

			// Verify primary design was updated
			const reloadedPrimary = store.loadDesign("design-primary");
			expect(reloadedPrimary?.revision).toBe(2);
			expect(reloadedPrimary?.design.viewport.x).toBe(999);

			// Verify secondary design was NOT touched
			const reloadedSecondary = store.loadDesign("design-secondary");
			expect(reloadedSecondary?.revision).toBe(1);
			expect(reloadedSecondary?.design.viewport.x).toBe(50);

			// loadProject continues to deterministically return the primary design
			const reloadedProject = store.loadProject("proj-multi");
			expect(reloadedProject!.designId).toBe("design-primary");
		} finally {
			store.close();
		}
	});
});
