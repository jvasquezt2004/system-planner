import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkthroughStepStatus, type Walkthrough } from "../shared/walkthrough";
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
	const step = walkthroughsOf(workspace).find((walkthrough) => walkthrough.id === walkthroughId)!.steps.find((item) => item.id === stepId)!;
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
		expect(upload.steps.map((step) => step.id)).toEqual(["s2", "s1"]);
		expect(upload.steps[0]).toMatchObject({
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
		expect(walkthroughsOf(workspace)[0]!.steps[0]!.explanation).toBe("");
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
		expect(walkthroughsOf(workspace)[0]!.steps.map((step) => step.id)).toEqual(["s", "t"]);
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
		expect(walkthroughsOf(reopened)[0]!.steps[0]!.explanation).toBe("Upload it");
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
		expect(walkthroughsOf(workspace)[0]!.steps.map((step) => step.id)).toEqual(["s", "t"]);
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
		expect(walkthroughsOf(workspace)[0]!.steps[0]).toMatchObject({ connectionId: "enqueue", route: { sourceId: "api", targetId: "queue" } });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });

		await workspace.updateSystemConnection({ connectionId: "enqueue", changes: { label: "Publish" } });
		await workspace.updateSystemConnection({ connectionId: "enqueue", changes: { sourceId: "client" } });
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "redirected", sourceId: "client", targetId: "queue" });

		await workspace.repairWalkthroughStep({ walkthroughId: "w", stepId: "s", connectionId: "enqueue" });
		expect(workspace.getState().undoActionName).toBe("Accept route for step “Send”");
		expect(statusOf(workspace, "w", "s")).toEqual({ status: "ok" });
		expect(walkthroughsOf(workspace)[0]!.steps[0]!.title).toBe("Send");
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
		expect(walkthroughsOf(workspace)[0]!.steps.map((step) => step.id)).toEqual(["s", "t"]);
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace)[0]!.name).toBe("Upload");
		await workspace.undo({ designId: activeDesign(workspace) });
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace)[0]!.steps).toEqual([]);
		await workspace.undo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace)).toEqual([]);
		expect(workspace.getState().undoRedo.canUndo).toBe(true);

		await workspace.redo({ designId: activeDesign(workspace) });
		expect(walkthroughsOf(workspace).map((walkthrough) => walkthrough.name)).toEqual(["Upload"]);
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
			expect.objectContaining({ id: "w", name: "Draft", steps: [expect.objectContaining({ id: "s", explanation: "Kept" })] }),
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
		expect(walkthroughsOf(workspace)[0]!.steps.map((step) => step.id)).toEqual(["s"]);

		await workspace.createWalkthrough({ id: "w2", name: "Billing run" });
		await workspace.openDesign({ designId: firstDesign });
		expect(walkthroughsOf(workspace).map((walkthrough) => walkthrough.name)).toEqual(["Upload", "Billing run"]);
		expect(workspace.getState().systemDesign?.components).toHaveLength(3);

		await workspace.close();
		openWorkspaces.splice(openWorkspaces.indexOf(workspace), 1);
		const reopened = await openWorkspace(databasePath);
		expect(walkthroughsOf(reopened).map((walkthrough) => walkthrough.name)).toEqual(["Upload", "Billing run"]);
		expect(walkthroughsOf(reopened)[0]!.steps[0]!.explanation).toBe("Kept");
	});

	test("Walkthrough edits are refused when no Project is open", async () => {
		const workspace = await openWorkspace(databasePathForTest());
		await expect(workspace.createWalkthrough({ name: "Orphan" })).rejects.toThrow("Open a project before editing its System design.");
		expect(walkthroughsOf(workspace)).toEqual([]);
	});
});
