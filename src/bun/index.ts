import { BrowserWindow, Screen, Updater, Utils } from "electrobun/main";
import { defineElectrobunRPC } from "electrobun/rpc";
import { join } from "node:path";
import type { AppRPCSchema, SqlWindowRPCSchema } from "../shared/rpc";
import type { WorkspaceState } from "../shared/design";
import { createDesignWorkspace } from "./workspace";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

// Check if Vite dev server is running for HMR. Both windows are pages of the
// same Vite build: the design view (index.html) and the SQL preview (sql.html).
async function getViewUrl(page: "index.html" | "sql.html"): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return `${DEV_SERVER_URL}/${page}`;
		} catch {
			console.log(
				"Vite dev server not running. Run 'hutch run dev:hmr' for HMR support.",
			);
		}
	}
	return `views://mainview/${page}`;
}

const databasePath =
	process.env.DB_PLANNER_DATABASE_PATH ??
	join(Utils.paths.userData, "schema-designer.sqlite");

// Keep the authoritative design and the disposable sandbox behind one public
// workspace interface. The view only sees this interface through typed RPC.
const workspacePromise = createDesignWorkspace({ databasePath });

let sqlWindow: BrowserWindow | null = null;
let sqlWindowRpc: { send: { workspaceState: (state: WorkspaceState) => void } } | null =
	null;
let sqlWindowCreation: Promise<void> | null = null;
let mainWindowClosing = false;

function openSqlWindow(): Promise<void> {
	if (sqlWindow) {
		sqlWindow.show();
		sqlWindow.activate();
		return Promise.resolve();
	}
	if (sqlWindowCreation) return sqlWindowCreation;
	sqlWindowCreation = createSqlWindow().finally(() => {
		sqlWindowCreation = null;
	});
	return sqlWindowCreation;
}

async function createSqlWindow(): Promise<void> {
	const url = await getViewUrl("sql.html");
	if (mainWindowClosing) return;
	const sqlRpc = defineElectrobunRPC<SqlWindowRPCSchema, "bun">("bun", {
		maxRequestTime: 60_000,
		handlers: {
			requests: {
				getWorkspaceState: async () => (await workspacePromise).getState(),
				copyText: ({ text }) => Utils.clipboardWriteText(text),
			},
		},
	});
	const window = new BrowserWindow({
		title: "SQL preview — Schema Designer",
		url,
		frame: sqlWindowFrame(),
		rpc: sqlRpc,
	});
	sqlWindow = window;
	sqlWindowRpc = sqlRpc;
	window.on("close", () => {
		if (sqlWindow === window) {
			sqlWindow = null;
			sqlWindowRpc = null;
		}
	});
}

/**
 * Beside the design window when the screen has room, otherwise against the
 * right edge of the work area, so the preview never opens off screen.
 */
function sqlWindowFrame() {
	const width = 720;
	const height = 820;
	const main = mainWindow.getFrame();
	const area = Screen.getPrimaryDisplay().workArea;
	let x = main.x + main.width + 16;
	let y = main.y;
	if (area.width > 0) {
		x = Math.max(area.x, Math.min(x, area.x + area.width - width));
		y = Math.max(area.y, Math.min(y, area.y + area.height - height));
	}
	return { x, y, width, height: area.height > 0 ? Math.min(height, area.height) : height };
}

const rpc = defineElectrobunRPC<AppRPCSchema, "bun">("bun", {
	maxRequestTime: 60_000,
	handlers: {
		requests: {
			openSqlWindow: async () => openSqlWindow(),
			getWorkspaceState: async () => (await workspacePromise).getState(),
			createProject: async ({ name }) => (await workspacePromise).createProject({ name }),
			openProject: async ({ projectId }) =>
				(await workspacePromise).openProject({ projectId }),
			addTable: async ({ name, position }) =>
				(await workspacePromise).addTable({ name, position }),
			renameTable: async ({ tableId, name }) =>
				(await workspacePromise).renameTable({ tableId, name }),
			removeTable: async ({ tableId, confirmed }) =>
				(await workspacePromise).removeTable({ tableId, confirmed }),
			moveTable: async ({ tableId, position }) =>
				(await workspacePromise).moveTable({ tableId, position }),
			addColumn: async ({ tableId, name, type }) =>
				(await workspacePromise).addColumn({ tableId, name, type }),
			updateColumn: async ({ tableId, columnId, changes }) =>
				(await workspacePromise).updateColumn({ tableId, columnId, changes }),
			removeColumn: async ({ tableId, columnId, confirmed }) =>
				(await workspacePromise).removeColumn({ tableId, columnId, confirmed }),
			addRelationship: async ({ referencingTableId, referencedTableId, cardinality }) =>
				(await workspacePromise).addRelationship({
					referencingTableId,
					referencedTableId,
					cardinality,
				}),
			updateRelationship: async ({ relationshipId, required, cardinality }) =>
				(await workspacePromise).updateRelationship({
					relationshipId,
					required,
					cardinality,
				}),
			removeRelationship: async ({ relationshipId }) =>
				(await workspacePromise).removeRelationship({ relationshipId }),
			describeRemoval: async (target) =>
				(await workspacePromise).describeRemoval(target),
			setViewport: async (viewport) => (await workspacePromise).setViewport(viewport),
		},
	},
});

const url = await getViewUrl("index.html");

const mainWindow = new BrowserWindow({
	title: "Schema Designer",
	url,
	frame: {
		width: 1280,
		height: 800,
		x: 160,
		y: 120,
	},
	rpc,
});

mainWindow.on("close", () => {
	mainWindowClosing = true;
	sqlWindow?.close();
});

void workspacePromise
	.then((workspace) => {
		const state = workspace.getState();
		console.log(
			`[workspace] database=${databasePath} project=${state.project?.name ?? "none"} sql=${state.sql.status} sandbox=${state.sandbox.status}`,
		);
		workspace.subscribe((next) => {
			rpc.send.workspaceState(next);
			sqlWindowRpc?.send.workspaceState(next);
		});
	})
	.catch((error: unknown) => {
		console.error("[workspace] failed to initialize", error);
	});

console.log("Schema Designer started!", mainWindow.id);
