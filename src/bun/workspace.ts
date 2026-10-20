import type {
	AddTableAction,
	CreateProjectAction,
	Design,
	DesignTable,
	OpenProjectAction,
	ProjectSummary,
	WorkspaceState,
} from "../shared/design";
import { createPGliteSandbox, type SchemaSandbox } from "./sandbox";
import { generateDesignSql } from "./sql";
import { openDesignStore } from "./store";

export type DesignWorkspaceOptions = {
	databasePath: string;
	/** Narrowly controlled test override for sandbox I/O failures. */
	createSandbox?: () => SchemaSandbox;
	now?: () => number;
	createId?: () => string;
};

export type WorkspaceListener = (state: WorkspaceState) => void;

/**
 * The public design workspace interface. The React view and behavioral tests
 * use these actions and observable state instead of reaching into storage, SQL
 * generation, or sandbox orchestration.
 */
export interface DesignWorkspace {
	getState(): WorkspaceState;
	subscribe(listener: WorkspaceListener): () => void;
	listProjects(): ProjectSummary[];
	createProject(action: CreateProjectAction): Promise<WorkspaceState>;
	openProject(action: OpenProjectAction): Promise<WorkspaceState>;
	addTable(action: AddTableAction): Promise<WorkspaceState>;
	close(): Promise<void>;
}

export async function createDesignWorkspace(
	options: DesignWorkspaceOptions,
): Promise<DesignWorkspace> {
	const store = openDesignStore(options.databasePath);
	const createSandbox = options.createSandbox ?? createPGliteSandbox;
	const now = options.now ?? (() => Date.now());
	const createId = options.createId ?? (() => crypto.randomUUID());

	const listeners = new Set<WorkspaceListener>();
	let state: WorkspaceState = {
		projects: store.listProjects(),
		project: null,
		design: null,
		revision: 0,
		save: { status: "idle" },
		sql: { status: "empty", errors: [] },
		sandbox: { status: "idle" },
	};
	let activeProjectId: string | null = null;
	let lastGeneratableSql: { revision: number; sql: string } | null = null;
	let pending: Promise<unknown> = Promise.resolve();

	function setState(next: WorkspaceState) {
		state = next;
		for (const listener of listeners) listener(state);
	}

	function enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = pending.then(task, task);
		pending = run.catch(() => undefined);
		return run;
	}

	function isCurrent(projectId: string, revision: number) {
		return activeProjectId === projectId && state.revision === revision;
	}

	async function generateAndApply(projectId: string, revision: number, design: Design) {
		const generation = generateDesignSql(design);
		if (!generation.ok) {
			setState({
				...state,
				sql:
					lastGeneratableSql === null
						? { status: "empty", errors: generation.errors }
						: {
								status: "stale",
								revision,
								sql: lastGeneratableSql.sql,
								errors: generation.errors,
							},
			});
			return;
		}

		lastGeneratableSql = { revision, sql: generation.sql };
		setState({
			...state,
			sql: { status: "current", revision, sql: generation.sql },
			sandbox: { status: "applying", revision },
		});

		const sandbox = createSandbox();
		try {
			const result = await sandbox.apply(generation.sql);
			if (!isCurrent(projectId, revision)) return;
			setState({
				...state,
				sandbox: result.ok
					? {
							status: "applied",
							revision,
							tables: result.tables,
							sql: generation.sql,
						}
					: {
							status: "failed",
							revision,
							attemptedSql: generation.sql,
							error: result.error,
						},
			});
		} catch (error) {
			if (!isCurrent(projectId, revision)) return;
			setState({
				...state,
				sandbox: {
					status: "failed",
					revision,
					attemptedSql: generation.sql,
					error: error instanceof Error ? error.message : String(error),
				},
			});
		} finally {
			try {
				await sandbox.dispose();
			} catch (error) {
				console.error("[sandbox] failed to dispose preview", error);
			}
		}
	}

	async function persistAndPreview(projectId: string, revision: number, design: Design) {
		setState({ ...state, save: { status: "saving", revision } });
		const savedAt = now();
		try {
			store.saveDesign(projectId, design, revision, savedAt);
			if (isCurrent(projectId, revision)) {
				setState({
					...state,
					projects: store.listProjects(),
					save: { status: "saved", revision, savedAt },
				});
			}
		} catch (error) {
			if (isCurrent(projectId, revision)) {
				setState({
					...state,
					save: {
						status: "failed",
						revision,
						error: error instanceof Error ? error.message : String(error),
					},
				});
			}
		}
		await generateAndApply(projectId, revision, design);
	}

	const workspace: DesignWorkspace = {
		getState() {
			return state;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		listProjects() {
			return store.listProjects();
		},
		createProject(action) {
			return enqueue(async () => {
				const name = action.name.trim();
				if (name.length === 0) throw new Error("Project name is required.");

				const project: ProjectSummary = { id: createId(), name };
				const design: Design = { tables: [] };
				const revision = 1;
				const savedAt = now();

				store.createProject(project, design, revision, savedAt);
				activeProjectId = project.id;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project,
					design,
					revision,
					save: { status: "saved", revision, savedAt },
					sql: { status: "empty", errors: [] },
					sandbox: { status: "idle" },
				});
				await generateAndApply(project.id, revision, design);
				return state;
			});
		},
		openProject(action) {
			return enqueue(async () => {
				const record = store.loadProject(action.projectId);
				if (!record) throw new Error("That project could not be found.");

				activeProjectId = record.project.id;
				lastGeneratableSql = null;
				setState({
					projects: store.listProjects(),
					project: record.project,
					design: record.design,
					revision: record.revision,
					save: { status: "saved", revision: record.revision, savedAt: record.savedAt },
					sql: { status: "empty", errors: [] },
					sandbox: { status: "idle" },
				});
				await generateAndApply(record.project.id, record.revision, record.design);
				return state;
			});
		},
		addTable(action) {
			return enqueue(async () => {
				const project = state.project;
				const design = state.design;
				if (!project || !design || activeProjectId === null) {
					throw new Error("Open a project before adding a table.");
				}
				const name = action.name.trim();
				if (name.length === 0) throw new Error("Table name is required.");

				const revision = state.revision + 1;
				const nextDesign: Design = {
					...design,
					tables: [...design.tables, createDefaultTable(name, design, createId)],
				};
				setState({ ...state, design: nextDesign, revision });
				await persistAndPreview(project.id, revision, nextDesign);
				return state;
			});
		},
		async close() {
			await pending.catch(() => undefined);
			listeners.clear();
			store.close();
		},
	};

	const mostRecent = state.projects[0];
	if (mostRecent) {
		await workspace.openProject({ projectId: mostRecent.id });
	}

	return workspace;
}

function createDefaultTable(
	name: string,
	design: Design,
	createId: () => string,
): DesignTable {
	const index = design.tables.length;
	return {
		id: createId(),
		name,
		position: {
			x: 40 + (index % 3) * 300,
			y: 40 + Math.floor(index / 3) * 240,
		},
		columns: [
			{
				id: createId(),
				name: "id",
				type: "bigint",
				nullable: false,
				primaryKey: true,
				identity: true,
			},
		],
	};
}
