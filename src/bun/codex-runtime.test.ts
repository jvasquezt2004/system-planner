import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace } from "./workspace";
import type { createCodexHarness } from "./codex-harness";
import { CodexProjectTools } from "./codex-project-tools";
import { applyAssistantDdl } from "./assistant-ddl";
import { createProjectFolderMirror } from "./project-folder";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); });

test("Codex Project tools create an undoable Project change and persist the transcript", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-runtime-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Codex project" });
	const mirror = createProjectFolderMirror({ root: join(dir, "projects"), workspace });
	const factory: typeof createCodexHarness = async (options) => {
		const target = { threadId: "thread", turnId: "turn" };
		const bridge = new CodexProjectTools(options.tools, () => target, options.onToolStart, options.onToolEnd);
		const call = async (tool: string, args: unknown, callId: string) => bridge.call({ ...target, namespace: null, tool, arguments: args, callId });
		const session = {
			target,
			send: async () => {
				expect((await call("read_project", {}, "read")).success).toBe(true);
				writeFileSync(mirror.schemaFile(workspace.getState().activeDesignId!)!, "CREATE TABLE customers (id uuid PRIMARY KEY);\n");
				expect((await call("apply_schema", {}, "ddl")).success).toBe(true);
				options.onNotification("item/completed", { item: { type: "agentMessage", text: "Created customers." } });
			},
			interrupt: async () => {},
		};
		return { session: session as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory, syncProjectFolder: (options) => mirror.sync(options), schemaFile: (id) => mirror.schemaFile(id) });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		await runtime.sendMessage(conversation.id, "Create customers", "codex-default", "medium", "codex-harness");
		expect(workspace.getState().design?.tables.map((table) => table.name)).toEqual(["customers"]);
		expect(runtime.canRevertTurn(conversation.id)).toBe(true);
		expect(runtime.loadConversation(conversation.id)?.messages.some((message) => message.role === "toolResult")).toBe(true);
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design?.tables).toEqual([]);
	} finally { mirror.dispose(); runtime.close(); await workspace.close(); }
});

test("Codex permission requests stay pending until the designer answers", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-permission-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Permission project" });
	let requestVisible!: () => void;
	const visible = new Promise<void>((resolve) => { requestVisible = resolve; });
	let answer: unknown;
	const factory: typeof createCodexHarness = async (options) => ({
		session: {
			target: { threadId: "thread", turnId: "turn" },
			send: async () => { answer = await options.onRequest("item/commandExecution/requestApproval", { threadId: "thread", command: "pwd" }); },
			interrupt: async () => {},
		} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"],
		close: () => {},
	});
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		runtime.subscribe((_id, event) => { if ((event as { type?: string }).type === "codex_request") requestVisible(); });
		const run = runtime.sendMessage(conversation.id, "Run pwd", "codex-default", "medium", "codex-harness");
		await visible;
		const request = runtime.getCodexRequest(conversation.id)!;
		expect(request.params.command).toBe("pwd");
		expect(runtime.answerCodexRequest(conversation.id, "wrong", { decision: "accept" })).toBe(false);
		expect(runtime.answerCodexRequest(conversation.id, request.id, { decision: "decline" })).toBe(true);
		await run;
		expect(answer).toEqual({ decision: "decline" });
		expect(runtime.getCodexRequest(conversation.id)).toBeNull();
	} finally { runtime.close(); await workspace.close(); }
});

test("Codex verification returns a native proof only after explicit verification", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-verification-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Verification project" });
	let requestVisible!: () => void;
	const visible = new Promise<void>((resolve) => { requestVisible = resolve; });
	let answer: unknown;
	const factory: typeof createCodexHarness = async (options) => ({
		session: {
			target: { threadId: "thread", turnId: "turn" },
			send: async () => { answer = await options.onRequest("mcpServer/elicitation/request", { threadId: "thread", mode: "openai/userVerification", challenge: "abc", title: "Confirm", description: "Test" }); },
			verifyUser: () => ({ promise: Promise.resolve({ proof: { credentialId: "credential", signature: "signature" } }), cancel: async () => {} }),
			interrupt: async () => {},
		} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"],
		close: () => {},
	});
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		runtime.subscribe((_id, event) => { if ((event as { type?: string }).type === "codex_request") requestVisible(); });
		const run = runtime.sendMessage(conversation.id, "Verify", "codex-default", "medium", "codex-harness");
		await visible;
		const request = runtime.getCodexRequest(conversation.id)!;
		expect(runtime.answerCodexRequest(conversation.id, request.id, { action: "accept", content: {} })).toBe(false);
		expect(await runtime.verifyCodexRequest(conversation.id, request.id)).toBe(true);
		await run;
		expect(answer).toEqual({ action: "accept", content: { credentialId: "credential", signature: "signature" }, _meta: null });
	} finally { runtime.close(); await workspace.close(); }
});

