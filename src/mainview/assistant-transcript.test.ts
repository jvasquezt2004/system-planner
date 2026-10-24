import { describe, expect, test } from "bun:test";
import { assistantText, foldAssistantEvent } from "./assistant-transcript";
import type { AssistantMessage } from "../shared/assistant";

describe("assistant transcript model", () => {
	test("folds text deltas into one message and ignores unrelated pi events", () => {
		let messages: AssistantMessage[] = [{ role: "user", payload: "Explain it" }];
		messages = foldAssistantEvent(messages, { type: "agent_start" });
		messages = foldAssistantEvent(messages, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
		messages = foldAssistantEvent(messages, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " world" } });
		expect(messages).toHaveLength(2);
		expect(assistantText(messages[1].payload)).toBe("Hello world");
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
});
