import { describe, expect, test } from "bun:test";
import { assistantError, assistantText, deriveDropConfirmationStates, foldAssistantEvent } from "./assistant-transcript";
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
});
