import { createDesignWorkspace } from "../src/bun/workspace";

const databasePath = process.argv[2];
if (!databasePath) {
	console.error("Usage: bun scripts/seed-smoke-database.ts <database-path>");
	process.exit(1);
}

const workspace = await createDesignWorkspace({ databasePath });
await workspace.createProject({ name: "Smoke Library" });
const state = await workspace.addTable({ name: "Books" });
console.log(
	JSON.stringify({
		project: state.project?.name,
		sql: state.sql.status,
		sandbox: state.sandbox.status,
	}),
);
await workspace.close();
