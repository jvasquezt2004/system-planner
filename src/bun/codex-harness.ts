import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { CodexSession, startCodexAppServer } from "./codex-app-server";
import { CodexProjectTools } from "./codex-project-tools";

export type CodexProjectCall = { threadId: string; turnId: string; callId: string; tool: string; namespace: string | null; arguments: unknown };

/** The part of a harness session the Assistant drives; Codex and OpenCode both provide it. */
export type ExternalHarnessSession = Pick<CodexSession, "target" | "defaultModel" | "send" | "steer" | "interrupt" | "verifyUser" | "close">;
export type ExternalHarness = { session: ExternalHarnessSession; close: () => void };
export type ExternalHarnessOptions = Parameters<typeof createCodexHarness>[0];

/** Starts an app-owned Codex process with Project tools attached only to its thread. */
export async function createCodexHarness(options: {
	cwd: string;
	instructions: string;
	tools: AgentTool[];
	threadId?: string;
	defaultModel?: string;
	onNotification: (method: string, params: unknown) => void;
	onToolStart: (call: CodexProjectCall) => void;
	onToolEnd: (call: CodexProjectCall, result: AgentToolResult, isError: boolean) => Promise<AgentToolResult> | AgentToolResult;
	onRequest: (method: string, params: unknown) => Promise<unknown>;
	onClose: (error: Error) => void;
	signal?: () => AbortSignal | undefined;
}) {
	let session: CodexSession | undefined;
	let bridge: CodexProjectTools | undefined;
	const server = await startCodexAppServer({
		cwd: options.cwd,
		onNotification: (method, params) => {
			session?.acceptNotification(method, params);
			options.onNotification(method, params);
		},
		onRequest: (method, params) => {
			if (method === "item/tool/call") {
				if (!bridge) throw new Error("Project tools are not ready");
				return bridge.call(params);
			}
			return options.onRequest(method, params);
		},
		onClose: (error) => { session?.close(error); options.onClose(error); },
	});
	session = new CodexSession(server.client);
	bridge = new CodexProjectTools(options.tools, () => session?.target ?? null, options.onToolStart, options.onToolEnd, options.signal);
	try {
		if (options.threadId) await session.resume(options.threadId, { cwd: options.cwd, instructions: options.instructions, defaultModel: options.defaultModel });
		else await session.start({ cwd: options.cwd, instructions: options.instructions, tools: bridge.specs() });
	} catch (error) {
		server.close();
		throw error;
	}
	return { session, close: server.close };
}
