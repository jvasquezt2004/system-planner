export type AssistantProviderId = "anthropic" | "openai" | "google";
export type AssistantAuthMethod = "api-key" | "oauth";

export type AssistantProviderConnection = {
	id: string;
	provider_id: AssistantProviderId | string;
	auth_method: AssistantAuthMethod;
	credential_name: string;
	created_at: number;
	updated_at: number;
};

export type AssistantConnectionStatus = {
	id: string;
	providerId: string;
	name: string;
	authMethod: AssistantAuthMethod;
	connected: boolean;
	error: string | null;
	claudeOptIn?: boolean;
};

export type AssistantModel = {
	id: string;
	name: string;
	provider: string;
	connectionId: string;
	connectionName: string;
	reasoning: boolean;
	contextWindow: number;
};

export type AssistantMessage = {
	id?: string;
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
	connection_id?: string | null;
	provider?: string | null;
	model?: string | null;
	thinking?: string | null;
};

export type AssistantTurnUsage = {
	turnId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cost: number | null;
	createdAt?: number;
};

export type AssistantTotalUsage = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cost: number | null;
};

export type AssistantConversationRecord = AssistantConversation & {
	messages: AssistantMessage[];
	usages?: AssistantTurnUsage[];
	totalUsage?: AssistantTotalUsage;
};
