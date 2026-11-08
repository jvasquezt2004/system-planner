/**
 * Differential fixtures for the file side of the app: copying and exporting the SQL preview and
 * generated ORM code, saving a System design as SVG or PNG, and exporting or importing a Project.
 *
 * The real TypeScript actions run against fake pickers and a fake clipboard in a scratch folder.
 * Every case records its setup, the result the view would get, the text copied, and the files left
 * behind (name and hash). Paths in results are shown relative to the scratch folder.
 *
 * Run from the repository root: bun tauri/fixtures/generate-transfer.ts
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqlPreviewActions } from "../../src/bun/sql-preview";
import { createSystemDesignSvgExports } from "../../src/bun/system-design-svg-export";
import { createSystemDesignPngExports } from "../../src/bun/system-design-png-export";
import { createProjectTransferActions } from "../../src/bun/project-transfer";
import { fnv } from "./lib/workspace-driver";

type Setup = {
	/** What the folder picker answers: a folder, a cancellation, blank text, or a folder that does not exist. */
	directory?: "dir" | "cancel" | "blank" | "missing";
	/** Files already in the folder. */
	existing?: Array<{ name: string; text: string }>;
	/** "fail:<message>" makes the clipboard throw. */
	clipboard?: "ok" | string;
	now?: string;
	/** For a Project import: the file the picker answers, and what the workspace does with the document. */
	importFile?: { base64: string } | "folder" | "missing" | "cancel";
	workspace?: { exportDocument?: unknown; exportError?: string; importProject?: { project: { id: string; name: string } | null } | { error: string } };
};
type Case = { name: string; action: string; input: unknown; setup: Setup; result: unknown; clipboard: string | null; files: Record<string, string> };

const cases: Case[] = [];

