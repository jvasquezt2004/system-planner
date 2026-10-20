import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Design, ProjectSummary } from "../shared/design";

export interface ProjectRecord {
	project: ProjectSummary;
	design: Design;
	revision: number;
	savedAt: number;
}

/**
 * Local SQLite persistence for authoritative designs. Each project owns exactly
 * one design, written atomically so a partially written design is never read as
 * complete.
 */
export interface DesignStore {
	listProjects(): ProjectSummary[];
	createProject(
		project: ProjectSummary,
		design: Design,
		revision: number,
		savedAt: number,
	): void | Promise<void>;
	saveDesign(
		projectId: string,
		design: Design,
		revision: number,
		savedAt: number,
	): void | Promise<void>;
	loadProject(projectId: string): ProjectRecord | null;
	close(): void;
}

type ProjectRow = {
	id: string;
	name: string;
	revision: number;
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
		document TEXT NOT NULL,
		updated_at INTEGER NOT NULL
	);
`;

export function openDesignStore(databasePath: string): DesignStore {
	mkdirSync(dirname(databasePath), { recursive: true });
	const database = new Database(databasePath, { create: true });
	database.exec(SCHEMA);

	const listProjects = database.query<{ id: string; name: string }, []>(
		`SELECT id, name FROM projects ORDER BY updated_at DESC, name ASC`,
	);
	const selectProject = database.query<ProjectRow, [string]>(`
		SELECT projects.id, projects.name, designs.revision, designs.document, designs.updated_at AS saved_at
		FROM projects
		JOIN designs ON designs.project_id = projects.id
		WHERE projects.id = ?
	`);
	const insertProject = database.query(
		`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
	);
	const insertDesign = database.query(
		`INSERT INTO designs (project_id, revision, document, updated_at) VALUES (?, ?, ?, ?)`,
	);
	const updateDesign = database.query(
		`UPDATE designs SET revision = ?, document = ?, updated_at = ? WHERE project_id = ? AND revision < ?`,
	);
	const touchProject = database.query(`UPDATE projects SET updated_at = ? WHERE id = ?`);

	const createProjectTransaction = database.transaction(
		(project: ProjectSummary, design: Design, revision: number, savedAt: number) => {
			insertProject.run(project.id, project.name, savedAt, savedAt);
			insertDesign.run(project.id, revision, JSON.stringify(design), savedAt);
		},
	);

	const saveDesignTransaction = database.transaction(
		(projectId: string, design: Design, revision: number, savedAt: number) => {
			// A delayed save must never overwrite a newer design that already landed.
			const result = updateDesign.run(
				revision,
				JSON.stringify(design),
				savedAt,
				projectId,
				revision,
			);
			if (result.changes > 0) touchProject.run(savedAt, projectId);
		},
	);

	return {
		listProjects() {
			return listProjects.all();
		},
		createProject(project, design, revision, savedAt) {
			createProjectTransaction(project, design, revision, savedAt);
		},
		saveDesign(projectId, design, revision, savedAt) {
			saveDesignTransaction(projectId, design, revision, savedAt);
		},
		loadProject(projectId) {
			const row = selectProject.get(projectId);
			if (!row) return null;
			return {
				project: { id: row.id, name: row.name },
				design: JSON.parse(row.document) as Design,
				revision: row.revision,
				savedAt: row.saved_at,
			};
		},
		close() {
			database.close();
		},
	};
}
