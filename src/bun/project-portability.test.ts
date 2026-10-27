import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_EXPORT_FORMAT,
	PROJECT_EXPORT_VERSION,
	ProjectImportError,
	type ProjectExportDocument,
} from "../shared/project-portability";
import { walkthroughStepStatus, type Walkthrough, walkthroughSteps } from "../shared/walkthrough";
import { createProjectTransferActions, exportFileName, PROJECT_IMPORT_FILE_LIMIT_BYTES } from "./project-transfer";
import { openDesignStore } from "./store";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-portability-"));
	temporaryDirectories.push(directory);
	return directory;
}

function databasePathForTest(): string {
	return join(temporaryDirectory(), "designs.sqlite");
}

async function openWorkspace(databasePath: string, options: { failImports?: boolean } = {}) {
	const workspace = await createDesignWorkspace({
		databasePath,
		openStore: (path) => openDesignStore(path, options.failImports ? { _testSimulateImportFailure: true } : undefined),
	});
	openWorkspaces.push(workspace);
	return workspace;
}

function activeDesign(workspace: DesignWorkspace): string {
	return workspace.getState().activeDesignId!;
}

/**
 * A Shop Project with everything #144 must carry: a Service owning components,
 * a Shared schema linked from two Database components, scenarios and an Edge
 * function in two Designs, nested Groups, Connections, a collapsed Service, saved
 * presentation, and a Walkthrough with parallel, repeat, dangling, and redirected steps.
 */
async function buildShopProject(workspace: DesignWorkspace): Promise<void> {
	await workspace.createProject({ name: "Shop" });
	await workspace.addSystemService({ id: "svc-orders", name: "Orders", x: 0, y: 0 });
	await workspace.addSystemComponent({ id: "api", kind: "generic", name: "Orders API", x: 40, y: 60, serviceId: "svc-orders" });
	await workspace.addSystemComponent({ id: "client", kind: "generic", name: "Browser", x: 420, y: 60 });
	await workspace.addSystemComponent({ id: "db-primary", kind: "database", name: "Primary", x: 40, y: 260, serviceId: "svc-orders" });
	await workspace.addSystemComponent({ id: "db-replica", kind: "database", name: "Replica", x: 300, y: 260 });

	await workspace.createSystemDatabaseDesign({ componentId: "db-primary", name: "Orders schema" });
	const ordersDesign = activeDesign(workspace);
	await workspace.linkSystemDatabase({ componentId: "db-replica", designId: ordersDesign });
	await workspace.addTable({ name: "orders", designId: ordersDesign });
	await workspace.createScenario({ name: "Place order", designId: ordersDesign });
	await workspace.updateScenarioSource({
		scenarioId: workspace.getState().scenarios[0]!.id,
		source: 'export const placed = "yes";',
		designId: ordersDesign,
	});
	await workspace.createEdgeFunction({ name: "send-receipt", designId: ordersDesign });
	await workspace.updateEdgeFunctionSource({
		edgeFunctionId: workspace.getState().edgeFunctions[0]!.id,
		source: 'Deno.serve(() => new Response("ok"));',
		designId: ordersDesign,
	});

	await workspace.createDesign({ name: "Analytics" });
	await workspace.createScenario({ name: "Daily totals", designId: activeDesign(workspace) });
	await workspace.openDesign({ designId: ordersDesign });

	await workspace.addSystemConnection({ id: "place", sourceId: "client", targetId: "api", label: "Place order" });
	await workspace.addSystemConnection({ id: "write", sourceId: "api", targetId: "db-primary", label: "Write order" });
	await workspace.addSystemConnection({ id: "replicate", sourceId: "db-primary", targetId: "db-replica", label: "Replicate" });
	await workspace.addSystemConnection({ id: "notify", sourceId: "api", targetId: "client", label: "Confirm" });
	await workspace.addSystemGroup({
		id: "grp-data",
		name: "Data",
		x: 20,
		y: 240,
		width: 300,
		height: 170,
		memberIds: ["db-primary", "db-replica"],
	});
	await workspace.addSystemGroup({
		id: "grp-eu",
		name: "EU region",
		x: -40,
		y: -40,
		width: 620,
		height: 520,
		memberIds: ["svc-orders", "client"],
	});
	await workspace.updateSystemGroup({
		groupId: "grp-eu",
		changes: { memberIds: ["svc-orders", "client", "grp-data"] },
	});
	await workspace.setSystemServiceCollapsed({ serviceId: "svc-orders", collapsed: true });
	await workspace.setSystemViewport({ x: 12, y: -4, zoom: 1.25 });
	await workspace.setActiveView({ view: "database" });

	await workspace.createWalkthrough({ id: "w-order", name: "Place an order" });
	await workspace.addWalkthroughStep({ id: "s-place", walkthroughId: "w-order", connectionId: "place", explanation: "The browser sends the order." });
	await workspace.addWalkthroughBlock({ id: "par-1", walkthroughId: "w-order", kind: "parallel" });
	await workspace.addWalkthroughStep({
		id: "s-write",
		walkthroughId: "w-order",
		connectionId: "write",
		sequence: { blockId: "par-1", branch: 0 },
	});
	await workspace.addWalkthroughStep({
		id: "s-replicate",
		walkthroughId: "w-order",
		connectionId: "replicate",
		explanation: "The replica follows.",
		sequence: { blockId: "par-1", branch: 1 },
	});
	await workspace.addWalkthroughBlock({ id: "retry-1", walkthroughId: "w-order", kind: "repeat" });
	await workspace.updateWalkthroughRepeat({ walkthroughId: "w-order", blockId: "retry-1", count: 3 });
	await workspace.addWalkthroughStep({
		id: "s-retry",
		walkthroughId: "w-order",
		connectionId: "write",
		explanation: "Retry the write.",
		sequence: { blockId: "retry-1" },
	});
	await workspace.addWalkthroughStep({ id: "s-confirm", walkthroughId: "w-order", connectionId: "notify", explanation: "Confirm." });
	// Removing a Connection keeps its steps, which become dangling until repaired.
	await workspace.removeSystemConnection({ connectionId: "notify" });
	// Re-routing a Connection makes the step that played it redirected until reviewed.
	await workspace.updateSystemConnection({ connectionId: "place", changes: { targetId: "db-primary" } });
}

