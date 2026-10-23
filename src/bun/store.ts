import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Design, EdgeFunction, ProjectSummary } from "../shared/design";

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
	createProject(project: ProjectSummary, design: Design, save: DesignSave): void | Promise<void>;
	saveDesign(projectId: string, design: Design, save: DesignSave): void | Promise<void>;
	loadProject(projectId: string): ProjectRecord | null;
	close(): void;
}

export type ScenarioSave = { revision: number; savedAt: number };

export interface StoredScenario {
	id: string;
	name: string;
	source: string;
}

export type ScenarioDocumentRecord = {
	scenarios: StoredScenario[];
	revision: number;
	savedAt: number | null;
};

export interface ScenarioStore {
	loadScenarios(projectId: string): ScenarioDocumentRecord;
	saveScenarios(
		projectId: string,
		scenarios: StoredScenario[],
		save: ScenarioSave,
	): void | Promise<void>;
}

export interface EdgeFunctionStore {
	loadEdgeFunctions(projectId: string): EdgeFunctionDocumentRecord;
	saveEdgeFunctions(
		projectId: string,
		edgeFunctions: EdgeFunction[],
		save: ScenarioSave,
	): void | Promise<void>;
}

export type EdgeFunctionDocumentRecord = {
	edgeFunctions: EdgeFunction[];
	revision: number;
	savedAt: number | null;
};