test("concurrent Codex permission requests are presented one at a time", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-requests-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Requests project" });
	let answers: unknown[] = [];
	const factory: typeof createCodexHarness = async (options) => ({
		session: {
			target: { threadId: "thread", turnId: "turn" },
			send: async () => { answers = await Promise.all(["first", "second"].map((command) => options.onRequest("item/commandExecution/requestApproval", { threadId: "thread", turnId: "turn", command }))); },
			interrupt: async () => {},
		} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {},
	});
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		let count = 0;
		runtime.subscribe((_id, event) => {
			if ((event as { type?: string }).type !== "codex_request") return;
			const request = runtime.getCodexRequest(conversation.id)!;
			expect(request.params.command).toBe(++count === 1 ? "first" : "second");
			queueMicrotask(() => runtime.answerCodexRequest(conversation.id, request.id, { decision: "decline" }));
		});
		await runtime.sendMessage(conversation.id, "Run commands", "codex-default", "medium", "codex-harness");
		expect(count).toBe(2);
		expect(answers).toEqual([{ decision: "decline" }, { decision: "decline" }]);
	} finally { runtime.close(); await workspace.close(); }
});

test("Codex tools do not retarget when the designer opens another Project", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-target-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const first = await workspace.createProject({ name: "First" });
	const second = await workspace.createProject({ name: "Second" });
	await workspace.openProject({ projectId: first.project!.id });
	let result: { success: boolean } | undefined;
	const factory: typeof createCodexHarness = async (options) => {
		const target = { threadId: "thread", turnId: "turn" };
		const bridge = new CodexProjectTools(options.tools, () => target, options.onToolStart, options.onToolEnd);
		const call = (tool: string, args: unknown) => bridge.call({ ...target, namespace: null, tool, arguments: args, callId: tool });
		return { session: { target, send: async () => {
			await call("read_project", {});
			await workspace.openProject({ projectId: second.project!.id });
			result = await call("apply_schema", {});
		}, interrupt: async () => {} } as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory, schemaFile: () => "/nonexistent/schema.sql" });
	try {
		const conversation = runtime.createConversation(first.project!.id);
		await runtime.sendMessage(conversation.id, "Create a table", "codex-default", "medium", "codex-harness");
		expect(result?.success).toBe(false);
		expect(workspace.getState().design?.tables).toEqual([]);
	} finally { runtime.close(); await workspace.close(); }
});

test("declining verification cancels the native request and discards a late proof", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-verification-cancel-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Verification project" });
	let requestVisible!: () => void;
	const visible = new Promise<void>((resolve) => { requestVisible = resolve; });
	let resolveProof!: (value: { proof: { credentialId: string; signature: string } }) => void;
	const proof = new Promise<{ proof: { credentialId: string; signature: string } }>((resolve) => { resolveProof = resolve; });
	let cancelled = false;
	let answer: unknown;
	const factory: typeof createCodexHarness = async (options) => ({ session: {
		target: { threadId: "thread", turnId: "turn" },
		send: async () => { answer = await options.onRequest("mcpServer/elicitation/request", { threadId: "thread", mode: "openai/userVerification", challenge: "abc", title: "Confirm", description: "Test" }); },
		verifyUser: () => ({ promise: proof, cancel: async () => { cancelled = true; } }), interrupt: async () => {},
	} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} });
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		runtime.subscribe((_id, event) => { if ((event as { type?: string }).type === "codex_request") requestVisible(); });
		const run = runtime.sendMessage(conversation.id, "Verify", "codex-default", "medium", "codex-harness");
		await visible;
		const request = runtime.getCodexRequest(conversation.id)!;
		const verify = runtime.verifyCodexRequest(conversation.id, request.id);
		expect(runtime.answerCodexRequest(conversation.id, request.id, { action: "decline", content: null, _meta: null })).toBe(true);
		resolveProof({ proof: { credentialId: "credential", signature: "signature" } });
		expect(await verify).toBe(false);
		await run;
		expect(cancelled).toBe(true);
		expect(answer).toEqual({ action: "decline", content: null, _meta: null });
	} finally { runtime.close(); await workspace.close(); }
});

