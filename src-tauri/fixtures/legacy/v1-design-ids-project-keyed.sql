-- After designs gained ids and document revisions, but before scenarios and Edge
-- functions were keyed by Design. A Project can already hold several Designs, so
-- rows with no design_id belong to the Project's first Design, and two Designs
-- can never share an Edge function name yet.
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
	document_revision INTEGER NOT NULL DEFAULT 0,
	document TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE scenarios (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	design_id TEXT,
	id TEXT NOT NULL,
	position INTEGER NOT NULL,
	name TEXT NOT NULL,
	source TEXT NOT NULL,
	PRIMARY KEY (project_id, id)
);
CREATE TABLE scenario_documents (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	design_id TEXT,
	revision INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE edge_functions (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	design_id TEXT,
	id TEXT NOT NULL,
	position INTEGER NOT NULL,
	name TEXT NOT NULL,
	source TEXT NOT NULL,
	PRIMARY KEY (project_id, id),
	UNIQUE (project_id, name)
);
CREATE TABLE edge_function_documents (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	design_id TEXT,
	revision INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE system_designs (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	document TEXT NOT NULL,
	revision INTEGER NOT NULL,
	document_revision INTEGER NOT NULL,
	last_view TEXT NOT NULL DEFAULT 'system',
	updated_at INTEGER NOT NULL
);

INSERT INTO projects VALUES ('proj-a', 'Shop', 1000, 5000);
INSERT INTO projects VALUES ('proj-b', 'Notes', 1500, 4000);

INSERT INTO designs VALUES ('design-a1', 'proj-a', '', 4, 9, '{"tables":[]}', 5000);
INSERT INTO designs VALUES ('design-a2', 'proj-a', 'Reporting', 1, 2, '{"tables":[{"id":"r1","name":"reports","position":{"x":0,"y":0},"columns":[]}]}', 4500);
INSERT INTO designs VALUES ('design-b1', 'proj-b', '', 2, 2, '{"tables":[]}', 4000);

-- No design_id: attach to the Project's first Design.
INSERT INTO scenarios VALUES ('proj-a', NULL, 's-null', 0, 'Unowned scenario', 'noop');
-- Owned by the second Design.
INSERT INTO scenarios VALUES ('proj-a', 'design-a2', 's-owned', 1, 'Report scenario', 'noop');
INSERT INTO scenario_documents VALUES ('proj-a', NULL, 3, 4800);
INSERT INTO edge_functions VALUES ('proj-a', NULL, 'f-null', 0, 'checkout', 'export default 1');
INSERT INTO edge_functions VALUES ('proj-a', 'design-a2', 'f-owned', 1, 'report', 'export default 2');
INSERT INTO edge_function_documents VALUES ('proj-a', 'design-a2', 5, 4600);
-- proj-a already has a System design with a project-level Walkthrough-free document.
INSERT INTO system_designs VALUES ('proj-a', '{"services":[],"groups":[],"components":[],"connections":[],"viewport":{"x":0,"y":0,"zoom":1},"collapsedServiceIds":[],"focusedServiceId":null,"focusViewport":{"x":0,"y":0,"zoom":1}}', 4, 9, 'system', 5000);
-- proj-b has none and gets one that keeps its database as the single component.
