import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	walkthroughStepStatus,
	type Walkthrough,
	walkthroughSteps,
} from "../shared/walkthrough";
import { compileWalkthroughPlayback } from "../shared/walkthrough-playback";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { openDesignStore, type DesignStore } from "./store";

const openWorkspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const workspace of openWorkspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databasePathForTest(): string {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-walkthroughs-"));
	temporaryDirectories.push(directory);
	return join(directory, "designs.sqlite");
}

async function openWorkspace(databasePath: string, options: { failWalkthroughSaves?: { remaining: number } } = {}) {
	const workspace = await createDesignWorkspace({
		databasePath,
		openStore: (path) => {
			const store: DesignStore = openDesignStore(path);
			if (!options.failWalkthroughSaves) return store;
			return {
				...store,
				saveWalkthroughs(projectId, walkthroughs, save) {
					if (options.failWalkthroughSaves!.remaining > 0) {
						options.failWalkthroughSaves!.remaining -= 1;
						throw new Error("simulated Walkthrough write failure");
					}
					return store.saveWalkthroughs(projectId, walkthroughs, save);
				},
			};
		},
	});
	openWorkspaces.push(workspace);
	return workspace;
}

function activeDesign(workspace: DesignWorkspace) {
	return workspace.getState().activeDesignId!;
}

/** Client → API → Queue, with an upload and an enqueue Connection, opened in a new Project. */
async function openImageUploadProject(workspace: DesignWorkspace) {
	await workspace.createProject({ name: "Image upload" });
	await workspace.addSystemComponent({ id: "client", name: "Browser", x: 0, y: 0 });
	await workspace.addSystemComponent({ id: "api", name: "API", x: 300, y: 0 });
	await workspace.addSystemComponent({ id: "queue", name: "Queue", x: 600, y: 0 });
	await workspace.addSystemConnection({ id: "upload", sourceId: "client", targetId: "api", label: "Upload" });
	await workspace.addSystemConnection({ id: "enqueue", sourceId: "api", targetId: "queue", label: "Enqueue" });
}

function walkthroughsOf(workspace: DesignWorkspace): Walkthrough[] {
	return workspace.getState().walkthroughs ?? [];
}

function statusOf(workspace: DesignWorkspace, walkthroughId: string, stepId: string) {
	const state = workspace.getState();
	const step = walkthroughSteps(walkthroughsOf(workspace).find((walkthrough) => walkthrough.id === walkthroughId)!).find((item) => item.id === stepId)!;
	return walkthroughStepStatus(step, state.systemDesign!);
}