test("Codex forwards a selected model and restores the configured default", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-model-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Model project" });
	const selected: Array<string | undefined> = [];
	const factory: typeof createCodexHarness = async () => ({ session: {
		target: { threadId: "thread" }, defaultModel: "configured-model",
		send: async (_text: string, _signal: AbortSignal, model?: string) => { selected.push(model); }, interrupt: async () => {},
	} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} });
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		await runtime.sendMessage(conversation.id, "Use a model", "chosen-model", "medium", "codex-harness");
		await runtime.sendMessage(conversation.id, "Use the default", "codex-default", "medium", "codex-harness");
		expect(selected).toEqual(["chosen-model", undefined]);
		expect(runtime.loadConversation(conversation.id)?.model).toBe("codex-default");
		expect(() => runtime.updateConversationSelection(conversation.id, "openai", "other-model", "medium")).toThrow("Start a new Conversation");
		await expect(runtime.sendMessage(conversation.id, "Switch", "other-model", "medium", "openai")).rejects.toThrow("Start a new Conversation");
	} finally { runtime.close(); await workspace.close(); }
});

test("Codex can edit the System design and revert the change", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-system-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "System project" });
	const factory: typeof createCodexHarness = async (options) => {
		const target = { threadId: "thread", turnId: "turn" };
		const bridge = new CodexProjectTools(options.tools, () => target, options.onToolStart, options.onToolEnd);
		const call = (tool: string, args: unknown) => bridge.call({ ...target, namespace: null, tool, arguments: args, callId: tool });
		return { session: { target, send: async () => {
			expect((await call("read_system_design", {})).success).toBe(true);
			expect((await call("edit_system_design", { operations: [{ op: "add_component", id: "worker", name: "Worker", kind: "generic", x: 40, y: 40 }] })).success).toBe(true);
		}, interrupt: async () => {} } as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		await runtime.sendMessage(conversation.id, "Add a worker", "codex-default", "medium", "codex-harness");
		expect(workspace.getState().systemDesign?.components.map((item) => item.name)).toEqual(["Worker"]);
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().systemDesign?.components).toEqual([]);
	} finally { runtime.close(); await workspace.close(); }
});

test("stopping while Codex is starting closes it before it can run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-start-stop-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Stop project" });
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let sent = false;
	let closed = false;
	const factory: typeof createCodexHarness = async () => {
		await gate;
		return { session: { target: { threadId: "thread" }, send: async () => { sent = true; } } as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => { closed = true; } };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		const run = runtime.sendMessage(conversation.id, "Start", "codex-default", "medium", "codex-harness");
		runtime.stop(conversation.id);
		release();
		await run;
		expect(sent).toBe(false);
		expect(closed).toBe(true);
		expect(runtime.isTurnRunning?.(conversation.id)).toBe(false);
	} finally { runtime.close(); await workspace.close(); }
});

test("Codex works inside the synced Project folder and is told it is read-only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-folder-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Folder project" });
	let seen: { cwd: string; instructions: string } | undefined;
	const factory: typeof createCodexHarness = async (options) => {
		seen = { cwd: options.cwd, instructions: options.instructions };
		return { session: { target: { threadId: "thread", turnId: "turn" }, send: async () => {}, interrupt: async () => {} } as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory, syncProjectFolder: async () => "/projects/folder-project" });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		await runtime.sendMessage(conversation.id, "Hello", "codex-default", "medium", "codex-harness");
		expect(seen?.cwd).toBe("/projects/folder-project");
		expect(seen?.instructions).toContain("apply_schema");
		expect(seen?.instructions).not.toContain("apply_ddl");
		expect(seen?.instructions).toContain("Everything else there is read-only");
	} finally { runtime.close(); await workspace.close(); }
});

