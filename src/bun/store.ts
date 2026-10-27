import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseDesignRecord, DatabaseDesignSummary, Design, EdgeFunction, ProjectSummary } from "../shared/design";

/**
 * A write of one stored design document. `revision` counts structural schema
 * edits, while `documentRevision` orders every write, including layout-only
 * ones, so a delayed older save can never replace a newer document.
 */
export type DesignSave = {
	revision: number;
	documentRevision: number;
	savedAt: number;
};

export interface ProjectRecord {
	project: ProjectSummary;
	design: Design;
	designId: string;
	revision: number;
	documentRevision: number;
	savedAt: number;
}

/**
 * Local SQLite persistence for project designs and independently saved
 * scenarios. Each design is written atomically so a partial save is never read
 * as complete.
 */
export interface DesignStore extends ScenarioStore, EdgeFunctionStore {
	listProjects(): ProjectSummary[];
	createProject(project: ProjectSummary, design: Design, save: DesignSave, designId: string): void | Promise<void>;
	/** Adds an independent database design to an existing project. */
	createDesign(projectId: string, designId: string, name: string, design: Design, save: DesignSave): void | Promise<void>;
	renameDesign(projectId: string, designId: string, name: string, savedAt: number): void | Promise<void>;
	saveDesign(projectId: string, design: Design, save: DesignSave, designId: string): void | Promise<void>;
	saveProjectArtifacts(input: {
		projectId: string;
		designId: string;
		design?: { design: Design; save: DesignSave };
		scenarios?: { scenarios: StoredScenario[]; save: ScenarioSave };
		edgeFunctions?: { edgeFunctions: EdgeFunction[]; save: ScenarioSave };
	}): void | Promise<void>;
	loadProject(projectId: string): ProjectRecord | null;
	listDesigns(projectId: string): DatabaseDesignSummary[];
	loadDesign(designId: string): DatabaseDesignRecord | null;
	close(): void;
}

export type ScenarioSave = { revision: number; savedAt: number };

export interface StoredScenario {
	id: string;
	name: string;
	source: string;
	designId?: string;
}

export type ScenarioDocumentRecord = {
	scenarios: StoredScenario[];
	revision: number;
	savedAt: number | null;
	designId?: string;
};

export interface ScenarioStore {
	loadScenarios(projectId: string, designId: string): ScenarioDocumentRecord;
	saveScenarios(
		projectId: string,
		scenarios: StoredScenario[],
		save: ScenarioSave,
		designId: string,
	): void | Promise<void>;
}

export interface EdgeFunctionStore {
	loadEdgeFunctions(projectId: string, designId: string): EdgeFunctionDocumentRecord;
	saveEdgeFunctions(
		projectId: string,
		edgeFunctions: EdgeFunction[],
		save: ScenarioSave,
		designId: string,
	): void | Promise<void>;
}

export type EdgeFunctionDocumentRecord = {
	edgeFunctions: EdgeFunction[];
	revision: number;
	savedAt: number | null;
	designId?: string;
};

type ProjectRow = {
	id: string;
	name: string;
	design_id: string;
	revision: number;
	document_revision: number;
	document: string;
	saved_at: number;
};

export type OpenDesignStoreOptions = {
	_testSimulateMigrationFailure?: boolean;
};

const SCHEMA = `
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;

	CREATE TABLE IF NOT EXISTS projects (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS designs (
		id TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		name TEXT NOT NULL DEFAULT '',
		revision INTEGER NOT NULL,
		document_revision INTEGER NOT NULL DEFAULT 0,
		document TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE INDEX IF NOT EXISTS idx_designs_project_id ON designs(project_id);

	CREATE TABLE IF NOT EXISTS scenarios (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		position INTEGER NOT NULL,
		name TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (design_id, id)
	);

	CREATE INDEX IF NOT EXISTS idx_scenarios_design_id ON scenarios(design_id);

	CREATE TABLE IF NOT EXISTS scenario_documents (
		design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS edge_functions (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		position INTEGER NOT NULL,
		name TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (design_id, id),
		UNIQUE (design_id, name)
	);

	CREATE INDEX IF NOT EXISTS idx_edge_functions_design_id ON edge_functions(design_id);

	CREATE TABLE IF NOT EXISTS edge_function_documents (
		design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
`;

