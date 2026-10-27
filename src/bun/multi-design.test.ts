import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Design, WorkspaceState } from "../shared/design";
import { openDesignStore, type DesignStore } from "./store";
import { createDesignWorkspace, type DesignWorkspace, type DesignWorkspaceOptions } from "./workspace";

// Each test starts real PGlite sandboxes, which take several seconds under load.
setDefaultTimeout(30_000);

/**
 * Behavior of several database Designs inside one Project, against real SQLite
 * storage and real PGlite sandboxes. Each Design must keep its own schema,
 * Scenarios, Edge functions, history, and saves, whichever one is shown.
 */

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createTempDatabasePath(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-multi-design-"));
	temporaryDirectories.push(directory);
	return join(directory, "designs.sqlite");
}

async function openWorkspace(databasePath: string, options: Pick<DesignWorkspaceOptions, "openStore"> = {}) {
	const workspace = await createDesignWorkspace({ databasePath, ...options });
	openWorkspaces.push(workspace);
	return workspace;
}

function activeDesignId(state: WorkspaceState): string {
	if (!state.activeDesignId) throw new Error("expected an active design");
	return state.activeDesignId;
}

function tableNames(state: WorkspaceState): string[] {
	return (state.design?.tables ?? []).map((table) => table.name).sort();
}

function appliedTableNames(state: WorkspaceState): string[] {
	if (state.sandbox.status !== "applied") throw new Error(`expected an applied sandbox, got ${state.sandbox.status}`);
	return state.sandbox.tables.map((table) => table.name).sort();
}

/** Lets a test hold one design's store writes until it decides to release them. */
function gateDesignWrites(databasePath: string, gatedDesignId: () => string | null) {
	const store = openDesignStore(databasePath);
	let release: (() => void) | null = null;
	let gate: Promise<void> | null = null;
	const wrapped: DesignStore = {
		...store,
		async saveDesign(projectId, design, save, designId) {
			if (designId === gatedDesignId() && gate) await gate;
			store.saveDesign(projectId, design, save, designId);
		},
	};
	return {
		store: wrapped,
		hold() {
			gate = new Promise<void>((resolve) => { release = resolve; });
		},
		release() {
			release?.();
			gate = null;
			release = null;
		},
	};
}

describe("creating and switching designs", () => {
	test("creates, names, and switches between designs with their own content and identities", async () => {
		const databasePath = createTempDatabasePath();
		const workspace = await openWorkspace(databasePath);

		const project = await workspace.createProject({ name: "Shop" });
		const ordersDesignId = activeDesignId(project);
		await workspace.addTable({ designId: ordersDesignId, name: "orders" });

		const created = await workspace.createDesign({ name: "Analytics" });
		const analyticsDesignId = activeDesignId(created);
		expect(analyticsDesignId).not.toBe(ordersDesignId);
		expect(created.designs.map((design) => design.name)).toEqual(["", "Analytics"]);
		expect(tableNames(created)).toEqual([]);

		await workspace.addTable({ designId: analyticsDesignId, name: "events" });
		expect(tableNames(workspace.getState())).toEqual(["events"]);

		const back = await workspace.openDesign({ designId: ordersDesignId });
		expect(activeDesignId(back)).toBe(ordersDesignId);
		expect(tableNames(back)).toEqual(["orders"]);
		expect(back.designs.map((design) => design.id)).toEqual([ordersDesignId, analyticsDesignId]);
	});

	test("reopening a multi-design project keeps every design's identity and content", async () => {
		const databasePath = createTempDatabasePath();
		const workspace = await openWorkspace(databasePath);
		const project = await workspace.createProject({ name: "Shop" });
		const ordersDesignId = activeDesignId(project);
		await workspace.addTable({ designId: ordersDesignId, name: "orders" });
		const second = await workspace.createDesign({ name: "Analytics" });
		const analyticsDesignId = activeDesignId(second);
		await workspace.addTable({ designId: analyticsDesignId, name: "events" });
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		const opened = await reopened.openProject({ projectId: project.project!.id });
		expect(opened.designs.map((design) => design.id)).toEqual([ordersDesignId, analyticsDesignId]);
		expect(opened.designs.map((design) => design.name)).toEqual(["", "Analytics"]);
		const analytics = await reopened.openDesign({ designId: analyticsDesignId });
		expect(tableNames(analytics)).toEqual(["events"]);
	});

	test("rejects duplicate design names and renames without touching content", async () => {
		const workspace = await openWorkspace(createTempDatabasePath());
		const project = await workspace.createProject({ name: "Shop" });
		const ordersDesignId = activeDesignId(project);
		await workspace.createDesign({ name: "Events" });

		await expect(workspace.createDesign({ name: "events" })).rejects.toThrow("already exists");
		await expect(workspace.renameDesign({ designId: ordersDesignId, name: "  EVENTS " })).rejects.toThrow("already exists");

		const renamed = await workspace.renameDesign({ designId: ordersDesignId, name: "  Orders  " });
		expect(renamed.designs.map((design) => design.name)).toEqual(["Orders", "Events"]);
		expect(renamed.activeDesignId).not.toBe(ordersDesignId);

		const defaulted = await workspace.createDesign({ name: "   " });
		expect(defaulted.designs[defaulted.designs.length - 1]?.name).toBe("Design 3");
	});
});

