import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexProjectTools } from "./codex-project-tools";
import type { ExternalHarness, ExternalHarnessOptions, ExternalHarnessSession } from "./codex-harness";
import { startProjectToolServer } from "./opencode-mcp";
import type { HarnessFormField, HarnessFormResult } from "../shared/harness-form";

/** The name OpenCode prefixes onto the Project tools it receives from the app's MCP server. */
export const OPENCODE_PROJECT_SERVER = "schema-designer";

/** GUI launchers may have a smaller PATH than an interactive shell. */
export function findOpenCodeExecutable(): string | null {
	const found = Bun.which("opencode");
	if (found) return found;
	if (process.platform === "win32") return null;
	for (const path of [
		join(homedir(), ".opencode/bin/opencode"),
		join(homedir(), ".local/bin/opencode"),
		join(homedir(), ".local/share/mise/shims/opencode"),
		join(homedir(), ".cargo/bin/opencode"),
		"/usr/local/bin/opencode", "/opt/homebrew/bin/opencode",
	]) {
		try { accessSync(path, constants.X_OK); return path; } catch { /* Try the next standard location. */ }
	}
	return null;
}

export type OpenCodeModelInfo = {
	/** providerID/modelID: the id the Assistant stores and sends back. */
	id: string;
	providerID: string;
	modelID: string;
	name: string;
	/** OpenCode reasoning variants, such as low or high. */
	variants: string[];
};

type OpenCodeServer = {
	request: (method: string, path: string, body?: unknown) => Promise<any>;
	events: (signal: AbortSignal) => AsyncGenerator<{ type: string; data: any }>;
	close: () => void;
	exited: Promise<Error>;
};

