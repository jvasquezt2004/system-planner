/**
 * Differential fixtures for the Project folder (`project-folder.ts`): the files rendered from a
 * Project's portable document. The documents are the exports and accepted imports the workspace
 * sessions recorded, so they cover real Projects and damaged-but-accepted ones.
 *
 * Run from the repository root (after generate-workspace.ts): bun tauri/fixtures/generate-folder.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderProjectFolder, folderSlug } from "../../src/bun/project-folder";
import { fnv } from "./lib/workspace-driver";

const sessions = JSON.parse(readFileSync(join(import.meta.dir, "data/workspace-sessions.json"), "utf8")) as Array<{ steps: Array<{ method: string; params: unknown; outcome: any }> }>;
const documents = new Map<string, unknown>();
const exportedSystems = new Set<string>();
const exportedDesigns = new Set<string>();
for (const session of sessions) {
	for (const step of session.steps) {
		if (step.method === "exportProject" && step.outcome.ok?.value) {
			documents.set(fnv(JSON.stringify(step.outcome.ok.value)), step.outcome.ok.value);
			exportedSystems.add(JSON.stringify(step.outcome.ok.value.systemDesign));
			for (const entry of step.outcome.ok.value.designs) exportedDesigns.add(JSON.stringify(entry.design));
		}
	}
}
// An accepted import is rendered only when its System design and Designs are already in the form an export writes.
for (const session of sessions) {
	for (const step of session.steps) {
		const params = step.params as any;
		if (step.method === "importProject" && step.outcome.ok && exportedSystems.has(JSON.stringify(params?.systemDesign)) && Array.isArray(params?.designs) && params.designs.every((entry: any) => exportedDesigns.has(JSON.stringify(entry?.design)))) documents.set(fnv(JSON.stringify(params)), params);
	}
}
const contexts = [
	[],
	[{ id: "f1", name: "spec.pdf", size: 10, mime: "application/pdf", addedAt: 1, hasText: true }],
	[{ id: "f2", name: "notes.md", size: 10, mime: "text/markdown", addedAt: 1, hasText: true }, { id: "f3", name: "logo.png", size: 5, mime: "image/png", addedAt: 2, hasText: false }],
];
const cases: unknown[] = [];
let skipped = 0;
for (const [key, document] of documents) {
	for (const [index, context] of contexts.entries()) {
		try {
			const files = renderProjectFolder(document as never, `project-${key}`, context as never);
			cases.push({ key: `${key}:${index}`, projectId: `project-${key}`, document, context, files: [...files].map(([path, content]) => [path, fnv(content)]) });
		} catch {
			skipped += 1;
		}
	}
}
const slugs = ["Shop", "  Café Ünï  ", "日本語", "", "---", "A B C", "x".repeat(80), "İstanbul", "Ǆ", "ﬁne", "a_b-c", "Straße"].map((name) => ({ name, slug: folderSlug(name), fallback: folderSlug(name, "project") }));
writeFileSync(join(import.meta.dir, "data/folder.json"), `${JSON.stringify({ slugs, cases })}\n`);
console.log(`folder: ${documents.size} documents, ${cases.length} renderings, ${skipped} skipped, ${slugs.length} slugs`);