test("OpenCode conversations use the OpenCode harness, keep their own thread, and cannot switch runtime", async () => {
	const dir = mkdtempSync(join(tmpdir(), "opencode-runtime-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "OpenCode project" });
	const sent: Array<{ model?: string; effort?: string }> = [];
	let created = 0;
	const unexpected: typeof createCodexHarness = async () => { throw new Error("Codex must not start for an OpenCode conversation"); };
	const factory: typeof createCodexHarness = async (options) => {
		created++;
		const session = {
			target: { threadId: options.threadId ?? "oc-session", turnId: "turn" },
			defaultModel: "opencode/crouton-alpha-free",
			send: async (_text: string, _signal?: AbortSignal, model?: string, effort?: string) => { sent.push({ model, effort }); },
			interrupt: async () => {},
		};
		return { session: session as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: unexpected, opencodeHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		await runtime.sendMessage(conversation.id, "Hi", "opencode-default", "high", "opencode-harness");
		await runtime.sendMessage(conversation.id, "Again", "opencode/pulse-alpha-free", "low", "opencode-harness");
		expect(sent).toEqual([{ model: undefined, effort: "high" }, { model: "opencode/pulse-alpha-free", effort: "low" }]);
		const messages = runtime.loadConversation(conversation.id)!.messages;
		expect(messages.filter((message) => message.kind === "opencode-thread")).toHaveLength(1);
		expect(messages.some((message) => message.kind === "codex-thread")).toBe(false);
		await expect(runtime.sendMessage(conversation.id, "Switch", "codex-default", "medium", "codex-harness")).rejects.toThrow("Start a new Conversation");
		expect(created).toBe(1);
	} finally { runtime.close(); await workspace.close(); }
});

test("Codex questions are answered through one in-app form and return to Codex in its own shape", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-form-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Form project" });
	let visible!: () => void;
	const shown = new Promise<void>((resolve) => { visible = resolve; });
	let received: unknown;
	const factory: typeof createCodexHarness = async (options) => ({
		session: {
			target: { threadId: "thread", turnId: "turn" },
			send: async () => { received = await options.onRequest("item/tool/requestUserInput", { threadId: "thread", questions: [{ id: "q1", header: "Name", question: "Your name?", isOther: false, isSecret: false, options: null }] }); },
			interrupt: async () => {},
		} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"],
		close: () => {},
	});
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		runtime.subscribe((_id, event) => { if ((event as { type?: string }).type === "codex_request") visible(); });
		const run = runtime.sendMessage(conversation.id, "Ask me", "codex-default", "medium", "codex-harness");
		await shown;
		const request = runtime.getCodexRequest(conversation.id)!;
		expect(request.method).toBe("form/request");
		expect((request.params.fields as Array<{ key: string }>).map((field) => field.key)).toEqual(["q1"]);
		expect(runtime.answerCodexRequest(conversation.id, request.id, { answer: { q1: 5 } })).toBe(false);
		expect(runtime.answerCodexRequest(conversation.id, request.id, { answer: {} })).toBe(false);
		expect(runtime.answerCodexRequest(conversation.id, request.id, { answer: { q1: "Ada" } })).toBe(true);
		await run;
		expect(received).toEqual({ answers: { q1: { answers: ["Ada"] } } });
	} finally { runtime.close(); await workspace.close(); }
});

test("skipping a form tells the harness it was cancelled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-form-skip-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Skip project" });
	let visible!: () => void;
	const shown = new Promise<void>((resolve) => { visible = resolve; });
	let received: unknown;
	const factory: typeof createCodexHarness = async (options) => ({
		session: {
			target: { threadId: "oc", turnId: "turn" },
			send: async () => { received = await options.onRequest("form/request", { threadId: "oc", title: "Questions", fields: [{ key: "a", type: "string" }] }); },
			interrupt: async () => {},
		} as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"],
		close: () => {},
	});
	const runtime = createAssistantRuntime({ databasePath, workspace, opencodeHarnessFactory: factory });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		runtime.subscribe((_id, event) => { if ((event as { type?: string }).type === "codex_request") visible(); });
		const run = runtime.sendMessage(conversation.id, "Ask", "opencode-default", "medium", "opencode-harness");
		await shown;
		const request = runtime.getCodexRequest(conversation.id)!;
		expect(runtime.answerCodexRequest(conversation.id, request.id, { cancel: true })).toBe(true);
		await run;
		expect(received).toEqual({ cancelled: true });
	} finally { runtime.close(); await workspace.close(); }
});

