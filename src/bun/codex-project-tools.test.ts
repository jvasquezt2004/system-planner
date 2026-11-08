import { describe, expect, test } from "bun:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CodexProjectTools } from "./codex-project-tools";

describe("Codex project tools", () => {
	test("validates arguments and rejects calls from other threads before executing", async () => {
		let calls = 0;
		const tool: AgentTool = { name: "read_project", label: "Read", description: "Read project", parameters: Type.Object({ id: Type.String() }), execute: async (_id, args) => {
			calls++;
			return { content: [{ type: "text", text: (args as { id: string }).id }], details: {} };
		} };
		const bridge = new CodexProjectTools([tool], () => ({ threadId: "t", turnId: "u" }), () => {}, (_call, result) => result);
		const call = { threadId: "t", turnId: "u", callId: "c", namespace: null, tool: "read_project", arguments: { id: "project" } };
		expect(await bridge.call(call)).toEqual({ success: true, contentItems: [{ type: "inputText", text: "project" }] });
		await expect(bridge.call({ ...call, threadId: "other" })).rejects.toThrow("another Codex turn");
		await expect(bridge.call({ ...call, arguments: { id: 42 } })).rejects.toThrow("Invalid arguments");
		expect(calls).toBe(1);
	});

	test("serializes mutations and reports tool failures", async () => {
		const order: string[] = [];
		const tool: AgentTool = { name: "edit", label: "Edit", description: "Edit", parameters: Type.Object({}), execute: async (id) => {
			order.push(`start ${id}`);
			await Promise.resolve();
			order.push(`end ${id}`);
			if (id === "a") throw new Error("failed");
			return { content: [{ type: "text", text: "ok" }], details: {} };
		} };
		const bridge = new CodexProjectTools([tool], () => ({ threadId: "t" }), () => {}, (_call, result) => result);
		const call = { threadId: "t", turnId: "u", callId: "a", namespace: null, tool: "edit", arguments: {} };
		const [first, second] = await Promise.all([bridge.call(call), bridge.call({ ...call, callId: "b" })]);
		expect(order).toEqual(["start a", "end a", "start b", "end b"]);
		expect(first.success).toBe(false);
		expect(second.success).toBe(true);
	});
});
