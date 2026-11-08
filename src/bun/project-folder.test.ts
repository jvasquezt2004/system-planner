import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectFolderMirror, folderSlug, PROJECT_FOLDER_MARKER } from "./project-folder";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function setup() {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-folder-"));
	directories.push(directory);
	const workspace = await createDesignWorkspace({ databasePath: join(directory, "project.sqlite") });
	workspaces.push(workspace);
	const root = join(directory, "mirror");
	return { workspace, root };
}

describe("Project folder mirror", () => {
	test("slugs names safely", () => {
		expect(folderSlug("Café / Orders!")).toBe("cafe-orders");
		expect(folderSlug("../..", "project")).toBe("project");
	});

	test("writes the open Project's SQL and follows later changes", async () => {
		const { workspace, root } = await setup();
		await workspace.createProject({ name: "Library" });
		const mirror = createProjectFolderMirror({ root, workspace });
		const dir = (await mirror.sync())!;
		expect(dir).toBe(join(root, "library"));
		expect(existsSync(join(dir, "README.md"))).toBe(true);
		expect(JSON.parse(readFileSync(join(dir, PROJECT_FOLDER_MARKER), "utf8")).projectId).toBe(workspace.getState().project!.id);

		const designId = workspace.getState().activeDesignId!;
		await workspace.addTable({ designId, name: "Books" });
		await mirror.sync();
		const sqlFile = join(dir, "designs", readdirDesign(dir), "schema.sql");
		expect(readFileSync(sqlFile, "utf8")).toContain("CREATE TABLE \"Books\"");
		expect(statSync(join(dir, "README.md")).mode & 0o222).toBe(0);
		mirror.dispose();
	});

	test("renames its own folder but never takes over a folder it does not own", async () => {
		const { workspace, root } = await setup();
		mkdirSync(join(root, "taken"), { recursive: true });
		writeFileSync(join(root, "taken", "mine.txt"), "keep");
		await workspace.createProject({ name: "Taken" });
		const mirror = createProjectFolderMirror({ root, workspace });
		const dir = (await mirror.sync())!;
		expect(dir).not.toBe(join(root, "taken"));
		expect(readFileSync(join(root, "taken", "mine.txt"), "utf8")).toBe("keep");
		mirror.dispose();
	});

	test("restores files deleted behind its back", async () => {
		const { workspace, root } = await setup();
		await workspace.createProject({ name: "Library" });
		const mirror = createProjectFolderMirror({ root, workspace });
		const dir = (await mirror.sync())!;
		rmSync(dir, { recursive: true, force: true });
		await mirror.sync();
		expect(existsSync(join(dir, "README.md"))).toBe(true);
		mirror.dispose();
	});
	test("schema.sql is the one editable file, and an unapplied edit is not overwritten", async () => {
		const { workspace, root } = await setup();
		await workspace.createProject({ name: "Library" });
		const designId = workspace.getState().activeDesignId!;
		await workspace.addTable({ designId, name: "Books" });
		const mirror = createProjectFolderMirror({ root, workspace });
		const dir = (await mirror.sync())!;
		const schema = mirror.schemaFile(designId)!;
		expect(schema).toBe(join(dir, "designs", readdirDesign(dir), "schema.sql"));
		expect(statSync(schema).mode & 0o222).not.toBe(0);
		expect(statSync(join(dir, "system-design.md")).mode & 0o222).toBe(0);

		// A designer's edit survives a later change to the Project…
		writeFileSync(schema, "-- my edit\n");
		await workspace.addTable({ designId, name: "Authors" });
		await mirror.sync();
		expect(readFileSync(schema, "utf8")).toBe("-- my edit\n");
		// …until it is applied, which rewrites the file from the Design.
		await mirror.sync({ force: true });
		expect(readFileSync(schema, "utf8")).toContain('CREATE TABLE "Authors"');
		mirror.dispose();
	});
	test("attached files are copied into context/, PDFs with a text copy, and removed with the file", async () => {
		const { workspace, root } = await setup();
		await workspace.createProject({ name: "Library" });
		const attached = [
			{ id: "f1", name: "spec.pdf", size: 3, mime: "application/pdf", addedAt: 1, hasText: true, pages: 2 },
			{ id: "f2", name: "brief.md", size: 2, mime: "text/markdown", addedAt: 2, hasText: true },
			{ id: "f3", name: "logo.png", size: 1, mime: "image/png", addedAt: 3, hasText: false, note: "An image" },
		];
		let current = [...attached];
		const mirror = createProjectFolderMirror({ root, workspace, contextFiles: {
			list: () => current,
			content: (id) => new TextEncoder().encode(`bytes of ${id}`),
			text: (_project, name) => ({ text: `text of ${name}` }),
		} });
		const dir = (await mirror.sync())!;
		expect(readFileSync(join(dir, "context", "spec.pdf"), "utf8")).toBe("bytes of f1");
		expect(readFileSync(join(dir, "context", "spec.pdf.txt"), "utf8")).toBe("text of spec.pdf");
		expect(existsSync(join(dir, "context", "brief.md.txt"))).toBe(false); // already text
		expect(existsSync(join(dir, "context", "logo.png.txt"))).toBe(false); // nothing to read
		expect(statSync(join(dir, "context", "spec.pdf")).mode & 0o222).toBe(0);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("`context/`");

		current = current.filter((file) => file.id !== "f1");
		await mirror.sync();
		expect(existsSync(join(dir, "context", "spec.pdf"))).toBe(false);
		expect(existsSync(join(dir, "context", "spec.pdf.txt"))).toBe(false);
		expect(existsSync(join(dir, "context", "brief.md"))).toBe(true);

		current = [];
		await mirror.sync();
		expect(existsSync(join(dir, "context"))).toBe(false);
		expect(readFileSync(join(dir, "README.md"), "utf8")).not.toContain("`context/`");
		mirror.dispose();
	});
});

function readdirDesign(dir: string): string {
	return require("node:fs").readdirSync(join(dir, "designs"))[0];
}
