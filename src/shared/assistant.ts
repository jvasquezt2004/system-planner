export type AssistantProviderConnection = {
	id: "anthropic";
	auth_method: "api-key";
	credential_name: "anthropic-api-key";
	created_at: number;
	updated_at: number;
};

export type AssistantMessage = {
	role: string;
	kind?: string;
	payload: unknown;
	created_at?: number;
};

export type AssistantThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type AssistantConversation = {
	id: string;
	project_id: string;
	title: string;
	created_at: number;
	updated_at: number;
	provider?: string | null;
	model?: string | null;
	thinking?: string | null;
};

export type AssistantConversationRecord = AssistantConversation & { messages: AssistantMessage[] };