describe("Walkthrough workspace", () => {
	test("named Walkthroughs and their steps save, reopen, and keep their references", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await openImageUploadProject(first);
		await first.createWalkthrough({ id: "w-upload", name: "Image upload" });
		await first.createWalkthrough({ id: "w-read", name: "Cached read" });
		await first.addWalkthroughStep({ id: "s1", walkthroughId: "w-upload", connectionId: "upload", explanation: "Browser posts the file." });
		await first.addWalkthroughStep({ id: "s2", walkthroughId: "w-upload", connectionId: "enqueue", title: "Queue the job", action: "send", durationMs: 800 });
		await first.updateWalkthroughStep({
			walkthroughId: "w-upload",
			stepId: "s2",
			changes: { exampleMessage: "{\"job\":\"resize\"}", operation: "enqueue" },
		});
		await first.moveWalkthroughStep({ walkthroughId: "w-upload", stepId: "s2", toIndex: 0 });
		await first.moveWalkthrough({ walkthroughId: "w-read", toIndex: 0 });
		await first.renameWalkthrough({ walkthroughId: "w-upload", name: "Upload an image" });
		expect(first.getState().walkthroughSave?.status).toBe("saved");
		const before = walkthroughsOf(first);
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		expect(walkthroughsOf(reopened)).toEqual(before);
		expect(walkthroughsOf(reopened).map((walkthrough) => walkthrough.name)).toEqual(["Cached read", "Upload an image"]);
		const upload = walkthroughsOf(reopened).find((walkthrough) => walkthrough.id === "w-upload")!;
		expect(walkthroughSteps(upload).map((step) => step.id)).toEqual(["s2", "s1"]);
		expect(walkthroughSteps(upload)[0]).toMatchObject({
			connectionId: "enqueue",
			route: { sourceId: "api", targetId: "queue" },
			title: "Queue the job",
			durationMs: 800,
			exampleMessage: "{\"job\":\"resize\"}",
			operation: "enqueue",
		});
		expect(statusOf(reopened, "w-upload", "s1")).toEqual({ status: "ok" });
		expect(reopened.getState().walkthroughSave?.status).toBe("saved");
	});

	test("each Walkthrough edit is one named Project-history action and typed explanations group into one", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		expect(workspace.getState().undoActionName).toBe("Add walkthrough “Upload”");

		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload" });
		expect(workspace.getState().undoActionName).toBe("Add step “Upload”");

		await workspace.updateWalkthroughStep({ walkthroughId: "w", stepId: "s", changes: { explanation: "Browser" } });
		await workspace.updateWalkthroughStep({ walkthroughId: "w", stepId: "s", changes: { explanation: "Browser sends the file" } });
		expect(workspace.getState().undoActionName).toBe("Edit step “Upload”");

		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!)[0]!.explanation).toBe("");
		expect(workspace.getState().undoActionName).toBe("Add step “Upload”");
		expect(workspace.getState().redoActionName).toBe("Edit step “Upload”");
	});

	test("removing a Connection keeps the step as dangling, and Undo restores the Connection and the step's status", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", explanation: "Upload it" });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue" });

		await workspace.removeSystemConnection({ connectionId: "upload" });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!).map((step) => step.id)).toEqual(["s", "t"]);
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "dangling" });
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "ok" });

		await workspace.undo({ designId: activeDesign(workspace) });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });
		expect(workspace.getState().systemDesign?.connections.map((connection) => connection.id)).toEqual(["upload", "enqueue"]);

		await workspace.redo({ designId: activeDesign(workspace) });
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(databasePath);
		expect(statusOf(reopened, "w", "s")).toEqual({ status: "dangling" });
		expect(walkthroughSteps(walkthroughsOf(reopened)[0]!)[0]!.explanation).toBe("Upload it");
	});

	test("removing a Component keeps its steps and renaming a Component keeps the references", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload" });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue" });

		await workspace.updateSystemComponent({ componentId: "api", changes: { name: "Gateway" } });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });

		await workspace.removeSystemComponent({ componentId: "api" });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!).map((step) => step.id)).toEqual(["s", "t"]);
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "dangling" });
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "dangling" });
	});

	test("repairing a step relinks it or accepts a redirected route as one named action", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", title: "Send" });
		await workspace.removeSystemConnection({ connectionId: "upload" });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "dangling" });

		await workspace.repairWalkthroughStep({ walkthroughId: "w", stepId: "s", connectionId: "enqueue" });
		expect(workspace.getState().undoActionName).toBe("Relink step “Send”");
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!)[0]).toMatchObject({ connectionId: "enqueue", route: { sourceId: "api", targetId: "queue" } });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });

		await workspace.updateSystemConnection({ connectionId: "enqueue", changes: { label: "Publish" } });
		await workspace.updateSystemConnection({ connectionId: "enqueue", changes: { sourceId: "client" } });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "redirected", sourceId: "client", targetId: "queue" });

		await workspace.repairWalkthroughStep({ walkthroughId: "w", stepId: "s", connectionId: "enqueue" });
		expect(workspace.getState().undoActionName).toBe("Accept route for step “Send”");
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!)[0]!.title).toBe("Send");
	});

	test("removal impact names the affected steps of every Walkthrough before anything changes", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.addSystemService({ id: "edge", name: "Edge", x: 0, y: 220 });
		await workspace.addSystemConnection({ id: "serve", sourceId: "edge", targetId: "client", label: "Serve" });
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.createWalkthrough({ id: "v", name: "Serve" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", title: "Send", explanation: "Browser posts." });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue", title: "Queue" });
		await workspace.addWalkthroughStep({ id: "u", walkthroughId: "v", connectionId: "serve", title: "Serve it" });

		const names = (impact: { walkthroughSteps: Array<{ walkthroughName: string; stepId: string }> }) =>
			impact.walkthroughSteps.map((step) => `${step.walkthroughName}:${step.stepId}`);
		const apiImpact = workspace.describeSystemComponentRemoval("api");
		expect(apiImpact.connections.map((connection) => connection.id)).toEqual(["upload", "enqueue"]);
		expect(names(apiImpact)).toEqual(["Upload:s", "Upload:t"]);
		expect(names(workspace.describeSystemComponentRemoval("client"))).toEqual(["Upload:s", "Serve:u"]);
		expect(names(workspace.describeSystemServiceRemoval("edge"))).toEqual(["Serve:u"]);
		expect(names(workspace.describeSystemConnectionRemoval("enqueue"))).toEqual(["Upload:t"]);
		expect(workspace.describeSystemConnectionRemoval("enqueue").connectionLabel).toBe("Enqueue");
		expect(names(workspace.describeSystemConnectionRemoval("serve"))).toEqual(["Serve:u"]);
		expect(names(workspace.describeSystemConnectionRemoval("upload"))).toEqual(["Upload:s"]);
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "ok" });

		await workspace.removeSystemComponent({ componentId: "api" });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!).map((step) => step.id)).toEqual(["s", "t"]);
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!)[0]!.explanation).toBe("Browser posts.");
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "dangling" });
		expect(statusOf(workspace, "v", "u")).toEqual({ status: "ok" });
		expect(names(workspace.describeSystemServiceRemoval("edge"))).toEqual(["Serve:u"]);
	});

	test("an unaffected Walkthrough stays playable while the affected one is blocked until its step is repaired", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.addSystemService({ id: "edge", name: "Edge", x: 0, y: 220 });
		await workspace.addSystemConnection({ id: "serve", sourceId: "edge", targetId: "client", label: "Serve" });
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.createWalkthrough({ id: "v", name: "Serve" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", title: "Send" });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue", title: "Queue" });
		await workspace.addWalkthroughStep({ id: "u", walkthroughId: "v", connectionId: "serve", title: "Serve it" });

		await workspace.removeSystemConnection({ connectionId: "enqueue" });
		const playable = (id: string) => {
			const design = workspace.getState().systemDesign!;
			const walkthrough = walkthroughsOf(workspace).find((item) => item.id === id)!;
			return compileWalkthroughPlayback(walkthrough, design).ok;
		};
		expect(playable("w")).toBe(false);
		expect(playable("v")).toBe(true);

		await workspace.repairWalkthroughStep({ walkthroughId: "w", stepId: "t", connectionId: "serve" });
		expect(playable("w")).toBe(true);
	});

	test("a redirected step needs an explicit acceptance, recorded as one named action that Undo reverses", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", title: "Send" });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue", title: "Queue", explanation: "Work is queued." });

		// Keeping the Connection id is not enough once its endpoints change.
		await workspace.updateSystemConnection({ connectionId: "enqueue", changes: { sourceId: "client" } });
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "redirected", sourceId: "client", targetId: "queue" });
		await expect(workspace.acceptWalkthroughStepRedirection({ walkthroughId: "w", stepId: "s" })).rejects.toThrow(
			"This step does not run a changed route to accept.",
		);

		await workspace.acceptWalkthroughStepRedirection({ walkthroughId: "w", stepId: "t" });
		expect(workspace.getState().undoActionName).toBe("Accept route for step “Queue”");
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "ok" });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!)[1]).toMatchObject({
			connectionId: "enqueue",
			route: { sourceId: "client", targetId: "queue" },
			explanation: "Work is queued.",
		});

		await workspace.undo({ designId: activeDesign(workspace) });
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "redirected", sourceId: "client", targetId: "queue" });
	});

	test("renaming and moving architecture keeps every step's reference without repair", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload" });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue" });

		await workspace.updateSystemComponent({ componentId: "queue", changes: { name: "Broker" } });
		await workspace.moveSystemComponent({ componentId: "queue", x: 900, y: 140 });
		await workspace.moveSystemComponent({ componentId: "api", x: 320, y: 40 });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });
		expect(statusOf(workspace, "w", "t")).toEqual({ status: "ok" });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!).map((step) => step.route)).toEqual([
			{ sourceId: "client", targetId: "api" },
			{ sourceId: "api", targetId: "queue" },
		]);
	});

	test("refused repairs and unknown Connections change nothing", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload" });
		const before = walkthroughsOf(workspace);

		await expect(workspace.repairWalkthroughStep({ walkthroughId: "w", stepId: "s", connectionId: "missing" })).rejects.toThrow(
			"Choose a Connection from the System design to repair this step.",
		);
		await expect(workspace.addWalkthroughStep({ walkthroughId: "w", connectionId: "missing" })).rejects.toThrow(
			"Choose a Connection from the System design for this step.",
		);
		await expect(workspace.updateWalkthroughStep({ walkthroughId: "w", stepId: "nope", changes: { title: "x" } })).rejects.toThrow(
			"That step could not be found.",
		);
		expect(walkthroughsOf(workspace)).toEqual(before);
	});

	test("Undo and Redo restore Walkthroughs together with the System design they reference", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload" });
		await workspace.addWalkthroughStep({ id: "t", walkthroughId: "w", connectionId: "enqueue" });
		await workspace.renameWalkthrough({ walkthroughId: "w", name: "Upload path" });
		await workspace.moveWalkthroughStep({ walkthroughId: "w", stepId: "t", toIndex: 0 });

		expect(workspace.getState().undoActionName).toBe("Move step “Enqueue”");
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!).map((step) => step.id)).toEqual(["s", "t"]);
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace)[0]!.name).toBe("Upload");
		await workspace.undo({ designId: activeDesign(workspace) });
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!)).toEqual([]);
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace)).toEqual([]);
		expect(workspace.getState().undoRedo.canUndo).toBe(true);

		await workspace.redo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace).map((walkthrough) => walkthrough.name)).toEqual(["Upload"]);
	});

	test("parallel and repeated blocks persist with their steps, and replay after reopening", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await openImageUploadProject(first);
		await first.createWalkthrough({ id: "w", name: "Concurrent retry" });
		await first.addWalkthroughBlock({ id: "p", walkthroughId: "w", kind: "parallel" });
		await first.addWalkthroughStep({ id: "a", walkthroughId: "w", connectionId: "upload", title: "Upload", sequence: { blockId: "p", branch: 0 } });
		await first.addWalkthroughStep({ id: "b", walkthroughId: "w", connectionId: "enqueue", title: "Queue", sequence: { blockId: "p", branch: 1 } });
		await first.addWalkthroughParallelBranch({ walkthroughId: "w", blockId: "p" });
		await first.addWalkthroughBlock({ id: "r", walkthroughId: "w", kind: "repeat" });
		await first.updateWalkthroughRepeat({ walkthroughId: "w", blockId: "r", count: 3 });
		await first.addWalkthroughStep({
			id: "attempt",
			walkthroughId: "w",
			connectionId: "upload",
			title: "Attempt fails",
			action: "fail",
			durationMs: 800,
			sequence: { blockId: "r" },
		});
		await first.addWalkthroughStep({ id: "ok", walkthroughId: "w", connectionId: "upload", title: "Succeeds", action: "succeed", durationMs: 800 });
		await first.moveWalkthroughBlock({ walkthroughId: "w", blockId: "r", toIndex: 0 });
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		const walkthrough = walkthroughsOf(reopened)[0]!;
		expect(walkthrough.blocks.map((block) => block.kind)).toEqual(["repeat", "parallel", "step"]);
		expect(walkthroughSteps(walkthrough).map((step) => step.id)).toEqual(["attempt", "a", "b", "ok"]);
		const parallel = walkthrough.blocks[1]!;
		expect(parallel.kind === "parallel" ? parallel.branches.map((branch) => branch.length) : []).toEqual([1, 1, 0]);

		const compiled = compileWalkthroughPlayback(walkthrough, reopened.getState().systemDesign!);
		expect(compiled.ok).toBe(true);
		if (compiled.ok) {
			expect(compiled.timeline.steps.map((step) => [step.stepId, step.startMs, step.repetition?.iteration ?? null])).toEqual([
				["attempt", 0, 1],
				["attempt", 800, 2],
				["attempt", 1600, 3],
				["a", 2400, null],
				["b", 2400, null],
				["ok", 3600, null],
			]);
			expect(compiled.timeline.totalMs).toBe(4400);
		}
		await reopened.removeSystemConnection({ connectionId: "enqueue" });
		expect(walkthroughStepStatus(walkthroughSteps(walkthroughsOf(reopened)[0]!)[2]!, reopened.getState().systemDesign!)).toEqual({ status: "dangling" });
	});

	test("a failed Walkthrough save keeps the draft and the next successful save writes it", async () => {
		const databasePath = databasePathForTest();
		const failures = { remaining: 1 };
		const workspace = await openWorkspace(databasePath, { failWalkthroughSaves: failures });
		await openImageUploadProject(workspace);
		const failed = await workspace.createWalkthrough({ id: "w", name: "Draft" });
		expect(failed.walkthroughSave?.status).toBe("failed");
		expect(failed.walkthroughs?.map((walkthrough) => walkthrough.name)).toEqual(["Draft"]);

		const recovered = await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", explanation: "Kept" });
		expect(recovered.walkthroughSave?.status).toBe("saved");
		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);

		const reopened = await openWorkspace(databasePath);
		expect(walkthroughsOf(reopened)).toEqual([
			expect.objectContaining({
				id: "w",
				name: "Draft",
				blocks: [expect.objectContaining({ kind: "step", step: expect.objectContaining({ id: "s", explanation: "Kept" }) })],
			}),
		]);
	});

	test("an existing Project without Walkthroughs opens with none and nothing marked as saved", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await first.createProject({ name: "Legacy" });
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const raw = new Database(databasePath);
		raw.run("DELETE FROM walkthrough_documents");
		raw.close();

		const migrated = await openWorkspace(databasePath);
		expect(migrated.getState().walkthroughs).toEqual([]);
		expect(migrated.getState().walkthroughSave).toEqual({ status: "idle" });
	});

	test("a repairable draft reopens with its dangling step visible, while malformed stored Walkthroughs refuse to open", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await openImageUploadProject(first);
		await first.createWalkthrough({ id: "w", name: "Draft" });
		await first.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload" });
		await first.removeSystemConnection({ connectionId: "upload" });
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		expect(statusOf(reopened, "w", "s")).toEqual({ status: "dangling" });
		await reopened.close();
		openWorkspaces.splice(openWorkspaces.indexOf(reopened), 1);

		const raw = new Database(databasePath);
		raw.run(`UPDATE walkthrough_documents SET document = ?`, [JSON.stringify([{
			id: "w",
			name: "Broken",
			steps: [{ id: "s", route: { sourceId: "a", targetId: "b" }, title: "", explanation: "", action: "explode" }],
		}])]);
		raw.close();
		await expect(openWorkspace(databasePath)).rejects.toThrow("Step connection is required.");
	});

	test("switching database designs keeps the Project's Walkthroughs and System design, and they save with the Project", async () => {
		const databasePath = databasePathForTest();
		const workspace = await openWorkspace(databasePath);
		await openImageUploadProject(workspace);
		await workspace.createWalkthrough({ id: "w", name: "Upload" });
		await workspace.addWalkthroughStep({ id: "s", walkthroughId: "w", connectionId: "upload", explanation: "Kept" });
		const firstDesign = activeDesign(workspace);

		await workspace.createDesign({ name: "Billing" });
		expect(activeDesign(workspace)).not.toBe(firstDesign);
		expect(workspace.getState().systemDesign?.connections.map((connection) => connection.id)).toEqual(["upload", "enqueue"]);
		expect(walkthroughSteps(walkthroughsOf(workspace)[0]!).map((step) => step.id)).toEqual(["s"]);

		await workspace.createWalkthrough({ id: "w2", name: "Billing run" });
		await workspace.openDesign({ designId: firstDesign });
		expect(walkthroughsOf(workspace).map((walkthrough) => walkthrough.name)).toEqual(["Upload", "Billing run"]);
		expect(workspace.getState().systemDesign?.components).toHaveLength(3);

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(databasePath);
		expect(walkthroughsOf(reopened).map((walkthrough) => walkthrough.name)).toEqual(["Upload", "Billing run"]);
		expect(walkthroughSteps(walkthroughsOf(reopened)[0]!)[0]!.explanation).toBe("Kept");
	});

	test("Walkthrough edits are refused when no Project is open", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await expect(workspace.createWalkthrough({ name: "Orphan" })).rejects.toThrow("Open a project before editing its System design.");
		expect(walkthroughsOf(workspace)).toEqual([]);
	});
});

