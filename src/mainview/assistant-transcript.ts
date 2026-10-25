import type { AssistantMessage } from "../shared/assistant";

type TranscriptRecord = Record<string, unknown>;

export type DropConfirmationState = "pending" | "confirmed" | "rejected" | "stale";

/** Resolve confirmation cards from persisted events and the runtime's live pending state. */
export function deriveDropConfirmationStates(messages: AssistantMessage[], isConfirmationPending: boolean): Map<string, DropConfirmationState> {
	const statuses = new Map<string, DropConfirmationState>();
	for (const message of messages) {
		if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") continue;
		const payload = message.payload as TranscriptRecord;
		if (typeof payload.toolCallId !== "string") continue;
		if (payload.status === "consumed") statuses.set(payload.toolCallId, "confirmed");
		else if (payload.status === "rejected") statuses.set(payload.toolCallId, "rejected");
	}
	const confirmationCards = messages.filter((message) => {
		if (message.role !== "toolResult" || !message.payload || typeof message.payload !== "object") return false;
		const payload = message.payload as TranscriptRecord;
		const details = payload.details;
		return typeof payload.toolCallId === "string" && details && typeof details === "object"
			&& (details as TranscriptRecord).status === "confirmation-required";
	});
	const latest = confirmationCards[confirmationCards.length - 1];
	for (const message of confirmationCards) {
		const payload = message.payload as TranscriptRecord;
		const id = payload.toolCallId as string;
		if (statuses.has(id)) continue;
		statuses.set(id, isConfirmationPending && message === latest ? "pending" : "stale");
	}
	return statuses;
}

/** Apply pi's streaming events to the same message list used by saved conversations. */
export function foldAssistantEvent(messages: AssistantMessage[], event: unknown): AssistantMessage[] {
	if (!event || typeof event !== "object") return messages;
	const record = event as TranscriptRecord;
	const type = record.type;

	if (type === "message_start" || type === "message_end") {
		if (!record.message || typeof record.message !== "object") return messages;
		const message = record.message as TranscriptRecord;
		if (message.role !== "assistant") return messages;
		if (type === "message_start") return [...messages, { role: "assistant", kind: "live-assistant", payload: message }];
		const index = lastLiveAssistantIndex(messages);
		if (index < 0) return messages;
		if (!assistantText(message).trim() && !assistantError(message)) return messages.filter((_item, itemIndex) => itemIndex !== index);
		return messages.map((item, itemIndex) => itemIndex === index ? { ...item, payload: message } : item);
	}

	if (type === "message_update") {
		const index = lastLiveAssistantIndex(messages);
		if (record.message && typeof record.message === "object") {
			const message = record.message as TranscriptRecord;
			const next: AssistantMessage = { role: "assistant", kind: "live-assistant", payload: message };
			if (index < 0) return [...messages, next];
			return messages.map((item, itemIndex) => itemIndex === index ? next : item);
		}
		const messageEvent = record.assistantMessageEvent && typeof record.assistantMessageEvent === "object"
			? record.assistantMessageEvent as TranscriptRecord
			: null;
		if (!messageEvent || messageEvent.type !== "text_delta" || typeof messageEvent.delta !== "string") return messages;
		const current = index >= 0 && messages[index].payload && typeof messages[index].payload === "object"
			? messages[index].payload as TranscriptRecord
			: {};
		const content = Array.isArray(current.content) ? [...current.content] : [];
		const last = content[content.length - 1];
		if (last && typeof last === "object" && (last as TranscriptRecord).type === "text") {
			const priorText = typeof (last as TranscriptRecord).text === "string" ? (last as TranscriptRecord).text as string : "";
			content[content.length - 1] = { ...(last as TranscriptRecord), text: priorText + messageEvent.delta };
		} else {
			content.push({ type: "text", text: messageEvent.delta });
		}
		const next: AssistantMessage = { role: "assistant", kind: "live-assistant", payload: { ...current, role: "assistant", content } };
		if (index < 0) return [...messages, next];
		return messages.map((item, itemIndex) => itemIndex === index ? next : item);
	}

	if (type === "tool_execution_start" || type === "tool_execution_end") {
		const id = typeof record.toolCallId === "string" ? record.toolCallId : "";
		if (!id) return messages;
		const index = messages.findIndex((message) => message.kind === "live-tool" && (message.payload as TranscriptRecord)?.toolCallId === id);
		const previous = index >= 0 ? messages[index].payload as TranscriptRecord : {};
		const isError = Boolean(record.isError ?? previous.isError);
		const payload = {
			...previous,
			toolCallId: id,
			toolName: record.toolName ?? previous.toolName,
			args: record.args ?? previous.args,
			result: record.result ?? previous.result,
			isError,
			durationMs: typeof record.durationMs === "number" ? record.durationMs : previous.durationMs,
			status: type === "tool_execution_start" ? "running" : isError ? "error" : "complete",
		};
		const message: AssistantMessage = { role: "assistant", kind: "live-tool", payload };
		if (index >= 0) return messages.map((item, itemIndex) => itemIndex === index ? message : item);
		return [...messages, message];
	}
	return messages;
}