describe("isolation between designs", () => {
	test("each design keeps a distinct PGlite schema, even when table names overlap", async () => {
		const workspace = await openWorkspace(createTempDatabasePath());
		const project = await workspace.createProject({ name: "Shop" });
		const first = activeDesignId(project);
		await workspace.addTable({ designId: first, name: "customers" });

		const second = activeDesignId(await workspace.createDesign({ name: "Support" }));
		await workspace.addTable({ designId: second, name: "customers" });
		await workspace.addTable({ designId: second, name: "tickets" });

		expect(tableNames(workspace.getState())).toEqual(["customers", "tickets"]);
		expect(appliedTableNames(workspace.getState())).toEqual(["customers", "tickets"]);

		const back = await workspace.openDesign({ designId: first });
		expect(tableNames(back)).toEqual(["customers"]);
		expect(appliedTableNames(back)).toEqual(["customers"]);
	});

	test("Scenarios and Edge functions with the same names stay scoped to their design across reopen", async () => {
		const databasePath = createTempDatabasePath();
		const workspace = await openWorkspace(databasePath);
		const project = await workspace.createProject({ name: "Shop" });
		const first = activeDesignId(project);
		const firstHandler = await workspace.createEdgeFunction({ designId: first, name: "charge" });
		await workspace.updateEdgeFunctionSource({
			designId: first,
			edgeFunctionId: firstHandler.edgeFunctions[0]!.id,
			source: "export default () => 'orders'",
		});
		const firstScenario = await workspace.createScenario({ designId: first, name: "Checkout" });
		await workspace.updateScenarioSource({
			designId: first,
			scenarioId: firstScenario.scenarios[0]!.id,
			source: "orders source",
		});

		const second = activeDesignId(await workspace.createDesign({ name: "Billing" }));
		// The same handler name is unique per design now, so Billing can reuse it.
		const secondHandler = await workspace.createEdgeFunction({ designId: second, name: "charge" });
		expect(secondHandler.edgeFunctions.map((item) => item.name)).toEqual(["charge"]);
		await workspace.updateEdgeFunctionSource({
			designId: second,
			edgeFunctionId: secondHandler.edgeFunctions[0]!.id,
			source: "export default () => 'billing'",
		});
		const secondScenario = await workspace.createScenario({ designId: second, name: "Checkout" });
		expect(secondScenario.scenarios.map((item) => item.name)).toEqual(["Checkout"]);
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		const reopenedProject = await reopened.openProject({ projectId: project.project!.id });
		expect(reopenedProject.edgeFunctions.map((item) => item.source)).toEqual(["export default () => 'orders'"]);
		expect(reopenedProject.scenarios.map((item) => item.source)).toEqual(["orders source"]);

		const billing = await reopened.openDesign({ designId: second });
		expect(billing.edgeFunctions.map((item) => item.source)).toEqual(["export default () => 'billing'"]);
		expect(billing.scenarios.map((item) => item.name)).toEqual(["Checkout"]);
		expect(billing.scenarios[0]!.source).toBe("");
	});

	test("a Scenario run cannot target a design that is no longer shown", async () => {
		const workspace = await openWorkspace(createTempDatabasePath());
		const project = await workspace.createProject({ name: "Shop" });
		const first = activeDesignId(project);
		const created = await workspace.createScenario({ designId: first, name: "Checkout" });
		const scenarioId = created.scenarios[0]!.id;
		await workspace.createDesign({ name: "Billing" });

		await expect(workspace.beginScenarioRun({ scenarioId, designId: first })).rejects.toThrow("not the active design");
	});

	test("undo and redo follow each design's own history", async () => {
		const workspace = await openWorkspace(createTempDatabasePath());
		const project = await workspace.createProject({ name: "Shop" });
		const first = activeDesignId(project);
		await workspace.addTable({ designId: first, name: "orders" });

		const second = activeDesignId(await workspace.createDesign({ name: "Support" }));
		await workspace.addTable({ designId: second, name: "tickets" });

		// Undoing the Support design reverses only its own table.
		const undone = await workspace.undo({ designId: second });
		expect(tableNames(undone)).toEqual([]);
		expect(undone.undoRedo.canRedo).toBe(true);

		// Switching back shows Orders' history, untouched by Support's undo.
		const orders = await workspace.openDesign({ designId: first });
		expect(tableNames(orders)).toEqual(["orders"]);
		expect(orders.undoRedo.canUndo).toBe(true);
		expect(orders.undoActionName).toContain("orders");

		const ordersUndone = await workspace.undo({ designId: first });
		expect(tableNames(ordersUndone)).toEqual([]);

		const support = await workspace.openDesign({ designId: second });
		expect(support.undoRedo.canRedo).toBe(true);
		const redone = await workspace.redo({ designId: second });
		expect(tableNames(redone)).toEqual(["tickets"]);
	});

	test("undo and redo refuse a design that is not the one shown", async () => {
		const workspace = await openWorkspace(createTempDatabasePath());
		const project = await workspace.createProject({ name: "Shop" });
		const first = activeDesignId(project);
		await workspace.addTable({ designId: first, name: "orders" });
		await workspace.createDesign({ name: "Support" });

		await expect(workspace.undo({ designId: first })).rejects.toThrow("not the active design");
	});

	test("a save that completes after switching designs lands in its own design and never shows in the other", async () => {
		const databasePath = createTempDatabasePath();
		let slowDesignId: string | null = null;
		const gate = gateDesignWrites(databasePath, () => slowDesignId);
		const workspace = await openWorkspace(databasePath, { openStore: () => gate.store });

		const project = await workspace.createProject({ name: "Shop" });
		const orders = activeDesignId(project);
		const support = activeDesignId(await workspace.createDesign({ name: "Support" }));
		await workspace.openDesign({ designId: orders });

		slowDesignId = orders;
		gate.hold();
		const pendingAdd = workspace.addTable({ designId: orders, name: "slow" });
		// Let the structural change reach its held write before switching away.
		await new Promise((resolve) => setTimeout(resolve, 10));

		const shown = await workspace.openDesign({ designId: support });
		expect(activeDesignId(shown)).toBe(support);
		expect(tableNames(shown)).toEqual([]);

		gate.release();
		await pendingAdd;
		// Orders' late write does not change what Support shows.
		const afterLateSave = workspace.getState();
		expect(activeDesignId(afterLateSave)).toBe(support);
		expect(tableNames(afterLateSave)).toEqual([]);
		expect(afterLateSave.save.status === "idle" || afterLateSave.save.designId === support).toBe(true);
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		// The late write is stored under Orders, and Support stays empty.
		const reopened = await openWorkspace(databasePath);
		const reopenedProject = await reopened.openProject({ projectId: project.project!.id });
		expect(activeDesignId(reopenedProject)).toBe(orders);
		expect(tableNames(reopenedProject)).toEqual(["slow"]);
		const supportAgain = await reopened.openDesign({ designId: support });
		expect(tableNames(supportAgain)).toEqual([]);
	});
});