/** A private loopback `opencode serve`. Its config is passed by environment, never written to disk. */
export async function startOpenCodeServer(options: { cwd: string; executable?: string; config?: unknown }): Promise<OpenCodeServer> {
	const password = crypto.randomUUID();
	const child: ChildProcessWithoutNullStreams = spawn(options.executable ?? findOpenCodeExecutable() ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, ...(options.config ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config) } : {}) },
	});
	let output = "";
	const exited = new Promise<Error>((resolve) => {
		child.on("error", (error) => resolve(new Error(`Could not start OpenCode: ${error.message}`)));
		child.on("exit", (code, signal) => resolve(new Error(`OpenCode exited (${signal ?? code ?? "unknown"})`)));
	});
	const base = await new Promise<string>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error("OpenCode did not start within 20 seconds")); }, 20_000);
		const onData = (chunk: Buffer) => {
			output = (output + chunk.toString("utf8")).slice(-4000);
			const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
			if (match) { clearTimeout(timer); resolve(match[1]); }
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		void exited.then((error) => { clearTimeout(timer); reject(error); });
	});
	const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" };
	return {
		exited,
		close: () => { child.kill(); },
		async request(method, path, body) {
			const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
			const text = await response.text();
			if (!response.ok) {
				let message = text;
				try { message = JSON.parse(text).message ?? text; } catch { /* Keep the raw text. */ }
				throw new Error(`OpenCode ${method} ${path} failed (${response.status}): ${message}`);
			}
			return text ? JSON.parse(text) : null;
		},
		async *events(signal) {
			const response = await fetch(`${base}/api/event`, { headers, signal });
			if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status})`);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) return;
					buffer += decoder.decode(value, { stream: true });
					let end: number;
					while ((end = buffer.indexOf("\n\n")) !== -1) {
						const frame = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
						if (!line) continue;
						try { const event = JSON.parse(line.slice(6)); if (typeof event?.type === "string") yield { type: event.type, data: event.data ?? {} }; } catch { /* Skip a malformed frame. */ }
					}
				}
			} finally { void reader.cancel().catch(() => {}); }
		},
	};
}

const KNOWN_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/** OpenCode names "no reasoning" `none`; the Assistant calls it `off`. */
export function variantToLevel(variant: string): string | null {
	const level = variant === "none" ? "off" : variant;
	return KNOWN_LEVELS.has(level) ? level : null;
}

function levelToVariant(level: string | undefined, model: OpenCodeModelInfo | undefined): string | undefined {
	if (!level || !model) return undefined;
	const wanted = level === "off" ? "none" : level;
	return model.variants.includes(wanted) ? wanted : undefined;
}

export function parseOpenCodeModels(response: any): OpenCodeModelInfo[] {
	const data: any[] = Array.isArray(response?.data) ? response.data : [];
	return data
		.filter((model) => (model.type === undefined || model.type === "chat") && model.enabled !== false && (model.status === undefined || model.status === "active") && typeof model.providerID === "string" && typeof model.modelID === "string")
		.map((model) => ({
			id: `${model.providerID}/${model.modelID}`,
			providerID: model.providerID,
			modelID: model.modelID,
			name: String(model.name || model.modelID),
			variants: Array.isArray(model.variants) ? model.variants.map((variant: { id?: unknown }) => String(variant.id)) : [],
		}));
}

function splitModel(id: string, models: OpenCodeModelInfo[]): OpenCodeModelInfo | undefined {
	return models.find((model) => model.id === id);
}

async function waitForProjectTools(server: OpenCodeServer): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const list = await server.request("GET", "/api/mcp").catch(() => null);
		const entry = Array.isArray(list?.data) ? list.data.find((candidate: { name?: string }) => candidate.name === OPENCODE_PROJECT_SERVER) : undefined;
		if (entry?.status?.status === "connected") return;
		if (entry?.status?.status === "failed") throw new Error(`OpenCode could not reach the Project tools: ${entry.status.error ?? "connection failed"}`);
		await Bun.sleep(250);
	}
	throw new Error("OpenCode did not connect to the Project tools in time");
}

class OpenCodeSession implements ExternalHarnessSession {
	private sessionId: string | null = null;
	private turnId: string | null = null;
	private configuredModel: string | undefined;
	private appliedModel: { id: string; variant?: string } | null = null;
	private completion: { resolve: () => void; reject: (error: Error) => void } | null = null;
	models: OpenCodeModelInfo[] = [];

	constructor(private server: OpenCodeServer, private cwd: string) {}

	get target(): { threadId: string; turnId?: string } | null {
		return this.sessionId ? { threadId: this.sessionId, ...(this.turnId ? { turnId: this.turnId } : {}) } : null;
	}
	get defaultModel(): string | undefined { return this.configuredModel; }
	get id(): string | null { return this.sessionId; }

	async start(options: { instructions: string; toolNames?: string[]; threadId?: string; defaultModel?: string }): Promise<string> {
		// OpenCode connects MCP servers in the background; a prompt sent earlier would not see the Project tools.
		await waitForProjectTools(this.server);
		this.models = parseOpenCodeModels(await this.server.request("GET", "/api/model"));
		if (options.threadId) {
			await this.server.request("GET", `/api/session/${encodeURIComponent(options.threadId)}`);
			this.sessionId = options.threadId;
			this.configuredModel = options.defaultModel;
		} else {
			const fallback = await this.server.request("GET", "/api/model/default").catch(() => null);
			const defaultId = fallback?.data?.providerID && fallback?.data?.modelID ? `${fallback.data.providerID}/${fallback.data.modelID}` : undefined;
			const model = defaultId ? splitModel(defaultId, this.models) : undefined;
			const created = await this.server.request("POST", "/api/session", {
				location: { directory: this.cwd },
				...(model ? { model: { providerID: model.providerID, id: model.modelID } } : {}),
			});
			if (typeof created?.data?.id !== "string") throw new Error("OpenCode did not return a session ID");
			this.sessionId = created.data.id;
			this.configuredModel = defaultId;
			if (model) this.appliedModel = { id: model.id };
		}
		// Session-scoped instructions: other OpenCode sessions never see them.
		await this.server.request("PUT", `/api/experimental/session/${this.sessionId}/instructions/entries/${OPENCODE_PROJECT_SERVER}`, { value: `${options.instructions}\n\nThe Project tools come from the \"${OPENCODE_PROJECT_SERVER}\" MCP server and are called directly as ${OPENCODE_PROJECT_SERVER}_<tool> (${(options.toolNames ?? []).map((name) => `${OPENCODE_PROJECT_SERVER}_${name}`).join(", ")}). Call them by those exact names; do not search for them or wrap them in code.` });
		return this.sessionId!;
	}

	async send(text: string, signal?: AbortSignal, model?: string, effort?: string): Promise<void> {
		if (!this.sessionId) throw new Error("OpenCode session has not started");
		if (this.completion) throw new Error("OpenCode turn already running");
		const chosen = model ?? this.configuredModel;
		const info = chosen ? splitModel(chosen, this.models) : undefined;
		if (chosen && !info) throw new Error(`OpenCode does not offer the model ${chosen}. Pick another model.`);
		const variant = levelToVariant(effort, info);
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const completed = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
		void completed.catch(() => {});
		this.completion = { resolve, reject };
		const interrupt = () => { void this.interrupt().catch(() => {}); };
		signal?.addEventListener("abort", interrupt, { once: true });
		try {
			if (info && (this.appliedModel?.id !== info.id || this.appliedModel?.variant !== variant)) {
				await this.server.request("POST", `/api/session/${this.sessionId}/model`, { model: { providerID: info.providerID, id: info.modelID, ...(variant ? { variant } : {}) } });
				this.appliedModel = { id: info.id, variant };
			}
			this.turnId = crypto.randomUUID();
			await this.server.request("POST", `/api/session/${this.sessionId}/prompt`, { text });
			if (signal?.aborted) interrupt();
			await completed;
		} finally {
			signal?.removeEventListener("abort", interrupt);
			this.completion = null;
			this.turnId = null;
		}
	}

	/** Called by the event loop when OpenCode reports the end of the running execution. */
	finish(outcome: "succeeded" | "failed" | "interrupted", message?: string): void {
		if (!this.completion) return;
		if (outcome === "succeeded") this.completion.resolve();
		else this.completion.reject(new Error(message ?? `OpenCode turn ${outcome}`));
	}

	async interrupt(): Promise<void> {
		if (this.sessionId && this.turnId) await this.server.request("POST", `/api/session/${this.sessionId}/interrupt`);
	}

	async steer(text: string): Promise<void> {
		if (!this.sessionId || !this.turnId) throw new Error("OpenCode turn is not ready for steering yet");
		await this.server.request("POST", `/api/session/${this.sessionId}/prompt`, { text, delivery: "steer" });
	}

	verifyUser(): never { throw new Error("OpenCode does not request identity verification"); }

	close(error = new Error("OpenCode session closed")): void { this.completion?.reject(error); }
}