function lastLiveAssistantIndex(messages: AssistantMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].kind === "live-assistant") return index;
	}
	return -1;
}

/** Extract displayable text without exposing provider metadata or hidden content parts. */
export function assistantText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	if ("content" in payload) {
		const content = payload.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content.flatMap((part) => {
				if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
					return [part.text];
				}
				return [];
			}).join("");
		}
	}
	return "";
}

/** The provider error a failed assistant message carries, e.g. a usage limit, or null. */
export function assistantError(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	const record = payload as TranscriptRecord;
	if (record.stopReason !== "error") return null;
	return typeof record.errorMessage === "string" && record.errorMessage.trim()
		? record.errorMessage
		: "The model request failed.";
}
export type MessageUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cost?: { total?: number };
};

/** Show usage line only once a message has ended and has non-zero tokens. */
export function shouldShowMessageUsage(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const record = payload as TranscriptRecord;
	if (record.stopReason === "pending") return false;
	const usage = record.usage;
	if (!usage || typeof usage !== "object") return false;
	const u = usage as TranscriptRecord;
	const input = typeof u.input === "number" ? u.input : 0;
	const output = typeof u.output === "number" ? u.output : 0;
	const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
	return input > 0 || output > 0 || cacheRead > 0;
}

/** Extract valid message usage for completed replies, or null. */
export function assistantMessageUsage(payload: unknown): MessageUsage | null {
	if (!shouldShowMessageUsage(payload)) return null;
	const record = payload as TranscriptRecord;
	const u = record.usage as TranscriptRecord;
	const input = typeof u.input === "number" ? u.input : 0;
	const output = typeof u.output === "number" ? u.output : 0;
	const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
	const cost = u.cost && typeof u.cost === "object" && typeof (u.cost as TranscriptRecord).total === "number"
		? { total: (u.cost as TranscriptRecord).total as number }
		: undefined;
	return { input, output, cacheRead, cost };
}

export type ToolTraceStatus = "running" | "error" | "pending";
export type ToolTraceIcon = "read" | "ddl" | "code" | "run" | "generic";

export type ToolTraceInfo = {
	title: string;
	status?: ToolTraceStatus;
	icon: ToolTraceIcon;
	description?: string;
};

export type ToolTraceInput = {
	toolName: string;
	toolCallId?: string;
	args?: unknown;
	result?: unknown;
	details?: unknown;
	status?: "running" | "complete" | "error";
	isError?: boolean;
	durationMs?: number;
};