async function run(name: string, action: string, input: unknown, setup: Setup = {}) {
	const root = mkdtempSync(join(tmpdir(), "db-planner-transfer-"));
	try {
		for (const file of setup.existing ?? []) writeFileSync(join(root, file.name), file.text);
		let clipboard: string | null = null;
		const chooseExportDirectory = async () => {
			switch (setup.directory ?? "dir") {
				case "dir": return root;
				case "cancel": return null;
				case "blank": return "   ";
				case "missing": return join(root, "nowhere");
			}
		};
		const now = () => new Date(setup.now ?? "2026-10-26T21:00:00.000Z");
		const sql = createSqlPreviewActions({
			writeClipboardText(text) {
				if (setup.clipboard?.startsWith("fail:")) throw new Error(setup.clipboard.slice(5));
				clipboard = text;
			},
			chooseExportDirectory,
		});
		const workspace = {
			async exportProject() {
				if (setup.workspace?.exportError) throw new Error(setup.workspace.exportError);
				return setup.workspace?.exportDocument;
			},
			async importProject() {
				const outcome = setup.workspace?.importProject ?? { project: { id: "p1", name: "Imported" } };
				if ("error" in outcome) throw new Error(outcome.error);
				return { project: outcome.project };
			},
		};
		const project = createProjectTransferActions({
			workspace: workspace as never,
			chooseExportDirectory,
			chooseImportFile: async () => {
				const file = setup.importFile;
				if (file === undefined || file === "cancel") return null;
				if (file === "missing") return join(root, "no-such-file.json");
				if (file === "folder") return root;
				const path = join(root, "import.json");
				writeFileSync(path, Buffer.from(file.base64, "base64"));
				return path;
			},
			now,
		});
		const svg = createSystemDesignSvgExports({ chooseExportDirectory, now });
		const png = createSystemDesignPngExports({ chooseExportDirectory, now });
		const arg = input as any;
		let result: unknown;
		switch (action) {
			case "copySql": result = sql.copy(arg.preview); break;
			case "exportSql": result = await sql.export(arg.preview, arg.fileName); break;
			case "copyCode": result = sql.copyCode(arg.snapshot); break;
			case "exportCode": result = await sql.exportCode(arg.snapshot, arg.fileName); break;
			case "exportSvg": result = await svg.export(arg); break;
			case "exportPng": result = await png.export(arg); break;
			case "exportProject": result = await project.exportProject(); break;
			case "importProject": result = await project.importProject(); break;
			default: throw new Error(`unknown action ${action}`);
		}
		const files: Record<string, string> = {};
		for (const entry of readdirSync(root)) {
			if (entry === "import.json") continue;
			files[entry] = fnv(readFileSync(join(root, entry)).toString("latin1"));
		}
		// An existing file that was only there for the case is part of "files" too, so a change to it shows.
		const text = JSON.stringify(result).replaceAll(root, "<dir>");
		cases.push({ name, action, input, setup, result: JSON.parse(text), clipboard, files });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------- SQL preview
const preview = (overrides: Record<string, unknown> = {}) => ({ status: "current", revision: 7, draftRevision: 7, sql: "CREATE TABLE a ();\n", designId: "d1", ...overrides });
for (const [label, value] of [
	["valid", preview()], ["blank", preview({ sql: "  \n " })], ["not text", preview({ sql: 5 })], ["null", null], ["no revision", { sql: "select 1" }],
	["null revision", { sql: "select 1", revision: null }], ["unicode", preview({ sql: "-- é💥\nselect 1;" })],
] as const) {
	await run(`copy sql: ${label}`, "copySql", { preview: value });
}
await run("copy sql: clipboard fails", "copySql", { preview: preview() }, { clipboard: "fail:Clipboard is locked" });

const fileNames = ["schema.sql", "SCHEMA.SQL", "a b.sql", " lead.sql", "trail.sql ", "a/b.sql", "a\\b.sql", "a:b.sql", "a*.sql", "a?.sql", "a<b>.sql", 'a"b.sql', "a|b.sql", "ends.", "x.sql.", "a.txt", "", "sql", ".sql", "\u0001.sql", "tab\t.sql", "é💥.sql", "x".repeat(300) + ".sql"];
for (const fileName of fileNames) await run(`export sql: ${[...JSON.stringify(fileName)].slice(0, 40).join("")}`, "exportSql", { preview: preview(), fileName });
await run("export sql: file name is a number", "exportSql", { preview: preview(), fileName: 12 });
await run("export sql: no file name", "exportSql", { preview: preview(), fileName: undefined });
await run("export sql: no sql", "exportSql", { preview: preview({ sql: "" }), fileName: "a.sql" });
await run("export sql: cancelled", "exportSql", { preview: preview(), fileName: "a.sql" }, { directory: "cancel" });
await run("export sql: blank folder", "exportSql", { preview: preview(), fileName: "a.sql" }, { directory: "blank" });
await run("export sql: missing folder", "exportSql", { preview: preview(), fileName: "a.sql" }, { directory: "missing" });
await run("export sql: file exists", "exportSql", { preview: preview(), fileName: "a.sql" }, { existing: [{ name: "a.sql", text: "keep me" }] });
await run("export sql: existing other file", "exportSql", { preview: preview(), fileName: "b.sql" }, { existing: [{ name: "a.sql", text: "keep me" }] });

// -------------------------------------------------------------------------------------- ORM code
const snapshot = (target: unknown, overrides: Record<string, unknown> = {}) => ({ target, revision: 3, code: "model A {}\n", designId: "d1", ...overrides });
for (const target of ["sql", "prisma", "drizzle", "sqlalchemy", "django"]) {
	await run(`copy code: ${target}`, "copyCode", { snapshot: snapshot(target) });
	for (const fileName of ["schema.prisma", "schema.ts", "models.py", "schema.sql", "models.PY", "x.txt"]) {
		await run(`export code: ${target} ${fileName}`, "exportCode", { snapshot: snapshot(target), fileName });
	}
}
await run("copy code: blank", "copyCode", { snapshot: snapshot("prisma", { code: "  " }) });
await run("copy code: null", "copyCode", { snapshot: null });
await run("export code: unknown target", "exportCode", { snapshot: snapshot("mongo"), fileName: "a.js" });
await run("export code: numeric target", "exportCode", { snapshot: snapshot(5), fileName: "a.js" });
await run("export code: no target", "exportCode", { snapshot: { revision: 1, code: "select 1" }, fileName: "a.sql" });
await run("export code: null target", "exportCode", { snapshot: snapshot(null), fileName: "a.sql" });
await run("export code: no code", "exportCode", { snapshot: snapshot("prisma", { code: undefined }), fileName: "a.prisma" });
await run("export code: cancelled", "exportCode", { snapshot: snapshot("django"), fileName: "models.py" }, { directory: "cancel" });
await run("export code: exists", "exportCode", { snapshot: snapshot("django"), fileName: "models.py" }, { existing: [{ name: "models.py", text: "old" }] });

// ------------------------------------------------------------------------------- System diagram
const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect/></svg>';
const names = ["𠀀".repeat(40), "Shop", "  Café Ünï  ", "日本語", "", "   ", "💥💥", "a/b\\c", "x".repeat(100), "İstanbul", "ΑΣ", "Straße", "--a--", "ﬃ ligature", "a.b.c"];
for (const projectName of names) await run(`svg: name ${[...JSON.stringify(projectName)].slice(0, 30).join("")}`, "exportSvg", { svg: svgText, projectName });
for (const [label, svg] of [["leading space", `  \n\t${svgText}`], ["xml", `<?xml version="1.0"?>${svgText}`], ["not svg", "<html></html>"], ["empty", ""], ["no-break space", ` ${svgText}`], ["bom", `﻿${svgText}`], ["missing", undefined], ["number", 5]] as const) {
	await run(`svg: ${label}`, "exportSvg", { svg, projectName: "Shop" });
}
for (const now of ["1970-01-01T00:00:00.000Z", "2000-02-29T12:34:56.789Z", "2026-12-31T23:59:59.999Z", "2100-03-01T00:00:00.001Z", "1999-12-31T23:59:59.000Z", "2024-02-29T00:00:00.000Z"]) {
	await run(`svg: at ${now}`, "exportSvg", { svg: svgText, projectName: "Shop" }, { now });
}
await run("svg: cancelled", "exportSvg", { svg: svgText, projectName: "Shop" }, { directory: "cancel" });
await run("svg: blank folder", "exportSvg", { svg: svgText, projectName: "Shop" }, { directory: "blank" });
await run("svg: missing folder", "exportSvg", { svg: svgText, projectName: "Shop" }, { directory: "missing" });
await run("svg: file exists", "exportSvg", { svg: svgText, projectName: "Shop" }, { existing: [{ name: "shop-system-design-2026-10-26T21-00-00-000Z.svg", text: "old" }] });

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}
function pngBytes(width = 1, height = 1): Uint8Array {
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, width);
	view.setUint32(4, height);
	header.set([8, 6, 0, 0, 0], 8);
	const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", new Uint8Array([1, 2, 3, 4, 0xfb, 0xef, 0xbe, 0xff, 0xff, 0xff])), chunk("IEND", new Uint8Array())];
	return Buffer.concat(parts);
}
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const good = pngBytes();
const flipped = Uint8Array.from(good);
flipped[0] = 0x88;
const noTrailer = good.slice(0, good.length - 1);
const zeroWidth = pngBytes(0, 1);
const zeroHeight = pngBytes(1, 0);
for (const [label, png] of [
	["valid", b64(good)], ["valid, wrapped lines", b64(good).replace(/(.{20})/g, "$1\n")], ["valid, url-safe alphabet", b64(good).replace(/\+/g, "-").replace(/\//g, "_")], ["valid, unpadded", b64(good).replace(/=+$/, "")],
	["valid, spaces", b64(good).replace(/(.{8})/g, "$1 ")], ["valid, junk characters", b64(good).replace(/(.{12})/g, "$1$#!")], ["valid, trailing junk after padding", `${b64(good)}AAAA`], ["bad signature", b64(flipped)], ["truncated", b64(noTrailer)], ["zero width", b64(zeroWidth)], ["zero height", b64(zeroHeight)],
	["large", b64(pngBytes(4000, 3000))], ["not base64", "!!!!"], ["empty", ""], ["missing", undefined], ["number", 7], ["signature only", b64(good.slice(0, 8))],
] as const) {
	await run(`png: ${label}`, "exportPng", { png, projectName: "Shop" });
}
await run("png: cancelled", "exportPng", { png: b64(good), projectName: "Shop" }, { directory: "cancel" });
await run("png: file exists", "exportPng", { png: b64(good), projectName: "Shop" }, { existing: [{ name: "shop-system-design-2026-10-26T21-00-00-000Z.png", text: "old" }] });
await run("png: invalid is refused before the picker", "exportPng", { png: "AAAA", projectName: "Shop" }, { directory: "cancel" });

// ------------------------------------------------------------------------------------ Project
const document = { format: "schema-designer.project", version: 1, project: { name: "Shop", activeDesignId: "d1", activeView: "system" }, systemDesign: { services: [], note: "é💥 " }, designs: [], walkthroughs: [] };
for (const name of ["Shop", "  Café Ünï  ", "日本語", "", "💥💥", "x".repeat(100), "A/B"]) {
	await run(`project export: name ${[...JSON.stringify(name)].slice(0, 30).join("")}`, "exportProject", {}, { workspace: { exportDocument: { ...document, project: { ...document.project, name } } } });
}
await run("project export: cancelled", "exportProject", {}, { directory: "cancel", workspace: { exportDocument: document } });
await run("project export: blank folder", "exportProject", {}, { directory: "blank", workspace: { exportDocument: document } });
await run("project export: missing folder", "exportProject", {}, { directory: "missing", workspace: { exportDocument: document } });
await run("project export: workspace refuses", "exportProject", {}, { workspace: { exportError: "Open a project before exporting it." } });
await run("project export: file exists", "exportProject", {}, { existing: [{ name: "shop-2026-10-26T21-00-00-000Z.schema-designer.json", text: "old" }], workspace: { exportDocument: document } });
const fileOf = (text: string | Buffer) => ({ base64: Buffer.from(text).toString("base64") });
await run("project import: valid", "importProject", {}, { importFile: fileOf(JSON.stringify(document)) });
await run("project import: cancelled", "importProject", {}, { importFile: "cancel" });
await run("project import: a folder", "importProject", {}, { importFile: "folder" });
await run("project import: missing file", "importProject", {}, { importFile: "missing" });
await run("project import: not JSON", "importProject", {}, { importFile: fileOf("{ nope") });
await run("project import: empty file", "importProject", {}, { importFile: fileOf("") });
await run("project import: byte order mark", "importProject", {}, { importFile: fileOf(`﻿${JSON.stringify(document)}`) });
await run("project import: invalid UTF-8", "importProject", {}, { importFile: fileOf(Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')])) });
await run("project import: JSON null", "importProject", {}, { importFile: fileOf("null") });
await run("project import: trailing comma", "importProject", {}, { importFile: fileOf('{"a":1,}') });
await run("project import: workspace refuses", "importProject", {}, { importFile: fileOf("{}"), workspace: { importProject: { error: "The project file is malformed: file must be an object." } } });
await run("project import: nothing opened", "importProject", {}, { importFile: fileOf("{}"), workspace: { importProject: { project: null } } });

const outDir = join(import.meta.dir, "data");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "transfer.json"), `${JSON.stringify(cases)}\n`);
const failed = cases.filter((entry) => (entry.result as { status?: string }).status === "failed").length;
console.log(`transfer: ${cases.length} cases, ${failed} failed, ${new Set(cases.map((entry) => JSON.stringify((entry.result as any).error))).size} distinct outcomes`);