/** Starts an app-owned OpenCode server with the Project tools reachable only through it. */
export async function createOpenCodeHarness(options: ExternalHarnessOptions): Promise<ExternalHarness> {
	let session: OpenCodeSession | undefined;
	let bridge: CodexProjectTools | undefined;
	const token = crypto.randomUUID();
	bridge = new CodexProjectTools(options.tools, () => session?.target ?? null, options.onToolStart, options.onToolEnd, options.signal);
	const mcp = startProjectToolServer({
		token,
		tools: bridge.specs(),
		call: (name, args) => {
			const target = session?.target;
			if (!bridge || !target?.turnId) throw new Error("Project tools are only available during a turn");
			return bridge.call({ threadId: target.threadId, turnId: target.turnId, callId: crypto.randomUUID(), tool: name, namespace: null, arguments: args });
		},
	});
	const abort = new AbortController();
	let server: OpenCodeServer;
	try {
		server = await startOpenCodeServer({
			cwd: options.cwd,
			config: { mcp: { servers: { [OPENCODE_PROJECT_SERVER]: { type: "remote", url: mcp.url, headers: { Authorization: `Bearer ${token}` }, oauth: false, codemode: false } } } },
		});
	} catch (error) {
		mcp.close();
		throw error;
	}
	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		abort.abort();
		session?.close();
		server.close();
		mcp.close();
	};
	void server.exited.then((error) => { if (!closed) { close(); options.onClose(error); } });
	session = new OpenCodeSession(server, options.cwd);
	const live = session;
	void runEvents(server, live, abort.signal, options, () => { if (!closed) { close(); options.onClose(new Error("OpenCode event stream ended")); } });
	try {
		await live.start({ instructions: options.instructions, toolNames: options.tools.map((tool) => tool.name), threadId: options.threadId, defaultModel: options.defaultModel });
	} catch (error) {
		close();
		throw error;
	}
	return { session: live, close };
}

