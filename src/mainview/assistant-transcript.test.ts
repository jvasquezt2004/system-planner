import { describe, expect, test } from "bun:test";
import {
	assistantError,
	assistantMessageUsage,
	assistantText,
	buildTranscript,
	deriveDropConfirmationStates,
	deriveToolTraceInfo,
	foldAssistantEvent,
	shouldShowMessageUsage,
	type TranscriptToolItem,
} from "./assistant-transcript";
import type { AssistantMessage } from "../shared/assistant";

describe("assistant transcript model", () => {
	test("starts a new assistant message after tool execution and uses full pi message updates", () => {
		let messages: AssistantMessage[] = [{ role: "user", payload: "Explain it" }];
		messages = foldAssistantEvent(messages, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "ignored" }] } });
		messages = foldAssistantEvent(messages, { type: "message_start", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read_project" }] } });
		messages = foldAssistantEvent(messages, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_project", args: {} });
		messages = foldAssistantEvent(messages, { type: "tool_execution_end", toolCallId: "call-1", result: "ready" });
		messages = foldAssistantEvent(messages, { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read_project" }] } });
		messages = foldAssistantEvent(messages, { type: "message_start", message: { role: "toolResult", content: [] } });
		messages = foldAssistantEvent(messages, { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } });
		messages = foldAssistantEvent(messages, { type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } });
		messages = foldAssistantEvent(messages, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] } });
		expect(messages.map((message) => message.kind)).toEqual([undefined, "live-tool", "live-assistant"]);
		expect(assistantText(messages[1].payload)).toBe("");
		expect(assistantText(messages[2].payload)).toBe("Hello world");
	});

	test("shows running tool calls and completes the same card", () => {
		let messages: AssistantMessage[] = [];
		messages = foldAssistantEvent(messages, { type: "tool_execution_start", toolCallId: "call-1", toolName: "read_project", args: { section: "design" } });
		const runningPayload = messages[0].payload;
		expect(runningPayload && typeof runningPayload === "object" && "status" in runningPayload ? runningPayload.status : undefined).toBe("running");
		messages = foldAssistantEvent(messages, { type: "tool_execution_end", toolCallId: "call-1", result: "ready" });
		expect(messages).toHaveLength(1);
		expect(messages[0].payload).toMatchObject({ status: "complete", result: "ready" });
	});

	test("saved content arrays expose text only, excluding signatures and non-text parts", () => {
		const saved = { role: "assistant", payload: { content: [
			{ type: "text", text: "**bold** and `code`", textSignature: "provider secret metadata" },
			{ type: "thinking", thinking: "hidden" },
		] } };
		expect(assistantText(saved.payload)).toBe("**bold** and `code`");
		expect(assistantText(saved.payload)).not.toContain("provider secret metadata");
	});

	test("confirmation state is pending only for the current unresolved plan", () => {
		const messages: AssistantMessage[] = [
			{ role: "toolResult", payload: { toolCallId: "old", details: { status: "confirmation-required" } } },
			{ role: "system", kind: "assistant-drop-confirmation", payload: { toolCallId: "old", status: "updated" } },
			{ role: "toolResult", payload: { toolCallId: "current", details: { status: "confirmation-required" } } },
		];
		expect(deriveDropConfirmationStates(messages, true)).toEqual(new Map([["old", "stale"], ["current", "pending"]]));
		expect(deriveDropConfirmationStates(messages, false).get("current")).toBe("stale");
		expect(deriveDropConfirmationStates([
			...messages,
			{ role: "system", kind: "assistant-drop-confirmation", payload: { toolCallId: "old", status: "consumed" } },
			{ role: "system", kind: "assistant-drop-confirmation", payload: { toolCallId: "current", status: "rejected" } },
		], true)).toEqual(new Map([["old", "confirmed"], ["current", "rejected"]]));
	});
	test("keeps failed assistant messages and exposes their provider error", () => {
		const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "The ChatGPT user has reached their usage limit." };
		let messages: AssistantMessage[] = [{ role: "user", payload: "Add a column" }];
		messages = foldAssistantEvent(messages, { type: "message_start", message: { role: "assistant", content: [] } });
		messages = foldAssistantEvent(messages, { type: "message_end", message: failed });
		expect(messages).toHaveLength(2);
		expect(assistantError(messages[1].payload)).toBe("The ChatGPT user has reached their usage limit.");
		expect(assistantError({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" })).toBeNull();
		expect(assistantError({ role: "assistant", content: [], stopReason: "error" })).toBe("The model request failed.");
	});
	describe("message usage (#102)", () => {
		test("hides usage line while streaming (stopReason pending or zero tokens)", () => {
			const streamingZero = {
				role: "assistant",
				stopReason: "pending",
				usage: { input: 0, output: 0, cacheRead: 0 },
			};
			expect(shouldShowMessageUsage(streamingZero)).toBe(false);
			expect(assistantMessageUsage(streamingZero)).toBeNull();

			const streamingWithTokens = {
				role: "assistant",
				stopReason: "pending",
				usage: { input: 150, output: 20, cacheRead: 5 },
			};
			expect(shouldShowMessageUsage(streamingWithTokens)).toBe(false);
			expect(assistantMessageUsage(streamingWithTokens)).toBeNull();

			const endedZero = {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 0, output: 0, cacheRead: 0 },
			};
			expect(shouldShowMessageUsage(endedZero)).toBe(false);
			expect(assistantMessageUsage(endedZero)).toBeNull();
		});

		test("shows usage line when message has ended with real non-zero tokens", () => {
			const ended = {
				role: "assistant",
				stopReason: "stop",
				usage: { input: 2450, output: 120, cacheRead: 800, cost: { total: 0.0042 } },
			};
			expect(shouldShowMessageUsage(ended)).toBe(true);
			expect(assistantMessageUsage(ended)).toEqual({
				input: 2450,
				output: 120,
				cacheRead: 800,
				cost: { total: 0.0042 },
			});
		});

		test("saved messages with token usage are visible", () => {
			const saved = {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				stopReason: "stop",
				usage: { input: 1200, output: 85, cacheRead: 0 },
			};
			expect(shouldShowMessageUsage(saved)).toBe(true);
			expect(assistantMessageUsage(saved)).toEqual({
				input: 1200,
				output: 85,
				cacheRead: 0,
				cost: undefined,
			});
		});
	});

	describe("tool trace mapping logic (#101)", () => {
		test("read_project titles and states", () => {
			expect(deriveToolTraceInfo({ toolName: "read_project", status: "running" })).toEqual({
				title: "Reading the project",
				status: "running",
				icon: "read",
			});
			expect(deriveToolTraceInfo({ toolName: "read_project", status: "complete", durationMs: 320 })).toEqual({
				title: "Read the project",
				status: undefined,
				icon: "read",
				description: "320ms",
			});
			expect(deriveToolTraceInfo({ toolName: "read_project", isError: true })).toEqual({
				title: "Failed to read the project",
				status: "error",
				icon: "read",
				description: undefined,
			});
		});

		test("apply_ddl titles, affected tables, and confirmation", () => {
			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				args: { sql: "CREATE TABLE authors ();" },
				status: "running",
			})).toEqual({
				title: "Applying SQL",
				status: "running",
				icon: "ddl",
			});

			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				details: { status: "applied", affectedTables: [{ name: "authors" }, { name: "books" }] },
				status: "complete",
			})).toEqual({
				title: "Applied SQL to authors, books",
				status: undefined,
				icon: "ddl",
				description: "2 tables",
			});

			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				details: { status: "applied", affectedTables: [{ name: "users" }] },
				status: "complete",
			})).toEqual({
				title: "Applied SQL to users",
				status: undefined,
				icon: "ddl",
				description: "1 table",
			});

			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				details: { status: "applied" },
				status: "complete",
			})).toEqual({
				title: "Applied SQL",
				status: undefined,
				icon: "ddl",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				details: { status: "confirmation-required" },
			})).toEqual({
				title: "Needs confirmation to apply SQL",
				status: "pending",
				icon: "ddl",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				isError: true,
			})).toEqual({
				title: "Failed to apply SQL",
				status: "error",
				icon: "ddl",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "apply_ddl",
				details: { status: "rejected-earlier" },
			})).toEqual({
				title: "Failed to apply SQL",
				status: "error",
				icon: "ddl",
				description: undefined,
			});
		});

		test("manage_code titles and actions", () => {
			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				args: { action: "write", kind: "scenario", name: "Loan lifecycle" },
				status: "running",
			})).toEqual({
				title: "Writing Scenario Loan lifecycle",
				status: "running",
				icon: "code",
			});

			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				details: { action: "write", kind: "scenario", name: "Loan lifecycle" },
				status: "complete",
			})).toEqual({
				title: "Wrote Scenario Loan lifecycle",
				status: undefined,
				icon: "code",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				details: { action: "created", kind: "edge-function", name: "auth-hook" },
				status: "complete",
			})).toEqual({
				title: "Created Edge function auth-hook",
				status: undefined,
				icon: "code",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				details: { action: "edit", kind: "function-body", name: "calculate_tax" },
				status: "complete",
			})).toEqual({
				title: "Edited Function body calculate_tax",
				status: undefined,
				icon: "code",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				details: { action: "remove", kind: "scenario", name: "Old test" },
				status: "complete",
			})).toEqual({
				title: "Removed Scenario Old test",
				status: undefined,
				icon: "code",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				details: { action: "rename", kind: "scenario", name: "New test" },
				status: "complete",
			})).toEqual({
				title: "Renamed Scenario New test",
				status: undefined,
				icon: "code",
				description: undefined,
			});

			expect(deriveToolTraceInfo({
				toolName: "manage_code",
				args: { action: "write", kind: "scenario", name: "Loan lifecycle" },
				isError: true,
			})).toEqual({
				title: "Failed to write Scenario Loan lifecycle",
				status: "error",
				icon: "code",
				description: undefined,
			});
		});

		test("run_scenarios titles and run results", () => {
			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				args: { mode: "one" },
				details: { mode: "one", runs: [{ scenario: "Loan lifecycle" }] },
				status: "running",
			})).toEqual({
				title: "Running Scenario Loan lifecycle",
				status: "running",
				icon: "run",
			});

			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				args: { mode: "all" },
				status: "running",
			})).toEqual({
				title: "Running Scenarios",
				status: "running",
				icon: "run",
			});

			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				details: { mode: "one", runs: [{ scenario: "Loan lifecycle", status: "passed" }] },
				status: "complete",
			})).toEqual({
				title: "Ran Scenario Loan lifecycle: passed",
				status: undefined,
				icon: "run",
				description: "1 run",
			});

			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				details: { mode: "one", runs: [{ scenario: "Loan lifecycle", status: "failed" }] },
				status: "complete",
			})).toEqual({
				title: "Ran Scenario Loan lifecycle: failed",
				status: "error",
				icon: "run",
				description: "1 run",
			});

			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				details: { mode: "all", runs: [{ scenario: "S1", status: "passed" }, { scenario: "S2", status: "passed" }] },
				status: "complete",
			})).toEqual({
				title: "Ran 2 Scenarios: passed",
				status: undefined,
				icon: "run",
				description: "2 runs",
			});

			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				details: { mode: "all", runs: [{ scenario: "S1", status: "passed" }, { scenario: "S2", status: "failed" }] },
				status: "complete",
			})).toEqual({
				title: "Ran 2 Scenarios: 1 failed",
				status: "error",
				icon: "run",
				description: "2 runs",
			});

			expect(deriveToolTraceInfo({
				toolName: "run_scenarios",
				isError: true,
			})).toEqual({
				title: "Failed to run Scenarios",
				status: "error",
				icon: "run",
				description: undefined,
			});
		});

		test("generic / unknown tools fallback", () => {
			expect(deriveToolTraceInfo({ toolName: "custom_op", status: "running" })).toEqual({
				title: "Running custom_op",
				status: "running",
				icon: "generic",
			});
			expect(deriveToolTraceInfo({ toolName: "custom_op", status: "complete" })).toEqual({
				title: "Ran custom_op",
				status: undefined,
				icon: "generic",
				description: undefined,
			});
			expect(deriveToolTraceInfo({ toolName: "custom_op", isError: true })).toEqual({
				title: "Failed to run custom_op",
				status: "error",
				icon: "generic",
				description: undefined,
			});
		});
	});

	describe("transcript unification and order (#101)", () => {
		test("live turn with N tool calls produces N trace rows in order relative to assistant text", () => {
			let messages: AssistantMessage[] = [{ role: "user", payload: "Build design" }];
			messages = foldAssistantEvent(messages, {
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "read_project",
				args: {},
			});
			messages = foldAssistantEvent(messages, {
				type: "tool_execution_end",
				toolCallId: "call-1",
				result: { details: { projectId: "p1" } },
			});
			messages = foldAssistantEvent(messages, {
				type: "tool_execution_start",
				toolCallId: "call-2",
				toolName: "apply_ddl",
				args: { sql: "CREATE TABLE users (id uuid);" },
			});
			messages = foldAssistantEvent(messages, {
				type: "tool_execution_end",
				toolCallId: "call-2",
				result: { details: { status: "applied", affectedTables: [{ id: "t1", name: "users" }] } },
			});
			messages = foldAssistantEvent(messages, {
				type: "message_start",
				message: { role: "assistant", content: [{ type: "text", text: "Created the users table." }] },
			});
			messages = foldAssistantEvent(messages, {
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Created the users table." }],
					stopReason: "stop",
					usage: { input: 100, output: 20, cacheRead: 0 },
				},
			});

			const items = buildTranscript(messages, false);
			expect(items.map((i) => i.kind)).toEqual(["user", "tool", "tool", "assistant"]);

			const tool1 = items[1] as TranscriptToolItem;
			expect(tool1.toolName).toBe("read_project");
			expect(tool1.trace.title).toBe("Read the project");

			const tool2 = items[2] as TranscriptToolItem;
			expect(tool2.toolName).toBe("apply_ddl");
			expect(tool2.trace.title).toBe("Applied SQL to users");
			expect(tool2.affectedTables).toEqual([{ id: "t1", name: "users" }]);
		});

		test("saved turn with N tool calls produces exactly N trace rows, merging toolCall and toolResult", () => {
			const savedMessages: AssistantMessage[] = [
				{ role: "user", payload: "Build design" },
				{
					role: "assistant",
					payload: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "call-1", name: "read_project", args: {} },
							{ type: "toolCall", id: "call-2", name: "apply_ddl", args: { sql: "CREATE TABLE users (id uuid);" } },
						],
						stopReason: "toolUse",
					},
				},
				{
					role: "toolResult",
					payload: {
						toolCallId: "call-1",
						toolName: "read_project",
						content: [{ type: "text", text: "{}" }],
						details: { projectId: "p1" },
					},
				},
				{
					role: "toolResult",
					payload: {
						toolCallId: "call-2",
						toolName: "apply_ddl",
						content: [{ type: "text", text: "{}" }],
						details: { status: "applied", affectedTables: [{ id: "t1", name: "users" }] },
					},
				},
				{
					role: "assistant",
					payload: {
						role: "assistant",
						content: [{ type: "text", text: "Created the users table." }],
						stopReason: "stop",
						usage: { input: 100, output: 20, cacheRead: 0 },
					},
				},
			];

			const items = buildTranscript(savedMessages, false);
			// Must have exactly 1 user, 2 tools, 1 assistant (NO duplicate tool result cards)
			expect(items.map((i) => i.kind)).toEqual(["user", "tool", "tool", "assistant"]);

			const tool1 = items[1] as TranscriptToolItem;
			expect(tool1.toolCallId).toBe("call-1");
			expect(tool1.trace.title).toBe("Read the project");

			const tool2 = items[2] as TranscriptToolItem;
			expect(tool2.toolCallId).toBe("call-2");
			expect(tool2.trace.title).toBe("Applied SQL to users");
			expect(tool2.affectedTables).toEqual([{ id: "t1", name: "users" }]);
		});

		test("detail content (DDL, diffs, run results) is extracted on tool items", () => {
			const messages: AssistantMessage[] = [
				{ role: "user", payload: "Do work" },
				{
					role: "assistant",
					payload: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "code-call",
								name: "manage_code",
								args: { action: "write", kind: "scenario", name: "Checkout" },
							},
							{
								type: "toolCall",
								id: "run-call",
								name: "run_scenarios",
								args: { mode: "one", scenarioId: "sc-1" },
							},
						],
					},
				},
				{
					role: "toolResult",
					payload: {
						toolCallId: "code-call",
						toolName: "manage_code",
						details: {
							action: "write",
							kind: "scenario",
							id: "sc-1",
							name: "Checkout",
							before: "const x = 1;",
							after: "const x = 2;",
							diagnostics: [],
						},
					},
				},
				{
					role: "toolResult",
					payload: {
						toolCallId: "run-call",
						toolName: "run_scenarios",
						details: {
							mode: "one",
							runs: [{ scenarioId: "sc-1", scenario: "Checkout", status: "passed", runId: "r-1" }],
						},
					},
				},
			];

			const items = buildTranscript(messages, false);
			const codeItem = items[1] as TranscriptToolItem;
			expect(codeItem.codeDiff).toEqual({
				before: "const x = 1;",
				after: "const x = 2;",
				kind: "scenario",
				id: "sc-1",
				name: "Checkout",
				diagnostics: [],
				diagnosticsNote: undefined,
			});

			const runItem = items[2] as TranscriptToolItem;
			expect(runItem.scenarioRuns).toEqual([
				{ scenarioId: "sc-1", scenario: "Checkout", status: "passed", runId: "r-1" },
			]);
		});

		test("apply_ddl compact details retains affected-table links and trace rows", () => {
			const messages: AssistantMessage[] = [
				{ role: "user", payload: "Add posts and remove old table" },
				{
					role: "assistant",
					payload: {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "ddl-call",
								name: "apply_ddl",
								args: { sql: "CREATE TABLE posts (id uuid PRIMARY KEY); DROP TABLE old_posts;" },
							},
						],
						stopReason: "toolUse",
					},
				},
				{
					role: "toolResult",
					payload: {
						toolCallId: "ddl-call",
						toolName: "apply_ddl",
						content: [{ type: "text", text: JSON.stringify({ status: "applied", affectedTables: [{ name: "posts", change: "added" }, { name: "old_posts", change: "removed" }] }) }],
						details: {
							status: "applied",
							statements: ["CREATE TABLE posts (id uuid PRIMARY KEY);", "DROP TABLE old_posts;"],
							affectedTables: [
								{ id: "tbl-posts", name: "posts", change: "added", added: true },
								{ id: "tbl-old", name: "old_posts", change: "removed", removed: true },
							],
							revision: 2,
							generatedSqlStatus: "current",
							sandboxOutcome: "accepted",
						},
					},
				},
				{
					role: "assistant",
					payload: {
						role: "assistant",
						content: [{ type: "text", text: "Updated schema." }],
						stopReason: "stop",
					},
				},
			];

			const items = buildTranscript(messages, false);
			const toolItem = items[1] as TranscriptToolItem;
			expect(toolItem.toolName).toBe("apply_ddl");
			expect(toolItem.trace.title).toBe("Applied SQL to posts, old_posts");
			expect(toolItem.affectedTables).toEqual([
				expect.objectContaining({ id: "tbl-posts", name: "posts" }),
				expect.objectContaining({ id: "tbl-old", name: "old_posts", removed: true }),
			]);
		});
	});
});
