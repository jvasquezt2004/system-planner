import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** GUI launchers may have a smaller PATH than an interactive shell. */
export function findCodexExecutable(): string | null {
	const found = Bun.which("codex");
	if (found) return found;
	if (process.platform === "win32") return null;
	for (const path of [
		join(homedir(), ".local/bin/codex"),
		join(homedir(), ".local/share/mise/command-wrappers/bin/codex"),
		join(homedir(), ".local/share/mise/shims/codex"),
		join(homedir(), ".cargo/bin/codex"),
		"/usr/local/bin/codex", "/opt/homebrew/bin/codex",
	]) {
		try { accessSync(path, constants.X_OK); return path; } catch { /* Try the next standard location. */ }
	}
	return null;
}

/** JSON-RPC transport for an app-owned Codex app-server process. */
export class CodexAppServer {
	private nextId = 0;
	private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private buffer = "";
	private closed = false;

	constructor(
		private write: (line: string) => void,
		private onNotification: (method: string, params: unknown) => void,
		private onRequest: (method: string, params: unknown) => Promise<unknown>,
		private onClose: (error: Error) => void = () => {},
	) {}

	request(method: string, params: unknown): Promise<unknown> {
		return this.requestTracked(method, params).promise;
	}

	requestTracked(method: string, params: unknown): { id: number; promise: Promise<unknown> } {
		if (this.closed) return { id: -1, promise: Promise.reject(new Error("Codex app-server is closed")) };
		const id = ++this.nextId;
		const promise = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex request ${method} timed out`)); }, method === "userVerification/verify" ? 120_000 : 30_000);
			this.pending.set(id, { resolve, reject, timer });
			try { this.send({ id, method, params }); }
			catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
		return { id, promise };
	}

	notify(method: string, params?: unknown): void {
		if (this.closed) throw new Error("Codex app-server is closed");
		this.send({ method, params });
	}

	private send(message: unknown): void { this.write(`${JSON.stringify(message)}\n`); }

	async initialize(): Promise<void> {
		await this.request("initialize", {
			clientInfo: { name: "schema_designer", title: "Schema Designer", version: "1.0.0" },
			capabilities: { experimentalApi: true },
		});
		this.notify("initialized");
	}

	/** Accept arbitrarily split UTF-8 text chunks from stdout. */
	accept(chunk: string): void {
		if (this.closed) return;
		this.buffer += chunk;
		let end: number;
		while ((end = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, end);
			this.buffer = this.buffer.slice(end + 1);
			if (!line.trim()) continue;
			let message: any;
			try { message = JSON.parse(line); }
			catch { this.close(new Error("Invalid JSON from Codex app-server")); return; }
			if (!message || typeof message !== "object" || Array.isArray(message)) { this.close(new Error("Invalid message from Codex app-server")); return; }
			if (typeof message.method === "string") {
				if (message.id === undefined) {
					try { this.onNotification(message.method, message.params); }
					catch (error) { this.close(error instanceof Error ? error : new Error(String(error))); return; }
				}
				else void Promise.resolve().then(() => this.onRequest(message.method, message.params)).then(
					(result) => { if (!this.closed) this.send({ id: message.id, result }); },
					(error) => { if (!this.closed) this.send({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); },
				);
			} else if (typeof message.id === "number") {
				const pending = this.pending.get(message.id);
				if (!pending) continue;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error(message.error.message ?? "Codex request failed"));
				else pending.resolve(message.result);
			}
		}
	}

	close(error = new Error("Codex app-server exited")): void {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
		this.onClose(error);
	}
}

export type CodexDynamicTool = {
	name: string;
	description: string;
	inputSchema: unknown;
};

/** Owns one app-scoped thread. Calls into the application stay on this connection. */
export class CodexSession {
	private threadId: string | null = null;
	private turnId: string | null = null;
	private configuredModel: string | undefined;
	private completion: { resolve: () => void; reject: (error: Error) => void } | null = null;

	constructor(private client: CodexAppServer) {}

	get target(): { threadId: string; turnId?: string } | null {
		return this.threadId ? { threadId: this.threadId, ...(this.turnId ? { turnId: this.turnId } : {}) } : null;
	}
	get defaultModel(): string | undefined { return this.configuredModel; }

	async start(options: { cwd: string; instructions: string; tools: CodexDynamicTool[]; model?: string }): Promise<string> {
		if (this.threadId) throw new Error("Codex thread already started");
		const result = await this.client.request("thread/start", {
			cwd: options.cwd,
			developerInstructions: options.instructions,
			dynamicTools: options.tools.map((tool) => ({ type: "function", ...tool })),
			...(options.model ? { model: options.model } : {}),
		}) as { thread?: { id?: unknown }; model?: unknown };
		if (typeof result.thread?.id !== "string") throw new Error("Codex did not return a thread ID");
		this.threadId = result.thread.id;
		this.configuredModel = typeof result.model === "string" ? result.model : undefined;
		return this.threadId;
	}

	async resume(threadId: string, options: { cwd: string; instructions: string; defaultModel?: string }): Promise<void> {
		if (this.threadId) throw new Error("Codex thread already started");
		const result = await this.client.request("thread/resume", {
			threadId, cwd: options.cwd, developerInstructions: options.instructions,
		}) as { thread?: { id?: unknown } };
		if (result.thread?.id !== threadId) throw new Error("Codex resumed an unexpected thread");
		this.threadId = threadId;
		this.configuredModel = options.defaultModel;
	}

	async send(text: string, signal?: AbortSignal, model?: string, effort?: string): Promise<void> {
		if (!this.threadId) throw new Error("Codex thread has not started");
		if (this.completion) throw new Error("Codex turn already running");
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const completed = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
		// The process may exit before turn/start returns; attach a handler immediately.
		void completed.catch(() => {});
		this.completion = { resolve, reject };
		const interrupt = () => { void this.interrupt().catch(() => {}); };
		signal?.addEventListener("abort", interrupt, { once: true });
		try {
			const result = await this.client.request("turn/start", {
				threadId: this.threadId,
				input: [{ type: "text", text, text_elements: [] }],
				...((model ?? this.configuredModel) ? { model: model ?? this.configuredModel } : {}),
				...(effort ? { effort } : {}),
			}) as { turn?: { id?: unknown } };
			if (typeof result.turn?.id !== "string") throw new Error("Codex did not return a turn ID");
			this.turnId = result.turn.id;
			if (signal?.aborted) interrupt();
			await completed;
		} finally {
			signal?.removeEventListener("abort", interrupt);
			this.completion = null;
			this.turnId = null;
		}
	}

	acceptNotification(method: string, params: unknown): void {
		if (method !== "turn/completed" || !params || typeof params !== "object") return;
		const event = params as { threadId?: string; turn?: { id?: string; status?: string; error?: { message?: string } | null } };
		if (event.threadId !== this.threadId || !this.completion || (this.turnId && event.turn?.id !== this.turnId)) return;
		if (event.turn?.status === "completed") this.completion.resolve();
		else this.completion.reject(new Error(event.turn?.error?.message ?? `Codex turn ${event.turn?.status ?? "failed"}`));
	}

	async interrupt(): Promise<void> {
		if (this.threadId && this.turnId) await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
	}

	async steer(text: string): Promise<void> {
		if (!this.threadId || !this.turnId) throw new Error("Codex turn is not ready for steering yet");
		await this.client.request("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: "text", text, text_elements: [] }] });
	}

	verifyUser(params: { challenge: string; title: string; description: string }) {
		const request = this.client.requestTracked("userVerification/verify", params);
		return {
			promise: request.promise as Promise<{ proof: { credentialId: string; signature: string } }>,
			cancel: () => this.client.request("userVerification/cancel", { requestId: request.id }).then(() => {}),
		};
	}

	close(error = new Error("Codex session closed")): void { this.completion?.reject(error); }
}

/** Starts a private stdio connection. It never changes the user's Codex configuration. */
export async function startCodexAppServer(options: {
	executable?: string;
	cwd: string;
	onNotification: (method: string, params: unknown) => void;
	onRequest: (method: string, params: unknown) => Promise<unknown>;
	onClose?: (error: Error) => void;
}): Promise<{ client: CodexAppServer; process: ChildProcessWithoutNullStreams; close: () => void }> {
	const child = spawn(options.executable ?? findCodexExecutable() ?? "codex", ["app-server", "--listen", "stdio://"], {
		cwd: options.cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const client = new CodexAppServer((line) => { child.stdin.write(line); }, options.onNotification, options.onRequest, (error) => {
		options.onClose?.(error);
		child.kill();
	});
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => client.accept(chunk));
	// Consume stderr so a verbose subprocess cannot block on a full pipe.
	child.stderr.resume();
	let closed = false;
	const closeWith = (error: Error) => {
		if (closed) return;
		closed = true;
		client.close(error);
	};
	child.on("error", (error) => closeWith(new Error(`Could not start Codex: ${error.message}`)));
	child.stdin.on("error", (error) => closeWith(new Error(`Codex connection failed: ${error.message}`)));
	child.on("exit", (code, signal) => closeWith(new Error(`Codex app-server exited (${signal ?? code ?? "unknown"})`)));
	const timeout = setTimeout(() => {
		closeWith(new Error("Codex app-server did not initialize within 15 seconds"));
		child.kill();
	}, 15_000);
	try {
		await client.initialize();
	} catch (error) {
		child.kill();
		throw error;
	} finally {
		clearTimeout(timeout);
	}
	return { client, process: child, close: () => { closeWith(new Error("Codex session closed")); child.kill(); } };
}