async function runEvents(server: OpenCodeServer, session: OpenCodeSession, signal: AbortSignal, options: ExternalHarnessOptions, onEnd: () => void): Promise<void> {
	const toolNames = new Map<string, string>();
	const toolItems = new Map<string, Record<string, unknown>>();
	const projectPrefix = `${OPENCODE_PROJECT_SERVER}_`;
	const nameOf = (id: string) => toolNames.get(id) ?? id.replace(/^functions\./, "").replace(/:\d+$/, "");
	try {
		for await (const { type, data } of server.events(signal)) {
			if (type === "permission.asked") { if (data.sessionID === session.id) void handlePermission(server, session, data, options); continue; }
			if (type === "form.created") { if (data.form?.sessionID === session.id) void handleForm(server, session, data.form, options); continue; }
			if (data.sessionID !== session.id) continue;
			const textId = () => `${data.assistantMessageID}:${data.ordinal ?? 0}`;
			switch (type) {
				case "session.text.started": options.onNotification("item/started", { item: { id: textId(), type: "agentMessage" } }); break;
				case "session.text.delta": options.onNotification("item/agentMessage/delta", { delta: data.delta }); break;
				case "session.text.ended": options.onNotification("item/completed", { item: { id: textId(), type: "agentMessage", text: data.text } }); break;
				case "session.tool.input.started": if (typeof data.id === "string" && typeof data.name === "string") toolNames.set(data.id, data.name); break;
				case "session.tool.called": {
					const name = nameOf(data.id);
					if (name.startsWith(projectPrefix)) break; // The Project tool bridge records these itself.
					const input = (data.input ?? {}) as Record<string, unknown>;
					const item = name === "shell" || name === "bash"
						? { id: data.id, type: "commandExecution", command: String(input.command ?? ""), cwd: String(input.cwd ?? input.workdir ?? "") }
						: { id: data.id, type: "mcpToolCall", server: "opencode", tool: name, arguments: input };
					toolItems.set(data.id, item);
					options.onNotification("item/started", { item });
					break;
				}
				case "session.tool.success":
				case "session.tool.failed": {
					const item = toolItems.get(data.id);
					if (!item) break;
					toolItems.delete(data.id);
					const output = Array.isArray(data.content) ? data.content.filter((part: { type?: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") : "";
					options.onNotification("item/completed", { item: { ...item, status: type === "session.tool.success" ? "completed" : "failed", aggregatedOutput: output, ...(type === "session.tool.failed" ? { error: data.error ?? true } : {}) } });
					break;
				}
				case "session.execution.succeeded": session.finish("succeeded"); break;
				case "session.execution.failed": session.finish("failed", data.error?.message); break;
				case "session.execution.interrupted": session.finish("interrupted", "OpenCode turn interrupted"); break;
			}
		}
	} catch (error) {
		if (signal.aborted) return;
		session.finish("failed", error instanceof Error ? error.message : String(error));
	}
	if (!signal.aborted) onEnd();
}

async function handlePermission(server: OpenCodeServer, session: OpenCodeSession, request: any, options: ExternalHarnessOptions): Promise<void> {
	const target = session.target;
	const resources = Array.isArray(request.resources) ? request.resources.map(String) : [];
	let decision: "once" | "reject" = "reject";
	try {
		const response = await options.onRequest("item/commandExecution/requestApproval", {
			threadId: target?.threadId,
			turnId: target?.turnId,
			itemId: request.source?.id,
			harnessName: "OpenCode",
			reason: request.message || `OpenCode wants permission for “${request.action}”.`,
			command: `${request.action}${resources.length ? ` ${resources.join(" ")}` : ""}`,
		}) as { decision?: string };
		if (response?.decision === "accept") decision = "once";
	} catch { /* Treat a failed prompt as a decline. */ }
	await server.request("POST", `/api/session/${request.sessionID}/permission/${request.id}/reply`, { decision }).catch(() => {});
}

/** One-shot discovery of what the installed OpenCode can run, using a bare private server. */
export async function discoverOpenCodeModels(executable = findOpenCodeExecutable() ?? undefined): Promise<{ models: OpenCodeModelInfo[]; defaultModel: string | null }> {
	const server = await startOpenCodeServer({ cwd: homedir(), executable });
	try {
		const models = parseOpenCodeModels(await server.request("GET", "/api/model"));
		const fallback = await server.request("GET", "/api/model/default").catch(() => null);
		const defaultModel = fallback?.data?.providerID && fallback?.data?.modelID ? `${fallback.data.providerID}/${fallback.data.modelID}` : null;
		return { models, defaultModel };
	} finally { server.close(); }
}

const finiteNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** OpenCode form fields as the Assistant's form fields. Unknown field types are dropped. */
export function formFieldsFromOpenCode(fields: unknown): HarnessFormField[] {
	if (!Array.isArray(fields)) return [];
	const known = new Set(["string", "number", "integer", "boolean", "multiselect", "external"]);
	return fields.filter((field) => field && typeof field.key === "string" && known.has(field.type)).map((field) => ({
		key: field.key,
		type: field.type,
		title: typeof field.title === "string" ? field.title : undefined,
		description: typeof field.description === "string" ? field.description : undefined,
		required: field.required === true,
		hidden: field.hidden === true,
		...(Array.isArray(field.when) ? { when: field.when.filter((condition: { key?: unknown; op?: unknown }) => typeof condition.key === "string" && (condition.op === "eq" || condition.op === "neq")) } : {}),
		...(Array.isArray(field.options) ? { options: field.options.map((option: { value: unknown; label?: unknown; description?: unknown }) => ({ value: String(option.value), label: String(option.label ?? option.value), ...(option.description ? { description: String(option.description) } : {}) })) } : {}),
		...(field.custom === true ? { custom: true } : {}),
		...(field.default !== undefined && !(typeof field.default === "number" && !Number.isFinite(field.default)) ? { default: field.default } : {}),
		...(finiteNumber(field.minimum) !== undefined ? { minimum: finiteNumber(field.minimum) } : {}),
		...(finiteNumber(field.maximum) !== undefined ? { maximum: finiteNumber(field.maximum) } : {}),
		...(typeof field.url === "string" ? { url: field.url } : {}),
	}));
}

/** Shows an OpenCode form in the app and sends the designer's answer back, or cancels the form. */
export async function handleForm(server: Pick<OpenCodeServer, "request">, session: { target: { threadId: string; turnId?: string } | null }, form: any, options: Pick<ExternalHarnessOptions, "onRequest">): Promise<void> {
	const target = session.target;
	let result: HarnessFormResult = { cancelled: true };
	try {
		result = await options.onRequest("form/request", {
			threadId: target?.threadId, turnId: target?.turnId,
			title: typeof form.title === "string" ? form.title : "OpenCode needs your input",
			fields: formFieldsFromOpenCode(form.fields),
		}) as HarnessFormResult;
	} catch { /* Treat a failed prompt as a cancellation. */ }
	if (result && "answer" in result) {
		const accepted = await server.request("POST", `/api/session/${form.sessionID}/form/${form.id}/reply`, { answer: result.answer }).then(() => true, () => false);
		if (accepted) return;
	}
	await server.request("DELETE", `/api/session/${form.sessionID}/form/${form.id}`).catch(() => {});
}
