/**
 * Differential fixtures for attached Project files (`project-files.ts`): the naming and type rules,
 * the text read from non-PDF files, and the store itself driven through add, list, remove and the
 * limits. PDF text comes from a different library on each side, so it is tested on its own.
 *
 * Run from the repository root: bun tauri/fixtures/generate-project-files.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesignStore } from "../../src/bun/store";
import { extractFileText, openProjectFileStore } from "../../src/bun/project-files";
import { fileExtension, isTextFileName, mimeForFileName, safeFileName, uniqueFileName, PROJECT_FILES_PER_PROJECT } from "../../src/shared/project-files";

const names = ["spec.pdf", "Spec.PDF", "a/b/c.txt", "..\\x\\y.md", "...hidden", ".env", "a<b>c:d\"e|f?g*.txt", "   spaced   .csv", "", "   ", "///", "\u0001ctl.json", "x".repeat(200) + ".sql", "é💥.yaml", "noext", "trailing.", "archive.tar.gz", "photo.JPG", "doc.docx", "page.html", "data.xml", "notes.markdown", "script.ts", "mixed.Tex", "weird.unknown", ".gitignore", "a.b.c.png", "UPPER.TXT", "tab\tname.txt"];
const naming = names.map((name) => ({ name, safe: safeFileName(name), extension: fileExtension(name), text: isTextFileName(name), mime: mimeForFileName(name) }));

const taken = [["a.pdf"], ["A.PDF"], ["a.pdf", "a (2).pdf"], ["a.pdf", "a (2).pdf", "A (3).PDF"], ["noext", "noext (2)"], [".hidden", ".hidden (2)"], []];
const uniques = ["a.pdf", "noext", ".hidden", "b.txt", "a (2).pdf"].flatMap((name) => taken.map((list) => ({ name, taken: list, result: uniqueFileName(name, list) })));

const contents: Array<[string, string]> = [
	["a.txt", "hello"], ["a.txt", "  \n "], ["a.txt", ""], ["a.md", "# Title\n\nbody"], ["a.json", '{"a":1}'], ["a.csv", "a,b\n1,2\n"], ["a.png", "x"], ["a.jpg", "x"], ["a.exe", "x"], ["a", "x"],
	["a.txt", "nul\u0000inside"], ["a.txt", "é💥 text"], ["a.sql", "x".repeat(2_100_000)], ["a.txt", "💥".repeat(1_100_000)],
];
const extraction = [] as Array<{ name: string; base64: string; result: unknown }>;
for (const [name, text] of contents) {
	const bytes = new TextEncoder().encode(text);
	const result = await extractFileText(name, bytes);
	extraction.push({ name, base64: Buffer.from(bytes).toString("base64"), result: { ...result, text: result.text === undefined || result.text === null ? result.text : `${result.text.length}:${result.text.slice(0, 40)}` } });
}
extraction.push({ name: "bad.txt", base64: Buffer.from([0xff, 0xfe, 0x41]).toString("base64"), result: await extractFileText("bad.txt", Uint8Array.from([0xff, 0xfe, 0x41])) });

// The store, driven as the app drives it.
type Step = { op: string; args: unknown; result: unknown; list: unknown };
const directory = mkdtempSync(join(tmpdir(), "db-planner-files-"));
const steps: Step[] = [];
try {
	const databasePath = join(directory, "files.sqlite");
	const designs = openDesignStore(databasePath);
	designs.createProject({ id: "p1", name: "One" }, { tables: [], relationships: [], manyToManyRelationships: [], viewport: { x: 0, y: 0, zoom: 1 } } as never, { revision: 1, documentRevision: 1, savedAt: 1 }, "d1");
	designs.createProject({ id: "p2", name: "Two" }, { tables: [], relationships: [], manyToManyRelationships: [], viewport: { x: 0, y: 0, zoom: 1 } } as never, { revision: 1, documentRevision: 1, savedAt: 1 }, "d2");
	let clock = 1000;
	const files = openProjectFileStore(databasePath, () => (clock += 10));
	const strip = (value: any): any => JSON.parse(JSON.stringify(value, (key, v) => (key === "id" ? "<id>" : v)));
	const record = async (op: string, args: Record<string, unknown>, run: () => Promise<unknown> | unknown) => {
		let result: unknown;
		try { result = { ok: strip(await run()) }; } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
		steps.push({ op, args, result, list: strip(files.list("p1")).concat(strip(files.list("p2"))) });
	};
	const add = (project: string, name: string, text: string | Uint8Array) => record("add", { project, name, base64: Buffer.from(text).toString("base64") }, () => files.add(project, { name, bytes: new Uint8Array(Buffer.from(text)) }));
	await add("p1", "spec.txt", "hello");
	await add("p1", "Spec.TXT", "again");
	await add("p1", "spec.txt", "third");
	await add("p2", "spec.txt", "other project");
	await add("p1", "a/b/notes.md", "# notes");
	await add("p1", "empty.txt", "");
	await add("p1", "blank.txt", "   ");
	await add("p1", "photo.png", "not really a png");
	await add("p1", "weird.bin", "binary");
	await add("p1", "..\\..\\evil.txt", "path tricks");
	await add("p1", "", "no name");
	for (let index = 0; index < PROJECT_FILES_PER_PROJECT + 2; index += 1) await add("p1", `bulk-${index}.txt`, `file ${index}`);
	const removable = files.list("p1")[1]!;
	await record("remove", { project: "p1", index: 1 }, () => files.remove("p1", removable.id));
	await record("remove", { project: "p1", index: -1 }, () => files.remove("p1", "missing"));
	await record("remove", { project: "p2", index: -2 }, () => files.remove("p2", removable.id));
	await add("p1", "after-removal.txt", "room again");
	await record("text", { project: "p2", name: "SPEC.txt" }, () => files.text("p2", "SPEC.txt"));
	await record("text", { project: "p1", name: "photo.png" }, () => files.text("p1", "photo.png"));
	await record("text", { project: "p1", name: "nothing.txt" }, () => files.text("p1", "nothing.txt"));
	// Adding by path.
	const real = join(directory, "from-disk.txt");
	writeFileSync(real, "from disk");
	mkdirSync(join(directory, "a-folder"));
	rmSync(join(directory, "gone"), { force: true });
	for (let index = 0; index < 55; index += 1) files.remove("p1", files.list("p1")[0]?.id ?? "x");
	await record("addFromPaths", { project: "p1", paths: ["from-disk.txt", "a-folder", "gone/missing.txt"] }, async () => {
		const result = await files.addFromPaths("p1", [real, join(directory, "a-folder"), join(directory, "gone", "missing.txt")]);
		return { added: result.added, skipped: result.skipped.map((entry) => ({ name: entry.name, reason: entry.reason.replace(directory, "<dir>") })) };
	});
	files.close();
	designs.close();
} finally {
	rmSync(directory, { recursive: true, force: true });
}

mkdirSync(join(import.meta.dir, "data"), { recursive: true });
writeFileSync(join(import.meta.dir, "data/project-files.json"), `${JSON.stringify({ naming, uniques, extraction, steps })}\n`);
console.log(`project files: ${naming.length} names, ${uniques.length} unique-name cases, ${extraction.length} extractions, ${steps.length} store steps`);
