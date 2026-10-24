import type { Scenario, ScenarioRun, SandboxApiRequest, SandboxApiResponse, WorkspaceState } from "../shared/design";

export type ScenarioRunClient = {
	beginScenarioRun(action: { scenarioId: string }): Promise<{ runId: string; state: WorkspaceState }>;
	handleSandboxApiRequest(action: { runId: string; request: SandboxApiRequest }): Promise<SandboxApiResponse>;
	finishScenarioRun(action: {
		runId: string;
		status: "passed" | "failed" | "errored";
		console: string[];
		expectations?: ScenarioRun["expectations"];
		reason?: ScenarioRun["reason"];
	}): Promise<WorkspaceState>;
};

type WorkerPort = Pick<Worker, "postMessage" | "terminate"> & {
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: ErrorEvent) => void) | null;
};

export type ScenarioRunDriverOptions = {
	workspace: ScenarioRunClient;
	createWorker: () => WorkerPort;
	createEdgeWorker: () => WorkerPort;
	timeoutMs: number;
	isCurrent?: () => boolean;
	getToken?: () => unknown;
	onState?: (state: WorkspaceState) => void;
};

export type ScenarioRunDriver = {
	run(scenario: Scenario): Promise<ScenarioRun | null>;
	runQueued(scenario: Scenario | (() => Scenario | null)): Promise<ScenarioRun | null>;
	stop(runId: string): Promise<ScenarioRun | null>;
	cancel(): void;
	dispose(): void;
};

type RunOutcome = {
	status: "passed" | "failed" | "errored";
	console: string[];
	expectations?: ScenarioRun["expectations"];
	reason?: ScenarioRun["reason"];
};

type ActiveRun = {
	scenario: Scenario;
	runId: string | null;
	projectId: string | null;
	token: unknown;
	worker: WorkerPort | null;
	edgeWorkers: Set<WorkerPort>;
	timer: ReturnType<typeof setTimeout> | undefined;
	resolve: (run: ScenarioRun | null) => void;
	reject: (error: unknown) => void;
	promise: Promise<ScenarioRun | null>;
	finishing: boolean;
	cancelled: boolean;
};

