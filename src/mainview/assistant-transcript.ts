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
		const payload = {
			...previous,
			toolCallId: id,
			toolName: record.toolName ?? previous.toolName,
			args: record.args ?? previous.args,
			result: record.result ?? previous.result,
			status: type === "tool_execution_start" ? "running" : "complete",
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
	const content = (payload as TranscriptRecord).content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => part && typeof part === "object" && (part as TranscriptRecord).type === "text" && typeof (part as TranscriptRecord).text === "string"
		? [(part as TranscriptRecord).text as string]
		: []).join("");
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
