import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Design, ProjectSummary } from "../shared/design";

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
 * Local SQLite persistence for authoritative designs. Each project owns exactly
 * one design, written atomically so a partially written design is never read as
 * complete.
 */
export interface DesignStore {
	listProjects(): ProjectSummary[];
	createProject(project: ProjectSummary, design: Design, save: DesignSave): void | Promise<void>;
	saveDesign(projectId: string, design: Design, save: DesignSave): void | Promise<void>;
	loadProject(projectId: string): ProjectRecord | null;
	close(): void;
}

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
`;

export function openDesignStore(databasePath: string): DesignStore {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true });
	database.exec(SCHEMA);
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
