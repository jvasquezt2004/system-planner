import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, MessageSquare, MoreHorizontal, Plus, Send, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import type {
	AssistantConnectionStatus,
	AssistantConversation,
	AssistantConversationRecord,
	AssistantMessage,
	AssistantModel,
	AssistantThinkingLevel,
	AssistantTotalUsage,
	AssistantTurnUsage,
} from "../shared/assistant";
import { workspaceClient } from "./workspace-client";
import { assistantText, foldAssistantEvent } from "./assistant-transcript";

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
	| "setAssistantApiKey"
	| "removeAssistantConnection"
	| "startAssistantOAuthLogin"
	| "answerAssistantOAuthPrompt"
	| "cancelAssistantOAuthLogin"
	| "getClaudeOptIn"
	| "setClaudeOptIn"
	| "sendAssistantMessage"
	| "stopAssistantTurn"
	| "continueAssistantTurn"
	| "getAssistantTurnStatus"
	| "updateAssistantConversationSelection"
	| "confirmAssistantDdlDrop"
	| "rejectAssistantDdlDrop"
	| "revertAssistantTurn"
	| "subscribeAssistantEvents"
	| "subscribeAssistantOAuthEvents"
	| "getAssistantRequestCap"
	| "setAssistantRequestCap"
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
	onSelectTable: (tableId: string) => void;
	onSelectCodeSource: (kind: "scenario" | "edge-function" | "function-body", id: string) => void;
}) {
	const [conversations, setConversations] = useState<AssistantConversation[]>([]);
	const [activeId, setActiveId] = useState("");
	const [messages, setMessages] = useState<AssistantMessage[]>([]);
	const [models, setModels] = useState<AssistantModel[]>([]);
	const [connections, setConnections] = useState<AssistantConnectionStatus[]>([]);
	const [selectedConnectionId, setSelectedConnectionId] = useState("");
	const [claudeOptIn, setClaudeOptIn] = useState(false);
	const [deviceCode, setDeviceCode] = useState<{ providerId: string; userCode: string; verificationUri: string } | null>(null);
	const [oAuthProgress, setOAuthProgress] = useState<{ providerId: string; message: string } | null>(null);
	const [oAuthPrompt, setOAuthPrompt] = useState<{ providerId: string; promptId: string; message: string; placeholder?: string; secret: boolean } | null>(null);
	const [oAuthAnswer, setOAuthAnswer] = useState("");
	const [cacheWarning, setCacheWarning] = useState<string | null>(null);
	const [requestCap, setRequestCap] = useState(40);
	const [apiKeys, setApiKeys] = useState<Record<string, string>>({ anthropic: "", openai: "", google: "" });
	const [model, setModel] = useState("");
	const [thinking, setThinking] = useState<AssistantThinkingLevel>("medium");
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [pending, setPending] = useState(false);
	const [turnPaused, setTurnPaused] = useState(false);
	const [confirmationRequired, setConfirmationRequired] = useState(false);
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
		setConversations([]);
		setMessages([]);
		setActiveId("");
		setTurnPaused(false);
		setConfirmationRequired(false);
		Promise.all([
			api.listAssistantConversations(projectId),
			api.listAssistantModels(),
			api.listAssistantConnections(),
			api.getClaudeOptIn(),
			api.getAssistantRequestCap(),
		])
			.then(([items, available, connectionList, optIn, cap]) => {
				if (!live) return;
				const recent = [...items].sort((a, b) => b.updated_at - a.updated_at);
				setConversations(recent);
				setConnections(connectionList);
				setClaudeOptIn(optIn);
				setRequestCap(cap);
				if (available[0]) {
					setModel(available[0].id);
					setSelectedConnectionId(available[0].connectionId);
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
					if (conversation.connection_id) setSelectedConnectionId(conversation.connection_id);
					if (conversation.model) {
						setModel(conversation.model);
						initialConversationModelRef.current = `${conversation.connection_id ?? ""}:${conversation.model}`;
					}
					if (conversation.thinking && isThinkingLevel(conversation.thinking)) setThinking(conversation.thinking);
					setCacheWarning(null);
				}
			})
			.catch((cause: unknown) => {
				if (live) setError(String(cause));
			});
		api.getAssistantTurnStatus(activeId).then(({ paused, confirmationRequired: requiresConfirmation }) => {
			if (live) {
				setTurnPaused(paused);
				setConfirmationRequired(requiresConfirmation);
			}
		}).catch((cause: unknown) => { if (live) setError(String(cause)); });
		return () => {
			live = false;
		};
	}, [activeId, api]);

	useEffect(() => {
		if (!activeId) return;
		return api.subscribeAssistantEvents((envelope: StreamEnvelope) => {
			if (envelope.conversationId !== activeId) return;
			if (envelope.event && typeof envelope.event === "object" && "type" in envelope.event) {
				if (envelope.event.type === "assistant_turn_paused") setTurnPaused(true);
				if (envelope.event.type === "assistant_confirmation_required") {
					setTurnPaused(true);
					setConfirmationRequired(true);
				}
				if (envelope.event.type === "assistant_confirmation_resolved") {
					setTurnPaused(false);
					setConfirmationRequired(false);
				}
				if (envelope.event.type === "assistant_turn_usage") {
					const usageEvent = envelope.event as unknown as { usage: AssistantTurnUsage };
					if (usageEvent.usage) setTurnUsages((current) => [...current, usageEvent.usage]);
				}
			}
			setMessages((current) => foldAssistantEvent(current, envelope.event));
		});
	}, [activeId, api]);
	useEffect(() => {
		return api.subscribeAssistantOAuthEvents(({ providerId, event }) => {
			if (!event || typeof event !== "object") return;
			const record = event as {
				type?: string;
				userCode?: string;
				verificationUri?: string;
				message?: string;
				promptId?: string;
				promptType?: string;
				placeholder?: string;
				success?: boolean;
				error?: string;
			};
			if (record.type === "device_code" && record.userCode && record.verificationUri) {
				setDeviceCode({ providerId, userCode: record.userCode, verificationUri: record.verificationUri });
			} else if (record.type === "progress" && record.message) {
				setOAuthProgress({ providerId, message: record.message });
			} else if (record.type === "prompt" && record.promptId) {
				setOAuthAnswer("");
				setOAuthPrompt({
					providerId,
					promptId: record.promptId,
					message: record.message ?? "Complete sign-in in your browser.",
					placeholder: record.placeholder,
					secret: record.promptType === "secret",
				});
			} else if (record.type === "prompt_closed" && record.promptId) {
				setOAuthPrompt((current) => (current?.promptId === record.promptId ? null : current));
			} else if (record.type === "login_finished") {
				setOAuthProgress(null);
				setDeviceCode(null);
				setOAuthPrompt(null);
				if (record.success === false && record.error) setError(record.error);
				void reloadConnections();
			}
		});
	}, [api]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages]);

	async function createConversation() {
		setError("");
		try {
			const conversation = await api.createAssistantConversation(projectId);
			if (conversation.connection_id) setSelectedConnectionId(conversation.connection_id);
			if (conversation.model) {
				setModel(conversation.model);
				initialConversationModelRef.current = `${conversation.connection_id ?? ""}:${conversation.model}`;
			}
			if (conversation.thinking && isThinkingLevel(conversation.thinking)) setThinking(conversation.thinking);
			setCacheWarning(null);
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
	function persistSelection(nextConnectionId: string | null, nextModel: string, nextThinking: AssistantThinkingLevel) {
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

	async function saveApiKey(providerId: string) {
		const apiKey = apiKeys[providerId]?.trim();
		if (!apiKey) return;
		try {
			await api.setAssistantApiKey(providerId, apiKey);
			setApiKeys((current) => ({ ...current, [providerId]: "" }));
			setError("");
			await reloadConnections();
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function removeConnection(connectionId: string) {
		try {
			await api.removeAssistantConnection(connectionId);
			setError("");
			await reloadConnections();
		} catch (cause) {
			setError(String(cause));
		}
	}

	async function startOAuthLogin(providerId: string) {
		setError("");
		setOAuthProgress({ providerId, message: "Complete sign-in in your browser…" });
		try {
			// The outcome arrives as a "login_finished" sign-in event.
			await api.startAssistantOAuthLogin(providerId);
		} catch (cause) {
			setError(String(cause));
			setOAuthProgress(null);
			setDeviceCode(null);
		}
	}

	async function submitOAuthAnswer() {
		if (!oAuthPrompt || !oAuthAnswer.trim()) return;
		const { promptId } = oAuthPrompt;
		setOAuthPrompt(null);
		await api.answerAssistantOAuthPrompt(promptId, oAuthAnswer.trim());
		setOAuthAnswer("");
	}

	async function toggleClaudeOptIn(enabled: boolean) {
		try {
			await api.setClaudeOptIn(enabled);
			setClaudeOptIn(enabled);
			await reloadConnections();
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
			const saved = await api.continueAssistantTurn(activeId) as AssistantConversationRecord | null;
			if (contextRef.current.generation === requestContext.generation && saved) {
				setMessages(saved.messages);
				setTurnUsages(saved.usages ?? []);
				setTotalUsage(saved.totalUsage ?? null);
			}
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) setError(String(cause));
		} finally {
			if (contextRef.current.generation === requestContext.generation) {
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
			const saved = await api.confirmAssistantDdlDrop(activeId, toolCallId);
			if (contextRef.current.generation === requestContext.generation && saved) setMessages(saved.messages);
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) setError(String(cause));
		} finally {
			if (contextRef.current.generation === requestContext.generation) {
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
			const saved = await api.rejectAssistantDdlDrop(activeId, toolCallId);
			if (contextRef.current.generation === requestContext.generation && saved) setMessages(saved.messages);
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) setError(String(cause));
		} finally {
			if (contextRef.current.generation === requestContext.generation) {
				setPending(false);
				const status = await api.getAssistantTurnStatus(activeId);
				if (contextRef.current.generation === requestContext.generation) {
					setTurnPaused(status.paused);
					setConfirmationRequired(status.confirmationRequired);
				}
			}
		}
	}
	async function sendMessage() {
		const message = text.trim();
		if (!message || !activeId || !model || confirmationRequired) return;
		const requestContext = contextRef.current;
		const steering = pending;
		setText("");
		setMessages((current) => [...current, { role: "user", payload: message }]);
		setPending(true);
		setError("");
		try {
			const saved = await api.sendAssistantMessage(activeId, message, model, thinking, selectedConnectionId || undefined) as AssistantConversationRecord | null;
			if (contextRef.current.generation !== requestContext.generation) return;
			if (saved) {
				setMessages(saved.messages);
				setTurnUsages(saved.usages ?? []);
				setTotalUsage(saved.totalUsage ?? null);
				setConversations((current) => current.map((item) => item.id === saved.id ? saved : item).sort((a, b) => b.updated_at - a.updated_at));
			}
			if (contextRef.current.generation === requestContext.generation) {
				const status = await api.getAssistantTurnStatus(activeId);
				setRevertAvailable(status.revertAvailable);
			}
		} catch (cause) {
			if (contextRef.current.generation === requestContext.generation) setError(String(cause));
		} finally {
			if (contextRef.current.generation === requestContext.generation && !steering) setPending(false);
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
			{(() => {
				const effectiveTotal = totalUsage ?? {
					inputTokens: turnUsages.reduce((sum, u) => sum + (u.inputTokens || 0), 0),
					outputTokens: turnUsages.reduce((sum, u) => sum + (u.outputTokens || 0), 0),
					cacheReadTokens: turnUsages.reduce((sum, u) => sum + (u.cacheReadTokens || 0), 0),
					cost: turnUsages.reduce((sum, u) => sum + (typeof u.cost === "number" ? u.cost : 0), 0),
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
				) : displayAssistantMessages(messages).map((message, index) => (
					<MessageCard key={`${index}-${message.role}`} message={message} pending={pending} onConfirmDrop={confirmDrop} onRejectDrop={rejectDrop} onSelectTable={onSelectTable} onSelectCodeSource={onSelectCodeSource} />
				))}
			</div>
			{error && <div role="alert" className="px-3 py-2 text-xs text-proof-red">{error}</div>}
			<div className="shrink-0 border-t border-ink/15 p-3">
				{cacheWarning && (
					<div role="status" className="mb-2 rounded border border-ink/20 bg-ink/5 p-2 text-xs text-ink-2">
						{cacheWarning}
					</div>
				)}
				{deviceCode && (
					<div className="mb-2 rounded border border-ink/25 bg-surface p-2 text-xs">
						<p className="font-semibold">Sign in with device code</p>
						<p className="mt-1">Code: <strong className="font-mono text-sm tracking-wider">{deviceCode.userCode}</strong></p>
						<p className="mt-1 text-ink-3">
							Verification URL:{" "}
							<a href={deviceCode.verificationUri} target="_blank" rel="noreferrer" className="underline underline-offset-2">
								{deviceCode.verificationUri}
							</a>
						</p>
					</div>
				)}
				{oAuthProgress && (
					<div className="mb-2 flex items-center justify-between gap-2 rounded border border-ink/20 p-2 text-xs text-ink-2">
						<span className="min-w-0 flex-1">{oAuthProgress.message}</span>
						<button
							onClick={() => void api.cancelAssistantOAuthLogin(oAuthProgress.providerId)}
							className="shrink-0 rounded border border-ink/30 bg-paper px-2 py-1 text-xs font-medium text-ink"
						>
							Cancel
						</button>
					</div>
				)}
				{oAuthPrompt && (
					<form
						className="mb-2 rounded border border-ink/20 p-2 text-xs text-ink-2"
						onSubmit={(event) => {
							event.preventDefault();
							void submitOAuthAnswer();
						}}
					>
						<label htmlFor="assistant-oauth-answer" className="block">{oAuthPrompt.message}</label>
						<div className="mt-1 flex gap-2">
							<Input
								id="assistant-oauth-answer"
								aria-label="Sign-in answer"
								type={oAuthPrompt.secret ? "password" : "text"}
								value={oAuthAnswer}
								placeholder={oAuthPrompt.placeholder}
								onChange={(event: ChangeEvent<HTMLInputElement>) => setOAuthAnswer(event.target.value)}
								className="h-8 min-w-0 flex-1 text-xs"
							/>
							<button type="submit" className="shrink-0 rounded border border-ink/30 bg-paper px-2 py-1 text-xs font-medium text-ink">
								Submit
							</button>
						</div>
					</form>
				)}
				{isConnectionRemoved && (
					<div role="alert" className="mb-2 rounded border border-ink/20 bg-ink/5 p-2 text-xs">
						The provider connection for this conversation was removed. Please select a connection and model to continue.
					</div>
				)}
				{selectedConnection?.error && (
					<div role="alert" className="mb-2 flex items-center justify-between gap-2 rounded border border-proof-red/40 bg-proof-red/10 p-2 text-xs text-proof-red">
						<span className="min-w-0 flex-1">{selectedConnection.name}: {selectedConnection.error}</span>
						{selectedConnection.authMethod === "oauth" ? (
							<button
								onClick={() => void startOAuthLogin(selectedConnection.providerId)}
								className="shrink-0 rounded border border-proof-red/50 bg-paper px-2 py-1 text-xs font-medium text-ink"
							>
								Re-sign in
							</button>
						) : (
							<button
								onClick={() => setExpandedSettings(true)}
								className="shrink-0 rounded border border-proof-red/50 bg-paper px-2 py-1 text-xs font-medium text-ink"
							>
								Update key
							</button>
						)}
					</div>
				)}
				<div className="mb-2 flex gap-2">
					<select
						aria-label="Model"
						value={`${selectedConnectionId}::${model}`}
						onChange={(event: ChangeEvent<HTMLSelectElement>) => {
							const [connId, modelId] = event.target.value.split("::");
							persistSelection(connId ?? null, modelId ?? "", thinking);
						}}
						className="min-w-0 flex-1 bg-transparent text-xs"
					>
						{pickerGroups.map((group) => (
							<optgroup
								key={group.id}
								label={group.error ? `${group.name} (${group.error})` : group.name}
							>
								{group.models.map((item) => (
									<option key={`${group.id}::${item.id}`} value={`${group.id}::${item.id}`}>
										{item.name}
									</option>
								))}
							</optgroup>
						))}
					</select>
					<select aria-label="Thinking level" value={thinking} onChange={(event: ChangeEvent<HTMLSelectElement>) => persistSelection(selectedConnectionId, model, event.target.value as AssistantThinkingLevel)} className="bg-transparent text-xs">
						<option value="off">Off</option><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option><option value="max">Max</option>
					</select>
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
						<button aria-label={pending ? "Steer assistant" : "Send message"} disabled={!activeId || !text.trim() || !model || isConnectionRemoved} onClick={() => void sendMessage()} className="rounded-sm bg-ink px-2.5 py-2 text-paper disabled:opacity-40">
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
						Provider connections · {connections.filter((c) => c.connected).length} connected
					</summary>
					<div className="mt-2 space-y-3">
						<label className="flex items-center justify-between gap-2 text-xs">
							<span>Model requests per Assistant turn</span>
							<input
								aria-label="Model requests per Assistant turn"
								type="number"
								min={1}
								max={500}
								value={requestCap}
								onChange={(event) => {
									const cap = Number(event.target.value);
									setRequestCap(cap);
									if (Number.isInteger(cap) && cap >= 1 && cap <= 500) {
										void api.setAssistantRequestCap(cap).catch((cause: unknown) => setError(String(cause)));
									}
								}}
								className="w-16 rounded border border-ink/20 bg-transparent px-1 py-0.5"
							/>
						</label>
						{/* Anthropic / Claude connection */}
						<div className="rounded border border-ink/10 p-2 text-xs">
							<div className="flex items-center justify-between font-medium">
								<span>Anthropic / Claude</span>
								<span className="text-[11px] text-ink-3">
									{connections.find((c) => c.providerId === "anthropic")?.connected ? "Connected" : "Not connected"}
								</span>
							</div>
							{connections.find((c) => c.providerId === "anthropic")?.error && (
								<p role="alert" className="mt-1 text-[11px] text-proof-red">
									{connections.find((c) => c.providerId === "anthropic")?.error}
								</p>
							)}
							<div className="mt-2 border-t border-ink/10 pt-2">
								<label className="flex items-start gap-2 text-xs">
									<input
										type="checkbox"
										checked={claudeOptIn}
										onChange={(event) => void toggleClaudeOptIn(event.target.checked)}
										className="mt-0.5"
									/>
									<div>
										<span className="font-medium">Enable Claude account sign-in (Pro/Max)</span>
										<p className="mt-0.5 text-[10px] text-ink-3">
											Anthropic's consumer terms restrict using a Pro/Max sign-in in third-party apps. Use at your own risk.
										</p>
									</div>
								</label>
								{claudeOptIn && (
									<div className="mt-2 flex gap-2">
										<button
											onClick={() => void startOAuthLogin("anthropic")}
											className="rounded border border-ink/20 px-2 py-1 text-xs hover:bg-ink/5"
										>
											{connections.find((c) => c.providerId === "anthropic" && c.authMethod === "oauth")?.error ? "Re-sign in with Claude" : "Sign in with Claude"}
										</button>
									</div>
								)}
							</div>
							<div className="mt-2 border-t border-ink/10 pt-2">
								<div className="flex gap-2">
									<Input
										type="password"
										value={apiKeys.anthropic ?? ""}
										onChange={(event: ChangeEvent<HTMLInputElement>) => setApiKeys((cur) => ({ ...cur, anthropic: event.target.value }))}
										placeholder="Paste Anthropic API key"
										autoComplete="off"
									/>
									<button
										onClick={() => void saveApiKey("anthropic")}
										disabled={!apiKeys.anthropic}
										className="rounded border border-ink/20 px-2 text-xs disabled:opacity-40"
									>
										Save
									</button>
								</div>
							</div>
							{connections.find((c) => c.providerId === "anthropic")?.connected && (
								<button onClick={() => void removeConnection("anthropic")} className="mt-2 rounded border border-ink/20 px-2 py-1 text-xs">
									Remove connection
								</button>
							)}
						</div>

						{/* OpenAI / ChatGPT connection */}
						<div className="rounded border border-ink/10 p-2 text-xs">
							<div className="flex items-center justify-between font-medium">
								<span>OpenAI / ChatGPT</span>
								<span className="text-[11px] text-ink-3">
									{connections.find((c) => c.providerId === "openai")?.connected ? "Connected" : "Not connected"}
								</span>
							</div>
							{connections.find((c) => c.providerId === "openai")?.error && (
								<p role="alert" className="mt-1 text-[11px] text-proof-red">
									{connections.find((c) => c.providerId === "openai")?.error}
								</p>
							)}
							<div className="mt-2 flex gap-2">
								<button
									onClick={() => void startOAuthLogin("openai")}
									className="rounded border border-ink/20 px-2 py-1 text-xs hover:bg-ink/5"
								>
									{connections.find((c) => c.providerId === "openai" && c.authMethod === "oauth")?.error ? "Re-sign in with ChatGPT" : "Sign in with ChatGPT"}
								</button>
							</div>
							<div className="mt-2 border-t border-ink/10 pt-2 flex gap-2">
								<Input
									type="password"
									value={apiKeys.openai ?? ""}
									onChange={(event: ChangeEvent<HTMLInputElement>) => setApiKeys((cur) => ({ ...cur, openai: event.target.value }))}
									placeholder="Paste OpenAI API key"
									autoComplete="off"
								/>
								<button
									onClick={() => void saveApiKey("openai")}
									disabled={!apiKeys.openai}
									className="rounded border border-ink/20 px-2 text-xs disabled:opacity-40"
								>
									Save
								</button>
							</div>
							{connections.find((c) => c.providerId === "openai")?.connected && (
								<button onClick={() => void removeConnection("openai")} className="mt-2 rounded border border-ink/20 px-2 py-1 text-xs">
									Remove connection
								</button>
							)}
						</div>

						{/* Google Gemini connection */}
						<div className="rounded border border-ink/10 p-2 text-xs">
							<div className="flex items-center justify-between font-medium">
								<span>Google Gemini</span>
								<span className="text-[11px] text-ink-3">
									{connections.find((c) => c.providerId === "google")?.connected ? "Connected" : "Not connected"}
								</span>
							</div>
							{connections.find((c) => c.providerId === "google")?.error && (
								<p role="alert" className="mt-1 text-[11px] text-proof-red">
									{connections.find((c) => c.providerId === "google")?.error}
								</p>
							)}
							<div className="mt-2 flex gap-2">
								<Input
									type="password"
									value={apiKeys.google ?? ""}
									onChange={(event: ChangeEvent<HTMLInputElement>) => setApiKeys((cur) => ({ ...cur, google: event.target.value }))}
									placeholder="Paste Google Gemini API key"
									autoComplete="off"
								/>
								<button
									onClick={() => void saveApiKey("google")}
									disabled={!apiKeys.google}
									className="rounded border border-ink/20 px-2 text-xs disabled:opacity-40"
								>
									Save
								</button>
							</div>
							{connections.find((c) => c.providerId === "google")?.connected && (
								<button onClick={() => void removeConnection("google")} className="mt-2 rounded border border-ink/20 px-2 py-1 text-xs">
									Remove connection
								</button>
							)}
							<p className="mt-1.5 text-[10px] text-ink-3">Google account sign-in is not offered. Gemini connections require an API key.</p>
						</div>
					</div>
					<p className="mt-2 text-[10px] text-ink-3">Stored in the operating-system credential service, never in conversation content or SQLite.</p>
				</details>
			</div>
		</aside>
	);
}

function displayAssistantMessages(messages: AssistantMessage[]): AssistantMessage[] {
	const updates = new Map<string, Record<string, unknown>>();
	const resolutions = new Set<string>();
	for (const message of messages) {
		if (message.kind !== "assistant-drop-confirmation" || !message.payload || typeof message.payload !== "object") continue;
		const payload = message.payload as Record<string, unknown>;
		if (typeof payload.toolCallId !== "string") continue;
		if (payload.status === "updated" && payload.details && typeof payload.details === "object") updates.set(payload.toolCallId, payload.details as Record<string, unknown>);
		if (payload.status === "consumed" || payload.status === "rejected") resolutions.add(payload.toolCallId);
	}
	return messages.map((message) => {
		if (message.role !== "toolResult" || !message.payload || typeof message.payload !== "object") return message;
		const payload = message.payload as Record<string, unknown>;
		if (typeof payload.toolCallId !== "string" || !payload.details || typeof payload.details !== "object") return message;
		const details = payload.details as Record<string, unknown>;
		if (resolutions.has(payload.toolCallId)) return { ...message, payload: { ...payload, details: { ...details, status: "resolved" } } };
		const updated = updates.get(payload.toolCallId);
		return updated ? { ...message, payload: { ...payload, details: { ...updated, planUpdated: true, note: "The plan changed. Review the updated plan before confirming." } } } : message;
	});
}
function MessageCard({
	message,
	onConfirmDrop,
	onRejectDrop,
	pending,
	onSelectTable,
	onSelectCodeSource,
}: {
	message: AssistantMessage;
	onConfirmDrop: (toolCallId: string) => void;
	onRejectDrop: (toolCallId: string) => void;
	pending: boolean;
	onSelectTable: (tableId: string) => void;
	onSelectCodeSource: (kind: "scenario" | "edge-function" | "function-body", id: string) => void;
}) {
	if (message.kind === "assistant-compaction") {
		const payload = message.payload as { text?: string } | null;
		return (
			<div role="status" aria-label="Compaction announcement" className="my-2 rounded border border-ink/15 bg-ink/5 px-2.5 py-1.5 text-xs text-ink-2">
				<span className="font-medium">Context compaction:</span> {payload?.text ?? "Older turns summarised to preserve context space."}
			</div>
		);
	}
	if (message.kind === "assistant-context" || message.kind === "assistant-change-note" || message.kind === "assistant-continue" || message.kind === "assistant-drop-confirmation") return null;
	const payload = message.payload;
	if (message.kind === "live-assistant" && !assistantText(payload).trim()) return null;
	const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
	const usage = record && "usage" in record && record.usage && typeof record.usage === "object"
		? record.usage as { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } }
		: null;
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
	const codeDiff = details
		&& typeof details.before === "string"
		&& typeof details.after === "string"
		&& typeof details.kind === "string"
		&& typeof details.id === "string"
		&& typeof details.name === "string"
		? { before: details.before, after: details.after, kind: details.kind as "scenario" | "edge-function" | "function-body", id: details.id, name: details.name }
		: null;
	const scenarioRuns = Array.isArray(details?.runs)
		? details.runs.filter((run): run is { scenarioId: string; scenario: string; status: string; runId?: string } =>
			Boolean(run && typeof run === "object" && "scenarioId" in run && typeof run.scenarioId === "string"
				&& "scenario" in run && typeof run.scenario === "string" && "status" in run && typeof run.status === "string"
				&& (!("runId" in run) || typeof run.runId === "string")),
		)
		: [];
	const isTool = message.role === "toolResult" || message.kind === "tool-result" || message.kind === "live-tool" || Boolean(toolCall);
	const summary = isTool ? "Tool call and result" : message.role === "user" ? "You" : "Assistant";
	const content = record && "content" in record ? record.content : payload;
	const printable = message.kind === "live-tool"
		? `${String(record?.toolName ?? "Tool")}${record?.args === undefined ? "" : `\n${JSON.stringify(record.args, null, 2)}`}`
		: typeof content === "string" ? content : JSON.stringify(content, null, 2);
	const body = isTool ? (
		<div className="border-y border-ink/10 py-2 text-xs">
			<details>
				<summary className="cursor-pointer font-medium">{summary}</summary>
				<pre className="mt-2 whitespace-pre-wrap break-words text-ink-3">{printable}</pre>
			{message.kind === "live-tool" && record?.status === "running" && <span className="mt-1 block text-ink-3">Running…</span>}
			</details>
			{scenarioRuns.map((run) => (
				<div key={run.runId ?? run.scenarioId} className="mt-2 flex items-center justify-between gap-2 rounded-sm border border-ink/15 px-2 py-1.5">
					<span>{run.scenario}: {run.status}</span>
					<button type="button" onClick={() => onSelectCodeSource("scenario", run.scenarioId)} className="underline underline-offset-2">
						Open Scenario
					</button>
				</div>
			))}
			{codeDiff && (
				<div className="mt-2 rounded-sm border border-ink/15 p-2">
					<button type="button" onClick={() => onSelectCodeSource(codeDiff.kind, codeDiff.id)} className="font-medium underline underline-offset-2">
						Open {codeDiff.name}
					</button>
					<details className="mt-1">
						<summary className="cursor-pointer">Code diff</summary>
						<pre className="mt-2 whitespace-pre-wrap break-words text-proof-red">− {codeDiff.before}</pre>
						<pre className="mt-1 whitespace-pre-wrap break-words text-ink">+ {codeDiff.after}</pre>
						{Array.isArray(details?.diagnostics) && <div className="mt-2 border-t border-ink/10 pt-2"><p className="font-medium">TypeScript diagnostics</p>{details.diagnostics.length ? <ul className="list-inside list-disc">{details.diagnostics.map((diagnostic, index) => <li key={index}>{String(diagnostic)}</li>)}</ul> : <p>None</p>}</div>}
						{typeof details?.diagnosticsNote === "string" && <p className="mt-2 border-t border-ink/10 pt-2 text-ink-3">{details.diagnosticsNote}</p>}
					</details>
				</div>
			)}
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
					{details?.planUpdated === true && <p className="mt-1 text-ink-3">{typeof details.note === "string" ? details.note : "The plan changed. Review the updated plan before confirming."}</p>}
					{affectedRelationships.length > 0 && <p className="mt-1 text-ink-3">This removes {affectedRelationships.length} relationship(s).</p>}
					<div className="mt-2 flex gap-2">
						<button disabled={!toolCallId || pending} onClick={() => onConfirmDrop(toolCallId)} className="rounded-sm border border-proof-red/40 px-2 py-1 text-xs disabled:opacity-40">Confirm drop</button>
						<button disabled={!toolCallId || pending} onClick={() => onRejectDrop(toolCallId)} className="rounded-sm border border-ink/25 px-2 py-1 text-xs disabled:opacity-40">Reject</button>
					</div>
				</div>
			)}
		</div>
	) : (
		<div className="text-sm leading-relaxed">
			<p className="mb-1 text-[10px] uppercase tracking-wide text-ink-3">{summary}</p>
			<p className="whitespace-pre-wrap">{message.role === "assistant" ? assistantText(payload) : printable}</p>
			{usage && (
				<div aria-label="Turn usage" className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-3">
					<span>{(usage.input ?? 0).toLocaleString()} in</span>
					<span>·</span>
					<span>{(usage.output ?? 0).toLocaleString()} out</span>
					<span>·</span>
					<span>{(usage.cacheRead ?? 0).toLocaleString()} cached</span>
					{typeof usage.cost?.total === "number" && usage.cost.total > 0 && (
						<span>· ${usage.cost.total < 0.01 ? usage.cost.total.toFixed(4) : usage.cost.total.toFixed(2)}</span>
					)}
				</div>
			)}
		</div>
	);
	return <article>{body}</article>;
}
function isThinkingLevel(value: string): value is AssistantThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}
