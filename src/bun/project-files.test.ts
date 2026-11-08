import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROJECT_FILE_LIMIT_BYTES, safeFileName, uniqueFileName } from "../shared/project-files";
import { pdfWithText } from "./pdf-fixture";
import { extractFileText, openProjectFileStore, type ProjectFileStore } from "./project-files";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";

const directories: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(): Promise<{ workspace: DesignWorkspace; store: ProjectFileStore; projectId: string; directory: string }> {
	const directory = mkdtempSync(join(tmpdir(), "project-files-"));
	directories.push(directory);
	const databasePath = join(directory, "app.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const store = openProjectFileStore(databasePath);
	closers.push(() => store.close(), () => workspace.close());
	const state = await workspace.createProject({ name: "Restaurant" });
	return { workspace, store, projectId: state.project!.id, directory };
}

describe("reading files", () => {
	test("PDF text is extracted, page count included", async () => {
		const extracted = await extractFileText("spec.pdf", pdfWithText("Orders ship within two days"));
		expect(extracted.text).toContain("Orders ship within two days");
		expect(extracted.pages).toBe(1);
	});

	test("a broken PDF, an image, and an unknown type explain why there is no text", async () => {
		expect((await extractFileText("bad.pdf", new TextEncoder().encode("not a pdf"))).note).toContain("could not be read");
		expect((await extractFileText("logo.png", new Uint8Array([1, 2, 3]))).note).toContain("image");
		expect((await extractFileText("notes.docx", new Uint8Array([1, 2, 3]))).note).toContain("PDF and plain text");
	});

	test("plain text and markdown are read as they are", async () => {
		expect((await extractFileText("brief.md", new TextEncoder().encode("# Goal\nTrack orders"))).text).toBe("# Goal\nTrack orders");
	});
});

describe("names", () => {
	test("paths and control characters never reach the Project folder", () => {
		expect(safeFileName("../../etc/passwd")).toBe("passwd");
		expect(safeFileName("C:\\Users\\me\\spec: v2?.pdf")).toBe("spec_ v2_.pdf");
		expect(safeFileName("...")).toBe("file");
	});
	test("a repeated name gets a number", () => {
		expect(uniqueFileName("spec.pdf", ["Spec.pdf"])).toBe("spec (2).pdf");
		expect(uniqueFileName("spec.pdf", ["spec.pdf", "spec (2).pdf"])).toBe("spec (3).pdf");
	});
});

describe("the store", () => {
	test("keeps files per Project with text, and removes them", async () => {
		const { store, projectId } = await open();
		const file = await store.add(projectId, { name: "spec.pdf", bytes: pdfWithText("Kitchen stations are per location") });
		expect(file).toMatchObject({ name: "spec.pdf", hasText: true, pages: 1, mime: "application/pdf" });
		await store.add(projectId, { name: "logo.png", bytes: new Uint8Array([1, 2, 3]) });
		expect(store.list(projectId).map((entry) => [entry.name, entry.hasText])).toEqual([["spec.pdf", true], ["logo.png", false]]);
		expect(store.text(projectId, "SPEC.pdf")?.text).toContain("Kitchen stations");
		expect(store.text(projectId, "logo.png")).toBeNull();
		expect(store.content(file.id)?.byteLength).toBeGreaterThan(100);
		expect(store.remove(projectId, file.id)).toBe(true);
		expect(store.remove(projectId, file.id)).toBe(false);
		expect(store.list(projectId).map((entry) => entry.name)).toEqual(["logo.png"]);
	});

	test("the same name twice is kept twice, under different names", async () => {
		const { store, projectId } = await open();
		await store.add(projectId, { name: "notes.txt", bytes: new TextEncoder().encode("a") });
		const second = await store.add(projectId, { name: "notes.txt", bytes: new TextEncoder().encode("b") });
		expect(second.name).toBe("notes (2).txt");
	});

	test("paths are read, and unreadable, empty, folder, and oversized ones are skipped with a reason", async () => {
		const { store, projectId, directory } = await open();
		writeFileSync(join(directory, "ok.txt"), "hello");
		writeFileSync(join(directory, "empty.txt"), "");
		writeFileSync(join(directory, "big.txt"), Buffer.alloc(PROJECT_FILE_LIMIT_BYTES + 1));
		const result = await store.addFromPaths(projectId, [join(directory, "ok.txt"), join(directory, "empty.txt"), join(directory, "big.txt"), join(directory, "missing.txt"), directory]);
		expect(result.added.map((entry) => entry.name)).toEqual(["ok.txt"]);
		expect(result.skipped.map((entry) => entry.name).sort()).toEqual([directory.split("/").pop()!, "big.txt", "empty.txt", "missing.txt"].sort());
		expect(result.skipped.find((entry) => entry.name === "big.txt")?.reason).toContain("Larger than");
	});

	test("deleting the Project deletes its files", async () => {
		const { store, projectId, workspace } = await open();
		await store.add(projectId, { name: "a.txt", bytes: new TextEncoder().encode("a") });
		const other = await workspace.createProject({ name: "Other" });
		await store.add(other.project!.id, { name: "b.txt", bytes: new TextEncoder().encode("b") });
		expect(store.list(projectId)).toHaveLength(1);
		expect(store.list(other.project!.id)).toHaveLength(1);
	});
});
