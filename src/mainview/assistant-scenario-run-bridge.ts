import type { Scenario, ScenarioRun, WorkspaceState } from "../shared/design";
import type { ScenarioRunDriver } from "./scenario-run-driver";

export type AssistantScenarioRunRequest = {
	requestId: string;
	projectId: string;
	scenario: Scenario;
};

type PendingRequest = {
	projectId: string;
	scenarioId: string;
	controller: AbortController;
	cancelled: boolean;
	runId: string | null;
};

/** Owns Assistant run queue cancellation while the view executes Scenario Workers. */
export type AssistantScenarioRunBridgeOptions = {
	driver: ScenarioRunDriver;
	getWorkspaceState: () => WorkspaceState | null;
	complete: (requestId: string, run: ScenarioRun | null, error?: string) => void;
	onQueued?: (request: AssistantScenarioRunRequest) => void;
};

export type AssistantScenarioRunBridge = {
	request: (input: AssistantScenarioRunRequest) => void;
	cancel: (requestId: string) => void;
	dispose: () => void;
	getPendingCount: () => number;
};

/** Owns Assistant run queue cancellation while the view executes Scenario Workers. */
export function createAssistantScenarioRunBridge(options: AssistantScenarioRunBridgeOptions): AssistantScenarioRunBridge {
	const pending = new Map<string, PendingRequest>();

	function request(input: AssistantScenarioRunRequest) {
		const current = options.getWorkspaceState();
		if (!current || current.project?.id !== input.projectId) {
			options.complete(input.requestId, null, "The project changed before the Scenario run could start.");
			return;
		}
		if (!current.scenarios.some(({ id }) => id === input.scenario.id)) {
			options.complete(input.requestId, null, "The requested Scenario no longer exists in this project.");
			return;
		}
		const entry: PendingRequest = {
			projectId: input.projectId,
			scenarioId: input.scenario.id,
			controller: new AbortController(),
			cancelled: false,
			runId: null,
		};
		pending.set(input.requestId, entry);
		options.onQueued?.(input);
		void options.driver.runQueued(() => {
			if (entry.cancelled) return null;
			const latest = options.getWorkspaceState();
			return latest?.project?.id === entry.projectId
				? latest.scenarios.find(({ id }) => id === entry.scenarioId) ?? null
				: null;
		}, {
			signal: entry.controller.signal,
			onStarted: (runId) => {
				entry.runId = runId;
				if (entry.cancelled) void options.driver.stop(runId);
			},
		}).then((run) => {
			if (entry.cancelled) return;
			const latest = options.getWorkspaceState();
			if (latest?.project?.id !== entry.projectId) {
				options.complete(input.requestId, null, "The project changed while the Scenario was running.");
			} else if (!run) {
				options.complete(input.requestId, null, "The Scenario run was cancelled before it finished.");
			} else {
				options.complete(input.requestId, run);
			}
		}).catch((cause: unknown) => {
			if (!entry.cancelled) options.complete(input.requestId, null, cause instanceof Error ? cause.message : String(cause));
		}).finally(() => {
			if (pending.get(input.requestId) === entry) pending.delete(input.requestId);
		});
	}

	function cancel(requestId: string) {
		const entry = pending.get(requestId);
		if (!entry) return;
		entry.cancelled = true;
		entry.controller.abort();
		if (entry.runId) void options.driver.stop(entry.runId);
	}

	function dispose() {
		for (const requestId of pending.keys()) cancel(requestId);
	}

	return { request, cancel, dispose, getPendingCount: () => pending.size };
}