type ProjectRow = {
	id: string;
	name: string;
	revision: number;
	document_revision: number;
	document: string;
	saved_at: number;
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
		project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		document_revision INTEGER NOT NULL DEFAULT 0,
		document TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS scenarios (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		position INTEGER NOT NULL,
		name TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (project_id, id)
	);

	CREATE TABLE IF NOT EXISTS scenario_documents (
		project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS edge_functions (
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		id TEXT NOT NULL,
		position INTEGER NOT NULL,
		name TEXT NOT NULL,
		source TEXT NOT NULL,
		PRIMARY KEY (project_id, id),
		UNIQUE (project_id, name)
	);

	CREATE TABLE IF NOT EXISTS edge_function_documents (
		project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
		revision INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	);
`;

export function openDesignStore(databasePath: string): DesignStore {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true });
	database.exec(SCHEMA);
	const listScenarios = database.query<StoredScenario, [string]>(`
		SELECT id, name, source FROM scenarios WHERE project_id = ? ORDER BY position ASC
	`);
	const selectScenarioDocument = database.query<{ revision: number; updated_at: number }, [string]>(
		`SELECT revision, updated_at FROM scenario_documents WHERE project_id = ?`,
	);
	const deleteScenarios = database.query(`DELETE FROM scenarios WHERE project_id = ?`);
	const insertScenario = database.query(
		`INSERT INTO scenarios (project_id, id, position, name, source) VALUES (?, ?, ?, ?, ?)`,
	);
	const selectScenarioRevision = database.query<{ revision: number }, [string]>(
		`SELECT revision FROM scenario_documents WHERE project_id = ?`,
	);
	const upsertScenarioRevision = database.query(
		`INSERT INTO scenario_documents (project_id, revision, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
		 WHERE scenario_documents.revision < excluded.revision`,
	);

	const saveScenariosTransaction = database.transaction(
		(projectId: string, scenarios: StoredScenario[], save: ScenarioSave) => {
			const current = selectScenarioRevision.get(projectId);
			if (current && current.revision >= save.revision) return;
			deleteScenarios.run(projectId);
			scenarios.forEach((scenario, position) =>
				insertScenario.run(projectId, scenario.id, position, scenario.name, scenario.source),
			);
			upsertScenarioRevision.run(projectId, save.revision, save.savedAt);
			touchProject.run(save.savedAt, projectId);
		},
	);

	const listEdgeFunctions = database.query<EdgeFunction, [string]>(
		`SELECT id, name, source FROM edge_functions WHERE project_id = ? ORDER BY position ASC`,
	);
	const selectEdgeFunctionDocument = database.query<{ revision: number; updated_at: number }, [string]>(
		`SELECT revision, updated_at FROM edge_function_documents WHERE project_id = ?`,
	);
	const selectEdgeFunctionRevision = database.query<{ revision: number }, [string]>(
		`SELECT revision FROM edge_function_documents WHERE project_id = ?`,
	);
	const deleteEdgeFunctions = database.query(`DELETE FROM edge_functions WHERE project_id = ?`);
	const insertEdgeFunction = database.query(
		`INSERT INTO edge_functions (project_id, id, position, name, source) VALUES (?, ?, ?, ?, ?)`,
	);
	const upsertEdgeFunctionRevision = database.query(
		`INSERT INTO edge_function_documents (project_id, revision, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(project_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
		 WHERE edge_function_documents.revision < excluded.revision`,
	);
	const saveEdgeFunctionsTransaction = database.transaction(
		(projectId: string, edgeFunctions: EdgeFunction[], save: ScenarioSave) => {
			const current = selectEdgeFunctionRevision.get(projectId);
			if (current && current.revision >= save.revision) return;
			deleteEdgeFunctions.run(projectId);
			edgeFunctions.forEach((edgeFunction, position) =>
				insertEdgeFunction.run(projectId, edgeFunction.id, position, edgeFunction.name, edgeFunction.source),
			);
			upsertEdgeFunctionRevision.run(projectId, save.revision, save.savedAt);
			touchProject.run(save.savedAt, projectId);
		},
	);

	migrateDocumentRevision(database);

	const listProjects = database.query<{ id: string; name: string }, []>(
		`SELECT id, name FROM projects ORDER BY updated_at DESC, name ASC`,
	);
	const selectProject = database.query<ProjectRow, [string]>(`
		SELECT projects.id, projects.name, designs.revision, designs.document_revision,
			designs.document, designs.updated_at AS saved_at
		FROM projects
		JOIN designs ON designs.project_id = projects.id
		WHERE projects.id = ?
	`);
	const insertProject = database.query(
		`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
	);
	const insertDesign = database.query(
		`INSERT INTO designs (project_id, revision, document_revision, document, updated_at)
		 VALUES (?, ?, ?, ?, ?)`,
	);
	const updateDesign = database.query(
		`UPDATE designs SET revision = ?, document_revision = ?, document = ?, updated_at = ?
		 WHERE project_id = ? AND document_revision < ?`,
	);
	const touchProject = database.query(`UPDATE projects SET updated_at = ? WHERE id = ?`);

	const createProjectTransaction = database.transaction(
		(project: ProjectSummary, design: Design, save: DesignSave) => {
			insertProject.run(project.id, project.name, save.savedAt, save.savedAt);
			insertDesign.run(
				project.id,
				save.revision,
				save.documentRevision,
				JSON.stringify(design),
				save.savedAt,
			);
		},
	);

	const saveDesignTransaction = database.transaction(
		(projectId: string, design: Design, save: DesignSave) => {
			// A delayed save must never overwrite a newer design that already landed.
			const result = updateDesign.run(
				save.revision,
				save.documentRevision,
				JSON.stringify(design),
				save.savedAt,
				projectId,
				save.documentRevision,
			);
			if (result.changes > 0) touchProject.run(save.savedAt, projectId);
		},
	);

	return {
		listProjects() {
			return listProjects.all();
		},
		createProject(project, design, save) {
			createProjectTransaction(project, design, save);
		},
		saveDesign(projectId, design, save) {
			saveDesignTransaction(projectId, design, save);
		},
		loadProject(projectId) {
			const row = selectProject.get(projectId);
			if (!row) return null;
			return {
				project: { id: row.id, name: row.name },
				design: JSON.parse(row.document) as Design,
				revision: row.revision,
				documentRevision: row.document_revision,
				savedAt: row.saved_at,
			};
		},
		loadScenarios(projectId) {
			const document = selectScenarioDocument.get(projectId);
			return {
				scenarios: listScenarios.all(projectId),
				revision: document?.revision ?? 0,
				savedAt: document?.updated_at ?? null,
			};
		},
		saveScenarios(projectId, scenarios, save) {
			saveScenariosTransaction(projectId, scenarios, save);
		},
		loadEdgeFunctions(projectId) {
			const document = selectEdgeFunctionDocument.get(projectId);
			return {
				edgeFunctions: listEdgeFunctions.all(projectId),
				revision: document?.revision ?? 0,
				savedAt: document?.updated_at ?? null,
			};
		},
		saveEdgeFunctions(projectId, edgeFunctions, save) {
			saveEdgeFunctionsTransaction(projectId, edgeFunctions, save);
		},
		close() {
			database.close();
		},
	};

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