describe("legacy projects", () => {
	test("a project saved before design-scoped artifacts keeps its design, Scenarios, and handlers", async () => {
		const databasePath = createTempDatabasePath();
		mkdirSync(dirname(databasePath), { recursive: true });
		const legacyDesign: Design = {
			tables: [],
			relationships: [],
			manyToManyRelationships: [],
			viewport: { x: 0, y: 0, zoom: 1 },
		};
		createLegacyProject(databasePath, {
			projectId: "legacy-project",
			design: legacyDesign,
			scenario: { id: "scenario-1", name: "Signup", source: "legacy scenario" },
			edgeFunction: { id: "edge-1", name: "charge", source: "legacy handler" },
		});

		const workspace = await openWorkspace(databasePath);
		const opened = await workspace.openProject({ projectId: "legacy-project" });
		const legacyDesignId = activeDesignId(opened);
		expect(opened.designs.map((design) => design.id)).toEqual([legacyDesignId]);
		expect(opened.scenarios.map((item) => item.source)).toEqual(["legacy scenario"]);
		expect(opened.edgeFunctions.map((item) => item.source)).toEqual(["legacy handler"]);

		// A second design can reuse the legacy handler name without clashing with it.
		const second = await workspace.createDesign({ name: "Billing" });
		const billingDesignId = activeDesignId(second);
		const withHandler = await workspace.createEdgeFunction({ designId: billingDesignId, name: "charge" });
		expect(withHandler.edgeFunctions.map((item) => item.name)).toEqual(["charge"]);
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		const back = await reopened.openDesign({ designId: legacyDesignId });
		expect(back.scenarios.map((item) => item.source)).toEqual(["legacy scenario"]);
		expect(back.edgeFunctions.map((item) => item.source)).toEqual(["legacy handler"]);
		const billing = await reopened.openDesign({ designId: billingDesignId });
		expect(billing.edgeFunctions.map((item) => item.name)).toEqual(["charge"]);
		// Billing's handler starts from its own default body, not the legacy source.
		expect(billing.edgeFunctions[0]!.source).not.toBe("legacy handler");
	});
});

