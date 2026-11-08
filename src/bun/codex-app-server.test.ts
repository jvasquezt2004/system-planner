import { describe, expect, test } from "bun:test";
import { CodexAppServer, CodexSession, startCodexAppServer } from "./codex-app-server";

describe("Codex app-server transport", () => {
	test("initializes after the server acknowledges the client", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const ready = client.initialize();
		expect(sent[0].method).toBe("initialize");
		expect(sent[0].params.capabilities.experimentalApi).toBe(true);
		client.accept('{"id":1,"res');
		client.accept('ult":{}}\n');
		await ready;
		expect(sent[1].method).toBe("initialized");
	});

	test("routes server tool requests and notifications", async () => {
		const sent: any[] = [];
		const events: unknown[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), (method, params) => events.push({ method, params }), async (method, params) => ({ method, params }));
		client.accept('{"method":"item/agentMessage/delta","params":{"delta":"hi"}}\n{"id":42,"method":"item/tool/call","params":{"tool":"read_project"}}\n');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual([{ method: "item/agentMessage/delta", params: { delta: "hi" } }]);
		expect(sent[0]).toEqual({ id: 42, result: { method: "item/tool/call", params: { tool: "read_project" } } });
	});

	test("rejects pending calls on exit or invalid output", async () => {
		const client = new CodexAppServer(() => {}, () => {}, async () => ({}));
		const pending = client.request("thread/start", {});
		client.accept('not json\n');
		await expect(pending).rejects.toThrow("Invalid JSON");
		await expect(client.request("turn/start", {})).rejects.toThrow("closed");
	});

	test("reports a missing Codex executable", async () => {
		await expect(startCodexAppServer({ executable: "/nonexistent/schema-designer-codex", cwd: "/tmp", onNotification: () => {}, onRequest: async () => ({}) })).rejects.toThrow("Could not start Codex");
	});

	test("scopes app tools to the thread and waits for a completed turn", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const session = new CodexSession(client);
		const start = session.start({ cwd: "/tmp", instructions: "Project context", tools: [{ name: "read_project", description: "Read", inputSchema: { type: "object" } }] });
		expect(sent[0].params.dynamicTools[0].name).toBe("read_project");
		client.accept('{"id":1,"result":{"thread":{"id":"thread-1"}}}\n');
		await start;
		const turn = session.send("Inspect my project");
		client.accept('{"id":2,"result":{"turn":{"id":"turn-1"}}}\n');
		await Promise.resolve();
		session.acceptNotification("turn/completed", { threadId: "another", turn: { id: "turn-1", status: "failed" } });
		session.acceptNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
		await turn;
		expect(sent[1].params.input[0].text).toBe("Inspect my project");
	});

	test("resumes the intended thread and propagates turn failure", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const session = new CodexSession(client);
		const resumed = session.resume("thread-1", { cwd: "/tmp", instructions: "Project context" });
		client.accept('{"id":1,"result":{"thread":{"id":"thread-1"}}}\n');
		await resumed;
		const turn = session.send("Hello");
		client.accept('{"id":2,"result":{"turn":{"id":"turn-1"}}}\n');
		await Promise.resolve();
		session.acceptNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "Model unavailable" } } });
		await expect(turn).rejects.toThrow("Model unavailable");
		expect(sent[0].method).toBe("thread/resume");
	});

	test("steers and interrupts only the active turn", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const session = new CodexSession(client);
		const start = session.start({ cwd: "/tmp", instructions: "", tools: [] });
		client.accept('{"id":1,"result":{"thread":{"id":"thread-1"}}}\n');
		await start;
		const run = session.send("Start");
		client.accept('{"id":2,"result":{"turn":{"id":"turn-1"}}}\n');
		await Promise.resolve();
		const steer = session.steer("Change direction");
		expect(sent[2].params.expectedTurnId).toBe("turn-1");
		client.accept('{"id":3,"result":{}}\n');
		await steer;
		const interrupt = session.interrupt();
		expect(sent[3].params).toEqual({ threadId: "thread-1", turnId: "turn-1" });
		client.accept('{"id":4,"result":{}}\n');
		await interrupt;
		session.acceptNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
		await expect(run).rejects.toThrow("interrupted");
	});

	test("interrupts a turn stopped while turn/start is still pending", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const session = new CodexSession(client);
		const start = session.start({ cwd: "/tmp", instructions: "", tools: [] });
		client.accept('{"id":1,"result":{"thread":{"id":"thread-1"}}}\n');
		await start;
		const abort = new AbortController();
		const run = session.send("Start", abort.signal);
		abort.abort();
		client.accept('{"id":2,"result":{"turn":{"id":"turn-1"}}}\n');
		await Promise.resolve();
		expect(sent[2]).toMatchObject({ method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });
		client.accept('{"id":3,"result":{}}\n');
		session.acceptNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } });
		await expect(run).rejects.toThrow("interrupted");
	});

	test("uses the thread's configured model when returning to the default", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const session = new CodexSession(client);
		const start = session.start({ cwd: "/tmp", instructions: "", tools: [] });
		client.accept('{"id":1,"result":{"thread":{"id":"thread-1"},"model":"configured-model"}}\n');
		await start;
		const run = session.send("Hello");
		expect(sent[1].params.model).toBe("configured-model");
		client.accept('{"id":2,"result":{"turn":{"id":"turn-1"}}}\n');
		await Promise.resolve();
		session.acceptNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
		await run;
	});
	test("sends the selected reasoning effort with the turn", async () => {
		const sent: any[] = [];
		const client = new CodexAppServer((line) => sent.push(JSON.parse(line)), () => {}, async () => ({}));
		const session = new CodexSession(client);
		const start = session.start({ cwd: "/tmp", instructions: "", tools: [] });
		client.accept('{"id":1,"result":{"thread":{"id":"thread-1"}}}\n');
		await start;
		const run = session.send("Hello", undefined, "gpt-6-sol", "ultra");
		expect(sent[1].params.effort).toBe("ultra");
		client.accept('{"id":2,"result":{"turn":{"id":"turn-1"}}}\n');
		await Promise.resolve();
		session.acceptNotification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } });
		await run;
	});
});
