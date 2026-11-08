import type { DesignStore } from "../../../src/bun/store";

/**
 * A complete, ordered reading of a store through its public loaders. The Rust
 * store must produce the identical document from the same database.
 */
export function dumpStore(store: DesignStore) {
	return store.listProjects().map((project) => ({
		summary: project,
		project: store.loadProject(project.id),
		designs: store.listDesigns(project.id).map((summary) => ({
			summary,
			record: store.loadDesign(summary.id),
			scenarios: store.loadScenarios(project.id, summary.id),
			edgeFunctions: store.loadEdgeFunctions(project.id, summary.id),
		})),
		systemDesign: store.loadSystemDesign(project.id),
		walkthroughs: store.loadWalkthroughs(project.id),
	}));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Migrations mint random UUIDs. Replacing each distinct one with `<uuid#n>`, in
 * order of first appearance over a traversal with sorted object keys, makes two
 * runs comparable while still proving that references to the same id agree.
 */
export function normalizeUuids(value: unknown): unknown {
	const seen = new Map<string, string>();
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") {
			if (!UUID.test(node)) return node;
			if (!seen.has(node)) seen.set(node, `<uuid#${seen.size + 1}>`);
			return seen.get(node)!;
		}
		if (Array.isArray(node)) return node.map(visit);
		if (node && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(node).sort()) out[key] = visit((node as Record<string, unknown>)[key]);
			return out;
		}
		return node;
	};
	return visit(value);
}