/**
 * A version-0 database: one design per project with no identity column, and
 * scenario and Edge function documents keyed by Project. The schema matches the
 * shape that existed before design-scoped artifacts.
 */
function createLegacyProject(
	databasePath: string,
	input: {
		projectId: string;
		design: Design;
		scenario: { id: string; name: string; source: string };
		edgeFunction: { id: string; name: string; source: string };
	},
) {
	const db = new Database(databasePath, { create: true });
	db.exec(`
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
	`);
	const now = Date.now();
	db.query("INSERT INTO projects VALUES (?, ?, ?, ?)").run(input.projectId, "Legacy", now, now);
	db.query("INSERT INTO designs VALUES (?, ?, ?, ?, ?)").run(input.projectId, 1, 1, JSON.stringify(input.design), now);
	db.query("INSERT INTO scenarios VALUES (?, ?, ?, ?, ?)").run(input.projectId, input.scenario.id, 0, input.scenario.name, input.scenario.source);
	db.query("INSERT INTO scenario_documents VALUES (?, ?, ?)").run(input.projectId, 1, now);
	db.query("INSERT INTO edge_functions VALUES (?, ?, ?, ?, ?)").run(input.projectId, input.edgeFunction.id, 0, input.edgeFunction.name, input.edgeFunction.source);
	db.query("INSERT INTO edge_function_documents VALUES (?, ?, ?)").run(input.projectId, 1, now);
	db.close();
}
