-- Designs have ids but no document_revision column yet. The stored revision becomes
-- the document revision. No scenario tables at all.
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE designs (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	name TEXT NOT NULL DEFAULT '',
	revision INTEGER NOT NULL,
	document TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
INSERT INTO projects VALUES ('proj-x', 'Old', 10, 20);
INSERT INTO designs VALUES ('design-x', 'proj-x', 'Main', 6, '{"tables":[]}', 20);
