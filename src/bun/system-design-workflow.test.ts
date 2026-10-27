import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { systemDesignSvg } from "../mainview/system-design-svg";
import { CATALOG_KINDS } from "../shared/component-catalog";
import type { ProjectExportDocument } from "../shared/project-portability";
import { type Walkthrough, walkthroughSteps, walkthroughStepStatus } from "../shared/walkthrough";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

/**
 * End-to-end workflow over one offline Project: the image-upload fixture built
 * through the same workspace actions the view and the Assistant use, then saved,
 * reopened, exported, imported, edited by the Assistant, reverted, and exported
 * as SVG. Each focused suite still owns its own rules; this one checks that the
 * modules agree when they are used together.
 */

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];
const runtimes: ReturnType<typeof createAssistantRuntime>[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePathForTest(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-system-workflow-"));
	directories.push(directory);
	return join(directory, "project.sqlite");
}

async function openWorkspace(databasePath: string): Promise<DesignWorkspace> {
	const workspace = await createDesignWorkspace({ databasePath });
	workspaces.push(workspace);
	return workspace;
}

/** Closes a workspace now, so a test can reopen the same saved file as after an app restart. */
async function closeWorkspace(workspace: DesignWorkspace): Promise<void> {
	await workspace.close();
	workspaces.splice(workspaces.indexOf(workspace), 1);
}

function activeDesignId(workspace: DesignWorkspace): string {
	return workspace.getState().activeDesignId!;
}

/** The export a file round trip produces: JSON out, parsed back in. */
function asFile(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

/** The authored content of an export, without Design fields a fresh Design fills in on load. */
function snapshot(document: ProjectExportDocument): unknown {
	return asFile({
		...document,
		designs: document.designs.map(({ id, name, design, scenarios, edgeFunctions }) => ({
			id,
			name,
			tables: design.tables,
			scenarios,
			edgeFunctions,
		})),
	});
}

/**
 * The image-upload fixture: client and person actors, an Upload service and a
 * Processing service, the API, queue, worker, bucket, primary and replica
 * databases sharing the Metadata Design, a separate Billing Design, telemetry,
 * overlapping and nested Groups, duplicate-endpoint and Service-to-Service
 * Connections, and a Walkthrough with parallel and finite retry blocks.
 */
async function buildImageUploadFixture(workspace: DesignWorkspace): Promise<{ metadataId: string; billingId: string }> {
	await workspace.createProject({ name: "Image upload" });

	await workspace.addSystemService({ id: "svc-upload", name: "Upload service", x: 0, y: 0 });
	await workspace.addSystemService({ id: "svc-processing", name: "Processing service", x: 520, y: 0 });
	await workspace.addSystemComponent({ id: "client", kind: "browser", name: "Browser", x: -360, y: 60 });
	await workspace.addSystemComponent({ id: "person", kind: "person", name: "Photographer", x: -360, y: 220 });
	await workspace.addSystemComponent({ id: "api", kind: "api", name: "Upload API", x: 40, y: 60, serviceId: "svc-upload" });
	await workspace.addSystemComponent({ id: "queue", kind: "queue", name: "Image queue", x: 300, y: 60, serviceId: "svc-upload" });
	await workspace.addSystemComponent({ id: "worker", kind: "worker", name: "Image worker", x: 560, y: 200, serviceId: "svc-processing" });
	await workspace.addSystemComponent({ id: "bucket", kind: "object_storage_bucket", name: "Image bucket", x: 820, y: 200 });
	await workspace.addSystemComponent({ id: "db-primary", kind: "database", name: "Metadata primary", x: 40, y: 340 });
	await workspace.addSystemComponent({ id: "db-replica", kind: "database", name: "Metadata replica", x: 300, y: 340 });
	await workspace.addSystemComponent({ id: "billing-db", kind: "database", name: "Billing database", x: 560, y: 340 });
	await workspace.addSystemComponent({ id: "telemetry", kind: "observability", name: "Telemetry", x: 820, y: 340 });

	await workspace.createSystemDatabaseDesign({ componentId: "db-primary", name: "Metadata" });
	const metadataId = activeDesignId(workspace);
	await workspace.addTable({ name: "images", designId: metadataId });
	await workspace.linkSystemDatabase({ componentId: "db-replica", designId: metadataId });
	await workspace.createScenario({ name: "Record upload", designId: metadataId });
	await workspace.createEdgeFunction({ name: "thumbnail-hook", designId: metadataId });

	await workspace.createSystemDatabaseDesign({ componentId: "billing-db", name: "Billing" });
	const billingId = activeDesignId(workspace);
	await workspace.addTable({ name: "invoices", designId: billingId });
	await workspace.createScenario({ name: "Bill upload", designId: billingId });
	await workspace.openDesign({ designId: metadataId });

	// Duplicate endpoints (client to API twice) and one Service-to-Service Connection.
	await workspace.addSystemConnection({ id: "upload", sourceId: "client", targetId: "api", label: "Upload image" });
	await workspace.addSystemConnection({ id: "poll", sourceId: "client", targetId: "api", label: "Poll status" });
	await workspace.addSystemConnection({ id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueue job" });
	await workspace.addSystemConnection({ id: "dequeue", sourceId: "worker", targetId: "queue", label: "Poll job" });
	await workspace.addSystemConnection({ id: "store", sourceId: "worker", targetId: "bucket", label: "Store variants" });
	await workspace.addSystemConnection({ id: "record", sourceId: "worker", targetId: "db-primary", label: "Record metadata" });
	await workspace.addSystemConnection({ id: "replicate", sourceId: "db-primary", targetId: "db-replica", label: "Replicate" });
	await workspace.addSystemConnection({ id: "bill", sourceId: "worker", targetId: "billing-db", label: "Write invoice" });
	await workspace.addSystemConnection({ id: "emit", sourceId: "worker", targetId: "telemetry", label: "Emit metrics" });
	await workspace.addSystemConnection({ id: "hand-off", sourceId: "svc-upload", targetId: "svc-processing", label: "Hands off jobs" });

	// Overlapping Groups (queue and api sit in two) and a Group nested inside another.
	await workspace.addSystemGroup({ id: "grp-edge", name: "Edge", x: -400, y: 20, width: 220, height: 280, memberIds: ["client", "person"] });
	await workspace.addSystemGroup({ id: "grp-data", name: "Data", x: 20, y: 320, width: 1000, height: 180, memberIds: ["db-primary", "db-replica", "billing-db"] });
	await workspace.addSystemGroup({ id: "grp-hot", name: "Hot path", x: 20, y: 40, width: 480, height: 260, memberIds: ["api", "queue"] });
	await workspace.addSystemGroup({ id: "grp-platform", name: "Platform", x: -20, y: -40, width: 1040, height: 540, memberIds: ["grp-hot", "grp-data", "queue", "svc-processing"] });

	await workspace.createWalkthrough({ id: "wt-upload", name: "Image upload" });
	await workspace.addWalkthroughStep({ id: "s-upload", walkthroughId: "wt-upload", connectionId: "upload", explanation: "The browser uploads the image." });
	await workspace.addWalkthroughStep({ id: "s-enqueue", walkthroughId: "wt-upload", connectionId: "enqueue", explanation: "The API enqueues the job." });
	await workspace.addWalkthroughStep({ id: "s-hand-off", walkthroughId: "wt-upload", connectionId: "hand-off", explanation: "The Upload service hands off to Processing." });
	await workspace.addWalkthroughStep({ id: "s-poll", walkthroughId: "wt-upload", connectionId: "dequeue", explanation: "The worker takes the job." });
	await workspace.addWalkthroughBlock({ id: "fanout", walkthroughId: "wt-upload", kind: "parallel" });
	await workspace.addWalkthroughStep({
		id: "s-store",
		walkthroughId: "wt-upload",
		connectionId: "store",
		explanation: "Variants go to the bucket.",
		sequence: { blockId: "fanout", branch: 0 },
	});
	await workspace.addWalkthroughStep({
		id: "s-record",
		walkthroughId: "wt-upload",
		connectionId: "record",
		explanation: "Metadata is recorded.",
		sequence: { blockId: "fanout", branch: 1 },
	});
	await workspace.addWalkthroughBlock({ id: "retry", walkthroughId: "wt-upload", kind: "repeat" });
	await workspace.updateWalkthroughRepeat({ walkthroughId: "wt-upload", blockId: "retry", count: 3 });
	await workspace.addWalkthroughStep({
		id: "s-retry-store",
		walkthroughId: "wt-upload",
		connectionId: "store",
		explanation: "A failed store is retried.",
		sequence: { blockId: "retry" },
	});
	await workspace.addWalkthroughStep({ id: "s-status", walkthroughId: "wt-upload", connectionId: "poll", explanation: "The browser polls status." });

	return { metadataId, billingId };
}

describe("System design workflow on one offline Project", () => {
	test("the image-upload fixture covers every agreed kind, Design, Group, Connection, and Walkthrough shape", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		const { metadataId, billingId } = await buildImageUploadFixture(workspace);

		const state = workspace.getState();
		const system = state.systemDesign!;
		expect(system.components.map((component) => component.kind)).toEqual([
			"browser",
			"person",
			"api",
			"queue",
			"worker",
			"object_storage_bucket",
			"database",
			"database",
			"database",
			"observability",
		]);
		expect(system.services.map((service) => service.id)).toEqual(["svc-upload", "svc-processing"]);

		// The primary and replica share one Design; the Billing database owns a second.
		const linked = system.components.filter((component) => component.designId !== undefined);
		expect(linked.map((component) => [component.id, component.designId])).toEqual([
			["db-primary", metadataId],
			["db-replica", metadataId],
			["billing-db", billingId],
		]);
		// Every Project starts with one unnamed Design; the two database Designs sit beside it.
		expect(state.designs.map((design) => design.name).sort()).toEqual(["", "Billing", "Metadata"]);

		// Two Connections share the same endpoints, and a Service joins a Service directly.
		const duplicates = system.connections.filter((connection) => connection.sourceId === "client" && connection.targetId === "api");
		expect(duplicates.map((connection) => connection.label)).toEqual(["Upload image", "Poll status"]);
		expect(system.connections.find((connection) => connection.id === "hand-off")).toMatchObject({
			sourceId: "svc-upload",
			targetId: "svc-processing",
		});

		// Groups overlap and nest without changing Service ownership.
		expect(system.groups.map((group) => group.id)).toEqual(["grp-edge", "grp-data", "grp-hot", "grp-platform"]);
		const queueGroups = system.groups.filter((group) => group.memberIds.includes("queue"));
		expect(queueGroups.map((group) => group.id)).toEqual(["grp-hot", "grp-platform"]);
		expect(system.groups.find((group) => group.id === "grp-platform")?.memberIds).toContain("grp-hot");
		expect(system.components.find((component) => component.id === "queue")?.serviceId).toBe("svc-upload");
		expect(system.components.find((component) => component.id === "worker")?.serviceId).toBe("svc-processing");

		const walkthrough = state.walkthroughs?.find((item) => item.id === "wt-upload") as Walkthrough;
		expect(walkthrough.blocks.map((block) => block.kind)).toEqual(["step", "step", "step", "step", "parallel", "repeat", "step"]);
		const parallel = walkthrough.blocks[4] as Extract<Walkthrough["blocks"][number], { kind: "parallel" }>;
		expect(parallel.branches.map((branch) => branch.map((block) => (block.kind === "step" ? block.step.id : block.kind)))).toEqual([["s-store"], ["s-record"]]);
		const repeat = walkthrough.blocks[5] as Extract<Walkthrough["blocks"][number], { kind: "repeat" }>;
		expect(repeat.count).toBe(3);
		const steps = walkthroughSteps(walkthrough);
		expect(steps.every((step) => walkthroughStepStatus(step, system).status === "ok")).toBe(true);
	});

	test("Designs keep Scenarios and Edge functions isolated, and a shared Design is one schema for both database components", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildImageUploadFixture(workspace);
		const exported = await workspace.exportProject();

		const byName = Object.fromEntries(exported.designs.map((design) => [design.name, design]));
		expect(byName.Metadata?.scenarios.map((scenario) => scenario.name)).toEqual(["Record upload"]);
		expect(byName.Metadata?.edgeFunctions.map((edgeFunction) => edgeFunction.name)).toEqual(["thumbnail-hook"]);
		expect(byName.Billing?.scenarios.map((scenario) => scenario.name)).toEqual(["Bill upload"]);
		expect(byName.Billing?.edgeFunctions).toEqual([]);

		// A schema change made through either database component lands in the one Design.
		await workspace.openDesign({ designId: byName.Metadata!.id });
		await workspace.addTable({ name: "thumbnails", designId: byName.Metadata!.id });
		const afterChange = await workspace.exportProject();
		const metadata = afterChange.designs.find((design) => design.name === "Metadata")!;
		expect(metadata.design.tables.map((table) => table.name).sort()).toEqual(["images", "thumbnails"]);
		expect(afterChange.designs.find((design) => design.name === "Billing")!.design.tables.map((table) => table.name)).toEqual(["invoices"]);
	});

	test("all 28 catalog kinds, a Custom component icon, and the generic kind persist through save and reopen", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await first.createProject({ name: "Catalog" });
		expect(CATALOG_KINDS).toHaveLength(28);
		for (const [index, kind] of CATALOG_KINDS.entries()) {
			await first.addSystemComponent({ id: `kind-${kind}`, kind, name: `Kind ${index}`, x: index * 10, y: index * 10 });
		}
		await first.addSystemComponent({ id: "custom", kind: "custom", name: "Custom", icon: "hexagon", x: 0, y: 0 });
		await first.addSystemComponent({ id: "generic", kind: "generic", name: "Generic", x: 0, y: 0 });
		await closeWorkspace(first);

		const reopened = await openWorkspace(databasePath);
		await reopened.openProject({ projectId: reopened.listProjects()[0]!.id });
		const components = reopened.getState().systemDesign!.components;
		const catalogComponents = components.filter((component) => component.id.startsWith("kind-"));
		expect(catalogComponents.map((component) => component.kind)).toEqual([...CATALOG_KINDS]);
		expect(components.find((component) => component.id === "custom")).toMatchObject({ kind: "custom", icon: "hexagon" });
		expect(components.find((component) => component.id === "generic")?.kind).toBe("generic");
	});

	test("focused and collapsed Service presentation, the walkthroughs, and the layout survive save, reopen, and a file round trip", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		const { metadataId } = await buildImageUploadFixture(first);
		await first.setSystemServiceCollapsed({ serviceId: "svc-processing", collapsed: true });
		await first.setSystemFocus({ serviceId: "svc-upload", viewport: { x: 12, y: -8, zoom: 1.25 } });
		await first.setSystemViewport({ x: 4, y: 6, zoom: 0.9 });
		await first.setActiveView({ view: "system" });
		expect(first.getState().systemSave?.status).toBe("saved");
		const projectId = first.getState().project!.id;
		await closeWorkspace(first);

		const reopened = await openWorkspace(databasePath);
		await reopened.openProject({ projectId });
		const restored = reopened.getState();
		expect(restored.systemDesign?.focusedServiceId).toBe("svc-upload");
		expect(restored.systemDesign?.focusViewport).toEqual({ x: 12, y: -8, zoom: 1.25 });
		expect(restored.systemDesign?.collapsedServiceIds).toEqual(["svc-processing"]);
		expect(restored.systemDesign?.viewport).toEqual({ x: 4, y: 6, zoom: 0.9 });
		expect(restored.walkthroughs?.find((item) => item.id === "wt-upload")).toBeDefined();

		// The file carries the same presentation into a fresh Project.
		const file = asFile(await reopened.exportProject());
		const elsewhere = await openWorkspace(databasePathForTest());
		await elsewhere.importProject(file);
		const imported = elsewhere.getState();
		expect(imported.project!.id).not.toBe(projectId);
		expect(imported.systemDesign?.focusedServiceId).toBe("svc-upload");
		expect(imported.systemDesign?.focusViewport).toEqual({ x: 12, y: -8, zoom: 1.25 });
		expect(imported.systemDesign?.collapsedServiceIds).toEqual(["svc-processing"]);
		expect(imported.systemDesign?.components).toHaveLength(restored.systemDesign!.components.length);
		expect(imported.systemDesign?.groups.map((group) => group.id)).toEqual(restored.systemDesign?.groups.map((group) => group.id));
		const importedWalkthrough = imported.walkthroughs?.find((item) => item.id === "wt-upload") as Walkthrough;
		expect(walkthroughSteps(importedWalkthrough).map((step) => step.id)).toEqual(walkthroughSteps(restored.walkthroughs!.find((item) => item.id === "wt-upload")!).map((step) => step.id));

		// The imported Databases keep the shared Design link under the new identity.
		const importedLinks = imported.systemDesign!.components.filter((component) => component.designId !== undefined);
		expect(importedLinks.map((component) => component.id)).toEqual(["db-primary", "db-replica", "billing-db"]);
		expect(importedLinks[0]!.designId).toBe(importedLinks[1]!.designId);
		expect(importedLinks[0]!.designId).not.toBe(metadataId);
	});

	test("an unfinished Walkthrough repair survives the file round trip and the step is marked, not dropped", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildImageUploadFixture(workspace);
		await workspace.removeSystemConnection({ connectionId: "poll" });
		const dangling = workspace.getState().walkthroughs!.find((item) => item.id === "wt-upload")!;
		const danglingStep = walkthroughSteps(dangling).find((step) => step.id === "s-status")!;
		expect(walkthroughStepStatus(danglingStep, workspace.getState().systemDesign!).status).toBe("dangling");

		const file = asFile(await workspace.exportProject());
		const elsewhere = await openWorkspace(databasePathForTest());
		await elsewhere.importProject(file);
		const imported = elsewhere.getState();
		const importedWalkthrough = imported.walkthroughs!.find((item) => item.id === "wt-upload")!;
		const importedStep = walkthroughSteps(importedWalkthrough).find((step) => step.id === "s-status")!;
		expect(importedStep.explanation).toBe("The browser polls status.");
		expect(walkthroughStepStatus(importedStep, imported.systemDesign!).status).toBe("dangling");
	});

	test("the System design SVG export draws the overview with every Component, and a focused Service with its connected context", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildImageUploadFixture(workspace);
		const system = workspace.getState().systemDesign!;

		const overview = systemDesignSvg(system, { title: "Image upload" });
		expect(overview.startsWith('<?xml version="1.0"')).toBe(true);
		expect(overview).toContain("<svg");
		for (const component of system.components) expect(overview).toContain(component.name);
		expect(overview).not.toContain("var(--color-");

		// Focus keeps the Service's contents and what it connects to; unrelated Components leave the drawing.
		await workspace.setSystemFocus({ serviceId: "svc-upload" });
		const focused = systemDesignSvg(workspace.getState().systemDesign!, { title: "Image upload" });
		expect(focused).toContain("Upload API");
		expect(focused).toContain("Browser");
		expect(focused).toContain("Image worker");
		expect(focused).not.toContain("Photographer");
	});

	test("System design edits undo and redo as one Project-wide history while focus and collapse stay outside it", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await buildImageUploadFixture(workspace);
		const designId = activeDesignId(workspace);
		await workspace.moveSystemComponent({ componentId: "bucket", x: 900, y: 220 });
		await workspace.setSystemServiceCollapsed({ serviceId: "svc-upload", collapsed: true });
		await workspace.setSystemFocus({ serviceId: "svc-processing" });

		await workspace.undo({ designId });
		expect(workspace.getState().systemDesign?.components.find((component) => component.id === "bucket")?.position).toEqual({ x: 820, y: 200 });
		expect(workspace.getState().systemDesign?.focusedServiceId).toBe("svc-processing");
		expect(workspace.getState().systemDesign?.collapsedServiceIds).toEqual(["svc-upload"]);

		await workspace.redo({ designId });
		expect(workspace.getState().systemDesign?.components.find((component) => component.id === "bucket")?.position).toEqual({ x: 900, y: 220 });
	});
});