/**
 * Schema version that scopes scenario and Edge function keys to their owning
 * Design. Version 1 (and unversioned databases) keyed them by Project, so two
 * Designs could not share a handler name or each keep a revision row.
 */
const DESIGN_SCOPED_ARTIFACTS_VERSION = 2;

export function openDesignStore(
	databasePath: string,
	options?: OpenDesignStoreOptions,
): DesignStore {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true });

	// Check if existing database requires migration to explicit design identity
	migrateToExplicitDesignIdentity(database, options);
	migrateDesignScopedArtifacts(database);

	database.exec(SCHEMA);
	database.exec(`PRAGMA user_version = ${DESIGN_SCOPED_ARTIFACTS_VERSION}`);

	const selectDesignByIdAndProject = database.query<{ id: string }, [string, string]>(
		`SELECT id FROM designs WHERE id = ? AND project_id = ?`,
	);
	const selectProjectById = database.query<{ id: string }, [string]>(`SELECT id FROM projects WHERE id = ?`);

	const listScenariosByDesign = database.query<{ id: string; name: string; source: string; design_id: string | null }, [string]>(`
		SELECT id, name, source, design_id FROM scenarios WHERE design_id = ? ORDER BY position ASC
	`);
	const selectScenarioDocumentByDesign = database.query<{ revision: number; updated_at: number; design_id: string | null }, [string]>(
		`SELECT revision, updated_at, design_id FROM scenario_documents WHERE design_id = ?`,
	);
	const deleteScenariosByDesign = database.query(`DELETE FROM scenarios WHERE design_id = ?`);
	const insertScenario = database.query(
		`INSERT INTO scenarios (project_id, design_id, id, position, name, source) VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const selectScenarioRevisionByDesign = database.query<{ revision: number }, [string]>(
		`SELECT revision FROM scenario_documents WHERE design_id = ?`,
	);
	const upsertScenarioRevision = database.query(
		`INSERT INTO scenario_documents (project_id, design_id, revision, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(design_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, project_id = excluded.project_id
		 WHERE scenario_documents.revision < excluded.revision`,
	);

	const saveScenariosTransaction = database.transaction(
		(projectId: string, scenarios: StoredScenario[], save: ScenarioSave, designId: string) => {
			const owner = selectDesignByIdAndProject.get(designId, projectId);
			if (!owner) {
				throw new Error(`Database design "${designId}" does not belong to project "${projectId}".`);
			}
			const current = selectScenarioRevisionByDesign.get(designId);
			if (current && current.revision >= save.revision) return;
			deleteScenariosByDesign.run(designId);
			scenarios.forEach((scenario, position) =>
				insertScenario.run(projectId, designId, scenario.id, position, scenario.name, scenario.source),
			);
			upsertScenarioRevision.run(projectId, designId, save.revision, save.savedAt);
			touchProject.run(save.savedAt, projectId);
		},
	);

	const listEdgeFunctionsByDesign = database.query<{ id: string; name: string; source: string; design_id: string | null }, [string]>(
		`SELECT id, name, source, design_id FROM edge_functions WHERE design_id = ? ORDER BY position ASC`,
	);
	const selectEdgeFunctionDocumentByDesign = database.query<{ revision: number; updated_at: number; design_id: string | null }, [string]>(
		`SELECT revision, updated_at, design_id FROM edge_function_documents WHERE design_id = ?`,
	);
	const selectEdgeFunctionRevisionByDesign = database.query<{ revision: number }, [string]>(
		`SELECT revision FROM edge_function_documents WHERE design_id = ?`,
	);
	const deleteEdgeFunctionsByDesign = database.query(`DELETE FROM edge_functions WHERE design_id = ?`);
	const insertEdgeFunction = database.query(
		`INSERT INTO edge_functions (project_id, design_id, id, position, name, source) VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const upsertEdgeFunctionRevision = database.query(
		`INSERT INTO edge_function_documents (project_id, design_id, revision, updated_at) VALUES (?, ?, ?, ?)
		 ON CONFLICT(design_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, project_id = excluded.project_id
		 WHERE edge_function_documents.revision < excluded.revision`,
	);
	const saveEdgeFunctionsTransaction = database.transaction(
		(projectId: string, edgeFunctions: EdgeFunction[], save: ScenarioSave, designId: string) => {
			const owner = selectDesignByIdAndProject.get(designId, projectId);
			if (!owner) {
				throw new Error(`Database design "${designId}" does not belong to project "${projectId}".`);
			}
			const current = selectEdgeFunctionRevisionByDesign.get(designId);
			if (current && current.revision >= save.revision) return;
			deleteEdgeFunctionsByDesign.run(designId);
			edgeFunctions.forEach((edgeFunction, position) =>
				insertEdgeFunction.run(projectId, designId, edgeFunction.id, position, edgeFunction.name, edgeFunction.source),
			);
			upsertEdgeFunctionRevision.run(projectId, designId, save.revision, save.savedAt);
			touchProject.run(save.savedAt, projectId);
		},
	);

	migrateDocumentRevision(database);

	const listProjects = database.query<{ id: string; name: string }, []>(
		`SELECT id, name FROM projects ORDER BY updated_at DESC, name ASC`,
	);
	const selectProject = database.query<ProjectRow, [string]>(`
		SELECT projects.id, projects.name, designs.id AS design_id, designs.revision, designs.document_revision,
			designs.document, designs.updated_at AS saved_at
		FROM projects
		JOIN designs ON designs.project_id = projects.id
		WHERE projects.id = ?
		ORDER BY designs.rowid ASC
		LIMIT 1
	`);
	const insertProject = database.query(
		`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
	);
	const insertDesign = database.query(
		`INSERT INTO designs (id, project_id, name, revision, document_revision, document, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateDesignByIdAndProject = database.query(
		`UPDATE designs SET revision = ?, document_revision = ?, document = ?, updated_at = ?
		 WHERE id = ? AND project_id = ? AND document_revision < ?`,
	);
	const listDesignsQuery = database.query<DatabaseDesignSummary, [string]>(
		`SELECT id, project_id AS projectId, name FROM designs WHERE project_id = ? ORDER BY rowid ASC`,
	);
	const selectDesignById = database.query<{
		id: string;
		project_id: string;
		name: string;
		revision: number;
		document_revision: number;
		document: string;
		updated_at: number;
	}, [string]>(
		`SELECT id, project_id, name, revision, document_revision, document, updated_at FROM designs WHERE id = ?`,
	);
	const touchProject = database.query(`UPDATE projects SET updated_at = ? WHERE id = ?`);

	const createProjectTransaction = database.transaction(
		(project: ProjectSummary, design: Design, save: DesignSave, designId: string) => {
			insertProject.run(project.id, project.name, save.savedAt, save.savedAt);
			insertDesign.run(
				designId,
				project.id,
				"",
				save.revision,
				save.documentRevision,
				JSON.stringify(design),
				save.savedAt,
			);
		},
	);

	const renameDesignByIdAndProject = database.query(
		`UPDATE designs SET name = ? WHERE id = ? AND project_id = ?`,
	);
	const createDesignTransaction = database.transaction(
		(projectId: string, designId: string, name: string, design: Design, save: DesignSave) => {
			if (!selectProjectById.get(projectId)) {
				throw new Error(`Project "${projectId}" does not exist.`);
			}
			insertDesign.run(
				designId,
				projectId,
				name,
				save.revision,
				save.documentRevision,
				JSON.stringify(design),
				save.savedAt,
			);
			touchProject.run(save.savedAt, projectId);
		},
	);
	const renameDesignTransaction = database.transaction(
		(projectId: string, designId: string, name: string, savedAt: number) => {
			const result = renameDesignByIdAndProject.run(name, designId, projectId);
			if (result.changes === 0) {
				throw new Error(`Database design "${designId}" does not belong to project "${projectId}".`);
			}
			touchProject.run(savedAt, projectId);
		},
	);

	const saveDesignTransaction = database.transaction(
		(projectId: string, design: Design, save: DesignSave, designId: string) => {
			const owner = selectDesignByIdAndProject.get(designId, projectId);
			if (!owner) {
				throw new Error(`Database design "${designId}" does not belong to project "${projectId}".`);
			}
			const result = updateDesignByIdAndProject.run(
				save.revision,
				save.documentRevision,
				JSON.stringify(design),
				save.savedAt,
				designId,
				projectId,
				save.documentRevision,
			);
			if (result.changes > 0) touchProject.run(save.savedAt, projectId);
		},
	);
	const saveProjectArtifactsTransaction = database.transaction(
		(input: {
			projectId: string;
			designId: string;
			design?: { design: Design; save: DesignSave };
			scenarios?: { scenarios: StoredScenario[]; save: ScenarioSave };
			edgeFunctions?: { edgeFunctions: EdgeFunction[]; save: ScenarioSave };
		}) => {
			if (!selectDesignByIdAndProject.get(input.designId, input.projectId)) {
				throw new Error(`Database design "${input.designId}" does not belong to project "${input.projectId}".`);
			}
			if (input.design) {
				const { design, save } = input.design;
				const result = updateDesignByIdAndProject.run(
					save.revision, save.documentRevision, JSON.stringify(design), save.savedAt,
					input.designId, input.projectId, save.documentRevision,
				);
				if (result.changes === 0) throw new Error("Stale design document revision during atomic save.");
				touchProject.run(save.savedAt, input.projectId);
			}
			if (input.scenarios) {
				const { scenarios, save } = input.scenarios;
				const current = selectScenarioRevisionByDesign.get(input.designId);
				if (current && current.revision >= save.revision) throw new Error("Stale scenario revision during atomic save.");
				deleteScenariosByDesign.run(input.designId);
				scenarios.forEach((scenario, position) =>
					insertScenario.run(input.projectId, input.designId, scenario.id, position, scenario.name, scenario.source),
				);
				upsertScenarioRevision.run(input.projectId, input.designId, save.revision, save.savedAt);
				touchProject.run(save.savedAt, input.projectId);
			}
			if (input.edgeFunctions) {
				const { edgeFunctions, save } = input.edgeFunctions;
				const current = selectEdgeFunctionRevisionByDesign.get(input.designId);
				if (current && current.revision >= save.revision) throw new Error("Stale edge function revision during atomic save.");
				deleteEdgeFunctionsByDesign.run(input.designId);
				edgeFunctions.forEach((edgeFunction, position) =>
					insertEdgeFunction.run(input.projectId, input.designId, edgeFunction.id, position, edgeFunction.name, edgeFunction.source),
				);
				upsertEdgeFunctionRevision.run(input.projectId, input.designId, save.revision, save.savedAt);
				touchProject.run(save.savedAt, input.projectId);
			}
		},
	);


	return {
		listProjects() {
			return listProjects.all();
		},
		createProject(project, design, save, designId) {
			createProjectTransaction(project, design, save, designId);
		},
		createDesign(projectId, designId, name, design, save) {
			createDesignTransaction(projectId, designId, name, design, save);
		},
		renameDesign(projectId, designId, name, savedAt) {
			renameDesignTransaction(projectId, designId, name, savedAt);
		},
		saveDesign(projectId, design, save, designId) {
			saveDesignTransaction(projectId, design, save, designId);
		},
		saveProjectArtifacts(input) {
			saveProjectArtifactsTransaction(input);
		},
		loadProject(projectId) {
			const row = selectProject.get(projectId);
			if (!row) return null;
			return {
				project: { id: row.id, name: row.name },
				design: JSON.parse(row.document) as Design,
				designId: row.design_id,
				revision: row.revision,
				documentRevision: row.document_revision,
				savedAt: row.saved_at,
			};
		},
		listDesigns(projectId) {
			return listDesignsQuery.all(projectId);
		},
		loadDesign(designId) {
			const row = selectDesignById.get(designId);
			if (!row) return null;
			return {
				id: row.id,
				projectId: row.project_id,
				name: row.name,
				design: JSON.parse(row.document) as Design,
				revision: row.revision,
				documentRevision: row.document_revision,
				savedAt: row.updated_at,
			};
		},
		loadScenarios(projectId, designId) {
			const owner = selectDesignByIdAndProject.get(designId, projectId);
			if (!owner) {
				throw new Error(`Database design "${designId}" does not belong to project "${projectId}".`);
			}
			const scenarios = listScenariosByDesign.all(designId);
			const document = selectScenarioDocumentByDesign.get(designId);
			return {
				scenarios: scenarios.map((scenario) => ({
					id: scenario.id,
					name: scenario.name,
					source: scenario.source,
					designId: scenario.design_id ?? designId,
				})),
				revision: document?.revision ?? 0,
				savedAt: document?.updated_at ?? null,
				designId,
			};
		},
		saveScenarios(projectId, scenarios, save, designId) {
			saveScenariosTransaction(projectId, scenarios, save, designId);
		},
		loadEdgeFunctions(projectId, designId) {
			const owner = selectDesignByIdAndProject.get(designId, projectId);
			if (!owner) {
				throw new Error(`Database design "${designId}" does not belong to project "${projectId}".`);
			}
			const edgeFunctions = listEdgeFunctionsByDesign.all(designId);
			const document = selectEdgeFunctionDocumentByDesign.get(designId);
			return {
				edgeFunctions: edgeFunctions.map((edgeFunction) => ({
					id: edgeFunction.id,
					name: edgeFunction.name,
					source: edgeFunction.source,
					designId: edgeFunction.design_id ?? designId,
				})),
				revision: document?.revision ?? 0,
				savedAt: document?.updated_at ?? null,
				designId,
			};
		},
		saveEdgeFunctions(projectId, edgeFunctions, save, designId) {
			saveEdgeFunctionsTransaction(projectId, edgeFunctions, save, designId);
		},
		close() {
			database.close();
		},
	};
}

/**
 * Transactionally migrates legacy databases where designs table had no `id` column.
 * Assigns each existing design a stable UUID and associates existing scenarios
 * and edge functions with that owning design.
 * If any step fails, bun:sqlite transaction automatically rolls back leaving the
 * database in its original legacy state.
 */
function migrateToExplicitDesignIdentity(database: Database, options?: OpenDesignStoreOptions) {
	const tables = database.query<{ name: string }, []>(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'designs'`,
	).all();
	if (tables.length === 0) return;

	const columns = database.query<{ name: string }, []>(`PRAGMA table_info(designs)`).all();
	const hasIdColumn = columns.some((column) => column.name === "id");
	if (hasIdColumn) return;

	const hasDocRevision = columns.some((column) => column.name === "document_revision");

	const runMigration = database.transaction(() => {
		database.exec(`
			CREATE TABLE designs_migrating (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				name TEXT NOT NULL DEFAULT '',
				revision INTEGER NOT NULL,
				document_revision INTEGER NOT NULL DEFAULT 0,
				document TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);
		`);

		const oldDesigns = hasDocRevision
			? database.query<{
					project_id: string;
					revision: number;
					document_revision: number;
					document: string;
					updated_at: number;
			  }, []>(`SELECT project_id, revision, document_revision, document, updated_at FROM designs`).all()
			: database.query<{
					project_id: string;
					revision: number;
					document: string;
					updated_at: number;
			  }, []>(`SELECT project_id, revision, document, updated_at FROM designs`).all().map((r) => ({
					...r,
					document_revision: r.revision,
			  }));

		const projectDesignMap = new Map<string, string>();
		const insertNewDesign = database.query(
			`INSERT INTO designs_migrating (id, project_id, name, revision, document_revision, document, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		);

		for (const row of oldDesigns) {
			const designId = crypto.randomUUID();
			projectDesignMap.set(row.project_id, designId);
			insertNewDesign.run(
				designId,
				row.project_id,
				"",
				row.revision,
				row.document_revision,
				row.document,
				row.updated_at,
			);
		}

		if (options?._testSimulateMigrationFailure) {
			throw new Error("Simulated migration failure");
		}

		// Update scenarios if table exists
		const allTables = database.query<{ name: string }, []>(
			`SELECT name FROM sqlite_master WHERE type = 'table'`,
		).all();
		const tableNames = new Set(allTables.map((t) => t.name));

		if (tableNames.has("scenarios")) {
			const scenarioCols = database.query<{ name: string }, []>(`PRAGMA table_info(scenarios)`).all();
			if (!scenarioCols.some((c) => c.name === "design_id")) {
				database.exec(`ALTER TABLE scenarios ADD COLUMN design_id TEXT`);
			}
			const updateScenario = database.query(`UPDATE scenarios SET design_id = ? WHERE project_id = ?`);
			for (const [projectId, designId] of projectDesignMap) {
				updateScenario.run(designId, projectId);
			}
		}

		if (tableNames.has("scenario_documents")) {
			const docCols = database.query<{ name: string }, []>(`PRAGMA table_info(scenario_documents)`).all();
			if (!docCols.some((c) => c.name === "design_id")) {
				database.exec(`ALTER TABLE scenario_documents ADD COLUMN design_id TEXT`);
			}
			const updateDoc = database.query(`UPDATE scenario_documents SET design_id = ? WHERE project_id = ?`);
			for (const [projectId, designId] of projectDesignMap) {
				updateDoc.run(designId, projectId);
			}
		}

		if (tableNames.has("edge_functions")) {
			const efCols = database.query<{ name: string }, []>(`PRAGMA table_info(edge_functions)`).all();
			if (!efCols.some((c) => c.name === "design_id")) {
				database.exec(`ALTER TABLE edge_functions ADD COLUMN design_id TEXT`);
			}
			const updateEf = database.query(`UPDATE edge_functions SET design_id = ? WHERE project_id = ?`);
			for (const [projectId, designId] of projectDesignMap) {
				updateEf.run(designId, projectId);
			}
		}

		if (tableNames.has("edge_function_documents")) {
			const efDocCols = database.query<{ name: string }, []>(`PRAGMA table_info(edge_function_documents)`).all();
			if (!efDocCols.some((c) => c.name === "design_id")) {
				database.exec(`ALTER TABLE edge_function_documents ADD COLUMN design_id TEXT`);
			}
			const updateEfDoc = database.query(`UPDATE edge_function_documents SET design_id = ? WHERE project_id = ?`);
			for (const [projectId, designId] of projectDesignMap) {
				updateEfDoc.run(designId, projectId);
			}
		}

		database.exec(`DROP TABLE designs`);
		database.exec(`ALTER TABLE designs_migrating RENAME TO designs`);
		database.exec(`CREATE INDEX IF NOT EXISTS idx_designs_project_id ON designs(project_id)`);
		if (tableNames.has("scenarios")) {
			database.exec(`CREATE INDEX IF NOT EXISTS idx_scenarios_design_id ON scenarios(design_id)`);
		}
		if (tableNames.has("edge_functions")) {
			database.exec(`CREATE INDEX IF NOT EXISTS idx_edge_functions_design_id ON edge_functions(design_id)`);
		}
	});

	runMigration();
}

/**
 * Databases written before layout-only saves existed have no document revision.
 * Their stored revision is a safe starting point for write ordering.
 */
function migrateDocumentRevision(database: Database) {
	const columns = database.query<{ name: string }, []>(`PRAGMA table_info(designs)`).all();
	if (columns.some((column) => column.name === "document_revision")) return;
	database.exec(
		`ALTER TABLE designs ADD COLUMN document_revision INTEGER NOT NULL DEFAULT 0`,
	);
	database.exec(`UPDATE designs SET document_revision = revision WHERE document_revision = 0`);
}

/**
 * Re-keys scenario and Edge function storage by owning Design (version 2).
 * Earlier databases keyed each document row by Project and made Edge function
 * names unique per Project, so a second Design could neither keep its own
 * revision nor reuse a handler name. Rows whose Design is missing are attached
 * to the Project's first Design, the owner earlier migrations already assigned.
 * The DDL below is the frozen version-2 shape and is independent of SCHEMA.
 */
function migrateDesignScopedArtifacts(database: Database) {
	const version = database.query<{ user_version: number }, []>(`PRAGMA user_version`).get()?.user_version ?? 0;
	if (version >= DESIGN_SCOPED_ARTIFACTS_VERSION) return;

	const tableNames = new Set(
		database.query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((table) => table.name),
	);
	// A database without a designs table is new; SCHEMA creates the scoped tables directly.
	if (!tableNames.has("designs")) return;

	const migrations: Array<{ table: string; columns: string[]; ddl: string }> = [
		{
			table: "scenarios",
			columns: ["project_id", "id", "position", "name", "source"],
			ddl: `(
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				position INTEGER NOT NULL,
				name TEXT NOT NULL,
				source TEXT NOT NULL,
				PRIMARY KEY (design_id, id)
			)`,
		},
		{
			table: "scenario_documents",
			columns: ["project_id", "revision", "updated_at"],
			ddl: `(
				design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
		},
		{
			table: "edge_functions",
			columns: ["project_id", "id", "position", "name", "source"],
			ddl: `(
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				design_id TEXT REFERENCES designs(id) ON DELETE CASCADE,
				id TEXT NOT NULL,
				position INTEGER NOT NULL,
				name TEXT NOT NULL,
				source TEXT NOT NULL,
				PRIMARY KEY (design_id, id),
				UNIQUE (design_id, name)
			)`,
		},
		{
			table: "edge_function_documents",
			columns: ["project_id", "revision", "updated_at"],
			ddl: `(
				design_id TEXT PRIMARY KEY REFERENCES designs(id) ON DELETE CASCADE,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)`,
		},
	];

	database.transaction(() => {
		for (const { table, columns, ddl } of migrations) {
			if (!tableNames.has(table)) continue;
			const existing = new Set(
				database.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name),
			);
			const firstDesign = `(SELECT d.id FROM designs d WHERE d.project_id = t.project_id ORDER BY d.rowid LIMIT 1)`;
			const owner = existing.has("design_id") ? `COALESCE(t.design_id, ${firstDesign})` : firstDesign;
			const staging = `${table}_design_scoped`;
			database.exec(`DROP TABLE IF EXISTS ${staging}`);
			database.exec(`CREATE TABLE ${staging} ${ddl}`);
			database.exec(`
				INSERT INTO ${staging} (design_id, ${columns.join(", ")})
				SELECT owner_id, ${columns.join(", ")} FROM (
					SELECT ${owner} AS owner_id, ${columns.map((column) => `t.${column}`).join(", ")} FROM ${table} t
				) WHERE owner_id IS NOT NULL
			`);
			database.exec(`DROP TABLE ${table}`);
			database.exec(`ALTER TABLE ${staging} RENAME TO ${table}`);
		}
	})();
}
