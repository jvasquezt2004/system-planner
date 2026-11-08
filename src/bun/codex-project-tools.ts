import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Check } from "typebox/value";
import type { CodexDynamicTool } from "./codex-app-server";

type ToolCall = { threadId: string; turnId: string; callId: string; tool: string; namespace: string | null; arguments: unknown };

/** Adapts the existing project tools to Codex's thread-local dynamic tools. */
export class CodexProjectTools {
	private queue: Promise<void> = Promise.resolve();
	private tools: Map<string, AgentTool>;
	constructor(
		tools: AgentTool[],
		private target: () => { threadId: string; turnId?: string } | null,
		private onStart: (call: ToolCall) => void,
		private onEnd: (call: ToolCall, result: AgentToolResult, isError: boolean) => Promise<AgentToolResult> | AgentToolResult,
		private signal: () => AbortSignal | undefined = () => undefined,
	) {
		this.tools = new Map(tools.map((tool) => [tool.name, tool]));
	}

	specs(): CodexDynamicTool[] {
		return [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters }));
	}

	async call(params: unknown): Promise<{ success: boolean; contentItems: Array<{ type: "inputText"; text: string }> }> {
		if (!params || typeof params !== "object") throw new Error("Malformed Codex tool request");
		const call = params as ToolCall;
		if (typeof call.threadId !== "string" || typeof call.turnId !== "string" || typeof call.callId !== "string" || typeof call.tool !== "string" || call.namespace != null) {
			throw new Error("Malformed Codex tool request");
		}
		// Workspace operations and their revision checks must not race each other.
		const run = this.queue.then(async () => {
			if (this.signal()?.aborted) throw new Error("Codex turn was stopped");
			const target = this.target();
			if (!target || target.threadId !== call.threadId || (target.turnId && target.turnId !== call.turnId)) throw new Error("Tool call belongs to another Codex turn");
			const tool = this.tools.get(call.tool);
			if (!tool) throw new Error(`Unknown project tool: ${call.tool}`);
			const args = tool.prepareArguments ? tool.prepareArguments(call.arguments) : call.arguments;
			if (!Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${call.tool}`);
			this.onStart(call);
			let result: AgentToolResult;
			let isError = false;
			try {
				result = await tool.execute(call.callId, args, this.signal());
				isError = Boolean(result.isError);
			} catch (error) {
				isError = true;
				result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], details: undefined };
			}
			result = await this.onEnd(call, result, isError);
			return { success: !isError, contentItems: result.content.filter((item) => item.type === "text").map((item) => ({ type: "inputText" as const, text: item.text })) };
		});
		this.queue = run.then(() => {}, () => {});
		return run;
	}
}
