import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, MessageSquare, MoreHorizontal, Plus, Send, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { AssistantThinkingLevel } from "../shared/assistant";
import type { AssistantConversation, AssistantConversationRecord, AssistantMessage } from "../shared/assistant";
import { workspaceClient } from "./workspace-client";

/** Main-view controls for saved Assistant conversations and their provider. */
type AssistantApi = Pick<
	typeof workspaceClient,
	| "listAssistantConversations"
	| "getAssistantConversation"
	| "createAssistantConversation"
	| "renameAssistantConversation"
	| "deleteAssistantConversation"
	| "listAssistantModels"
	| "getAnthropicConnectionStatus"
	| "setAnthropicApiKey"
	| "removeAnthropicApiKey"
	| "sendAssistantMessage"
	| "stopAssistantTurn"
	| "continueAssistantTurn"
	| "getAssistantTurnStatus"
	| "updateAssistantConversationSelection"
	| "confirmAssistantDdlDrop"
	| "subscribeAssistantEvents"
>;

type AssistantModel = { id: string; name: string; reasoning: boolean; contextWindow: number };
type StreamEnvelope = { conversationId: string; event: unknown };

export function AssistantSidebar({
	projectId,
	collapsed,
	width,
	api,
	onCollapse,
	onExpand,
	onResizeStart,
	onSelectTable,
}: {
	projectId: string;
	collapsed: boolean;
	width: number;
	api: AssistantApi;
	onCollapse: () => void;
	onExpand: () => void;
	onResizeStart: (event: React.PointerEvent) => void;
	onSelectTable: (tableId: string) => void;
}) {
	const [conversations, setConversations] = useState<AssistantConversation[]>([]);
	const [activeId, setActiveId] = useState("");
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const [models, setModels] = useState<AssistantModel[]>([]);
	const [model, setModel] = useState("");
	const [thinking, setThinking] = useState<AssistantThinkingLevel>("medium");
	const [text, setText] = useState("");
	const [key, setKey] = useState("");
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [connection, setConnection] = useState<{ connected: boolean; error: string | null }>({ connected: false, error: null });
	const [turnPaused, setTurnPaused] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		setConversations([]);
		setMessages([]);
		setActiveId("");
		Promise.all([
			api.listAssistantConversations(projectId),
			api.listAssistantModels(),
			api.getAnthropicConnectionStatus(),
		])
			.then(([items, available, status]) => {
				if (!live) return;
				const recent = [...items].sort((a, b) => b.updated_at - a.updated_at);
				setConversations(recent);
				setModels(available);
				setConnection(status);
				if (available[0]) setModel(available[0].id);
				if (recent[0]) setActiveId(recent[0].id);
			})
			.catch((cause: unknown) => {
				if (live) setError(String(cause));
			});
		return () => {
			live = false;
		};
	}, [api, projectId]);

	useEffect(() => {
		if (!activeId) {
			setMessages([]);
			setTurnPaused(false);
			return;
		}
		let live = true;
		setMessages([]);
		api.getAssistantConversation(activeId)
			.then((conversation: AssistantConversationRecord | null) => {
				if (live && conversation) {
					setMessages(conversation.messages);
					if (conversation.model) setModel(conversation.model);
					if (conversation.thinking && isThinkingLevel(conversation.thinking)) setThinking(conversation.thinking);
				}
			})
			.catch((cause: unknown) => {
				if (live) setError(String(cause));
			});
		api.getAssistantTurnStatus(activeId).then(({ paused }) => {
			if (live) setTurnPaused(paused);
		}).catch((cause: unknown) => { if (live) setError(String(cause)); });
		return () => {
			live = false;
		};
	}, [activeId, api]);

	useEffect(() => {
		if (!activeId) return;
		return api.subscribeAssistantEvents((envelope: StreamEnvelope) => {
			if (envelope.conversationId !== activeId) return;
			if (envelope.event && typeof envelope.event === "object" && "type" in envelope.event && envelope.event.type === "assistant_turn_paused") setTurnPaused(true);
			setMessages((current) => [...current, {
				role: "assistant",
				kind: "event",
				payload: envelope.event,
			}]);
		});
	}, [activeId, api]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages]);

	async function createConversation() {
		setError("");
		try {
			const conversation = await api.createAssistantConversation(projectId);
			if (model) await api.updateAssistantConversationSelection(conversation.id, model, thinking);
			setConversations((current) => [conversation, ...current]);
			setActiveId(conversation.id);
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function renameConversation() {
		const conversation = conversations.find(({ id }) => id === activeId);
		if (!conversation) return;
		const title = window.prompt("Conversation name", conversation.title || "New conversation");
		if (!title?.trim()) return;
		try {
			await api.renameAssistantConversation(activeId, title.trim());
			setConversations((current) => current.map((item) =>
				item.id === activeId ? { ...item, title: title.trim() } : item,
			));
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function deleteConversation() {
		if (!activeId || !window.confirm("Delete this conversation?")) return;
		try {
			await api.deleteAssistantConversation(activeId);
			const remaining = conversations.filter(({ id }) => id !== activeId);
			setConversations(remaining);
			setActiveId(remaining[0]?.id ?? "");
		} catch (cause) {
			setError(String(cause));
		}
	}
	function persistSelection(nextModel: string, nextThinking: AssistantThinkingLevel) {
		setModel(nextModel);
		setThinking(nextThinking);
		if (activeId) {
			void api.updateAssistantConversationSelection(activeId, nextModel, nextThinking)
				.catch((cause: unknown) => setError(String(cause)));
		}
	}

	async function continueTurn() {
		if (!activeId || pending) return;
		setPending(true);
		setError("");
		try {
			const saved = await api.continueAssistantTurn(activeId) as AssistantConversationRecord | null;
			if (saved) setMessages(saved.messages);
		} catch (cause) {
			setError(String(cause));
		} finally {
			setPending(false);
			const status = await api.getAssistantTurnStatus(activeId);
			setTurnPaused(status.paused);
		}
	}

	async function confirmDrop(toolCallId: string) {
		if (!activeId || pending) return;
		setPending(true);
		setError("");
		try {
			const saved = await api.confirmAssistantDdlDrop(activeId, toolCallId);
			if (saved) setMessages(saved.messages);
		} catch (cause) {
			setError(String(cause));
		} finally {
			setPending(false);
		}
	}
	async function sendMessage() {
		const message = text.trim();
		if (!message || !activeId || !model || pending) return;
		setText("");
		setMessages((current) => [...current, { role: "user", payload: message }]);
		setPending(true);
		setError("");
		try {
			const saved = await api.sendAssistantMessage(activeId, message, model, thinking) as AssistantConversationRecord | null;
			if (saved) {
				setMessages(saved.messages);
				setConversations((current) => current.map((item) => item.id === saved.id ? saved : item).sort((a, b) => b.updated_at - a.updated_at));
			}
		} catch (cause) {
			setError(String(cause));
		} finally {
			setPending(false);
		}
	}

	async function saveApiKey() {
		try {
			await api.setAnthropicApiKey(key);
			setKey("");
			setError("");
			setConnection(await api.getAnthropicConnectionStatus());
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function removeApiKey() {
		try {
			await api.removeAnthropicApiKey();
			setConnection(await api.getAnthropicConnectionStatus());
			setError("");
		} catch (cause) {
			setError(String(cause));
		}
	}

	if (collapsed) {
		return (
			<aside className="absolute inset-y-0 right-0 z-20 flex w-10 flex-col items-center border-l border-ink/15 bg-paper pt-3">
				<button aria-label="Expand Assistant" onClick={onExpand} className="rounded p-2 hover:bg-ink/5">
					<ChevronLeft className="size-4" />
				</button>
				<MessageSquare className="mt-3 size-4 text-ink-3" />
				<span className="mt-3 [writing-mode:vertical-rl] text-[11px] tracking-wide text-ink-3">Assistant</span>
			</aside>
		);
	}

	return (
		<aside className="absolute inset-y-0 right-0 z-20 flex flex-col border-l border-ink/15 bg-paper" style={{ width }}>
			<button
				aria-label="Resize Assistant sidebar"
				onPointerDown={onResizeStart}
				className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none"
			/>
			<header className="flex h-12 shrink-0 items-center gap-2 border-b border-ink/15 px-3">
				<MessageSquare className="size-4" />
				<h2 className="min-w-0 flex-1 font-display text-base">Assistant</h2>
				<button aria-label="New conversation" onClick={() => void createConversation()} className="rounded p-1.5 hover:bg-ink/5">
					<Plus className="size-4" />
				</button>
				<button aria-label="Collapse Assistant" onClick={onCollapse} className="rounded p-1.5 hover:bg-ink/5">
					<ChevronRight className="size-4" />
				</button>
			</header>
			<div className="flex shrink-0 gap-1 border-b border-ink/10 p-2">
				<select aria-label="Conversation" value={activeId} onChange={(event: ChangeEvent<HTMLSelectElement>) => setActiveId(event.target.value)} className="min-w-0 flex-1 bg-transparent px-2 py-1 text-sm">
					{conversations.length === 0 && <option value="">No conversations</option>}
					{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title || "New conversation"} · {new Date(conversation.updated_at).toLocaleString()}</option>)}
				</select>
				<button aria-label="Rename conversation" disabled={!activeId} onClick={() => void renameConversation()} className="rounded p-1.5 hover:bg-ink/5 disabled:opacity-40">
					<MoreHorizontal className="size-4" />
				</button>
				<button aria-label="Delete conversation" disabled={!activeId} onClick={() => void deleteConversation()} className="rounded p-1.5 hover:bg-ink/5 disabled:opacity-40">
					<X className="size-4" />
				</button>
			</div>
			<div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
				{messages.length === 0 ? (
					<div className="pt-8 text-center">
						<p className="font-display text-lg">Start a conversation</p>
						<p className="mt-2 text-xs text-ink-3">Ask about the open project.</p>
					</div>
				) : messages.map((message, index) => (
					<MessageCard key={`${index}-${message.role}`} message={message} onConfirmDrop={confirmDrop} onSelectTable={onSelectTable} />
				))}
			</div>
			{error && <div role="alert" className="px-3 py-2 text-xs text-proof-red">{error}</div>}
			<div className="shrink-0 border-t border-ink/15 p-3">
				<div className="mb-2 flex gap-2">
					<select aria-label="Model" value={model} onChange={(event: ChangeEvent<HTMLSelectElement>) => persistSelection(event.target.value, thinking)} className="min-w-0 flex-1 bg-transparent text-xs">
						{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
					</select>
					<select aria-label="Thinking level" value={thinking} onChange={(event: ChangeEvent<HTMLSelectElement>) => persistSelection(model, event.target.value as AssistantThinkingLevel)} className="bg-transparent text-xs">
						<option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Max</option>
					</select>
				</div>
				<div className="flex items-end gap-2">
					<textarea
						aria-label="Message"
						value={text}
						onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
						onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
							if (event.key === "Enter" && !event.shiftKey) {
								event.preventDefault();
								void sendMessage();
							}
						}}
						placeholder="Ask about your design…"
						rows={3}
						className="min-w-0 flex-1 resize-y rounded-sm border border-ink/20 bg-transparent p-2 text-sm outline-none focus:border-ink/50"
					/>
					{pending ? (
						<button aria-label="Stop assistant response" onClick={() => void api.stopAssistantTurn(activeId).catch((cause: unknown) => setError(String(cause)))} className="rounded-sm border border-ink/25 px-2.5 py-2 text-xs">Stop</button>
					) : turnPaused ? (
						<button aria-label="Continue assistant response" onClick={() => void continueTurn()} className="rounded-sm border border-ink/25 px-2.5 py-2 text-xs">Continue</button>
					) : (
						<button aria-label="Send message" disabled={!activeId || !text.trim() || !model} onClick={() => void sendMessage()} className="rounded-sm bg-ink px-2.5 py-2 text-paper disabled:opacity-40">
							<Send className="size-4" />
						</button>
					)}
				</div>
				<details className="mt-2">
					<summary className="cursor-pointer text-[11px] text-ink-3">Anthropic API key · {connection.connected ? "Connected" : "Not connected"}</summary>
					{connection.error && <p role="alert" className="mt-2 text-[11px] text-proof-red">{connection.error}</p>}
					<div className="mt-2 flex gap-2">
						<Input type="password" value={key} onChange={(event: ChangeEvent<HTMLInputElement>) => setKey(event.target.value)} placeholder={connection.connected ? "Replace API key" : "Paste API key"} autoComplete="off" />
						<button onClick={() => void saveApiKey()} disabled={!key} className="rounded border border-ink/20 px-2 text-xs disabled:opacity-40">Save</button>
					</div>
					{connection.connected && <button onClick={() => void removeApiKey()} className="mt-2 rounded border border-ink/20 px-2 py-1 text-xs">Remove connection</button>}
					<p className="mt-1 text-[10px] text-ink-3">Stored in the operating-system credential service, never in conversation content.</p>
				</details>
			</div>
		</aside>
	);
}

function MessageCard({
	message,
	onConfirmDrop,
	onSelectTable,
}: {
	message: AssistantMessage;
	onConfirmDrop: (toolCallId: string) => void;
	onSelectTable: (tableId: string) => void;
}) {
	if (message.kind === "assistant-context" || message.kind === "assistant-change-note" || message.kind === "assistant-continue" || message.kind === "assistant-drop-confirmation") return null;
	const payload = message.payload;
	const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
	const toolCall = record && Array.isArray(record.content)
		? record.content.find((part) => part && typeof part === "object" && "type" in part && part.type === "toolCall")
		: undefined;
	const details = record?.details && typeof record.details === "object" ? record.details as Record<string, unknown> : null;
	const affectedTables = Array.isArray(details?.affectedTables)
		? details.affectedTables.filter((table): table is { id: string; name: string; removed?: boolean } =>
			Boolean(table && typeof table === "object" && "id" in table && typeof table.id === "string" && "name" in table && typeof table.name === "string"),
		)
		: [];
	const confirmation = details?.status === "confirmation-required" ? details : null;
	const toolCallId = typeof record?.toolCallId === "string" ? record.toolCallId : "";
	const removal = confirmation?.removal && typeof confirmation.removal === "object" ? confirmation.removal as Record<string, unknown> : null;
	const affectedRelationships = Array.isArray(removal?.relationships) ? removal.relationships as Array<Record<string, unknown>> : [];
	const isTool = message.role === "toolResult" || message.kind === "tool-result" || Boolean(toolCall);
	const summary = message.kind === "event" ? "Assistant activity" : isTool ? "Tool call and result" : message.role === "user" ? "You" : "Assistant";
	const content = record && "content" in record ? record.content : payload;
	const printable = typeof content === "string" ? content : JSON.stringify(content, null, 2);
	const body = isTool ? (
		<div className="border-y border-ink/10 py-2 text-xs">
			<details>
				<summary className="cursor-pointer font-medium">{summary}</summary>
				<pre className="mt-2 whitespace-pre-wrap break-words text-ink-3">{printable}</pre>
			</details>
			{affectedTables.length > 0 && (
				<div className="mt-2 flex flex-wrap items-center gap-1 text-[11px]">
					<span>Affected tables:</span>
					{affectedTables.map((table) => table.removed
						? <span key={table.id} className="text-ink-3">removed {table.name}</span>
						: <button key={table.id} onClick={() => onSelectTable(table.id)} className="underline underline-offset-2">{table.name}</button>)}
				</div>
			)}
			{confirmation && (
				<div className="mt-2 rounded-sm border border-proof-red/30 p-2">
					<p className="font-medium">Destructive change needs confirmation</p>
					{affectedRelationships.length > 0 && <p className="mt-1 text-ink-3">This removes {affectedRelationships.length} relationship(s).</p>}
					<button disabled={!toolCallId} onClick={() => onConfirmDrop(toolCallId)} className="mt-2 rounded-sm border border-proof-red/40 px-2 py-1 text-xs disabled:opacity-40">Confirm drop</button>
				</div>
			)}
		</div>
	) : (
		<div className="text-sm leading-relaxed">
			<p className="mb-1 text-[10px] uppercase tracking-wide text-ink-3">{summary}</p>
			<p className="whitespace-pre-wrap">{printable}</p>
		</div>
	);
	return <article>{body}</article>;
}
function isThinkingLevel(value: string): value is AssistantThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
