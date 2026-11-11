-- The first schema: one design per Project, keyed by the Project, no design ids,
-- no document revision, no System designs or Walkthroughs. Scenarios and Edge
-- functions belong to the Project.
CREATE TABLE projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE designs (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	document TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE scenarios (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	position INTEGER NOT NULL,
	name TEXT NOT NULL,
	source TEXT NOT NULL,
	PRIMARY KEY (project_id, id)
);
CREATE TABLE scenario_documents (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE edge_functions (
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	position INTEGER NOT NULL,
	name TEXT NOT NULL,
	source TEXT NOT NULL,
	PRIMARY KEY (project_id, id),
	UNIQUE (project_id, name)
);
CREATE TABLE edge_function_documents (
	project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

INSERT INTO projects VALUES ('proj-a', 'Shop', 1000, 3000);
INSERT INTO projects VALUES ('proj-b', 'Blog', 1100, 2000);
INSERT INTO projects VALUES ('proj-c', 'Empty', 1200, 1200);

INSERT INTO designs VALUES ('proj-a', 7, '{"tables":[{"id":"t1","name":"orders","position":{"x":40,"y":40},"columns":[{"id":"c1","name":"id","type":"bigint","nullable":false,"primaryKey":true,"identity":true}]}]}', 3000);
INSERT INTO designs VALUES ('proj-b', 2, '{"tables":[]}', 2000);
INSERT INTO designs VALUES ('proj-c', 1, '{"tables":[],"relationships":[],"manyToManyRelationships":[],"viewport":{"x":0,"y":0,"zoom":1}}', 1200);

INSERT INTO scenarios VALUES ('proj-a', 's1', 0, 'Place an order', 'await supabase.from("orders").insert({})');
INSERT INTO scenarios VALUES ('proj-a', 's2', 1, 'Cancel an order', 'await supabase.from("orders").delete()');
INSERT INTO scenario_documents VALUES ('proj-a', 4, 3000);
INSERT INTO edge_functions VALUES ('proj-a', 'f1', 0, 'checkout', 'export default () => new Response("ok")');
INSERT INTO edge_functions VALUES ('proj-a', 'f2', 1, 'refund', 'export default () => new Response("refund")');
INSERT INTO edge_function_documents VALUES ('proj-a', 2, 2900);
-- A row whose Project no longer exists: nothing can own it, so it is dropped.
INSERT INTO scenarios VALUES ('proj-gone', 'orphan', 0, 'Orphan', 'noop');
INSERT INTO scenario_documents VALUES ('proj-gone', 1, 500);
