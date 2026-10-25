import { describe, expect, test } from "bun:test";
import { createRpcRequestHandlers } from "./rpc-handlers";
import type { DesignWorkspace } from "./workspace";
import type { AssistantRuntime } from "./assistant-runtime";
import type { SqlPreviewActions } from "./sql-preview";
import type { ScenarioRun, WorkspaceState } from "../shared/design";

describe("RPC request handlers", () => {
	test("finishScenarioRun forwards the complete action including expectations and reason", async () => {
		let forwardedAction: unknown = null;
		const fakeWorkspace = {
			finishScenarioRun: async (action: unknown) => {
				forwardedAction = action;
				return {} as WorkspaceState;
			},
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
		});

		const expectations: ScenarioRun["expectations"] = [
			{ description: "should insert row", passed: false, message: "duplicate key value" },
			{ description: "should return row", passed: true, message: "Returned data matched." },
		];

		await handlers.finishScenarioRun({
			runId: "run-123",
			status: "failed",
			console: ["starting scenario", "query executed"],
			expectations,
			reason: "exception",
		});

		expect(forwardedAction).toEqual({
			runId: "run-123",
			status: "failed",
			console: ["starting scenario", "query executed"],
			expectations: [
				{ description: "should insert row", passed: false, message: "duplicate key value" },
				{ description: "should return row", passed: true, message: "Returned data matched." },
			],
			reason: "exception",
		});
	});

	test("workspace actions forward their complete parameter objects without dropping fields", async () => {
		const capturedCalls: Record<string, unknown> = {};

		const fakeWorkspace = {
			addTable: async (action: unknown) => {
				capturedCalls.addTable = action;
				return {} as WorkspaceState;
			},
			addColumn: async (action: unknown) => {
				capturedCalls.addColumn = action;
				return {} as WorkspaceState;
			},
			updateColumn: async (action: unknown) => {
				capturedCalls.updateColumn = action;
				return {} as WorkspaceState;
			},
			removeColumn: async (action: unknown) => {
				capturedCalls.removeColumn = action;
				return {} as WorkspaceState;
			},
			addRelationship: async (action: unknown) => {
				capturedCalls.addRelationship = action;
				return {} as WorkspaceState;
			},
			updateRelationship: async (action: unknown) => {
				capturedCalls.updateRelationship = action;
				return {} as WorkspaceState;
			},
			handleSandboxApiRequest: async (action: unknown) => {
				capturedCalls.handleSandboxApiRequest = action;
				return {} as unknown;
			},
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
		});

		await handlers.addTable({ name: "Users", position: { x: 100, y: 200 } });
		expect(capturedCalls.addTable).toEqual({ name: "Users", position: { x: 100, y: 200 } });

		await handlers.addColumn({ tableId: "t1", name: "email", type: "text" });
		expect(capturedCalls.addColumn).toEqual({ tableId: "t1", name: "email", type: "text" });

		await handlers.updateColumn({ tableId: "t1", columnId: "c1", changes: { name: "email_address" } });
		expect(capturedCalls.updateColumn).toEqual({ tableId: "t1", columnId: "c1", changes: { name: "email_address" } });

		await handlers.removeColumn({ tableId: "t1", columnId: "c1", confirmed: true });
		expect(capturedCalls.removeColumn).toEqual({ tableId: "t1", columnId: "c1", confirmed: true });

		await handlers.addRelationship({
			referencingTableId: "t2",
			referencedTableId: "t1",
			cardinality: "one-to-many",
			junctionPosition: { x: 50, y: 50 },
		});
		expect(capturedCalls.addRelationship).toEqual({
			referencingTableId: "t2",
			referencedTableId: "t1",
			cardinality: "one-to-many",
			junctionPosition: { x: 50, y: 50 },
		});

		await handlers.updateRelationship({
			relationshipId: "r1",
			required: true,
			cardinality: "one-to-one",
		});
		expect(capturedCalls.updateRelationship).toEqual({
			relationshipId: "r1",
			required: true,
			cardinality: "one-to-one",
		});
	});
});