/** A scripted Assistant over a small architecture: a Browser, an API, a queue, and a Metadata database. */
async function assistantProject(name: string) {
	const databasePath = databasePathForTest();
	const workspace = await openWorkspace(databasePath);
	const state = await workspace.createProject({ name });
	if (!state.project) throw new Error("Expected the project to be open.");
	await workspace.addSystemComponent({ id: "client", kind: "browser", name: "Browser", x: 0, y: 0 });
	await workspace.addSystemComponent({ id: "api", kind: "api", name: "Upload API", x: 300, y: 0 });
	await workspace.addSystemConnection({ id: "upload", sourceId: "client", targetId: "api", label: "Upload image" });
	await workspace.addSystemComponent({ id: "metadata", kind: "database", name: "Metadata", x: 600, y: 0 });
	await workspace.createSystemDatabaseDesign({ componentId: "metadata", name: "Metadata" });

	const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
	const models = createModels();
	models.setProvider(scripted.provider);
	const runtime = createAssistantRuntime({ databasePath, workspace, models, getApiKey: async () => "test-key" });
	runtimes.push(runtime);
	const conversation = runtime.createConversation(state.project.id);
	return { workspace, runtime, scripted, conversation };
}

/** One Assistant request adds a worker, its Connections, a schema change, and a Walkthrough with a parallel block and a retry. */
function workerTurnResponses(scripted: ReturnType<typeof fauxProvider>) {
	scripted.setResponses([
		fauxAssistantMessage([fauxToolCall("read_project", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read_system_design", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read_walkthroughs", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("edit_system_design", {
				operations: [
					{ op: "add_component", id: "worker", name: "Image worker", kind: "worker", x: 300, y: 160 },
					{ op: "add_connection", id: "dequeue", sourceId: "worker", targetId: "api", label: "Takes job", interactionType: "Synchronous request" },
					{ op: "add_connection", id: "record", sourceId: "worker", targetId: "metadata", label: "Records metadata" },
				],
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("apply_ddl", { sql: "CREATE TABLE variants (id uuid PRIMARY KEY, image_id uuid NOT NULL);" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("edit_walkthroughs", {
				operations: [
					{ op: "create_walkthrough", id: "process", name: "Image processing" },
					{ op: "add_step", id: "s-take", walkthroughId: "process", connectionId: "dequeue", title: "Take job", action: "receive", explanation: "The worker takes the job." },
					{ op: "add_block", id: "fanout", walkthroughId: "process", kind: "parallel" },
					{ op: "add_step", id: "s-record", walkthroughId: "process", connectionId: "record", title: "Record", action: "process", sequence: { blockId: "fanout", branch: 0 }, explanation: "Metadata is recorded." },
					{ op: "add_step", id: "s-take-again", walkthroughId: "process", connectionId: "dequeue", title: "Retry", action: "receive", sequence: { blockId: "fanout", branch: 1 }, explanation: "The take is retried." },
				],
			}),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("Added the worker, its Connections, the variants table, and the processing Walkthrough.")]),
	]);
}

describe("One Assistant turn across architecture, schema, and Walkthroughs", () => {
	test("Revert undoes the whole turn: Components, Connections, schema, and the Walkthrough", async () => {
		const { workspace, runtime, scripted, conversation } = await assistantProject("Worker turn");
		const before = snapshot(await workspace.exportProject());
		workerTurnResponses(scripted);

		await runtime.sendMessage(conversation.id, "Add an image worker and show how it processes.", "scripted-model");

		const during = workspace.getState();
		expect(during.systemDesign?.components.map((component) => component.id)).toEqual(["client", "api", "metadata", "worker"]);
		expect(during.design?.tables.map((table) => table.name)).toEqual(["variants"]);
		expect(during.walkthroughs?.map((item) => item.id)).toEqual(["process"]);
		expect(during.systemDesign?.connections.find((connection) => connection.id === "dequeue")?.interactionType).toBe("Synchronous request");

		await runtime.revertTurn(conversation.id);

		const after = workspace.getState();
		expect(after.systemDesign?.components.map((component) => component.id)).toEqual(["client", "api", "metadata"]);
		expect(after.systemDesign?.connections.map((connection) => connection.id)).toEqual(["upload"]);
		expect(after.design?.tables).toEqual([]);
		expect(after.walkthroughs ?? []).toEqual([]);
		expect(snapshot(await workspace.exportProject())).toEqual(before);
	});

	test("Revert is refused with the conflicting Component named when a designer renamed it after the turn", async () => {
		const { workspace, runtime, scripted, conversation } = await assistantProject("Worker conflict");
		workerTurnResponses(scripted);
		await runtime.sendMessage(conversation.id, "Add an image worker and show how it processes.", "scripted-model");

		await workspace.updateSystemComponent({ componentId: "worker", changes: { name: "Renamed worker" } });

		await expect(runtime.revertTurn(conversation.id)).rejects.toThrow(
			'Cannot revert Assistant turn due to conflicting items: Component "Image worker" was modified after this Assistant turn',
		);
		expect(workspace.getState().systemDesign?.components.find((component) => component.id === "worker")?.name).toBe("Renamed worker");
		expect(workspace.getState().walkthroughs?.map((item) => item.id)).toEqual(["process"]);
	});
});
