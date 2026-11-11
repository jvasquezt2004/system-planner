import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { BookOpen, ChevronLeft, ChevronRight, Database, FileCode2, FolderOpen, MessageSquare, MoreHorizontal, Play, Plus, Send, Wrench, X } from "lucide-react";
import { HarnessFormPanel } from "./harness-form";
import { ProjectFilesPanel, type ProjectFilesApi } from "./project-files-panel";
import type { HarnessFormField } from "./shared/harness-form";
import {
	Trace,
	TraceCollapsible,
	TraceCollapsibleContent,
	TraceCollapsibleTrigger,
	TraceDescription,
	TraceIcon,
	TraceLine,
	TraceTitle,
} from "@/components/ui/trace";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import type {
	AssistantConnectionStatus,
	AssistantConversation,
	AssistantConversationRecord,
	AssistantMessage,
	AssistantModel,
	AssistantThinkingLevel,
	AssistantTotalUsage,
	AssistantTurnUsage,
	CodexPendingRequest,
} from "./shared/assistant";
import { workspaceClient } from "./workspace-client";
import { buildTranscript, foldAssistantEvent, type TranscriptDisplayItem, type TranscriptToolItem } from "./assistant-transcript";
import { pickUsableModel } from "./assistant-model-selection";

/** Main-view controls for saved Assistant conversations and their provider. */
type AssistantApi = Pick<
	typeof workspaceClient,
	| "listAssistantConversations"
	| "getAssistantConversation"
	| "createAssistantConversation"
	| "renameAssistantConversation"
	| "deleteAssistantConversation"
	| "listAssistantModels"
	| "listAssistantConnections"
	| "sendAssistantMessage"
	| "stopAssistantTurn"
	| "continueAssistantTurn"
	| "getAssistantTurnStatus"
	| "getCodexRequest"
	| "answerCodexRequest"
	| "verifyCodexRequest"
	| "updateAssistantConversationSelection"
	| "confirmAssistantDdlDrop"
	| "rejectAssistantDdlDrop"
	| "revertAssistantTurn"
	| "subscribeAssistantEvents"
>;
type StreamEnvelope = { conversationId: string; event: unknown };

