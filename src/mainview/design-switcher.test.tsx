import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceState } from "../shared/design";

// The masthead uses none of the views, the editor, or the webview client. Their
// browser-only imports (a window, Vite's import.meta.glob, Monaco workers) cannot
// load in the test runtime, so App's view modules are replaced before it loads.
const placeholder = () => null;
mock.module("./monaco-setup", () => ({ configureTypeScript: () => {} }));
mock.module("./workspace-client", () => ({ workspaceClient: {} }));
mock.module("./canvas", () => ({ TableCanvas: placeholder }));
mock.module("./sql-preview", () => ({ SqlPreviewView: placeholder, sqlStatusLine: () => "" }));
mock.module("./table-inspector", () => ({ TableInspector: placeholder }));
mock.module("./scenario-view", () => ({ ScenarioView: placeholder }));
mock.module("./triggers-view", () => ({ TriggersView: placeholder }));
mock.module("./functions-view", () => ({ FunctionsView: placeholder }));
mock.module("./assistant-sidebar", () => ({ AssistantSidebar: placeholder }));
mock.module("./edge-functions-view", () => ({ EdgeFunctionsView: placeholder }));
mock.module("./architecture-proof", () => ({ ArchitectureProofView: placeholder }));
const { Masthead } = await import("./App");

/**
 * The masthead's Design switcher, rendered without a window. It shows the
 * open Project's designs with the active one marked, and the active design's
 * name in the trigger, so a designer can see which database the views show.
 */

function stateWithDesigns(activeDesignId: string): WorkspaceState {
	return {
		projects: [{ id: "project-1", name: "Shop" }],
		project: { id: "project-1", name: "Shop" },
		design: { tables: [], relationships: [], manyToManyRelationships: [], viewport: { x: 0, y: 0, zoom: 1 } },
		activeDesignId,
		designs: [
			{ id: "design-orders", projectId: "project-1", name: "Orders" },
			{ id: "design-support", projectId: "project-1", name: "" },
		],
		revision: 1,
		save: { status: "idle" },
		sql: { status: "empty", draftRevision: 1, errors: [] },
		sandbox: { status: "idle" },
		scenarios: [],
		edgeFunctions: [],
		edgeFunctionSave: { status: "idle" },
		scenarioSave: { status: "idle" },
		scenarioRuns: {},
		undoRedo: { canUndo: false, canRedo: false },
	} as WorkspaceState;
}

function renderMasthead(state: WorkspaceState, schemaLinks: string[] = []) {
	return renderToStaticMarkup(
		<Masthead
			state={state}
			schemaLinks={schemaLinks}
			busy={false}
			onOpenProject={() => {}}
			onNewProject={() => {}}
			onOpenDesign={() => {}}
			onNewDesign={() => {}}
			onRenameDesign={() => {}}
			onUndo={() => {}}
			onRedo={() => {}}
			view="canvas"
			onViewChange={() => {}}
		/>,
	);
}

describe("design switcher", () => {
	test("the trigger names the active design, falling back to its position for unnamed designs", () => {
		const markup = renderMasthead(stateWithDesigns("design-orders"));
		expect(markup).toContain('data-testid="active-design-name"');
		expect(markup).toContain(">Orders<");

		const unnamed = renderMasthead(stateWithDesigns("design-support"));
		expect(unnamed).toContain(">Design 2<");
	});

	test("a project with a single design still shows the switcher with its count", () => {
		const single = stateWithDesigns("design-orders");
		single.designs = [{ id: "design-orders", projectId: "project-1", name: "Orders" }];
		const markup = renderMasthead(single);
		expect(markup).toContain('data-testid="design-switcher"');
	});

	test("a Design that several architecture Components link names the shared schema in the header", () => {
		const shared = renderMasthead(stateWithDesigns("design-orders"), ["Primary", "Read replica"]);
		expect(shared).toContain('data-testid="shared-schema-indicator"');
		expect(shared).toContain("Shared schema · 2");
		expect(shared).toContain('title="Shared schema: Primary, Read replica"');

		const single = renderMasthead(stateWithDesigns("design-orders"), ["Primary"]);
		expect(single).not.toContain('data-testid="shared-schema-indicator"');
	});

	test("no switcher appears without an open project", () => {
		const empty = { ...stateWithDesigns("design-orders"), project: null, design: null, activeDesignId: null, designs: [] } as WorkspaceState;
		expect(renderMasthead(empty)).not.toContain('data-testid="design-switcher"');
	});
});