/** Drives the real Scenario Worker and its Sandbox API traffic without React. */
export function createScenarioRunDriver(options: ScenarioRunDriverOptions): ScenarioRunDriver {
	let active: ActiveRun | null = null;
	let disposed = false;
	const pendingStops = new Set<string>();
	let queueTail: Promise<void> = Promise.resolve();

	const isCurrent = (run?: ActiveRun) =>
		!disposed &&
		(options.isCurrent?.() ?? true) &&
		(run === undefined || options.getToken?.() === run.token);
	const finish = (run: ActiveRun, outcome: RunOutcome) => {
		if (run.finishing || run.cancelled || !run.runId) return;
		run.finishing = true;
		pendingStops.delete(run.runId);
		clearTimeout(run.timer);
		for (const edgeWorker of run.edgeWorkers) edgeWorker.terminate();
		run.edgeWorkers.clear();
		run.worker?.terminate();
		run.worker = null;
		void options.workspace.finishScenarioRun({ runId: run.runId, ...outcome }).then((state) => {
			if (active === run) active = null;
			if (!isCurrent(run) || state.project?.id !== run.projectId) {
				run.resolve(null);
				return;
			}
			options.onState?.(state);
			const finished = state.scenarioRuns[run.scenario.id];
			run.resolve(finished?.id === run.runId && finished.status !== "running" ? finished : null);
		}).catch((error: unknown) => {
			if (active === run) active = null;
			run.reject(error);
		});
	};
	const cancel = () => {
		const run = active;
		if (!run) return;
		active = null;
		run.cancelled = true;
		clearTimeout(run.timer);
		run.worker?.terminate();
		run.worker = null;
		for (const edgeWorker of run.edgeWorkers) edgeWorker.terminate();
		run.edgeWorkers.clear();
		run.resolve(null);
	};

	return {
		async run(scenario) {
			if (disposed || active || !isCurrent()) return null;
			const token = options.getToken?.();
			const { promise, resolve, reject } = Promise.withResolvers<ScenarioRun | null>();
			const run: ActiveRun = {
				scenario,
				runId: null,
				projectId: null,
				token,
				worker: null,
				edgeWorkers: new Set(),
				timer: undefined,
				resolve,
				reject,
				promise,
				finishing: false,
				cancelled: false,
			};
			active = run;
			try {
				const begun = await options.workspace.beginScenarioRun({ scenarioId: scenario.id });
				run.runId = begun.runId;
				if (run.cancelled || active !== run || !isCurrent(run) || begun.state.project?.id == null) {
					if (active === run) active = null;
					run.resolve(null);
					return promise;
				}
				run.projectId = begun.state.project.id;
				if (pendingStops.delete(run.runId)) {
					finish(run, { status: "errored", reason: "stopped", console: [] });
					return promise;
				}
				const worker = options.createWorker();
				run.worker = worker;
				options.onState?.(begun.state);
				run.timer = setTimeout(() => finish(run, {
					status: "errored",
					reason: "timed out",
					console: [],
				}), options.timeoutMs);

				worker.onmessage = (event: MessageEvent) => {
					if (active !== run || run.finishing || run.cancelled || !isCurrent(run)) return;
					const message = event.data;
					if (message.type === "invoke" && message.runId === run.runId) {
						const edgeFunction = begun.state.edgeFunctions.find(({ name }) => name === message.functionName);
						const invocationId = `${message.requestId}:${message.functionName}`;
						const completeInvocation = async (status: number, body: unknown) => {
							await options.workspace.handleSandboxApiRequest({
								runId: run.runId!,
								request: {
									method: "POST",
									path: `/functions/v1/${encodeURIComponent(message.functionName)}`,
									query: "",
									headers: message.request.headers,
									body: message.request.body,
									invocation: { functionName: message.functionName, status, response: body },
								},
							});
							if (active === run && !run.finishing && isCurrent(run)) {
								worker.postMessage({
									type: "response",
									requestId: message.requestId,
									response: { status, headers: { "content-type": "application/json" }, body },
								});
							}
						};
						if (!edgeFunction) {
							void completeInvocation(404, { error: `Edge function not found: ${message.functionName}` });
							return;
						}
						const edgeWorker = options.createEdgeWorker();
						run.edgeWorkers.add(edgeWorker);
						edgeWorker.onmessage = (edgeEvent: MessageEvent) => {
							if (active !== run || run.finishing || run.cancelled || !isCurrent(run)) return;
							const edgeMessage = edgeEvent.data;
							if (edgeMessage.type === "request" && edgeMessage.invocationId === invocationId) {
								void options.workspace.handleSandboxApiRequest({ runId: run.runId!, request: edgeMessage.request }).then((response) => {
									if (active === run && !run.finishing && isCurrent(run)) edgeWorker.postMessage({ type: "response", requestId: edgeMessage.requestId, response });
								});
								return;
							}
							if (edgeMessage.type === "finished" && edgeMessage.invocationId === invocationId) {
								run.edgeWorkers.delete(edgeWorker);
								edgeWorker.terminate();
								worker.postMessage({ type: "console", lines: edgeMessage.logs.map((line: string) => `[${message.functionName}] ${line}`) });
								let body: unknown = edgeMessage.body;
								try {
									body = JSON.parse(edgeMessage.body);
								} catch {
									// Preserve non-JSON response text for supabase-js error handling.
								}
								void completeInvocation(edgeMessage.status, body);
							}
						};
						edgeWorker.onerror = (error: ErrorEvent) => {
							run.edgeWorkers.delete(edgeWorker);
							edgeWorker.terminate();
							worker.postMessage({ type: "console", lines: [`[${message.functionName}] ${error.message}`] });
							void completeInvocation(500, { error: error.message });
						};
						edgeWorker.postMessage({ type: "start", runId: run.runId, invocationId, source: edgeFunction.source, request: message.request });
						return;
					}
					if (message.type === "request" && message.runId === run.runId) {
						void options.workspace.handleSandboxApiRequest({ runId: run.runId!, request: message.request }).then((response) => {
							if (active === run && !run.finishing && isCurrent(run)) {
								worker.postMessage({ type: "response", requestId: message.requestId, response });
							}
						}).catch((error: unknown) => {
							if (active !== run || run.finishing || !isCurrent(run)) return;
							worker.postMessage({
								type: "response",
								requestId: message.requestId,
								response: {
									status: 500,
									headers: { "content-type": "application/json" },
									body: { code: "XX000", message: error instanceof Error ? error.message : String(error), details: null, hint: null },
								},
							});
						});
						return;
					}
					if (message.type === "finished" && message.runId === run.runId) {
						finish(run, {
							status: message.status,
							reason: message.reason,
							console: message.console,
							expectations: message.expectations,
						});
					}
				};
				worker.onerror = (event: ErrorEvent) => {
					if (active === run && !run.finishing && !run.cancelled) {
						finish(run, { status: "errored", reason: "exception", console: [event.message] });
					}
				};
				worker.postMessage({ type: "start", runId: run.runId, source: scenario.source, edgeFunctions: begun.state.edgeFunctions });
			} catch (error) {
				if (run.runId && !run.cancelled && active === run) {
					finish(run, { status: "errored", reason: "exception", console: [error instanceof Error ? error.message : String(error)] });
				} else {
					if (active === run) active = null;
					if (run.cancelled || !isCurrent(run)) run.resolve(null);
					else run.reject(error);
				}
			}
			return promise;
		},
		runQueued(scenario) {
			const queued = queueTail.then(async () => {
				while (!disposed && isCurrent()) {
					if (active) {
						await active.promise;
						continue;
					}
					const currentScenario = typeof scenario === "function" ? scenario() : scenario;
					if (!currentScenario) return null;
					const result = await this.run(currentScenario);
					if (result) return result;
				}
				return null;
			});
			queueTail = queued.then(() => undefined, () => undefined);
			return queued;
		},
		stop(runId) {
			const run = active;
			if (!run || run.finishing || run.cancelled) return Promise.resolve(null);
			if (run.runId === null) {
				pendingStops.add(runId);
				return run.promise;
			}
			if (run.runId !== runId) return Promise.resolve(null);
			finish(run, { status: "errored", reason: "stopped", console: [] });
			return run.promise;
		},
		cancel() {
			pendingStops.clear();
			cancel();
		},
		dispose() {
			disposed = true;
			cancel();
		},
	};
}