test("a harness changes the schema by editing schema.sql and calling apply_schema", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codex-schema-file-"));
	dirs.push(dir);
	const databasePath = join(dir, "workspace.sqlite");
	const workspace = await createDesignWorkspace({ databasePath });
	const state = await workspace.createProject({ name: "Schema file project" });
	await applyAssistantDdl(workspace, "CREATE TABLE notes (id integer PRIMARY KEY, body text); CREATE INDEX notes_body_idx ON notes (body);");
	const mirror = createProjectFolderMirror({ root: join(dir, "projects"), workspace });
	const seen: { tools: string[]; results: Array<{ success: boolean; text: string }>; file: string } = { tools: [], results: [], file: "" };
	const factory: typeof createCodexHarness = async (options) => {
		seen.tools = options.tools.map((tool) => tool.name);
		const target = { threadId: "thread", turnId: "turn" };
		const bridge = new CodexProjectTools(options.tools, () => target, options.onToolStart, options.onToolEnd);
		const apply = async () => { const r = await bridge.call({ ...target, namespace: null, tool: "apply_schema", arguments: {}, callId: `c${seen.results.length}` }); seen.results.push({ success: r.success, text: r.contentItems.map((item) => item.text).join("") }); };
		const session = {
			target,
			send: async () => {
				const file = mirror.schemaFile(workspace.getState().activeDesignId!)!;
				const original = readFileSync(file, "utf8");
				// A bad edit is reported and changes nothing.
				writeFileSync(file, `${original}\nCREATE VIEW broken AS SELECT nope FROM notes;\n`);
				await apply();
				// A good edit: add a column and drop the index.
				writeFileSync(file, original.replace('"body" text', '"body" text,\n  "pinned" boolean').replace(/CREATE INDEX "notes_body_idx"[^;]*;\n*/, ""));
				await apply();
				seen.file = readFileSync(file, "utf8");
				await apply();
			},
			interrupt: async () => {},
		};
		return { session: session as unknown as Awaited<ReturnType<typeof createCodexHarness>>["session"], close: () => {} };
	};
	const runtime = createAssistantRuntime({ databasePath, workspace, codexHarnessFactory: factory, syncProjectFolder: (options) => mirror.sync(options), schemaFile: (id) => mirror.schemaFile(id) });
	try {
		const conversation = runtime.createConversation(state.project!.id);
		await runtime.sendMessage(conversation.id, "Add a pinned flag", "codex-default", "medium", "codex-harness");
		expect(seen.tools).toContain("apply_schema");
		expect(seen.tools).not.toContain("apply_ddl");
		expect(seen.results[0].success).toBe(false);
		expect(seen.results[0].text).toContain("PostgreSQL rejected schema.sql");
		expect(seen.results[1]).toMatchObject({ success: true });
		expect(JSON.parse(seen.results[1].text)).toMatchObject({ status: "applied", tablesChanged: ["notes"] });
		const notes = workspace.getState().design!.tables[0];
		expect(notes.columns.map((column) => column.name)).toEqual(["id", "body", "pinned"]);
		expect(notes.indexes ?? []).toEqual([]);
		// The file is rewritten from the Design, so applying it again has nothing to do.
		expect(seen.file).toContain('"pinned" boolean');
		expect(JSON.parse(seen.results[2].text)).toMatchObject({ status: "unchanged" });
		// One Turn revert undoes the schema edit.
		await runtime.revertTurn(conversation.id);
		expect(workspace.getState().design!.tables[0].columns.map((column) => column.name)).toEqual(["id", "body"]);
	} finally { mirror.dispose(); runtime.close(); await workspace.close(); }
});