function transfers(workspace: DesignWorkspace, choices: { exportDirectory?: string | null; importFile?: string | null } = {}) {
	return createProjectTransferActions({
		workspace,
		chooseExportDirectory: async () => choices.exportDirectory ?? null,
		chooseImportFile: async () => choices.importFile ?? null,
		now: () => new Date("2026-10-26T21:00:00.000Z"),
	});
}

/**
 * Compares an export with the original by content. Each Design and Project gets
 * a fresh identity on import, so the original's ids are mapped to the copy's.
 */
function withImportedIdentities(original: ProjectExportDocument, copy: ProjectExportDocument): ProjectExportDocument {
	const designIds = new Map(original.designs.map((design, index) => [design.id, copy.designs[index]!.id]));
	const expected = structuredClone(original);
	expected.project.activeDesignId = designIds.get(original.project.activeDesignId)!;
	expected.designs = expected.designs.map((design) => ({ ...design, id: designIds.get(design.id)! }));
	expected.systemDesign.components = expected.systemDesign.components.map((component) =>
		component.designId === undefined ? component : { ...component, designId: designIds.get(component.designId)! },
	);
	return expected;
}

function walkthroughsOf(workspace: DesignWorkspace): Walkthrough[] {
	return workspace.getState().walkthroughs ?? [];
}

function countRows(databasePath: string): Record<string, number> {
	const database = new Database(databasePath, { readonly: true });
	try {
		return Object.fromEntries(
			["projects", "designs", "scenarios", "edge_functions", "system_designs", "walkthrough_documents"].map((table) => [
				table,
				database.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
			]),
		);
	} finally {
		database.close();
	}
}

/** The Design that is open when the Project is exported; the Shop fixture edits it. */
function activeDesignOf(document: Record<string, any>): Record<string, any> {
	return document.designs.find((design: Record<string, any>) => design.id === document.project.activeDesignId);
}

