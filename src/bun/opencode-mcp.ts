import { timingSafeEqual } from "node:crypto";
import type { CodexDynamicTool } from "./codex-app-server";

type ToolResult = { success: boolean; contentItems: Array<{ type: "inputText"; text: string }> };

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/**
 * A minimal MCP server (Streamable HTTP, JSON responses) that exposes the app's Project tools.
 * It listens on loopback only, requires a random bearer token, and lives only as long as the
 * harness that owns it, so the tools exist for no other client.
 */
export function startProjectToolServer(options: {
	tools: CodexDynamicTool[];
	call: (name: string, args: unknown) => Promise<ToolResult>;
	token: string;
}): { url: string; close: () => void } {
	const expected = Buffer.from(`Bearer ${options.token}`);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const given = Buffer.from(request.headers.get("authorization") ?? "");
			if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response("Unauthorized", { status: 401 });
			if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
			let message: JsonRpcRequest;
			try { message = await request.json() as JsonRpcRequest; }
			catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
			if (!message || typeof message !== "object" || Array.isArray(message)) return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }, { status: 400 });
			// Notifications and client responses carry no id (or no method) and get no body.
			if (message.id === undefined || message.id === null || typeof message.method !== "string") return new Response(null, { status: 202 });
			const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
			const fail = (code: number, text: string) => Response.json({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
			switch (message.method) {
				case "initialize": {
					const requested = typeof message.params?.protocolVersion === "string" ? message.params.protocolVersion : "";
					return reply({
						protocolVersion: SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
						capabilities: { tools: { listChanged: false } },
						serverInfo: { name: "schema-designer", version: "1.0.0" },
					});
				}
				case "ping": return reply({});
				case "tools/list":
					return reply({ tools: options.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
				case "tools/call": {
					const name = message.params?.name;
					if (typeof name !== "string" || !options.tools.some((tool) => tool.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
					try {
						const result = await options.call(name, message.params?.arguments ?? {});
						return reply({ content: result.contentItems.map((item) => ({ type: "text", text: item.text })), isError: !result.success });
					} catch (error) {
						return reply({ content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true });
					}
				}
				default: return fail(-32601, `Method not found: ${message.method}`);
			}
		},
	});
	return { url: `http://127.0.0.1:${server.port}/mcp`, close: () => { void server.stop(true); } };
}