function formatDuration(durationMs?: number): string | undefined {
	if (typeof durationMs !== "number" || durationMs <= 0) return undefined;
	if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1000).toFixed(1)}s`;
}

/** Derive sentence title, status, icon, and description for a tool call. */
export function deriveToolTraceInfo(input: ToolTraceInput): ToolTraceInfo {
	const toolName = input.toolName;
	const isRunning = input.status === "running";
	const isError = Boolean(
		input.isError ||
		input.status === "error" ||
		(input.details && typeof input.details === "object" && (input.details as TranscriptRecord).status === "rejected-earlier")
	);
	const args = (input.args && typeof input.args === "object" ? input.args as TranscriptRecord : {}) as TranscriptRecord;
	const details = (input.details && typeof input.details === "object" ? input.details as TranscriptRecord : {}) as TranscriptRecord;
	const durationDesc = formatDuration(input.durationMs);

	if (toolName === "read_project") {
		if (isRunning) {
			return { title: "Reading the project", status: "running", icon: "read" };
		}
		if (isError) {
			return { title: "Failed to read the project", status: "error", icon: "read", description: durationDesc };
		}
		return { title: "Read the project", status: undefined, icon: "read", description: durationDesc };
	}

	if (toolName === "apply_ddl") {
		if (isRunning) {
			return { title: "Applying SQL", status: "running", icon: "ddl" };
		}
		if (isError) {
			return { title: "Failed to apply SQL", status: "error", icon: "ddl", description: durationDesc };
		}
		if (details.status === "confirmation-required") {
			return { title: "Needs confirmation to apply SQL", status: "pending", icon: "ddl", description: durationDesc };
		}
		const affected = Array.isArray(details.affectedTables) ? details.affectedTables : [];
		const tableNames = affected
			.map((table) => {
				if (typeof table === "string") return table;
				if (table && typeof table === "object" && typeof (table as TranscriptRecord).name === "string") {
					return (table as TranscriptRecord).name as string;
				}
				return null;
			})
			.filter((name): name is string => Boolean(name));
		if (tableNames.length > 0) {
			return {
				title: `Applied SQL to ${tableNames.join(", ")}`,
				status: undefined,
				icon: "ddl",
				description: durationDesc ?? `${tableNames.length} ${tableNames.length === 1 ? "table" : "tables"}`,
			};
		}
		return { title: "Applied SQL", status: undefined, icon: "ddl", description: durationDesc };
	}

	if (toolName === "manage_code") {
		const rawAction = typeof details.action === "string" ? details.action : typeof args.action === "string" ? args.action : "write";
		const action = rawAction === "created" ? "create" : rawAction === "renamed" ? "rename" : rawAction === "removed" ? "remove" : rawAction;
		const kind = typeof details.kind === "string" ? details.kind : typeof args.kind === "string" ? args.kind : "scenario";
		const kindLabel = kind === "scenario" ? "Scenario" : kind === "edge-function" ? "Edge function" : kind === "function-body" ? "Function body" : "Code";
		const name = typeof details.name === "string" ? details.name : typeof args.name === "string" ? args.name : "";
		const targetLabel = name ? `${kindLabel} ${name}` : kindLabel;

		if (isRunning) {
			const verb = action === "create" ? "Creating" : action === "write" ? "Writing" : action === "edit" ? "Editing" : action === "rename" ? "Renaming" : action === "remove" ? "Removing" : "Updating";
			return { title: `${verb} ${targetLabel}`, status: "running", icon: "code" };
		}
		if (isError) {
			const verb = action === "create" ? "create" : action === "write" ? "write" : action === "edit" ? "edit" : action === "rename" ? "rename" : action === "remove" ? "remove" : "update";
			return { title: `Failed to ${verb} ${targetLabel}`, status: "error", icon: "code", description: durationDesc };
		}
		const pastVerb = action === "create" ? "Created" : action === "write" ? "Wrote" : action === "edit" ? "Edited" : action === "rename" ? "Renamed" : action === "remove" ? "Removed" : "Updated";
		return { title: `${pastVerb} ${targetLabel}`, status: undefined, icon: "code", description: durationDesc };
	}

	if (toolName === "run_scenarios") {
		const mode = typeof details.mode === "string" ? details.mode : typeof args.mode === "string" ? args.mode : "all";
		const runs = Array.isArray(details.runs) ? details.runs as TranscriptRecord[] : [];
		if (isRunning) {
			const title = mode === "one" && runs[0] && typeof runs[0].scenario === "string"
				? `Running Scenario ${runs[0].scenario}`
				: mode === "one" ? "Running Scenario" : "Running Scenarios";
			return { title, status: "running", icon: "run" };
		}
		if (isError) {
			const title = mode === "one" && runs[0] && typeof runs[0].scenario === "string"
				? `Failed to run Scenario ${runs[0].scenario}`
				: "Failed to run Scenarios";
			return { title, status: "error", icon: "run", description: durationDesc };
		}
		if (runs.length === 1) {
			const run = runs[0];
			const scenarioName = typeof run.scenario === "string" ? run.scenario : "Scenario";
			const runStatus = typeof run.status === "string" ? run.status : "complete";
			const runFailed = runStatus === "failed" || runStatus === "error";
			return {
				title: `Ran Scenario ${scenarioName}: ${runStatus}`,
				status: runFailed ? "error" : undefined,
				icon: "run",
				description: durationDesc ?? "1 run",
			};
		}
		if (runs.length > 1) {
			const failedRuns = runs.filter((r) => r.status === "failed" || r.status === "error");
			const hasFailures = failedRuns.length > 0;
			const outcome = hasFailures ? `${failedRuns.length} failed` : "passed";
			return {
				title: `Ran ${runs.length} Scenarios: ${outcome}`,
				status: hasFailures ? "error" : undefined,
				icon: "run",
				description: durationDesc ?? `${runs.length} runs`,
			};
		}
		return { title: "Ran Scenarios", status: undefined, icon: "run", description: durationDesc };
	}

	// Fallback for custom / generic tools
	if (isRunning) {
		return { title: `Running ${toolName}`, status: "running", icon: "generic" };
	}
	if (isError) {
		return { title: `Failed to run ${toolName}`, status: "error", icon: "generic", description: durationDesc };
	}
	return { title: `Ran ${toolName}`, status: undefined, icon: "generic", description: durationDesc };
}

export type TranscriptToolItem = {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	result: unknown;
	details: Record<string, unknown> | null;
	status?: ToolTraceStatus;
	trace: ToolTraceInfo;
	affectedTables: Array<{ id: string; name: string; change?: "added" | "changed" | "removed"; removed?: boolean }>;
	codeDiff: {
		before: string;
		after: string;
		kind: "scenario" | "edge-function" | "function-body";
		id: string;
		name: string;
		diagnostics?: unknown[];
		diagnosticsNote?: string;
	} | null;
	scenarioRuns: Array<{ scenarioId: string; scenario: string; status: string; runId?: string }>;
	confirmation: Record<string, unknown> | null;
	rawContent: string;
};

export type TranscriptAssistantItem = {
	kind: "assistant";
	text: string;
	error: string | null;
	usage: MessageUsage | null;
	isStreaming?: boolean;
	message: AssistantMessage;
};

export type TranscriptUserItem = {
	kind: "user";
	text: string;
	message: AssistantMessage;
};

export type TranscriptCompactionItem = {
	kind: "compaction";
	text: string;
};

export type TranscriptDisplayItem =
	| TranscriptToolItem
	| TranscriptAssistantItem
	| TranscriptUserItem
	| TranscriptCompactionItem;

function extractDetails(rawDetails: unknown, rawResult: unknown): Record<string, unknown> | null {
	if (rawDetails && typeof rawDetails === "object") return rawDetails as Record<string, unknown>;
	if (rawResult && typeof rawResult === "object") {
		const res = rawResult as Record<string, unknown>;
		if (res.details && typeof res.details === "object") return res.details as Record<string, unknown>;
	}
	return null;
}

function extractAffectedTables(details: Record<string, unknown> | null): Array<{ id: string; name: string; change?: "added" | "changed" | "removed"; removed?: boolean }> {
	if (!details || !Array.isArray(details.affectedTables)) return [];
	return details.affectedTables
		.filter((table): table is Record<string, unknown> =>
			Boolean(table && typeof table === "object" && "id" in table && typeof table.id === "string" && "name" in table && typeof table.name === "string")
		)
		.map((table) => {
			const change = table.change === "removed" ? "removed" : table.change === "added" ? "added" : table.change === "changed" ? "changed" : undefined;
			const removed = change === "removed" || table.removed === true;
			return {
				id: table.id as string,
				name: table.name as string,
				...(change ? { change } : {}),
				...(removed ? { removed: true } : {}),
			};
		});
}

function extractCodeDiff(details: Record<string, unknown> | null) {
	if (!details) return null;
	if (
		typeof details.before === "string" &&
		typeof details.after === "string" &&
		typeof details.kind === "string" &&
		typeof details.id === "string" &&
		typeof details.name === "string"
	) {
		return {
			before: details.before,
			after: details.after,
			kind: details.kind as "scenario" | "edge-function" | "function-body",
			id: details.id,
			name: details.name,
			diagnostics: Array.isArray(details.diagnostics) ? details.diagnostics : undefined,
			diagnosticsNote: typeof details.diagnosticsNote === "string" ? details.diagnosticsNote : undefined,
		};
	}
	return null;
}

function extractScenarioRuns(details: Record<string, unknown> | null) {
	if (!details || !Array.isArray(details.runs)) return [];
	return details.runs.filter((run): run is { scenarioId: string; scenario: string; status: string; runId?: string } =>
		Boolean(run && typeof run === "object" && "scenarioId" in run && typeof run.scenarioId === "string"
			&& "scenario" in run && typeof run.scenario === "string" && "status" in run && typeof run.status === "string"
			&& (!("runId" in run) || typeof run.runId === "string"))
	);
}

function extractConfirmation(
	details: Record<string, unknown> | null,
	toolCallId: string,
	states: Map<string, DropConfirmationState>,
	updates: Map<string, Record<string, unknown>>,
): Record<string, unknown> | null {
	if (!details || details.status !== "confirmation-required") return null;
	const state = states.get(toolCallId);
	const updated = updates.get(toolCallId);
	const merged = updated ? { ...updated, planUpdated: true, note: "The plan changed. Review the updated plan before confirming." } : details;
	return { ...merged, confirmationState: state ?? "stale" };
}

function formatRawContent(toolName: string, args: unknown, result: unknown): string {
	const parts: string[] = [];
	if (args !== undefined && args !== null) {
		parts.push(`Arguments:\n${JSON.stringify(args, null, 2)}`);
	}
	if (result !== undefined && result !== null) {
		parts.push(`Result:\n${typeof result === "string" ? result : JSON.stringify(result, null, 2)}`);
	}
	return parts.join("\n\n") || toolName;
}

/** Transform live and saved transcript messages into unified display items. */
export function buildTranscript(messages: AssistantMessage[], isConfirmationPending: boolean): TranscriptDisplayItem[] {
	const confirmationStates = deriveDropConfirmationStates(messages, isConfirmationPending);
	const updates = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") continue;
		const payload = message.payload as Record<string, unknown>;
		if (typeof payload.toolCallId === "string" && payload.status === "updated" && payload.details && typeof payload.details === "object") {
			updates.set(payload.toolCallId, payload.details as Record<string, unknown>);
		}
	}

	const toolResultsByCallId = new Map<string, AssistantMessage>();
	for (const message of messages) {
		if (message.role === "toolResult" && message.payload && typeof message.payload === "object") {
			const payload = message.payload as TranscriptRecord;
			if (typeof payload.toolCallId === "string") {
				toolResultsByCallId.set(payload.toolCallId, message);
			}
		}
	}

	const items: TranscriptDisplayItem[] = [];
	const consumedToolResultIds = new Set<string>();

	for (const message of messages) {
		if (message.kind === "assistant-compaction") {
			const payload = message.payload as { text?: string } | null;
			items.push({
				kind: "compaction",
				text: payload?.text ?? "Older turns summarised to preserve context space.",
			});
			continue;
		}

		if (
			message.kind === "assistant-context" ||
			message.kind === "assistant-change-note" ||
			message.kind === "assistant-continue" ||
			message.kind === "assistant-drop-confirmation"
		) {
			continue;
		}

		if (message.role === "toolResult") {
			// Matched by toolCall in assistant messages. If orphaned, emit fallback.
			const payload = message.payload as TranscriptRecord | null;
			const toolCallId = typeof payload?.toolCallId === "string" ? payload.toolCallId : "";
			if (toolCallId && !consumedToolResultIds.has(toolCallId)) {
				consumedToolResultIds.add(toolCallId);
				const details = extractDetails(payload?.details, payload?.content);
				const isError = Boolean(payload?.isError);
				const trace = deriveToolTraceInfo({
					toolName: (payload?.toolName as string) ?? "Tool",
					toolCallId,
					details,
					result: payload?.content,
					isError,
					status: isError ? "error" : "complete",
				});
				items.push({
					kind: "tool",
					toolCallId,
					toolName: (payload?.toolName as string) ?? "Tool",
					args: {},
					result: payload?.content,
					details,
					status: trace.status,
					trace,
					affectedTables: extractAffectedTables(details),
					codeDiff: extractCodeDiff(details),
					scenarioRuns: extractScenarioRuns(details),
					confirmation: extractConfirmation(details, toolCallId, confirmationStates, updates),
					rawContent: formatRawContent(payload?.toolName as string ?? "Tool", {}, payload?.content),
				});
			}
			continue;
		}

		if (message.kind === "live-tool") {
			const payload = (message.payload ?? {}) as TranscriptRecord;
			const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
			const toolName = typeof payload.toolName === "string" ? payload.toolName : "Tool";
			const args = (payload.args && typeof payload.args === "object" ? payload.args : {}) as Record<string, unknown>;
			const result = payload.result;
			const isError = Boolean(payload.isError);
			const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : undefined;
			const details = extractDetails(payload.details, result);
			const status = payload.status === "running" ? "running" : isError ? "error" : "complete";
			const trace = deriveToolTraceInfo({
				toolName,
				toolCallId,
				args,
				result,
				details,
				status,
				isError,
				durationMs,
			});
			items.push({
				kind: "tool",
				toolCallId,
				toolName,
				args,
				result,
				details,
				status: trace.status,
				trace,
				affectedTables: extractAffectedTables(details),
				codeDiff: extractCodeDiff(details),
				scenarioRuns: extractScenarioRuns(details),
				confirmation: extractConfirmation(details, toolCallId, confirmationStates, updates),
				rawContent: formatRawContent(toolName, args, result),
			});
			continue;
		}

		if (message.role === "user") {
			let text = "";
			if (typeof message.payload === "string") {
				text = message.payload;
			} else if (message.payload && typeof message.payload === "object") {
				if ("content" in message.payload && typeof message.payload.content === "string") {
					text = message.payload.content;
				} else {
					text = assistantText(message.payload);
				}
			}
			if (!text) {
				text = typeof message.payload === "object" ? JSON.stringify(message.payload, null, 2) : String(message.payload ?? "");
			}
			items.push({ kind: "user", text, message });
			continue;
		}

		if (message.role === "assistant") {
			const payload = message.payload as TranscriptRecord | null;
			const isLive = message.kind === "live-assistant";
			const isStreaming = isLive && payload?.stopReason === "pending";
			const content = payload && Array.isArray(payload.content) ? payload.content : null;

			if (content) {
				let textBuffer = "";
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const partRecord = part as TranscriptRecord;
					if (partRecord.type === "text" && typeof partRecord.text === "string") {
						textBuffer += partRecord.text;
					} else if (partRecord.type === "toolCall") {
						if (textBuffer.trim()) {
							items.push({
								kind: "assistant",
								text: textBuffer,
								error: null,
								usage: null,
								message,
							});
							textBuffer = "";
						}
						const callId = typeof partRecord.id === "string" ? partRecord.id : "";
						const toolName = typeof partRecord.name === "string" ? partRecord.name : "Tool";
						const args = (partRecord.args && typeof partRecord.args === "object" ? partRecord.args : {}) as Record<string, unknown>;
						const matchingResultMsg = callId ? toolResultsByCallId.get(callId) : undefined;
						if (callId) consumedToolResultIds.add(callId);
						const resultPayload = matchingResultMsg?.payload as TranscriptRecord | undefined;
						const result = resultPayload?.content ?? resultPayload?.result;
						const details = extractDetails(resultPayload?.details, result);
						const isError = Boolean(resultPayload?.isError);
						const trace = deriveToolTraceInfo({
							toolName,
							toolCallId: callId,
							args,
							result,
							details,
							isError,
							status: isError ? "error" : "complete",
						});
						items.push({
							kind: "tool",
							toolCallId: callId,
							toolName,
							args,
							result,
							details,
							status: trace.status,
							trace,
							affectedTables: extractAffectedTables(details),
							codeDiff: extractCodeDiff(details),
							scenarioRuns: extractScenarioRuns(details),
							confirmation: extractConfirmation(details, callId, confirmationStates, updates),
							rawContent: formatRawContent(toolName, args, result),
						});
					}
				}
				const error = assistantError(payload);
				if (textBuffer.trim() || error) {
					items.push({
						kind: "assistant",
						text: textBuffer,
						error,
						usage: assistantMessageUsage(payload),
						isStreaming,
						message,
					});
				}
			} else {
				const text = assistantText(payload);
				const error = assistantError(payload);
				if (text.trim() || error) {
					items.push({
						kind: "assistant",
						text,
						error,
						usage: assistantMessageUsage(payload),
						isStreaming,
						message,
					});
				}
			}
		}
	}

	return items;
}