describe("Project export and import", () => {
	test("an exported Project imports as a separate Project with every part preserved", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await buildShopProject(workspace);
		const original = await workspace.exportProject();
		const exportDirectory = temporaryDirectory();

		const exported = await transfers(workspace, { exportDirectory }).exportProject();
		expect(exported.status).toBe("exported");
		const filePath = exported.status === "exported" ? exported.path : "";
		const importedFile = await transfers(workspace, { importFile: filePath }).importProject();
		expect(importedFile.status).toBe("imported");

		const copy = await workspace.exportProject();
		expect(copy).toEqual(withImportedIdentities(original, copy));
		expect(copy.designs.some((design) => original.designs.some((item) => item.id === design.id))).toBe(false);
		expect(importedFile).toMatchObject({ status: "imported", name: "Shop", projectId: workspace.getState().project!.id });
		expect(workspace.getState().activeView).toBe("database");
		expect(workspace.getState().systemDesign!.viewport).toEqual({ x: 12, y: -4, zoom: 1.25 });
		expect(workspace.getState().systemDesign!.collapsedServiceIds).toEqual(["svc-orders"]);
	});

	test("Database components that shared one Design still share the imported Design", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const original = await workspace.exportProject();
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(original));

		await transfers(workspace, { importFile: documentPath }).importProject();

		const components = workspace.getState().systemDesign!.components;
		const primary = components.find((component) => component.id === "db-primary")!;
		const replica = components.find((component) => component.id === "db-replica")!;
		expect(primary.designId).toBeDefined();
		expect(replica.designId).toBe(primary.designId);
		expect(primary.designId).not.toBe(original.systemDesign.components.find((c) => c.id === "db-primary")!.designId);
		// The Shared schema's Scenario and Edge function came with it.
		expect(workspace.getState().scenarios.map((scenario) => scenario.name)).toEqual(["Place order"]);
		expect(workspace.getState().edgeFunctions.map((edgeFunction) => edgeFunction.name)).toEqual(["send-receipt"]);
	});

	test("the original Project is unchanged by an import of its own export", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await buildShopProject(workspace);
		const originalProjectId = workspace.getState().project!.id;
		const before = await workspace.exportProject();
		const projectCountBefore = workspace.listProjects().length;
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(before));

		await transfers(workspace, { importFile: documentPath }).importProject();

		expect(workspace.listProjects().length).toBe(projectCountBefore + 1);
		expect(workspace.getState().project!.id).not.toBe(originalProjectId);
		await workspace.openProject({ projectId: originalProjectId });
		// Opening a Project shows its first Design; the export's active Design is restored explicitly.
		await workspace.openDesign({ designId: before.project.activeDesignId });
		expect(await workspace.exportProject()).toEqual(before);
	});

	test("an imported Project reopens after the app restarts, with its unfinished steps", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await buildShopProject(first);
		const original = await first.exportProject();
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(original));
		await transfers(first, { importFile: documentPath }).importProject();
		const importedProjectId = first.getState().project!.id;
		const importedExport = await first.exportProject();
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);

		expect(reopened.getState().project!.id).toBe(importedProjectId);
		await reopened.openDesign({ designId: importedExport.project.activeDesignId });
		expect(await reopened.exportProject()).toEqual(importedExport);
		const steps = walkthroughSteps(walkthroughsOf(reopened)[0]!);
		const confirm = steps.find((step) => step.id === "s-confirm")!;
		const place = steps.find((step) => step.id === "s-place")!;
		expect(walkthroughStepStatus(confirm, reopened.getState().systemDesign!)).toEqual({ status: "dangling" });
		expect(walkthroughStepStatus(place, reopened.getState().systemDesign!).status).toBe("redirected");
	});

	test("parallel and repeat blocks, dangling and redirected steps round-trip exactly", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const originalWalkthroughs = structuredClone(walkthroughsOf(workspace));
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(await workspace.exportProject()));

		await transfers(workspace, { importFile: documentPath }).importProject();

		expect(walkthroughsOf(workspace)).toEqual(originalWalkthroughs);
		const blocks = walkthroughsOf(workspace)[0]!.blocks;
		expect(blocks.map((block) => block.kind)).toEqual(["step", "parallel", "repeat", "step"]);
		const repeat = blocks[2] as { kind: "repeat"; count: number; body: unknown[] };
		expect(repeat.count).toBe(3);
		expect(repeat.body).toHaveLength(1);
	});

	test("a Walkthrough whose Connection is missing from the file is kept as an unfinished explanation", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const document = await workspace.exportProject();
		// A saved step may name a Connection that is no longer in the System design.
		document.systemDesign.connections = document.systemDesign.connections.filter((connection) => connection.id !== "write");
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(document));

		const result = await transfers(workspace, { importFile: documentPath }).importProject();

		expect(result.status).toBe("imported");
		const write = walkthroughSteps(walkthroughsOf(workspace)[0]!).find((step) => step.id === "s-write")!;
		expect(walkthroughStepStatus(write, workspace.getState().systemDesign!)).toEqual({ status: "dangling" });
	});

	test("an export contains only the portable fields, never credentials or conversations", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const document = await workspace.exportProject();

		expect(Object.keys(document).sort()).toEqual(["designs", "format", "project", "systemDesign", "version", "walkthroughs"]);
		expect(document.format).toBe(PROJECT_EXPORT_FORMAT);
		expect(document.version).toBe(PROJECT_EXPORT_VERSION);
		const serialized = JSON.stringify(document);
		expect(serialized).not.toMatch(/apiKey|api_key|conversation|oauth|refreshToken/i);
	});

	test("fields for credentials and conversations in a file are ignored, not stored", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const document = JSON.parse(JSON.stringify(await workspace.exportProject())) as Record<string, unknown>;
		document.credentials = { providerId: "openai", apiKey: "sk-test-should-not-import" };
		document.conversations = [{ id: "c1", messages: ["private"] }];
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(document));

		await transfers(workspace, { importFile: documentPath }).importProject();

		expect(JSON.stringify(await workspace.exportProject())).not.toContain("sk-test-should-not-import");
		expect(JSON.stringify(await workspace.exportProject())).not.toContain("private");
	});

	test("importing does not run imported Scenario or Edge function source", async () => {
		const sentinelDirectory = temporaryDirectory();
		const sentinel = join(sentinelDirectory, "ran.txt");
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const document = await workspace.exportProject();
		const hostile = `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");`;
		const active = activeDesignOf(document);
		active.edgeFunctions = [{ id: "evil", name: "evil", source: hostile }];
		active.scenarios = [{ id: "evil-scenario", name: "Evil", source: hostile }];
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(document));

		const result = await transfers(workspace, { importFile: documentPath }).importProject();

		expect(result.status).toBe("imported");
		expect(existsSync(sentinel)).toBe(false);
		expect(workspace.getState().scenarioRuns).toEqual({});
		expect(workspace.getState().edgeFunctions.map((edgeFunction) => edgeFunction.source)).toEqual([hostile]);
	});

	describe("malformed files are refused with the problem named and nothing written", () => {
		async function refusal(mutate: (document: Record<string, any>) => void, message: string) {
			const workspace = await openWorkspace(databasePathForTest());
			await buildShopProject(workspace);
			const projectsBefore = workspace.listProjects().map((project) => project.id);
			const openBefore = workspace.getState().project!.id;
			const document = JSON.parse(JSON.stringify(await workspace.exportProject())) as Record<string, any>;
			mutate(document);

			const error = await workspace.importProject(document).then(
				() => null,
				(cause: unknown) => cause,
			);
			expect(error).toBeInstanceOf(ProjectImportError);
			expect((error as Error).message).toContain(message);
			expect(workspace.listProjects().map((project) => project.id)).toEqual(projectsBefore);
			expect(workspace.getState().project!.id).toBe(openBefore);
		}

		test("a file that is not a Schema Designer export", () =>
			refusal((document) => { document.format = "some-other-app"; }, "This file is not a Schema Designer project export."));

		test("a newer format version", () =>
			refusal((document) => { document.version = 2; }, "uses format version 2"));

		test("a missing design list", () =>
			refusal((document) => { delete document.designs; }, "designs must be a list"));

		test("a repeated design identity", () =>
			refusal((document) => { document.designs[1].id = document.designs[0].id; }, "designs[1].id repeats design"));

		test("an active design the file does not contain", () =>
			refusal((document) => { document.project.activeDesignId = "missing"; }, "names design \"missing\""));

		test("a Database component linked to a design the file does not contain", () =>
			refusal(
				(document) => { document.systemDesign.components.find((c: any) => c.id === "db-replica").designId = "gone"; },
				"links design \"gone\"",
			));

		test("a Connection that joins a Component the file does not contain", () =>
			refusal(
				(document) => { document.systemDesign.connections[0].targetId = "nowhere"; },
				"The project file is malformed: systemDesign",
			));

		test("a Group that names a member the file does not contain", () =>
			refusal(
				(document) => { document.systemDesign.groups[0].memberIds.push("nobody"); },
				"The project file is malformed: systemDesign",
			));

		test("a Walkthrough that is not a list", () =>
			refusal((document) => { document.walkthroughs = "steps"; }, "The project file is malformed: walkthroughs"));

		test("an Edge function name the app would not accept", () =>
			refusal(
				(document) => { activeDesignOf(document).edgeFunctions[0].name = "Send Receipt!"; },
				"edgeFunctions[0].name",
			));

		test("a repeated Edge function name within one Design", () =>
			refusal(
				(document) => {
					const active = activeDesignOf(document);
					active.edgeFunctions.push({ ...active.edgeFunctions[0], id: "copy" });
				},
				"repeats \"send-receipt\"",
			));

		test("a Design whose tables are missing", () =>
			refusal((document) => { delete document.designs[0].design.tables; }, "designs[0].design.tables must be a list"));

		test("an unknown active view", () =>
			refusal((document) => { document.project.activeView = "elsewhere"; }, "project.activeView must be"));

	});

	test("a document that is not an object is refused", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);

		await expect(workspace.importProject("Shop")).rejects.toThrow("file must be an object");
	});

	test("a file that is not JSON is refused and creates nothing", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const projectCount = workspace.listProjects().length;
		const path = join(temporaryDirectory(), "broken.schema-designer.json");
		writeFileSync(path, "{ not json");

		const result = await transfers(workspace, { importFile: path }).importProject();

		expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("not valid JSON") });
		expect(workspace.listProjects().length).toBe(projectCount);
	});

	test("a file larger than the import limit is refused before it is read", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		const path = join(temporaryDirectory(), "huge.schema-designer.json");
		writeFileSync(path, "{}");
		truncateSync(path, PROJECT_IMPORT_FILE_LIMIT_BYTES + 1);

		const result = await transfers(workspace, { importFile: path }).importProject();

		expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("larger than 64 MB") });
	});

	test("cancelling the file picker changes nothing", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const projectCount = workspace.listProjects().length;

		expect(await transfers(workspace, { importFile: null }).importProject()).toEqual({ status: "cancelled" });
		expect(workspace.listProjects().length).toBe(projectCount);
	});

	test("cancelling the folder picker writes no file", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const projectsBefore = workspace.listProjects().map((project) => project.id);

		expect(await transfers(workspace, { exportDirectory: null }).exportProject()).toEqual({ status: "cancelled" });
		expect(workspace.listProjects().map((project) => project.id)).toEqual(projectsBefore);
	});

	test("an import that fails partway keeps no Project, Design, or document rows", async () => {
		const databasePath = databasePathForTest();
		const healthy = await openWorkspace(databasePath);
		await buildShopProject(healthy);
		const document = await healthy.exportProject();
		const projectsBefore = healthy.listProjects().map((project) => project.id);
		const openBefore = healthy.getState().project!.id;
		await healthy.close();
		openWorkspaces.splice(openWorkspaces.indexOf(healthy), 1);
		const rowsBefore = countRows(databasePath);

		const failing = await openWorkspace(databasePath, { failImports: true });
		await expect(failing.importProject(document)).rejects.toThrow("Simulated import failure");

		expect(failing.listProjects().map((project) => project.id)).toEqual(projectsBefore);
		expect(failing.getState().project!.id).toBe(openBefore);
		expect(countRows(databasePath)).toEqual(rowsBefore);
	});

	test("a file transfer reports the failure and leaves the open Project as it was", async () => {
		const databasePath = databasePathForTest();
		const healthy = await openWorkspace(databasePath);
		await buildShopProject(healthy);
		const document = await healthy.exportProject();
		await healthy.close();
		openWorkspaces.splice(openWorkspaces.indexOf(healthy), 1);
		const failing = await openWorkspace(databasePath, { failImports: true });
		const path = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(path, JSON.stringify(document));
		const openBefore = failing.getState().project?.id;

		const result = await transfers(failing, { importFile: path }).importProject();

		expect(result).toEqual({ status: "failed", error: "Simulated import failure" });
		expect(failing.getState().project?.id).toBe(openBefore);
	});

	test("exporting with no open Project is refused", async () => {
		const workspace = await openWorkspace(databasePathForTest());

		expect(await transfers(workspace, { exportDirectory: temporaryDirectory() }).exportProject()).toEqual({
			status: "failed",
			error: "Open a project before exporting it.",
		});
	});

	test("export file names are filesystem-safe, dated, and never repeat", () => {
		const now = new Date("2026-10-26T21:00:00.000Z");
		expect(exportFileName("Shop & Co / Orders", now)).toBe("shop-co-orders-2026-10-26T21-00-00-000Z.schema-designer.json");
		expect(exportFileName("  ", now)).toBe("project-2026-10-26T21-00-00-000Z.schema-designer.json");
	});

	test("an empty legacy Design name survives the round-trip", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildShopProject(workspace);
		const document = await workspace.exportProject();
		// The first Design of a Project created before names existed has an empty name.
		expect(document.designs[0]!.name).toBe("");
		const documentPath = join(temporaryDirectory(), "shop.schema-designer.json");
		writeFileSync(documentPath, JSON.stringify(document));

		await transfers(workspace, { importFile: documentPath }).importProject();

		expect((await workspace.exportProject()).designs.map((design) => design.name)).toEqual(
			document.designs.map((design) => design.name),
		);
	});
});
