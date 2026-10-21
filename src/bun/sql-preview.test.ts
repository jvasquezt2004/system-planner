import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getDisplayedSqlPreview,
	type DisplayedSqlPreview,
} from "../shared/design";
import { createPGliteSandbox, type SchemaSandbox } from "./sandbox";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import { createSqlPreviewActions } from "./sql-preview";

const workspaces: DesignWorkspace[] = [];
const temporaryDirectories: string[] = [];

async function openWorkspace(options: { createSandbox?: () => SchemaSandbox } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-sql-preview-"));
	temporaryDirectories.push(directory);
	const workspace = await createDesignWorkspace({
		databasePath: join(directory, "design.sqlite"),
		...options,
	});
	workspaces.push(workspace);
	return { workspace, directory };
}

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function requirePreview(preview: DisplayedSqlPreview | null): DisplayedSqlPreview {
	if (!preview) throw new Error("Expected displayed SQL to be available.");
	return preview;
}

describe("SQL preview transfer", () => {
	test("copies and exports the current or stale SQL actually displayed", async () => {
		const { workspace, directory } = await openWorkspace();
		const empty = await workspace.createProject({ name: "Library" });
		expect(getDisplayedSqlPreview(empty.sql)).toBeNull();

		const current = await workspace.addTable({ name: "Books" });
		expect(current.sql.status).toBe("current");
		const currentPreview = requirePreview(getDisplayedSqlPreview(current.sql));
		const copied: string[] = [];
		const actions = createSqlPreviewActions({
			writeClipboardText: (sql) => copied.push(sql),
			chooseExportDirectory: async () => directory,
		});

		expect(actions.copy(currentPreview)).toMatchObject({
			status: "copied",
			revision: currentPreview.revision,
		});
		expect(copied).toEqual([currentPreview.sql]);
		const currentExport = await actions.export(currentPreview, "current.sql");
		expect(currentExport).toMatchObject({
			status: "saved",
			revision: currentPreview.revision,
		});
		expect(readFileSync(join(directory, "current.sql"), "utf8")).toBe(
			currentPreview.sql,
		);

		const invalidDraft = await workspace.addTable({ name: "Books" });
		expect(invalidDraft.sql.status).toBe("stale");
		const stalePreview = requirePreview(getDisplayedSqlPreview(invalidDraft.sql));
		expect(stalePreview).toMatchObject({
			status: "stale",
			revision: currentPreview.revision,
			draftRevision: invalidDraft.revision,
			sql: currentPreview.sql,
		});
		expect(getDisplayedSqlPreview({
			status: "checking",
			draftRevision: invalidDraft.revision + 1,
			availableRevision: stalePreview.revision,
			sql: stalePreview.sql,
		})).toMatchObject({
			status: "checking",
			revision: stalePreview.revision,
			draftRevision: invalidDraft.revision + 1,
			sql: stalePreview.sql,
		});
		expect(actions.copy(stalePreview)).toMatchObject({
			status: "copied",
			revision: stalePreview.revision,
		});
		expect(copied).toEqual([currentPreview.sql, stalePreview.sql]);
		const staleExport = await actions.export(stalePreview, "stale.sql");
		expect(staleExport.status).toBe("saved");
		expect(readFileSync(join(directory, "stale.sql"), "utf8")).toBe(
			stalePreview.sql,
		);
		expect(workspace.getState().sql.status).toBe("stale");
		expect(workspace.getState().design?.tables.map((table) => table.name)).toEqual([
			"Books",
			"Books",
		]);
		expect(workspace.getState().sandbox).toMatchObject({
			status: "applied",
			revision: currentPreview.revision,
		});
	}, 30_000);

	test("exports its click-time SQL snapshot while edits and project switches continue", async () => {
		const { workspace, directory } = await openWorkspace();
		await workspace.createProject({ name: "Authors project" });
		const authored = await workspace.addTable({ name: "Authors" });
		const snapshot = requirePreview(getDisplayedSqlPreview(authored.sql));
		const exportDirectory = join(directory, "exports");
		mkdirSync(exportDirectory);

		const { promise: dialogStartedPromise, resolve: dialogStarted } =
			Promise.withResolvers<void>();
		const { promise: dialogResult, resolve: continueDialog } =
			Promise.withResolvers<string | null>();
		const actions = createSqlPreviewActions({
			writeClipboardText: () => {},
			chooseExportDirectory: () => {
				dialogStarted();
				return dialogResult;
			},
		});

		const exportPromise = actions.export(snapshot, "authors.sql");
		await dialogStartedPromise;
		await workspace.addTable({ name: "Books" });
		await workspace.createProject({ name: "Courses project" });
		const otherProject = await workspace.addTable({ name: "Courses" });
		expect(otherProject.sql.status).toBe("current");
		continueDialog(exportDirectory);

		const result = await exportPromise;
		expect(result).toMatchObject({ status: "saved", revision: snapshot.revision });
		const exported = readFileSync(join(exportDirectory, "authors.sql"), "utf8");
		expect(exported).toBe(snapshot.sql);
		expect(exported).toContain('CREATE TABLE "Authors"');
		expect(exported).not.toContain('CREATE TABLE "Books"');
		expect(exported).not.toContain('CREATE TABLE "Courses"');
		expect(workspace.getState().design?.tables.map((table) => table.name)).toEqual([
			"Courses",
		]);
	}, 30_000);

	test("copies and exports the displayed SQL even when PostgreSQL rejected that revision", async () => {
		let attempts = 0;
		const { workspace, directory } = await openWorkspace({
			createSandbox: () => {
				const sandbox = createPGliteSandbox();
				return {
					apply(sql) {
						attempts += 1;
						return sandbox.apply(
							attempts === 1 ? sql : `${sql}\nTHIS IS NOT VALID SQL`,
						);
					},
					dispose: () => sandbox.dispose(),
				};
			},
		});
		await workspace.createProject({ name: "Library" });
		const accepted = await workspace.addTable({ name: "Books" });
		const table = accepted.design?.tables[0];
		if (!table) throw new Error("Expected Books table.");
		const rejected = await workspace.renameTable({ tableId: table.id, name: "Volumes" });
		expect(rejected.sql.status).toBe("current");
		expect(rejected.sandbox).toMatchObject({
			status: "failed",
			failure: "sql-rejected",
			revision: rejected.revision,
		});
		if (rejected.sandbox.status !== "failed" || rejected.sandbox.failure !== "sql-rejected") {
			throw new Error("Expected PostgreSQL to reject the generated candidate.");
		}
		const preview = requirePreview(getDisplayedSqlPreview(rejected.sql));
		const copied: string[] = [];
		const actions = createSqlPreviewActions({
			writeClipboardText: (sql) => copied.push(sql),
			chooseExportDirectory: async () => directory,
		});

		expect(actions.copy(preview)).toMatchObject({
			status: "copied",
			revision: rejected.revision,
		});
		expect(copied).toEqual([rejected.sandbox.attemptedSql]);

		const result = await actions.export(preview, "rejected.sql");
		expect(result.status).toBe("saved");
		expect(readFileSync(join(directory, "rejected.sql"), "utf8")).toBe(
			rejected.sandbox.attemptedSql,
		);
		expect(workspace.getState().sandbox).toMatchObject({
			status: "failed",
			failure: "sql-rejected",
			revision: rejected.revision,
		});
	}, 30_000);

	test("reports cancellation, clipboard failure, and file errors without changing the design", async () => {
		const { workspace, directory } = await openWorkspace();
		await workspace.createProject({ name: "Library" });
		const state = await workspace.addTable({ name: "Books" });
		const preview = requirePreview(getDisplayedSqlPreview(state.sql));
		const originalDesign = structuredClone(state.design);
		const cancelActions = createSqlPreviewActions({
			writeClipboardText: () => {},
			chooseExportDirectory: async () => null,
		});

		expect(await cancelActions.export(preview, "cancelled.sql")).toMatchObject({
			status: "cancelled",
			revision: preview.revision,
		});
		expect(existsSync(join(directory, "cancelled.sql"))).toBe(false);

		const clipboardActions = createSqlPreviewActions({
			writeClipboardText: () => {
				throw new Error("clipboard unavailable");
			},
			chooseExportDirectory: async () => directory,
		});
		expect(clipboardActions.copy(preview)).toMatchObject({
			status: "failed",
			error: "clipboard unavailable",
		});

		const existingSqlFile = join(directory, "already.sql");
		writeFileSync(existingSqlFile, "preserve this content");
		const existingFileActions = createSqlPreviewActions({
			writeClipboardText: () => {},
			chooseExportDirectory: async () => directory,
		});
		expect(await existingFileActions.export(preview, "already.sql")).toMatchObject({
			status: "failed",
			error: "A file with that name already exists. Choose a different name.",
		});
		expect(readFileSync(existingSqlFile, "utf8")).toBe("preserve this content");

		const notDirectory = join(directory, "not-a-folder");
		writeFileSync(notDirectory, "keep this file");
		const fileActions = createSqlPreviewActions({
			writeClipboardText: () => {},
			chooseExportDirectory: async () => notDirectory,
		});
		const failedExport = await fileActions.export(preview, "books.sql");
		expect(failedExport.status).toBe("failed");
		expect(readFileSync(notDirectory, "utf8")).toBe("keep this file");
		expect(workspace.getState().design).toEqual(originalDesign);
		expect(workspace.getState().sql).toEqual(state.sql);
		expect(workspace.getState().sandbox).toEqual(state.sandbox);
	}, 30_000);
});
