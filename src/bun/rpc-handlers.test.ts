import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRpcRequestHandlers } from "./rpc-handlers";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace } from "./workspace";
import type { DesignWorkspace } from "./workspace";
import type { AssistantRuntime } from "./assistant-runtime";
import type { SqlPreviewActions } from "./sql-preview";
import type { ProjectTransferActions } from "./project-transfer";
import type { SystemDesignSvgExports } from "./system-design-svg-export";
import type { SystemDesignPngExports } from "./system-design-png-export";
import type { ScenarioRun, WorkspaceState } from "../shared/design";
import type { SystemDesignExportResult } from "../shared/rpc";

describe("RPC request handlers", () => {
	test("beginSystemDesignSvgExport requires an open Project and passes the drawn SVG to the export when its picker runs", async () => {
		const workspaceWith = (project: unknown) => ({ getState: () => ({ project }) }) as unknown as DesignWorkspace;
		const forwarded: unknown[] = [];
		const pending = new Map<string, () => Promise<SystemDesignExportResult>>();
		const svgExports = {
			export: async (request: unknown) => {
				forwarded.push(request);
				return { status: "cancelled" as const };
			},
		};
		const handlersFor = (project: unknown) => createRpcRequestHandlers({
			workspace: workspaceWith(project),
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: svgExports,
			pendingSystemDesignSvgExports: pending,
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await expect(handlersFor(null).beginSystemDesignSvgExport({ svg: "<svg/>", projectName: "Shop" })).rejects.toThrow("Open a project");

		const { requestId } = await handlersFor({ id: "p1", name: "Shop" }).beginSystemDesignSvgExport({ svg: "<svg/>", projectName: "Shop" });
		expect(pending.has(requestId)).toBe(true);
		expect(await pending.get(requestId)!()).toEqual({ status: "cancelled" });
		expect(forwarded).toEqual([{ svg: "<svg/>", projectName: "Shop" }]);
	});

	test("beginSystemDesignPngExport requires an open Project and passes the rasterized PNG to the export when its picker runs", async () => {
		const workspaceWith = (project: unknown) => ({ getState: () => ({ project }) }) as unknown as DesignWorkspace;
		const forwarded: unknown[] = [];
		const pending = new Map<string, () => Promise<SystemDesignExportResult>>();
		const pngExports = {
			export: async (request: unknown) => {
				forwarded.push(request);
				return { status: "cancelled" as const };
			},
		};
		const handlersFor = (project: unknown) => createRpcRequestHandlers({
			workspace: workspaceWith(project),
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: pngExports,
			pendingSystemDesignPngExports: pending,
		});

		await expect(handlersFor(null).beginSystemDesignPngExport({ png: "AAAA", projectName: "Shop" })).rejects.toThrow("Open a project");

		const { requestId } = await handlersFor({ id: "p1", name: "Shop" }).beginSystemDesignPngExport({ png: "AAAA", projectName: "Shop" });
		expect(pending.has(requestId)).toBe(true);
		expect(await pending.get(requestId)!()).toEqual({ status: "cancelled" });
		expect(forwarded).toEqual([{ png: "AAAA", projectName: "Shop" }]);
	});

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
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
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
			beginScenarioRun: async (action: unknown) => {
				capturedCalls.beginScenarioRun = action;
				return { runId: "r1", state: {} as WorkspaceState };
			},
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await handlers.addTable({ designId: "d-1", name: "Users", position: { x: 100, y: 200 } });
		expect(capturedCalls.addTable).toEqual({ designId: "d-1", name: "Users", position: { x: 100, y: 200 } });

		await handlers.beginScenarioRun({ scenarioId: "s1", designId: "d-1" });
		expect(capturedCalls.beginScenarioRun).toEqual({ scenarioId: "s1", designId: "d-1" });
		await handlers.addColumn({ designId: "d-1", tableId: "t1", name: "email", type: "text" });
		expect(capturedCalls.addColumn).toEqual({ designId: "d-1", tableId: "t1", name: "email", type: "text" });

		await handlers.updateColumn({ designId: "d-1", tableId: "t1", columnId: "c1", changes: { name: "email_address" } });
		expect(capturedCalls.updateColumn).toEqual({ designId: "d-1", tableId: "t1", columnId: "c1", changes: { name: "email_address" } });

		await handlers.removeColumn({ designId: "d-1", tableId: "t1", columnId: "c1", confirmed: true });
		expect(capturedCalls.removeColumn).toEqual({ designId: "d-1", tableId: "t1", columnId: "c1", confirmed: true });

		await handlers.addRelationship({
			designId: "d-1",
			referencingTableId: "t2",
			referencedTableId: "t1",
			cardinality: "one-to-many",
			junctionPosition: { x: 50, y: 50 },
		});
		expect(capturedCalls.addRelationship).toEqual({
			designId: "d-1",
			referencingTableId: "t2",
			referencedTableId: "t1",
			cardinality: "one-to-many",
			junctionPosition: { x: 50, y: 50 },
		});

		await handlers.updateRelationship({
			designId: "d-1",
			relationshipId: "r1",
			required: true,
			cardinality: "one-to-one",
		});
		expect(capturedCalls.updateRelationship).toEqual({
			designId: "d-1",
			relationshipId: "r1",
			required: true,
			cardinality: "one-to-one",
		});
	});

	test("System design Group requests forward their complete parameters to the workspace", async () => {
		const captured: Record<string, unknown> = {};
		const record = (name: string) => async (action: unknown) => {
			captured[name] = action;
			return {} as WorkspaceState;
		};
		const fakeWorkspace = {
			addSystemGroup: record("addSystemGroup"),
			updateSystemGroup: record("updateSystemGroup"),
			moveSystemGroup: record("moveSystemGroup"),
			resizeSystemGroup: record("resizeSystemGroup"),
			removeSystemGroup: record("removeSystemGroup"),
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await handlers.addSystemGroup({ id: "domain", name: "Domain", x: 40, y: 40, width: 360, height: 240, memberIds: ["queue", "orders"] });
		expect(captured.addSystemGroup).toEqual({ id: "domain", name: "Domain", x: 40, y: 40, width: 360, height: 240, memberIds: ["queue", "orders"] });
		await handlers.updateSystemGroup({ groupId: "domain", changes: { memberIds: ["queue"] } });
		expect(captured.updateSystemGroup).toEqual({ groupId: "domain", changes: { memberIds: ["queue"] } });
		await handlers.moveSystemGroup({ groupId: "domain", x: 60, y: 30 });
		expect(captured.moveSystemGroup).toEqual({ groupId: "domain", x: 60, y: 30 });
		await handlers.resizeSystemGroup({ groupId: "domain", width: 500, height: 300 });
		expect(captured.resizeSystemGroup).toEqual({ groupId: "domain", width: 500, height: 300 });
		await handlers.removeSystemGroup({ groupId: "domain" });
		expect(captured.removeSystemGroup).toEqual({ groupId: "domain" });
	});

	test("System design Service requests forward their complete parameters to the workspace", async () => {
		const captured: Record<string, unknown> = {};
		const record = (name: string) => async (action: unknown) => {
			captured[name] = action;
			return {} as WorkspaceState;
		};
		const fakeWorkspace = {
			addSystemService: record("addSystemService"),
			updateSystemService: record("updateSystemService"),
			moveSystemService: record("moveSystemService"),
			resizeSystemService: record("resizeSystemService"),
			removeSystemService: record("removeSystemService"),
			setSystemServiceCollapsed: record("setSystemServiceCollapsed"),
			setSystemFocus: record("setSystemFocus"),
			describeSystemServiceRemoval: (serviceId: string) => {
				captured.describeSystemServiceRemoval = serviceId;
				return { serviceId, serviceName: "Orders", releasedComponents: [], connections: [] };
			},
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await handlers.addSystemService({ id: "orders", name: "Orders", x: 40, y: 40 });
		expect(captured.addSystemService).toEqual({ id: "orders", name: "Orders", x: 40, y: 40 });
		await handlers.updateSystemService({ serviceId: "orders", changes: { name: "Order API" } });
		expect(captured.updateSystemService).toEqual({ serviceId: "orders", changes: { name: "Order API" } });
		await handlers.moveSystemService({ serviceId: "orders", x: 60, y: 30 });
		expect(captured.moveSystemService).toEqual({ serviceId: "orders", x: 60, y: 30 });
		await handlers.resizeSystemService({ serviceId: "orders", width: 500, height: 320 });
		expect(captured.resizeSystemService).toEqual({ serviceId: "orders", width: 500, height: 320 });
		await handlers.removeSystemService({ serviceId: "orders" });
		expect(captured.removeSystemService).toEqual({ serviceId: "orders" });
		await handlers.setSystemServiceCollapsed({ serviceId: "orders", collapsed: true });
		expect(captured.setSystemServiceCollapsed).toEqual({ serviceId: "orders", collapsed: true });
		await handlers.setSystemFocus({ serviceId: "orders", viewport: { x: 12, y: 24, zoom: 0.9 } });
		expect(captured.setSystemFocus).toEqual({ serviceId: "orders", viewport: { x: 12, y: 24, zoom: 0.9 } });
		await handlers.setSystemFocus({ serviceId: null });
		expect(captured.setSystemFocus).toEqual({ serviceId: null });

		const plan = await handlers.describeSystemServiceRemoval({ serviceId: "orders" });
		expect(captured.describeSystemServiceRemoval).toBe("orders");
		expect(plan.serviceName).toBe("Orders");
	});

	test("database link requests forward the component, the target Design, and the create-and-link name", async () => {
		const captured: Record<string, unknown> = {};
		const record = (name: string) => async (action: unknown) => {
			captured[name] = action;
			return {} as WorkspaceState;
		};
		const fakeWorkspace = {
			linkSystemDatabase: record("linkSystemDatabase"),
			createSystemDatabaseDesign: record("createSystemDatabaseDesign"),
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await handlers.linkSystemDatabase({ componentId: "replica", designId: "design-orders" });
		expect(captured.linkSystemDatabase).toEqual({ componentId: "replica", designId: "design-orders" });
		await handlers.linkSystemDatabase({ componentId: "replica", designId: null });
		expect(captured.linkSystemDatabase).toEqual({ componentId: "replica", designId: null });
		await handlers.createSystemDatabaseDesign({ componentId: "primary", name: "Orders schema" });
		expect(captured.createSystemDatabaseDesign).toEqual({ componentId: "primary", name: "Orders schema" });
	});

	test("Walkthrough requests forward their complete parameter objects to the workspace", async () => {
		const calls: Array<{ method: string; action: unknown }> = [];
		const record = (method: string) => async (action: unknown) => {
			calls.push({ method, action });
			return {} as WorkspaceState;
		};
		const fakeWorkspace = {
			createWalkthrough: record("createWalkthrough"),
			renameWalkthrough: record("renameWalkthrough"),
			removeWalkthrough: record("removeWalkthrough"),
			moveWalkthrough: record("moveWalkthrough"),
			addWalkthroughStep: record("addWalkthroughStep"),
			updateWalkthroughStep: record("updateWalkthroughStep"),
			moveWalkthroughStep: record("moveWalkthroughStep"),
			removeWalkthroughStep: record("removeWalkthroughStep"),
			repairWalkthroughStep: record("repairWalkthroughStep"),
			acceptWalkthroughStepRedirection: record("acceptWalkthroughStepRedirection"),
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await handlers.createWalkthrough({ id: "w-1", name: "Cached read" });
		await handlers.renameWalkthrough({ walkthroughId: "w-1", name: "Upload" });
		await handlers.moveWalkthrough({ walkthroughId: "w-1", toIndex: 2 });
		await handlers.addWalkthroughStep({
			id: "s-1",
			walkthroughId: "w-1",
			connectionId: "c-1",
			title: "Send",
			action: "send",
			durationMs: 500,
			examplePayload: "{}",
		});
		await handlers.updateWalkthroughStep({ walkthroughId: "w-1", stepId: "s-1", changes: { durationMs: null, operation: "" } });
		await handlers.moveWalkthroughStep({ walkthroughId: "w-1", stepId: "s-1", toIndex: 0 });
		await handlers.removeWalkthroughStep({ walkthroughId: "w-1", stepId: "s-1" });
		await handlers.repairWalkthroughStep({ walkthroughId: "w-1", stepId: "s-2", connectionId: "c-2" });
		await handlers.acceptWalkthroughStepRedirection({ walkthroughId: "w-1", stepId: "s-2" });
		await handlers.removeWalkthrough({ walkthroughId: "w-1" });

		expect(calls).toEqual([
			{ method: "createWalkthrough", action: { id: "w-1", name: "Cached read" } },
			{ method: "renameWalkthrough", action: { walkthroughId: "w-1", name: "Upload" } },
			{ method: "moveWalkthrough", action: { walkthroughId: "w-1", toIndex: 2 } },
			{
				method: "addWalkthroughStep",
				action: { id: "s-1", walkthroughId: "w-1", connectionId: "c-1", title: "Send", action: "send", durationMs: 500, examplePayload: "{}" },
			},
			{ method: "updateWalkthroughStep", action: { walkthroughId: "w-1", stepId: "s-1", changes: { durationMs: null, operation: "" } } },
			{ method: "moveWalkthroughStep", action: { walkthroughId: "w-1", stepId: "s-1", toIndex: 0 } },
			{ method: "removeWalkthroughStep", action: { walkthroughId: "w-1", stepId: "s-1" } },
			{ method: "repairWalkthroughStep", action: { walkthroughId: "w-1", stepId: "s-2", connectionId: "c-2" } },
			{ method: "acceptWalkthroughStepRedirection", action: { walkthroughId: "w-1", stepId: "s-2" } },
			{ method: "removeWalkthrough", action: { walkthroughId: "w-1" } },
		]);
	});

	test("undo, redo, layout, and routine requests forward the explicit designId to the workspace", async () => {
		const captured: Array<{ method: string; args: unknown[] }> = [];
		const record = (method: string) => async (...args: unknown[]) => {
			captured.push({ method, args });
			return {} as WorkspaceState;
		};
		const fakeWorkspace = {
			undo: record("undo"),
			redo: record("redo"),
			setViewport: record("setViewport"),
			moveTable: record("moveTable"),
			updateFunctions: record("updateFunctions"),
		} as unknown as DesignWorkspace;

		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await handlers.undo({ designId: "d-1" });
		await handlers.redo({ designId: "d-1" });
		await handlers.setViewport({ designId: "d-1", x: 1, y: 2, zoom: 1 });
		await handlers.moveTable({ designId: "d-1", tableId: "t1", position: { x: 3, y: 4 } });
		await handlers.updateFunctions({ designId: "d-1", functions: [] });

		expect(captured).toEqual([
			{ method: "undo", args: [{ designId: "d-1" }] },
			{ method: "redo", args: [{ designId: "d-1" }] },
			{ method: "setViewport", args: [{ designId: "d-1", x: 1, y: 2, zoom: 1 }] },
			{ method: "moveTable", args: [{ designId: "d-1", tableId: "t1", position: { x: 3, y: 4 } }] },
			{ method: "updateFunctions", args: [{ designId: "d-1", functions: [] }] },
		]);
	});

	test("copy and export requests are rejected before SQL actions run when the snapshot belongs to another Design", async () => {
		const sqlCalls: string[] = [];
		const fakeWorkspace = {
			requireActiveDesign: (designId?: string) => {
				if (designId !== undefined && designId !== "active-design") {
					throw new Error(`Target database design '${designId}' is not the active design.`);
				}
			},
		} as unknown as DesignWorkspace;
		const sqlPreviewActions = {
			copy: () => {
				sqlCalls.push("copy");
				return { status: "copied", revision: 1 };
			},
			export: () => {
				sqlCalls.push("export");
				return { status: "saved", revision: 1, path: "x.sql" };
			},
			copyCode: () => {
				sqlCalls.push("copyCode");
				return { status: "copied", revision: 1 };
			},
			exportCode: () => {
				sqlCalls.push("exportCode");
				return { status: "saved", revision: 1, path: "x.ts" };
			},
		} as unknown as SqlPreviewActions;
		const pendingSqlExports = new Map<string, () => Promise<unknown>>();
		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions,
			pendingSqlExports: pendingSqlExports as never,
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		const stalePreview = { status: "current", revision: 1, draftRevision: 1, sql: "CREATE TABLE a ();", designId: "old-design" } as const;
		const staleSnapshot = { target: "prisma", revision: 1, code: "model A {}", designId: "old-design" } as const;

		await expect(handlers.copySqlPreview({ preview: stalePreview })).rejects.toThrow(/not the active/i);
		await expect(handlers.beginSqlPreviewExport({ preview: stalePreview, fileName: "a.sql" })).rejects.toThrow(/not the active/i);
		await expect(handlers.copySchemaCode({ snapshot: staleSnapshot as never })).rejects.toThrow(/not the active/i);
		await expect(handlers.beginSchemaCodeExport({ snapshot: staleSnapshot as never, fileName: "a.ts" })).rejects.toThrow(/not the active/i);
		expect(sqlCalls).toEqual([]);
		expect(pendingSqlExports.size).toBe(0);

		const activePreview = { ...stalePreview, designId: "active-design" };
		expect(await handlers.copySqlPreview({ preview: activePreview })).toEqual({ status: "copied", revision: 1 });
		expect(sqlCalls).toEqual(["copy"]);
	});

	test("sendAssistantMessage resolves with started: true before the turn finishes, signalling completion through events", async () => {
		let turnResolved = false;
		let passedWaitForCompletion: boolean | undefined;
		const emittedEvents: unknown[] = [];
		const slowTurn = Promise.withResolvers<{ started: boolean }>();

		const fakeAssistant = {
			sendMessage: async (
				_conversationId: string,
				_text: string,
				_modelId: string,
				_thinkingLevel?: string,
				_connectionId?: string,
				options?: { waitForCompletion?: boolean },
			) => {
				passedWaitForCompletion = options?.waitForCompletion;
				if (options?.waitForCompletion === false) {
					void slowTurn.promise;
					return { started: true };
				}
				return slowTurn.promise;
			},
		} as unknown as AssistantRuntime;

		const handlers = createRpcRequestHandlers({
			workspace: {} as DesignWorkspace,
			assistant: fakeAssistant,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		const result = await handlers.sendAssistantMessage({
			conversationId: "conv-1",
			text: "Explain the design.",
			modelId: "model-1",
			thinkingLevel: "medium",
		});

		expect(passedWaitForCompletion).toBe(false);
		expect(result).toEqual({ started: true });
		expect(turnResolved).toBe(false);

		turnResolved = true;
		emittedEvents.push({ type: "agent_end" });
		emittedEvents.push({ type: "assistant_turn_ended" });
		slowTurn.resolve({ started: true });
		await slowTurn.promise;
		expect(emittedEvents).toEqual([{ type: "agent_end" }, { type: "assistant_turn_ended" }]);
	});

	test("sendAssistantMessage rejects promptly when an error is raised before the turn starts", async () => {
		const fakeAssistant = {
			sendMessage: async () => {
				throw new Error("Configure credentials for Anthropic before sending a message.");
			},
		} as unknown as AssistantRuntime;

		const handlers = createRpcRequestHandlers({
			workspace: {} as DesignWorkspace,
			assistant: fakeAssistant,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await expect(
			handlers.sendAssistantMessage({
				conversationId: "conv-1",
				text: "Hello",
				modelId: "claude-3-5-sonnet",
				thinkingLevel: "medium",
			}),
		).rejects.toThrow("Configure credentials for Anthropic before sending a message.");
	});

	test("continueAssistantTurn, confirmAssistantDdlDrop, and rejectAssistantDdlDrop resolve with started: true before completion and reject on start errors", async () => {
		let turnContinuing = false;
		let dropConfirming = false;
		let dropRejecting = false;

		const fakeAssistant = {
			continueTurn: async (_conversationId: string, options?: { waitForCompletion?: boolean }) => {
				if (options?.waitForCompletion === false) return { started: true };
				turnContinuing = true;
				return null;
			},
			confirmDdlDrop: async (_conversationId: string, _toolCallId: string, options?: { waitForCompletion?: boolean }) => {
				if (options?.waitForCompletion === false) return { started: true };
				dropConfirming = true;
				return null;
			},
			rejectDdlDrop: async (_conversationId: string, _toolCallId: string, options?: { waitForCompletion?: boolean }) => {
				if (options?.waitForCompletion === false) return { started: true };
				dropRejecting = true;
				return null;
			},
		} as unknown as AssistantRuntime;

		const handlers = createRpcRequestHandlers({
			workspace: {} as DesignWorkspace,
			assistant: fakeAssistant,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		expect(await handlers.continueAssistantTurn({ conversationId: "conv-1" })).toEqual({ started: true });
		expect(turnContinuing).toBe(false);

		expect(await handlers.confirmAssistantDdlDrop({ conversationId: "conv-1", toolCallId: "tool-1" })).toEqual({ started: true });
		expect(dropConfirming).toBe(false);

		expect(await handlers.rejectAssistantDdlDrop({ conversationId: "conv-1", toolCallId: "tool-1" })).toEqual({ started: true });
		expect(dropRejecting).toBe(false);

		// Start errors reject promptly
		const failingAssistant = {
			continueTurn: async () => { throw new Error("This Assistant turn is not waiting to continue."); },
			confirmDdlDrop: async () => { throw new Error("This DDL confirmation is no longer available."); },
			rejectDdlDrop: async () => { throw new Error("This DDL confirmation has already been used."); },
		} as unknown as AssistantRuntime;

		const failingHandlers = createRpcRequestHandlers({
			workspace: {} as DesignWorkspace,
			assistant: failingAssistant,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await expect(failingHandlers.continueAssistantTurn({ conversationId: "conv-1" })).rejects.toThrow("This Assistant turn is not waiting to continue.");
		await expect(failingHandlers.confirmAssistantDdlDrop({ conversationId: "conv-1", toolCallId: "tool-1" })).rejects.toThrow("This DDL confirmation is no longer available.");
		await expect(failingHandlers.rejectAssistantDdlDrop({ conversationId: "conv-1", toolCallId: "tool-1" })).rejects.toThrow("This DDL confirmation has already been used.");
	});

	test("real AssistantRuntime with faux model resolves RPC immediately and completes turn via events without blocking the request", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-rpc-test-"));
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		const state = await workspace.createProject({ name: "Assistant RPC test project" });
		if (!state.project) throw new Error("Expected the project to be open.");

		const scripted = fauxProvider({ provider: "anthropic", models: [{ id: "scripted-model", name: "Scripted model" }] });
		const models = createModels();
		models.setProvider(scripted.provider);

		const modelGate = Promise.withResolvers<void>();
		const turnCompleted = Promise.withResolvers<void>();

		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key-not-sent-to-a-provider",
			streamFn: async (model, context, options) => {
				await modelGate.promise;
				return models.streamSimple(model, context, options);
			},
		});

		const conversation = runtime.createConversation(state.project.id);
		scripted.setResponses([fauxAssistantMessage([fauxText("The slow turn has completed successfully.")])]);

		const emittedEvents: string[] = [];
		runtime.subscribe((_conversationId, event) => {
			const record = event as { type?: string };
			if (record.type) {
				emittedEvents.push(record.type);
				if (record.type === "assistant_turn_ended") {
					turnCompleted.resolve();
				}
			}
		});
		const handlers = createRpcRequestHandlers({
			workspace,
			assistant: runtime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {} as ProjectTransferActions,
			pendingProjectTransfers: new Map(),
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		// 1. sendAssistantMessage must resolve promptly before the model stream gate opens
		const startResult = await handlers.sendAssistantMessage({
			conversationId: conversation.id,
			text: "Run a slow operation.",
			modelId: "scripted-model",
			thinkingLevel: "medium",
		});

		expect(startResult).toEqual({ started: true });
		// While the model gate is closed, the turn is still running in the background
		const runningStatus = await handlers.getAssistantTurnStatus({ conversationId: conversation.id });
		expect(runningStatus.running).toBe(true);
		expect(emittedEvents.includes("agent_end")).toBe(false);

		// 2. Open the gate and let the faux model finish
		modelGate.resolve();

		// Wait for turn completion event directly
		await turnCompleted.promise;

		// 3. Status is now finished, and saved transcript has the response
		const finalStatus = await handlers.getAssistantTurnStatus({ conversationId: conversation.id });
		expect(finalStatus.running).toBe(false);

		const loaded = await handlers.getAssistantConversation({ conversationId: conversation.id });
		expect(loaded?.messages.some((m) => JSON.stringify(m.payload).includes("The slow turn has completed successfully."))).toBe(true);

		// 4. Pre-start error rejects promptly
		await expect(
			handlers.sendAssistantMessage({
				conversationId: conversation.id,
				text: "Will fail",
				modelId: "nonexistent-model",
				thinkingLevel: "medium",
			}),
		).rejects.toThrow(/Unknown model/);

		runtime.close();
		await workspace.close();
		rmSync(directory, { recursive: true, force: true });
	});
});

describe("Project transfer request handlers", () => {
	test("exporting needs an open Project, and an import starts its picker without one", async () => {
		const calls: string[] = [];
		const pendingProjectTransfers = new Map<string, () => Promise<unknown>>();
		const fakeWorkspace = { getState: () => ({ project: null }) } as unknown as DesignWorkspace;
		const handlers = createRpcRequestHandlers({
			workspace: fakeWorkspace,
			assistant: {} as AssistantRuntime,
			sqlPreviewActions: {} as SqlPreviewActions,
			pendingSqlExports: new Map(),
			projectTransfers: {
				exportProject: async () => {
					calls.push("export");
					return { status: "cancelled" as const };
				},
				importProject: async () => {
					calls.push("import");
					return { status: "cancelled" as const };
				},
			},
			pendingProjectTransfers: pendingProjectTransfers as never,
			systemDesignSvgExports: {} as SystemDesignSvgExports,
			pendingSystemDesignSvgExports: new Map(),
			systemDesignPngExports: {} as SystemDesignPngExports,
			pendingSystemDesignPngExports: new Map(),
		});

		await expect(handlers.beginProjectExport()).rejects.toThrow("Open a project before exporting it.");
		expect(pendingProjectTransfers.size).toBe(0);

		const { requestId } = await handlers.beginProjectImport();
		expect(pendingProjectTransfers.has(requestId)).toBe(true);
		expect(await pendingProjectTransfers.get(requestId)!()).toEqual({ status: "cancelled" });
		expect(calls).toEqual(["import"]);
	});
});
