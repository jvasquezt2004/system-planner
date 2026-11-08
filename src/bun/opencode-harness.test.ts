import { afterEach, describe, expect, test } from "bun:test";
import { formFieldsFromOpenCode, handleForm, parseOpenCodeModels, variantToLevel } from "./opencode-harness";
import { startProjectToolServer } from "./opencode-mcp";

const servers: Array<{ close: () => void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

function start(call = async () => ({ success: true, contentItems: [{ type: "inputText" as const, text: "ok" }] })) {
	const server = startProjectToolServer({ token: "secret", tools: [{ name: "read_project", description: "Read", inputSchema: { type: "object", properties: {} } }], call });
	servers.push(server);
	return server;
}
const rpc = (url: string, body: unknown, token = "secret") => fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Project tool MCP server", () => {
	test("rejects callers without the token", async () => {
		const server = start();
		expect((await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "ping" }, "wrong")).status).toBe(401);
		expect((await fetch(server.url, { method: "POST", body: "{}" })).status).toBe(401);
	});

	test("initializes, lists tools, and runs a call", async () => {
		const calls: unknown[] = [];
		const server = start(async (...args: unknown[]) => { calls.push(args); return { success: true, contentItems: [{ type: "inputText" as const, text: "Project: X" }] }; });
		const init = await (await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json() as any;
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect(init.result.capabilities.tools).toBeDefined();
		expect((await rpc(server.url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
		const list = await (await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
		expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["read_project"]);
		const result = await (await rpc(server.url, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_project", arguments: {} } })).json() as any;
		expect(result.result).toEqual({ content: [{ type: "text", text: "Project: X" }], isError: false });
		expect(calls).toHaveLength(1);
	});

	test("reports unknown tools and failed calls without throwing", async () => {
		const server = start(async () => { throw new Error("boom"); });
		const unknown = await (await rpc(server.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } })).json() as any;
		expect(unknown.error.code).toBe(-32602);
		const failed = await (await rpc(server.url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_project" } })).json() as any;
		expect(failed.result).toEqual({ content: [{ type: "text", text: "boom" }], isError: true });
	});
});

describe("OpenCode model catalog", () => {
	test("keeps usable chat models and maps variants to Assistant levels", () => {
		const models = parseOpenCodeModels({ data: [
			{ providerID: "opencode", modelID: "a", name: "A", type: "chat", enabled: true, status: "active", variants: [{ id: "none" }, { id: "low" }, { id: "weird" }] },
			{ providerID: "opencode", modelID: "img", name: "Img", type: "image", enabled: true, status: "active" },
			{ providerID: "x", modelID: "off", name: "Off", type: "chat", enabled: false, status: "active" },
			{ providerID: "x", modelID: "old", name: "Old", type: "chat", enabled: true, status: "deprecated" },
		] });
		expect(models.map((model) => model.id)).toEqual(["opencode/a"]);
		expect(models[0].variants.map(variantToLevel)).toEqual(["off", "low", null]);
	});
});

describe("OpenCode forms", () => {
	const form = { id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [
		{ key: "q0", title: "Color", type: "string", options: [{ value: "Red", label: "Red" }], custom: true },
		{ key: "n", type: "number", minimum: "-Infinity", maximum: 10 },
		{ key: "weird", type: "hologram" },
	] };
	const session = { target: { threadId: "ses_1", turnId: "turn" } };

	test("maps fields, dropping unknown types and non-finite bounds", () => {
		const fields = formFieldsFromOpenCode(form.fields);
		expect(fields.map((field) => field.key)).toEqual(["q0", "n"]);
		expect(fields[0]).toMatchObject({ custom: true, options: [{ value: "Red", label: "Red" }] });
		expect(fields[1]).toMatchObject({ maximum: 10 });
		expect(fields[1].minimum).toBeUndefined();
	});

	test("sends the designer's answer to the form", async () => {
		const requests: string[][] = [];
		const server = { request: async (method: string, path: string, body?: unknown) => { requests.push([method, path, JSON.stringify(body ?? null)]); return null; } };
		await handleForm(server, session, form, { onRequest: async (method, params: any) => { expect(method).toBe("form/request"); expect(params.threadId).toBe("ses_1"); return { answer: { q0: "Red" } }; } });
		expect(requests).toEqual([["POST", "/api/session/ses_1/form/frm_1/reply", JSON.stringify({ answer: { q0: "Red" } })]]);
	});

	test("cancels the form when skipped, when the prompt fails, or when OpenCode rejects the answer", async () => {
		for (const [onRequest, replyFails] of [
			[async () => ({ cancelled: true }), false],
			[async () => { throw new Error("closed"); }, false],
			[async () => ({ answer: { q0: "Red" } }), true],
		] as const) {
			const requests: string[] = [];
			const server = { request: async (method: string, path: string) => { requests.push(`${method} ${path}`); if (replyFails && method === "POST") throw new Error("invalid"); return null; } };
			await handleForm(server, session, form, { onRequest });
			expect(requests[requests.length - 1]).toBe("DELETE /api/session/ses_1/form/frm_1");
		}
	});
});