export function AssistantSidebar({
	projectId,
	collapsed,
	width,
	api,
	onCollapse,
	onExpand,
	onResizeStart,
	onShowProjectFolder,
	filesApi,
	onSelectTable,
	onSelectCodeSource,
}: {
	projectId: string;
	collapsed: boolean;
	width: number;
	api: AssistantApi;
	onCollapse: () => void;
	onExpand: () => void;
	onResizeStart: (event: React.PointerEvent) => void;
	/** Opens the Project's read-only folder, which Codex reads. */
	onShowProjectFolder?: () => void;
	/** Attaching and listing the files the Assistant reads as background; absent in views that do not support it. */
	filesApi?: ProjectFilesApi;
	onSelectTable: (tableId: string) => void;
	onSelectCodeSource: (kind: "scenario" | "edge-function" | "function-body", id: string) => void;
}) {
	const [conversations, setConversations] = useState<AssistantConversation[]>([]);
	const [activeId, setActiveId] = useState("");
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const [models, setModels] = useState<AssistantModel[]>([]);
	const [connections, setConnections] = useState<AssistantConnectionStatus[]>([]);
	const [selectedConnectionId, setSelectedConnectionId] = useState("");
	const [cacheWarning, setCacheWarning] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const [thinking, setThinking] = useState<AssistantThinkingLevel>("medium");
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [turnPaused, setTurnPaused] = useState(false);
	const [confirmationRequired, setConfirmationRequired] = useState(false);
	const [codexRequest, setCodexRequest] = useState<CodexPendingRequest | null>(null);
	const [codexElicitation, setCodexElicitation] = useState("{}");
	const [codexVerifying, setCodexVerifying] = useState(false);
	const [expandedSettings, setExpandedSettings] = useState(false);
	const [revertAvailable, setRevertAvailable] = useState(false);
	const initialConversationModelRef = useRef<string | null>(null);
	const [turnUsages, setTurnUsages] = useState<AssistantTurnUsage[]>([]);
	const [totalUsage, setTotalUsage] = useState<AssistantTotalUsage | null>(null);
	const contextRef = useRef({ projectId, activeId, generation: 0 });
	if (contextRef.current.projectId !== projectId || contextRef.current.activeId !== activeId) {
		contextRef.current = {
			projectId,
			activeId,
			generation: contextRef.current.generation + 1,
		};
	}

	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let live = true;
		setPending(false);
		setCodexRequest(null);
		setConversations([]);
		setMessages([]);
		setActiveId("");
		setTurnPaused(false);
		setConfirmationRequired(false);
		Promise.all([
			api.listAssistantConversations(projectId),
			api.listAssistantModels(),
			api.listAssistantConnections(),
		])
			.then(([items, available, connectionList]) => {
				if (!live) return;
				const recent = [...items].sort((a, b) => b.updated_at - a.updated_at);
				setConversations(recent);
				setModels(available);
				setConnections(connectionList);
				const initial = pickUsableModel(available);
				if (initial) {
					setModel(initial.id);
					setSelectedConnectionId(initial.connectionId);
				}
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
		let live = true;
		setPending(false);
		setCodexRequest(null);
		if (!activeId) {
			setMessages([]);
			setTurnPaused(false);
			setConfirmationRequired(false);
			return () => {
				live = false;
			};
		}
		setMessages([]);
		api.getAssistantConversation(activeId)
			.then((conversation: AssistantConversationRecord | null) => {
				if (live && conversation) {
					setMessages(conversation.messages);
					setTurnUsages(conversation.usages ?? []);
					setTotalUsage(conversation.totalUsage ?? null);
					const usable = pickUsableModel(models, conversation.connection_id, conversation.model);
					const nextConnId = usable?.connectionId ?? conversation.connection_id ?? "";
					const nextModel = usable?.id ?? conversation.model ?? "";
					setSelectedConnectionId(nextConnId);
					setModel(nextModel);
					initialConversationModelRef.current = `${nextConnId}:${nextModel}`;
					const effectiveThinking = conversation.thinking && isThinkingLevel(conversation.thinking) ? conversation.thinking : "medium";
					if (conversation.thinking && isThinkingLevel(conversation.thinking)) setThinking(conversation.thinking);
					setCacheWarning(null);
					if (usable && (conversation.model !== usable.id || (conversation.connection_id ?? "") !== usable.connectionId)) {
						void api.updateAssistantConversationSelection(activeId, usable.connectionId, usable.id, effectiveThinking)
							.catch((cause: unknown) => setError(String(cause)));
					}
				}
			})
			.catch((cause: unknown) => {
				if (live) setError(String(cause));
			});
		api.getAssistantTurnStatus(activeId).then(({ paused, confirmationRequired: requiresConfirmation, running }) => {
			if (live) {
				setTurnPaused(paused);
				setConfirmationRequired(requiresConfirmation);
				if (running !== undefined) setPending(running);
			}
		}).catch((cause: unknown) => { if (live) setError(String(cause)); });
		api.getCodexRequest(activeId).then((request) => { if (live) setCodexRequest(request); }).catch((cause: unknown) => { if (live) setError(String(cause)); });
		return () => {
			live = false;
		};
	}, [activeId, api]);

	async function reloadConversation(targetId: string) {
		try {
			const saved = await api.getAssistantConversation(targetId);
			if (contextRef.current.activeId === targetId && saved) {
				setMessages(saved.messages);
				setTurnUsages(saved.usages ?? []);
				setTotalUsage(saved.totalUsage ?? null);
				setConversations((current) =>
					current.map((item) => (item.id === saved.id ? saved : item)).sort((a, b) => b.updated_at - a.updated_at)
				);
			}
			const status = await api.getAssistantTurnStatus(targetId);
			if (contextRef.current.activeId === targetId) {
				setRevertAvailable(status.revertAvailable);
				setTurnPaused(status.paused);
				setConfirmationRequired(status.confirmationRequired);
			}
		} catch (cause) {
			if (contextRef.current.activeId === targetId) setError(String(cause));
		} finally {
			if (contextRef.current.activeId === targetId) setPending(false);
		}
	}

	useEffect(() => {
		if (!activeId) return;
		return api.subscribeAssistantEvents((envelope: StreamEnvelope) => {
			if (envelope.conversationId !== activeId) return;
			if (envelope.event && typeof envelope.event === "object" && "type" in envelope.event) {
				if (envelope.event.type === "assistant_turn_paused") {
					setTurnPaused(true);
					setPending(false);
				}
				if (envelope.event.type === "assistant_confirmation_required") {
					setTurnPaused(true);
					setConfirmationRequired(true);
					setPending(false);
				}
				if (envelope.event.type === "assistant_confirmation_resolved") {
					setTurnPaused(false);
					setConfirmationRequired(false);
				}
				if (envelope.event.type === "assistant_turn_usage") {
					const usageEvent = envelope.event as unknown as { usage: AssistantTurnUsage };
					if (usageEvent.usage) setTurnUsages((current) => [...current, usageEvent.usage]);
				}
				if (envelope.event.type === "assistant_error") {
					const errorEvent = envelope.event as unknown as { error?: string };
					if (errorEvent.error) setError(errorEvent.error);
					setPending(false);
				}
				if (envelope.event.type === "codex_request") {
					setCodexRequest((envelope.event as unknown as { request: CodexPendingRequest }).request);
					setCodexElicitation("{}");
				}
				if (envelope.event.type === "codex_request_resolved") setCodexRequest(null);
				if (envelope.event.type === "agent_end" || envelope.event.type === "assistant_turn_ended") {
					void reloadConversation(activeId);
				}
			}
			setMessages((current) => foldAssistantEvent(current, envelope.event));
		});
	}, [activeId, api]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages]);
	useEffect(() => {
		if (!models.length) return;
		const usable = pickUsableModel(models, selectedConnectionId, model);
		if (!usable) return;
		if (usable.id !== model || usable.connectionId !== selectedConnectionId) {
			setSelectedConnectionId(usable.connectionId);
			setModel(usable.id);
			if (activeId) {
				initialConversationModelRef.current = `${usable.connectionId}:${usable.id}`;
				void api.updateAssistantConversationSelection(activeId, usable.connectionId, usable.id, thinking)
					.catch((cause: unknown) => setError(String(cause)));
			}
		}
	}, [models, activeId, selectedConnectionId, model, thinking, api]);


	async function createConversation() {
		setError("");
		try {
			const conversation = await api.createAssistantConversation(projectId);
			const usable = pickUsableModel(models, conversation.connection_id, conversation.model);
			const nextConnId = usable?.connectionId ?? conversation.connection_id ?? "";
			const nextModel = usable?.id ?? conversation.model ?? "";
			setSelectedConnectionId(nextConnId);
			setModel(nextModel);
			initialConversationModelRef.current = `${nextConnId}:${nextModel}`;
			if (conversation.thinking && isThinkingLevel(conversation.thinking)) setThinking(conversation.thinking);
			setCacheWarning(null);
			setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
			setActiveId(conversation.id);
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function sendMessage() {
		const message = text.trim();
		if (!message || !model || confirmationRequired) return;
		const usable = pickUsableModel(models, selectedConnectionId, model);
		const effectiveModel = usable?.id ?? model;
		const effectiveConnectionId = usable?.connectionId ?? selectedConnectionId;
		if (usable && (usable.id !== model || usable.connectionId !== selectedConnectionId)) {
			setSelectedConnectionId(usable.connectionId);
			setModel(usable.id);
			if (activeId) {
				initialConversationModelRef.current = `${usable.connectionId}:${usable.id}`;
				void api.updateAssistantConversationSelection(activeId, usable.connectionId, usable.id, thinking)
					.catch((cause: unknown) => setError(String(cause)));
			}
		}
		const requestContext = contextRef.current;
		setText("");
		setMessages((current) => [...current, { role: "user", payload: message }]);
		setPending(true);
		setError("");
		let targetConversationId = activeId;
		try {
			if (!targetConversationId) {
				const conversation = await api.createAssistantConversation(projectId);
				targetConversationId = conversation.id;
				await api.updateAssistantConversationSelection(targetConversationId, effectiveConnectionId || null, effectiveModel, effectiveThinkingValue);
				setConversations((current) => [conversation, ...current.filter((item) => item.id !== conversation.id)]);
				const createdConnId = effectiveConnectionId;
				const createdModel = effectiveModel;
				setSelectedConnectionId(createdConnId);
				setModel(createdModel);
				initialConversationModelRef.current = `${createdConnId}:${createdModel}`;
				setActiveId(targetConversationId);
			}
			await api.sendAssistantMessage(targetConversationId, message, effectiveModel, effectiveThinkingValue, effectiveConnectionId || undefined);
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) {
				setError(String(cause));
				setPending(false);
				setText(message);
				if (targetConversationId) {
					void api.getAssistantConversation(targetConversationId).then((saved) => {
						if (contextRef.current.activeId === targetConversationId && saved) {
							setMessages(saved.messages);
						}
					});
				}
			}
		}
	}

	const selectedConnection = connections.find((c) => c.id === selectedConnectionId);
	const isConnectionRemoved = Boolean(selectedConnectionId && !selectedConnection && connections.length > 0);

	const connectionGroups = connections.map((conn) => {
		const connModels = models.filter((m) => m.connectionId === conn.id);
		return {
			...conn,
			models: connModels,
		};
	}).filter((g) => g.models.length > 0);

	const pickerGroups = connectionGroups.length > 0 ? connectionGroups : Array.from(
		new Set(models.map((m) => m.provider)),
	).map((providerId) => ({
		id: providerId,
		providerId,
		name: providerId === "anthropic" ? "Anthropic" : providerId === "openai" ? "OpenAI" : providerId === "google" ? "Google Gemini" : providerId,
		authMethod: "api-key" as const,
		connected: false,
		error: null,
		models: models.filter((m) => m.provider === providerId),
	}));

	const usableModel = pickUsableModel(models, selectedConnectionId, model);
	const effectiveConnId = usableModel?.connectionId ?? selectedConnectionId;
	const effectiveModelId = usableModel?.id ?? model;
	const allPickerModelValues = pickerGroups.flatMap((group) =>
		group.models.map((item) => `${group.id}::${item.id}`),
	);
	const candidateModelValue = `${effectiveConnId}::${effectiveModelId}`;
	const selectedModelValue = allPickerModelValues.includes(candidateModelValue)
		? candidateModelValue
		: allPickerModelValues.find((val) => val.endsWith(`::${effectiveModelId}`)) ?? (allPickerModelValues[0] ?? undefined);

	/** Codex models advertise their own efforts; other connections use the standard levels. */
	function effortsFor(item: AssistantModel | undefined): AssistantThinkingLevel[] {
		if (item?.reasoningEfforts?.length) return item.reasoningEfforts.map((effort) => effort.id).filter(isThinkingLevel);
		const connection = item?.connectionId ?? effectiveConnId;
		if (connection === "opencode-harness") return item && item.id !== "opencode-default" ? [] : ["low", "medium", "high", "xhigh", "max"];
		return connection === "codex-harness" ? ["low", "medium", "high", "xhigh", "max"] : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	}
	const effortOptions = effortsFor(usableModel ?? undefined);
	const effectiveThinkingValue = effortOptions.includes(thinking) ? thinking : (usableModel?.defaultReasoningEffort && effortOptions.includes(usableModel.defaultReasoningEffort) ? usableModel.defaultReasoningEffort : effortOptions.includes("medium") ? "medium" : effortOptions[0]);

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
	function persistSelection(nextConnectionId: string | null, nextModel: string, nextThinking: AssistantThinkingLevel) {
		if (messages.some((message) => message.role === "user") && (isHarnessConnection(selectedConnectionId) || isHarnessConnection(nextConnectionId)) && (selectedConnectionId || null) !== (nextConnectionId || null)) {
			setError("Start a new Conversation to switch between Codex, OpenCode, and provider connections.");
			return;
		}
		setSelectedConnectionId(nextConnectionId ?? "");
		setModel(nextModel);
		setThinking(nextThinking);
		const key = `${nextConnectionId ?? ""}:${nextModel}`;
		if (activeId && messages.length > 0 && initialConversationModelRef.current && key !== initialConversationModelRef.current) {
			setCacheWarning("Switching models mid-conversation means the next request won't hit the prompt cache.");
		} else {
			setCacheWarning(null);
		}
		if (activeId) {
			void api.updateAssistantConversationSelection(activeId, nextConnectionId, nextModel, nextThinking)
				.catch((cause: unknown) => setError(String(cause)));
		}
	}

	async function reloadConnections() {
		try {
			const [available, connectionList] = await Promise.all([
				api.listAssistantModels(),
				api.listAssistantConnections(),
			]);
			setModels(available);
			setConnections(connectionList);
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function continueTurn() {
		const requestContext = contextRef.current;
		if (!activeId || pending) return;
		setPending(true);
		setError("");
		try {
			await api.continueAssistantTurn(activeId);
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) {
				setError(String(cause));
				setPending(false);
				const status = await api.getAssistantTurnStatus(activeId);
				if (contextRef.current.generation === requestContext.generation) {
					setTurnPaused(status.paused);
					setConfirmationRequired(status.confirmationRequired);
				}
			}
		}
	}

	async function confirmDrop(toolCallId: string) {
		const requestContext = contextRef.current;
		if (!activeId || pending) return;
		setPending(true);
		setError("");
		try {
			await api.confirmAssistantDdlDrop(activeId, toolCallId);
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) {
				setError(String(cause));
				setPending(false);
				const status = await api.getAssistantTurnStatus(activeId);
				if (contextRef.current.generation === requestContext.generation) {
					setTurnPaused(status.paused);
					setConfirmationRequired(status.confirmationRequired);
				}
			}
		}
	}
	async function rejectDrop(toolCallId: string) {
		const requestContext = contextRef.current;
		if (!activeId || pending) return;
		setPending(true);
		setError("");
		try {
			await api.rejectAssistantDdlDrop(activeId, toolCallId);
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) {
				setError(String(cause));
				setPending(false);
				const status = await api.getAssistantTurnStatus(activeId);
				if (contextRef.current.generation === requestContext.generation) {
					setTurnPaused(status.paused);
					setConfirmationRequired(status.confirmationRequired);
				}
			}
		}
	}

	async function answerCodex(response: unknown) {
		if (!codexRequest || !activeId) return;
		try {
			if (!await api.answerCodexRequest(activeId, codexRequest.id, response)) throw new Error("This Codex request is no longer available.");
			setCodexRequest(null);
		} catch (cause) { setError(String(cause)); }
	}

	async function verifyCodex() {
		if (!codexRequest || !activeId || codexVerifying) return;
		setCodexVerifying(true);
		try {
			if (await api.verifyCodexRequest(activeId, codexRequest.id)) setCodexRequest(null);
		} catch (cause) { setError(String(cause)); }
		finally { setCodexVerifying(false); }
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
			<div className="flex shrink-0 items-center gap-1 border-b border-ink/10 p-2">
				<Select
					value={activeId || undefined}
					onValueChange={(value) => {
						if (value) setActiveId(value);
					}}
					disabled={conversations.length === 0}
				>
					<SelectTrigger aria-label="Conversation" className="h-8 min-w-0 flex-1 text-xs">
						<SelectValue placeholder={conversations.length === 0 ? "No conversations" : "Select conversation"} />
					</SelectTrigger>
					<SelectContent position="popper" align="start" className="max-h-80">
						{conversations.map((conversation) => (
							<SelectItem key={conversation.id} value={conversation.id}>
								{conversation.title || "New conversation"} · {new Date(conversation.updated_at).toLocaleString()}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				{onShowProjectFolder && (
					<button aria-label="Show project folder" title="Show project folder" onClick={onShowProjectFolder} className="rounded p-1.5 hover:bg-ink/5">
						<FolderOpen className="size-4" />
					</button>
				)}
				<button aria-label="Rename conversation" disabled={!activeId} onClick={() => void renameConversation()} className="rounded p-1.5 hover:bg-ink/5 disabled:opacity-40">
					<MoreHorizontal className="size-4" />
				</button>
				<button aria-label="Delete conversation" disabled={!activeId} onClick={() => void deleteConversation()} className="rounded p-1.5 hover:bg-ink/5 disabled:opacity-40">
					<X className="size-4" />
				</button>
			</div>
			{(() => {
				const effectiveTotal = totalUsage ?? {
					inputTokens: turnUsages.reduce((sum, u) => sum + (u.inputTokens || 0), 0),
					outputTokens: turnUsages.reduce((sum, u) => sum + (u.outputTokens || 0), 0),
					cacheReadTokens: turnUsages.reduce((sum, u) => sum + (u.cacheReadTokens || 0), 0),
					cost: turnUsages.some((u) => typeof u.cost === "number")
						? turnUsages.reduce((sum, u) => sum + (typeof u.cost === "number" ? u.cost : 0), 0)
						: null,
				};
				if (effectiveTotal.inputTokens <= 0 && effectiveTotal.outputTokens <= 0 && effectiveTotal.cacheReadTokens <= 0) return null;
				return (
					<div aria-label="Conversation usage" className="flex shrink-0 items-center justify-between border-b border-ink/10 px-3 py-1 text-[11px] text-ink-3">
						<span>Total:</span>
						<span>
							{effectiveTotal.inputTokens.toLocaleString()} in · {effectiveTotal.outputTokens.toLocaleString()} out · {effectiveTotal.cacheReadTokens.toLocaleString()} cached
							{typeof effectiveTotal.cost === "number" && effectiveTotal.cost > 0 && ` · $${effectiveTotal.cost < 0.01 ? effectiveTotal.cost.toFixed(4) : effectiveTotal.cost.toFixed(2)}`}
						</span>
					</div>
				);
			})()}
			<div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
				{messages.length === 0 ? (
					<div className="pt-8 text-center">
						<p className="font-display text-lg">Start a conversation</p>
						<p className="mt-2 text-xs text-ink-3">Ask about the open project.</p>
					</div>
				) : (
					<TranscriptView
						messages={messages}
						confirmationRequired={confirmationRequired}
						pending={pending}
						onConfirmDrop={confirmDrop}
						onRejectDrop={rejectDrop}
						onSelectTable={onSelectTable}
						onSelectCodeSource={onSelectCodeSource}
					/>
				)}
			</div>
			{error && <div role="alert" className="px-3 py-2 text-xs text-proof-red">{error}</div>}
			<div className="shrink-0 border-t border-ink/15 p-3">
				{codexRequest && (
					<div className="mb-2 max-h-[55vh] overflow-y-auto overscroll-contain rounded border border-ink/25 bg-surface p-2 text-xs" role="group" aria-label="Codex request">
						{codexRequest.method === "form/request" ? (
							<HarnessFormPanel
								key={codexRequest.id}
								title={String(codexRequest.params.title ?? `${String(codexRequest.params.harnessName ?? "Codex")} needs your input`)}
								message={typeof codexRequest.params.message === "string" ? codexRequest.params.message : undefined}
								form={{ fields: Array.isArray(codexRequest.params.fields) ? codexRequest.params.fields as HarnessFormField[] : [] }}
								onSubmit={(answer) => void answerCodex({ answer })}
								onCancel={() => void answerCodex({ cancel: true })}
							/>
						) : codexRequest.method === "mcpServer/elicitation/request" ? (
							<div>
								<p className="font-semibold">{String(codexRequest.params.serverName ?? "MCP server")} needs your input</p>
								{codexRequest.params.mode === "openai/userVerification" && <p className="mt-1 font-medium">{String(codexRequest.params.title ?? "Verify your identity")}</p>}
								<p className="mt-1 whitespace-pre-wrap">{String(codexRequest.params.message ?? codexRequest.params.description ?? "Review this request.")}</p>
								{codexRequest.params.mode === "url" && typeof codexRequest.params.url === "string" && /^https?:\/\//i.test(codexRequest.params.url) && <a className="mt-1 block break-all underline" href={codexRequest.params.url} target="_blank" rel="noreferrer">{codexRequest.params.url}</a>}
								{["form", "openai/form", "openaiForm"].includes(String(codexRequest.params.mode)) && <><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap">{JSON.stringify(codexRequest.params.requestedSchema, null, 2)}</pre><label className="mt-1 block">Response (JSON)<textarea aria-label="MCP response JSON" value={codexElicitation} onChange={(event) => setCodexElicitation(event.target.value)} className="mt-1 block h-20 w-full rounded border border-ink/20 bg-transparent p-1 font-mono" /></label></>}
								<div className="mt-2 flex gap-2"><button disabled={codexVerifying} onClick={() => {
									if (codexRequest.params.mode === "openai/userVerification") { void verifyCodex(); return; }
									try { const content = codexRequest.params.mode === "url" ? null : JSON.parse(codexElicitation); void answerCodex({ action: "accept", content, _meta: null }); }
									catch { setError("Enter a valid JSON response."); }
								}} className="rounded border border-ink/30 px-2 py-1 disabled:opacity-40">{codexVerifying ? "Verifying…" : codexRequest.params.mode === "openai/userVerification" ? "Verify" : "Continue"}</button><button onClick={() => void answerCodex({ action: "decline", content: null, _meta: null })} className="rounded border border-ink/30 px-2 py-1">Decline</button></div>
							</div>
						) : (
							<>
								<p className="font-semibold">{String(codexRequest.params.harnessName ?? "Codex")} requests permission</p>
								<p className="mt-1 whitespace-pre-wrap break-all">{String(codexRequest.params.reason ?? "Review this action before allowing it.")}</p>
								{typeof codexRequest.params.command === "string" && <pre className="mt-1 overflow-auto whitespace-pre-wrap">{codexRequest.params.command}</pre>}
								{typeof codexRequest.params.cwd === "string" && <p className="mt-1 break-all">Working directory: {codexRequest.params.cwd}</p>}
								{codexRequest.method === "item/permissions/requestApproval" && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(codexRequest.params.permissions, null, 2)}</pre>}
								{codexRequest.params.networkApprovalContext != null && <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(codexRequest.params.networkApprovalContext, null, 2)}</pre>}
								{typeof codexRequest.params.grantRoot === "string" && <p className="mt-1 break-all">Requested write root: {codexRequest.params.grantRoot}</p>}
								{codexRequest.method === "item/fileChange/requestApproval" && <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all">{Array.isArray((codexRequest.params.item as { changes?: unknown } | undefined)?.changes) && ((codexRequest.params.item as { changes: unknown[] }).changes.length > 0) ? JSON.stringify(codexRequest.params.item, null, 2) : "File change details are unavailable; this request cannot be approved here."}</pre>}
								<div className="mt-2 flex gap-2"><button disabled={(codexRequest.method === "item/fileChange/requestApproval" && (!Array.isArray((codexRequest.params.item as { changes?: unknown } | undefined)?.changes) || !(codexRequest.params.item as { changes: unknown[] }).changes.length)) || (codexRequest.method === "item/commandExecution/requestApproval" && typeof codexRequest.params.command !== "string" && !codexRequest.params.networkApprovalContext)} onClick={() => void answerCodex({ decision: "accept" })} className="rounded border border-ink/30 px-2 py-1 disabled:opacity-40">Allow</button><button onClick={() => void answerCodex({ decision: "decline" })} className="rounded border border-ink/30 px-2 py-1">Decline</button></div>
							</>
						)}
					</div>
				)}
				{cacheWarning && (
					<div role="status" className="mb-2 rounded border border-ink/20 bg-ink/5 p-2 text-xs text-ink-2">
						{cacheWarning}
					</div>
				)}
				{isConnectionRemoved && (
					<div role="alert" className="mb-2 rounded border border-ink/20 bg-ink/5 p-2 text-xs">
						The provider connection for this conversation was removed. Please select a connection and model to continue.
					</div>
				)}
				{selectedConnection?.error && (
					<div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded border border-proof-red/40 bg-proof-red/10 p-2 text-xs text-proof-red">
						<span className="min-w-0 flex-1">{selectedConnection.name}: {selectedConnection.error}</span>
						{(
							<button onClick={() => void reloadConnections()} className="shrink-0 rounded border border-proof-red/50 bg-paper px-2 py-1 text-xs font-medium text-ink">Check again</button>
						)}
					</div>
				)}
				{filesApi && <ProjectFilesPanel projectId={projectId} api={filesApi} />}
				<div className="mb-2 flex items-center gap-2">
					<Select
						value={selectedModelValue}
						onValueChange={(val) => {
							const [connId, ...rest] = val.split("::");
							const next = models.find((item) => item.connectionId === connId && item.id === rest.join("::"));
							const nextEfforts = effortsFor(next);
							persistSelection(connId || null, rest.join("::"), nextEfforts.includes(thinking) ? thinking : (next?.defaultReasoningEffort && nextEfforts.includes(next.defaultReasoningEffort) ? next.defaultReasoningEffort : nextEfforts.includes("medium") ? "medium" : nextEfforts[0]));
						}}
						disabled={models.length === 0 || pending || confirmationRequired}
					>
						<SelectTrigger aria-label="Model" className="h-8 min-w-0 flex-1 text-xs">
							<SelectValue placeholder="Select model" />
						</SelectTrigger>
						<SelectContent position="popper" align="start" className="max-h-80">
							{pickerGroups.map((group) => (
								<SelectGroup key={group.id}>
									<SelectLabel>
										{group.error ? `${group.name} (${group.error})` : group.name}
									</SelectLabel>
									{group.models.map((item) => (
										<SelectItem
											key={`${group.id}::${item.id}`}
											value={`${group.id}::${item.id}`}
										>
											{item.name}
										</SelectItem>
									))}
								</SelectGroup>
							))}
						</SelectContent>
					</Select>
					<Select
						value={effectiveThinkingValue}
						disabled={pending || confirmationRequired}
						onValueChange={(val) => {
							if (isThinkingLevel(val)) {
								persistSelection(selectedConnectionId, model, val);
							}
						}}
					>
						<SelectTrigger aria-label="Thinking level" className="h-8 w-fit shrink-0 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper" align="end" className="max-h-80">
							{effortOptions.map((level) => (
								<SelectItem key={level} value={level}>{THINKING_LABELS[level]}</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex items-end gap-2">
					<textarea
						aria-label="Message"
						disabled={confirmationRequired}
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
					{pending && (
						<button aria-label="Stop assistant response" onClick={() => void api.stopAssistantTurn(activeId).catch((cause: unknown) => setError(String(cause)))} className="rounded-sm border border-ink/25 px-2.5 py-2 text-xs">Stop</button>
					)}
					{confirmationRequired ? (
						<button aria-label="Waiting for destructive confirmation" disabled className="rounded-sm border border-ink/25 px-2.5 py-2 text-xs">Confirm plan above</button>
					) : turnPaused ? (
						<button aria-label="Continue assistant response" onClick={() => void continueTurn()} className="rounded-sm border border-ink/25 px-2.5 py-2 text-xs">Continue</button>
					) : (
						<button aria-label={pending ? "Steer assistant" : "Send message"} disabled={!text.trim() || !model || isConnectionRemoved} onClick={() => void sendMessage()} className="rounded-sm bg-ink px-2.5 py-2 text-paper disabled:opacity-40">
							<Send className="size-4" />
						</button>
					)}
					{revertAvailable && !pending && (
						<button aria-label="Revert this Assistant turn" onClick={() => void api.revertAssistantTurn(activeId).then((saved) => {
							if (saved) setMessages(saved.messages);
							setRevertAvailable(false);
						}).catch((cause: unknown) => setError(String(cause)))} className="rounded-sm border border-ink/25 px-2.5 py-2 text-xs">Revert this turn</button>
					)}
				</div>
				<details className="mt-2" open={expandedSettings} onToggle={(event) => setExpandedSettings((event.target as HTMLDetailsElement).open)}>
					<summary className="cursor-pointer text-[11px] text-ink-3">
						Harnesses · {connections.filter((c) => c.connected).length} ready
					</summary>
					<div className="mt-2 space-y-3">
						<div className="rounded border border-ink/10 p-2 text-xs">
							<div className="flex items-center justify-between font-medium"><span>Codex</span><span className="text-[11px] text-ink-3">{connections.find((c) => c.providerId === "codex-harness")?.connected ? "Ready" : "Setup needed"}</span></div>
							<p className="mt-1 text-ink-3">Uses the installed Codex CLI and its sign-in and reasoning settings. Run <code>codex login</code> in a terminal if needed. Codex starts in the Project's read-only folder; its file and command actions follow its own permissions. Project Revert covers Project changes only.</p>
						</div>
						<div className="rounded border border-ink/10 p-2 text-xs">
							<div className="flex items-center justify-between font-medium"><span>OpenCode</span><span className="text-[11px] text-ink-3">{connections.find((c) => c.providerId === "opencode-harness")?.connected ? "Ready" : "Setup needed"}</span></div>
							<p className="mt-1 text-ink-3">Uses the installed OpenCode with its own providers, models, and permissions. Run <code>opencode auth login</code> in a terminal to connect a provider. OpenCode starts in the Project's read-only folder and receives the Project tools only from this app. Project Revert covers Project changes only.</p>
						</div>
					</div>
				</details>
			</div>
		</aside>
	);
}

type TranscriptGroup =
	| { kind: "trace"; items: TranscriptToolItem[] }
	| { kind: "single"; item: TranscriptDisplayItem };

function groupTranscriptItems(items: TranscriptDisplayItem[]): TranscriptGroup[] {
	const groups: TranscriptGroup[] = [];
	let currentTrace: TranscriptToolItem[] = [];

	const flush = () => {
		if (currentTrace.length > 0) {
			groups.push({ kind: "trace", items: currentTrace });
			currentTrace = [];
		}
	};

	for (const item of items) {
		if (item.kind === "tool") {
			currentTrace.push(item);
		} else {
			flush();
			groups.push({ kind: "single", item });
		}
	}
	flush();
	return groups;
}

function ToolTraceRow({
	item,
	onSelectTable,
	onSelectCodeSource,
}: {
	item: TranscriptToolItem;
	onSelectTable: (tableId: string) => void;
	onSelectCodeSource: (kind: "scenario" | "edge-function" | "function-body", id: string) => void;
}) {
	const isRunning = item.status === "running";
	const [open, setOpen] = useState<boolean>();

	const toolIcon = (() => {
		switch (item.trace.icon) {
			case "read":
				return <BookOpen className="size-3.5" />;
			case "ddl":
				return <Database className="size-3.5" />;
			case "code":
				return <FileCode2 className="size-3.5" />;
			case "run":
				return <Play className="size-3.5" />;
			default:
				return <Wrench className="size-3.5" />;
		}
	})();

	const ddlSql = typeof item.args?.sql === "string" ? item.args.sql : null;
	const sandbox = item.details?.sandbox;
	const sandboxRejection = sandbox && typeof sandbox === "object" && "rejected" in sandbox && typeof sandbox.rejected === "string"
		? sandbox.rejected
		: null;
	const rejectionReason = typeof item.details?.message === "string" ? item.details.message : sandboxRejection;
	const codeDiff = item.codeDiff;
	const scenarioRuns = item.scenarioRuns;
	const affectedTables = item.affectedTables;

	const hasSpecificDetail = Boolean(ddlSql || rejectionReason || codeDiff || scenarioRuns.length > 0 || affectedTables.length > 0);

	return (
		<TraceCollapsible open={open ?? isRunning} onOpenChange={setOpen}>
			<TraceCollapsibleTrigger>
				<TraceLine status={item.trace.status}>
					<TraceIcon>{toolIcon}</TraceIcon>
					<TraceTitle>{item.trace.title}</TraceTitle>
					{item.trace.description && (
						<TraceDescription>{item.trace.description}</TraceDescription>
					)}
				</TraceLine>
			</TraceCollapsibleTrigger>
			<TraceCollapsibleContent>
				{ddlSql && (
					<pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-ink-3">{ddlSql}</pre>
				)}
				{rejectionReason && (
					<pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-proof-red">{rejectionReason}</pre>
				)}
				{affectedTables.length > 0 && (
					<div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px]">
						<span>Affected tables:</span>
						{affectedTables.map((table) =>
							table.change === "removed" || table.removed ? (
								<span key={table.id} className="text-ink-3">removed {table.name}</span>
							) : (
								<button key={table.id} type="button" onClick={() => onSelectTable(table.id)} className="underline underline-offset-2">
									{table.name}
								</button>
							)
						)}
					</div>
				)}
				{codeDiff && (
					<div className="mt-2 rounded-sm border border-ink/15 p-2">
						<button type="button" onClick={() => onSelectCodeSource(codeDiff.kind, codeDiff.id)} className="font-medium underline underline-offset-2">
							Open {codeDiff.name}
						</button>
						<details className="mt-1" open>
							<summary className="cursor-pointer text-[11px]">Code diff</summary>
							<pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-proof-red">− {codeDiff.before}</pre>
							<pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-ink">+ {codeDiff.after}</pre>
							{Array.isArray(codeDiff.diagnostics) && (
								<div className="mt-2 border-t border-ink/10 pt-2 text-[11px]">
									<p className="font-medium">TypeScript diagnostics</p>
									{codeDiff.diagnostics.length ? (
										<ul className="list-inside list-disc">
											{codeDiff.diagnostics.map((diagnostic, index) => <li key={index}>{String(diagnostic)}</li>)}
										</ul>
									) : (
										<p>None</p>
									)}
								</div>
							)}
							{codeDiff.diagnosticsNote && (
								<p className="mt-2 border-t border-ink/10 pt-2 text-ink-3 text-[11px]">{codeDiff.diagnosticsNote}</p>
							)}
						</details>
					</div>
				)}
				{scenarioRuns.map((run) => (
					<div key={run.runId ?? run.scenarioId} className="mt-1.5 flex items-center justify-between gap-2 rounded-sm border border-ink/15 px-2 py-1 text-[11px]">
						<span>{run.scenario}: {run.status}</span>
						<button type="button" onClick={() => onSelectCodeSource("scenario", run.scenarioId)} className="underline underline-offset-2">
							Open Scenario
						</button>
					</div>
				))}
				{!hasSpecificDetail && (
					<pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-ink-3">{item.rawContent}</pre>
				)}
			</TraceCollapsibleContent>
		</TraceCollapsible>
	);
}

function DropConfirmationCard({
	confirmation,
	toolCallId,
	pending,
	onConfirmDrop,
	onRejectDrop,
}: {
	confirmation: Record<string, unknown>;
	toolCallId: string;
	pending: boolean;
	onConfirmDrop: (toolCallId: string) => void;
	onRejectDrop: (toolCallId: string) => void;
}) {
	const removal = confirmation.removal && typeof confirmation.removal === "object" ? confirmation.removal as Record<string, unknown> : null;
	const affectedRelationships = Array.isArray(removal?.relationships) ? removal.relationships as Array<Record<string, unknown>> : [];
	const state = confirmation.confirmationState;

	return (
		<div className="mt-2 rounded-sm border border-proof-red/30 p-2 text-xs">
			<p className="font-medium">
				Destructive change {state === "pending" ? "needs confirmation" : state === "confirmed" ? "Confirmed" : state === "rejected" ? "Rejected" : "No longer pending"}
			</p>
			{confirmation.planUpdated === true && (
				<p className="mt-1 text-ink-3">{typeof confirmation.note === "string" ? confirmation.note : "The plan changed. Review the updated plan before confirming."}</p>
			)}
			{affectedRelationships.length > 0 && (
				<div className="mt-1 text-ink-3">
					<p>This removes {affectedRelationships.length} {affectedRelationships.length === 1 ? "relationship" : "relationships"}:</p>
					<ul className="list-inside list-disc">
						{affectedRelationships.map((relationship, index) => (
							<li key={typeof relationship.relationshipId === "string" ? relationship.relationshipId : index}>
								{String(relationship.referencingTable ?? "?")}.{String(relationship.referencingColumn ?? "?")} → {String(relationship.referencedTable ?? "?")}.{String(relationship.referencedColumn ?? "?")} ({String(relationship.cardinality ?? "relationship")}; {Array.isArray(relationship.constraints) ? relationship.constraints.join(", ") : "constraints unspecified"})
								{typeof relationship.junctionTable === "string" ? `; junction table ${relationship.junctionTable}` : ""}
							</li>
						))}
					</ul>
				</div>
			)}
			{state === "pending" && (
				<div className="mt-2 flex gap-2">
					<button disabled={!toolCallId || pending} onClick={() => onConfirmDrop(toolCallId)} className="rounded-sm border border-proof-red/40 px-2 py-1 text-xs disabled:opacity-40">Confirm drop</button>
					<button disabled={!toolCallId || pending} onClick={() => onRejectDrop(toolCallId)} className="rounded-sm border border-ink/25 px-2 py-1 text-xs disabled:opacity-40">Reject</button>
				</div>
			)}
		</div>
	);
}

function TranscriptView({
	messages,
	confirmationRequired,
	pending,
	onConfirmDrop,
	onRejectDrop,
	onSelectTable,
	onSelectCodeSource,
}: {
	messages: AssistantMessage[];
	confirmationRequired: boolean;
	pending: boolean;
	onConfirmDrop: (toolCallId: string) => void;
	onRejectDrop: (toolCallId: string) => void;
	onSelectTable: (tableId: string) => void;
	onSelectCodeSource: (kind: "scenario" | "edge-function" | "function-body", id: string) => void;
}) {
	const items = buildTranscript(messages, confirmationRequired);
	const groups = groupTranscriptItems(items);

	return (
		<>
			{groups.map((group, groupIndex) => {
				if (group.kind === "trace") {
					return (
						<div key={`trace-${groupIndex}`} className="space-y-2">
							<Trace>
								{group.items.map((toolItem) => (
									<ToolTraceRow
										key={toolItem.toolCallId || `${groupIndex}-${toolItem.toolName}`}
										item={toolItem}
										onSelectTable={onSelectTable}
										onSelectCodeSource={onSelectCodeSource}
									/>
								))}
							</Trace>
							{group.items.map((toolItem) =>
								toolItem.confirmation ? (
									<DropConfirmationCard
										key={`confirm-${toolItem.toolCallId}`}
										confirmation={toolItem.confirmation}
										toolCallId={toolItem.toolCallId}
										pending={pending}
										onConfirmDrop={onConfirmDrop}
										onRejectDrop={onRejectDrop}
									/>
								) : null
							)}
						</div>
					);
				}

				const item = group.item;
				if (item.kind === "compaction") {
					return (
						<div key={`compaction-${groupIndex}`} role="status" aria-label="Compaction announcement" className="my-2 rounded border border-ink/15 bg-ink/5 px-2.5 py-1.5 text-xs text-ink-2">
							<span className="font-medium">Context compaction:</span> {item.text}
						</div>
					);
				}

				if (item.kind === "user") {
					return (
						<article key={`user-${groupIndex}`} className="text-sm leading-relaxed">
							<p className="mb-1 text-[10px] uppercase tracking-wide text-ink-3">You</p>
							<p className="whitespace-pre-wrap">{item.text}</p>
						</article>
					);
				}

				if (item.kind === "assistant") {
					return (
						<article key={`assistant-${groupIndex}`} className="text-sm leading-relaxed">
							<p className="mb-1 text-[10px] uppercase tracking-wide text-ink-3">Assistant</p>
							<p className="whitespace-pre-wrap">{item.text}</p>
							{item.error && (
								<p role="alert" className="mt-1 whitespace-pre-wrap rounded border border-proof-red/40 bg-proof-red/10 p-2 text-xs text-proof-red">
									{item.error}
								</p>
							)}
							{item.usage && (
								<div aria-label="Turn usage" className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
									<span>{item.usage.input.toLocaleString()} in</span>
									<span>·</span>
									<span>{item.usage.output.toLocaleString()} out</span>
									<span>·</span>
									<span>{item.usage.cacheRead.toLocaleString()} cached</span>
									{typeof item.usage.cost?.total === "number" && item.usage.cost.total > 0 && (
										<span>· ${item.usage.cost.total < 0.01 ? item.usage.cost.total.toFixed(4) : item.usage.cost.total.toFixed(2)}</span>
									)}
								</div>
							)}
							{item.isStreaming && !item.usage && (
								<div aria-label="Turn usage" className="mt-1.5 text-[11px] text-ink-4">
									…
								</div>
							)}
						</article>
					);
				}

				return null;
			})}
		</>
	);
}
const THINKING_LABELS: Record<AssistantThinkingLevel, string> = {
	off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra",
};
function isHarnessConnection(id: string | null | undefined): boolean {
	return id === "codex-harness" || id === "opencode-harness";
}
function isThinkingLevel(value: string): value is AssistantThinkingLevel {
	return value in THINKING_LABELS;
}