describe("client and traffic Components in a Project", () => {
	test("all nine kinds are created, edited, connected, saved, reopened, and played in a named Walkthrough with operations", async () => {
		const databasePath = databasePathForTest();
		const first = await openWorkspace(databasePath);
		await first.createProject({ name: "Cached catalog" });
		const kinds = [
			["person", "Shopper"],
			["browser", "Web app"],
			["mobile_app", "Mobile app"],
			["external_system", "Payments"],
			["dns", "Public DNS"],
			["cdn", "Edge cache"],
			["load_balancer", "Balancer"],
			["api_gateway", "Gateway"],
			["proxy", "Egress proxy"],
		] as const;
		for (const [index, [kind, name]] of kinds.entries()) {
			await first.addSystemComponent({ id: kind, kind, name, x: index * 220, y: 0 });
		}
		await first.updateSystemComponent({
			componentId: "dns",
			changes: {
				technology: "Route 53",
				properties: [{ key: "Zone", value: "example.com" }, { key: "Record description", value: "A record to the balancer" }],
			},
		});
		await first.updateSystemComponent({ componentId: "mobile_app", changes: { name: "Mobile client", properties: [{ key: "Platform", value: "iOS" }] } });
		await first.addSystemConnection({ id: "lookup", sourceId: "browser", targetId: "dns", label: "Resolve" });
		await first.addSystemConnection({ id: "fetch", sourceId: "browser", targetId: "cdn", label: "Request asset" });
		await first.addSystemConnection({ id: "miss", sourceId: "cdn", targetId: "load_balancer", label: "Origin fetch" });
		await first.addSystemConnection({ id: "call", sourceId: "mobile_app", targetId: "api_gateway", label: "API call" });
		await first.addSystemConnection({ id: "egress", sourceId: "proxy", targetId: "external_system", label: "Outbound call" });
		await first.createWalkthrough({ id: "w-cached", name: "Cached asset" });
		await first.addWalkthroughStep({ id: "s-lookup", walkthroughId: "w-cached", connectionId: "lookup" });
		await first.addWalkthroughStep({ id: "s-hit", walkthroughId: "w-cached", connectionId: "fetch", action: "succeed" });
		await first.updateWalkthroughStep({ walkthroughId: "w-cached", stepId: "s-hit", changes: { operation: "cache hit" } });
		await first.addWalkthroughStep({ id: "s-miss", walkthroughId: "w-cached", connectionId: "miss", action: "send" });
		await first.updateWalkthroughStep({ walkthroughId: "w-cached", stepId: "s-miss", changes: { operation: "cache miss" } });
		await first.addWalkthroughStep({ id: "s-limit", walkthroughId: "w-cached", connectionId: "call", action: "fail" });
		await first.updateWalkthroughStep({ walkthroughId: "w-cached", stepId: "s-limit", changes: { operation: "rate limited" } });
		expect(first.getState().walkthroughSave?.status).toBe("saved");
		expect(first.getState().undoActionName).toBe("Edit step “API call”");
		const before = { design: first.getState().systemDesign, walkthroughs: walkthroughsOf(first) };
		await first.close();
		openWorkspaces.splice(openWorkspaces.indexOf(first), 1);

		const reopened = await openWorkspace(databasePath);
		expect(reopened.getState().systemDesign).toEqual(before.design);
		expect(walkthroughsOf(reopened)).toEqual(before.walkthroughs);
		expect(reopened.getState().systemDesign!.components.map((component) => component.kind)).toEqual(kinds.map(([kind]) => kind));
		expect(reopened.getState().systemDesign!.components.find((component) => component.id === "dns")).toMatchObject({
			technology: "Route 53",
			properties: [{ key: "Zone", value: "example.com" }, { key: "Record description", value: "A record to the balancer" }],
		});
		expect(reopened.getState().systemDesign!.components.find((component) => component.id === "mobile_app")?.name).toBe("Mobile client");
		const walkthrough = walkthroughsOf(reopened).find((item) => item.id === "w-cached")!;
		const steps = walkthroughSteps(walkthrough);
		expect(steps.map((step) => step.operation)).toEqual([undefined, "cache hit", "cache miss", "rate limited"]);
		for (const step of steps) expect(walkthroughStepStatus(step, reopened.getState().systemDesign!)).toEqual({ status: "ok" });
		expect(compileWalkthroughPlayback(walkthrough, reopened.getState().systemDesign!).ok).toBe(true);
	});

	test("a client or traffic Component's kind change and its added step are each one undoable Project action", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await workspace.createProject({ name: "Kinds" });
		await workspace.addSystemComponent({ id: "edge", kind: "cdn", name: "Edge", x: 0, y: 0 });
		await workspace.addSystemComponent({ id: "origin", name: "Origin", x: 300, y: 0 });
		await workspace.addSystemConnection({ id: "serve", sourceId: "edge", targetId: "origin", label: "Fetch" });
		await workspace.updateSystemComponent({ componentId: "edge", changes: { kind: "proxy" } });
		expect(workspace.getState().systemDesign!.components.find((component) => component.id === "edge")?.kind).toBe("proxy");
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(workspace.getState().systemDesign!.components.find((component) => component.id === "edge")?.kind).toBe("cdn");
	});
});
