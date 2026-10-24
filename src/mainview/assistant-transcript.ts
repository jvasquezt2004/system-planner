import type { AssistantMessage } from "../shared/assistant";

type TranscriptRecord = Record<string, unknown>;

/** Apply pi's streaming events to the same message list used by saved conversations. */
export function foldAssistantEvent(messages: AssistantMessage[], event: unknown): AssistantMessage[] {
	if (!event || typeof event !== "object") return messages;
	const record = event as TranscriptRecord;
	if (record.type === "message_update") {
		const index = messages.findIndex((message) => message.kind === "live-assistant");
		const current = index >= 0 && messages[index].payload && typeof messages[index].payload === "object"
			? messages[index].payload as TranscriptRecord
			: {};
		const assistantMessage = record.assistantMessage && typeof record.assistantMessage === "object"
			? record.assistantMessage as TranscriptRecord
			: null;
		const messageEvent = record.assistantMessageEvent && typeof record.assistantMessageEvent === "object"
			? record.assistantMessageEvent as TranscriptRecord
			: null;
		let payload = assistantMessage ?? current;
		if (messageEvent?.type === "text_delta" && typeof messageEvent.delta === "string") {
			const content = Array.isArray(current.content) ? [...current.content] : [];
			const last = content[content.length - 1];
			if (last && typeof last === "object" && (last as TranscriptRecord).type === "text") {
				const priorText = typeof (last as TranscriptRecord).text === "string" ? (last as TranscriptRecord).text as string : "";
				content[content.length - 1] = { ...(last as TranscriptRecord), text: priorText + messageEvent.delta };
			} else {
				content.push({ type: "text", text: messageEvent.delta });
			}
			payload = { ...current, role: "assistant", content };
		}
		if (!assistantMessage && !messageEvent) return messages;
		const message: AssistantMessage = { role: "assistant", kind: "live-assistant", payload };
		if (index >= 0) return messages.map((item, itemIndex) => itemIndex === index ? message : item);
		return [...messages, message];
	}
	if (record.type === "tool_execution_start" || record.type === "tool_execution_end") {
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
			status: record.type === "tool_execution_start" ? "running" : "complete",
		};
		const message: AssistantMessage = { role: "assistant", kind: "live-tool", payload };
		if (index >= 0) return messages.map((item, itemIndex) => itemIndex === index ? message : item);
		return [...messages, message];
	}
	return messages;
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
