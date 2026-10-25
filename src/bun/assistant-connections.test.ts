import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type OAuthAuth,
	type OAuthCredential,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { createAssistantRuntime, type AssistantRuntime } from "./assistant-runtime";
import { createDesignWorkspace, type DesignWorkspace } from "./workspace";
import {
	BunSecretCredentialStore,
	createInMemorySecretBackend,
	type BunSecretCredentialStoreOptions,
} from "./assistant-credentials";
import { pickUsableModel } from "../mainview/assistant-model-selection";

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];
const runtimes: AssistantRuntime[] = [];

function createTestCredentials(databasePath: string, initialSecrets?: Record<string, string>) {
	const backend = createInMemorySecretBackend(initialSecrets);
	if ((backend as unknown) === Bun.secrets) {
		throw new Error("Guard failed: tests must never use real Bun.secrets!");
	}
	const credentialsOptions: BunSecretCredentialStoreOptions = {
		secrets: backend,
		service: "com.dbplanner.schema-designer.test",
	};
	const store = new BunSecretCredentialStore(databasePath, credentialsOptions);
	return { store, backend, credentialsOptions };
}

function createGuardedAssistantRuntime(
	options: Parameters<typeof createAssistantRuntime>[0] & { credentialsOptions: BunSecretCredentialStoreOptions },
): AssistantRuntime {
	if (!options.credentialsOptions?.secrets || (options.credentialsOptions.secrets as unknown) === Bun.secrets) {
		throw new Error("Guard failed: tests must pass an in-memory secrets backend, never real Bun.secrets!");
	}
	return createAssistantRuntime(options);
}
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	for (const workspace of workspaces.splice(0)) await workspace.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Assistant provider connections", () => {
	test("API-key connections for OpenAI and Gemini authenticate, store nothing secret in SQLite, and stream responses", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-api-keys-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "API Key Project" });
		if (!state.project) throw new Error("Expected project to be open.");

		const openaiKey = "sk-proj-test-openai-key-secret-12345";
		const geminiKey = "AIzaSyTestGeminiSecretKey-67890";

		const openaiFaux = fauxProvider({
			provider: "openai",
			models: [{ id: "gpt-6-luna", name: "GPT-4o" }],
		});
		const googleFaux = fauxProvider({
			provider: "google",
			models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
		});

		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider(openaiFaux.provider);
		models.setProvider(googleFaux.provider);

		const runtime = createGuardedAssistantRuntime({
			databasePath,
			workspace,
			models,
			credentialsOptions,
		});
		runtimes.push(runtime);

		// Configure OpenAI and Gemini API keys
		await runtime.setAssistantApiKey("openai", openaiKey);
		await runtime.setAssistantApiKey("google", geminiKey);

		// Assert connection statuses are connected
		const openaiStatus = await runtime.getConnectionStatus("openai");
		expect(openaiStatus.connected).toBe(true);
		expect(openaiStatus.error).toBeNull();
		expect(openaiStatus.authMethod).toBe("api-key");

		const googleStatus = await runtime.getConnectionStatus("google");
		expect(googleStatus.connected).toBe(true);
		expect(googleStatus.error).toBeNull();
		expect(googleStatus.authMethod).toBe("api-key");

		// Inspect SQLite: nothing secret must be stored in SQLite
		const db = new Database(databasePath, { readonly: true });
		const tableRows = db.query<{ name: string; sql: string }, []>(
			"SELECT name, sql FROM sqlite_master WHERE type='table'",
		).all();
		for (const table of tableRows) {
			const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${table.name}"`).all();
			const json = JSON.stringify(rows);
			expect(json).not.toContain(openaiKey);
			expect(json).not.toContain(geminiKey);
		}
		db.close();

		// Stream a message with OpenAI model to observe real outcome (table created)
		openaiFaux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE items (id uuid PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created items table with OpenAI.")]),
		]);

		const conversation = runtime.createConversation(state.project.id);
		await runtime.sendMessage(conversation.id, "Create items table", "gpt-6-luna");

		expect(workspace.getState().design?.tables.map((t) => t.name)).toEqual(["items"]);
	});

	test("ChatGPT and opt-in Claude OAuth sign-in flow surfaces URLs and device codes without hitting real servers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-oauth-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "OAuth Project" });
		if (!state.project) throw new Error("Expected project to be open.");

		const fakeAccessToken = "test-chatgpt-access-token-abc";
		const fakeRefreshToken = "test-chatgpt-refresh-token-xyz";
		const surfacedUrls: string[] = [];
		const surfacedEvents: unknown[] = [];

		const chatgptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async (interaction: ProviderAuthInteraction) => {
				interaction.notify({
					type: "auth_url",
					url: "https://auth.openai.com/mock-authorize?client_id=pi",
				});
				interaction.notify({
					type: "device_code",
					userCode: "MOCK-CODE-4321",
					verificationUri: "https://auth.openai.com/mock-device",
				});
				return {
					type: "oauth",
					access: fakeAccessToken,
					refresh: fakeRefreshToken,
					expires: Date.now() + 3600_000,
				};
			},
			refresh: async (cred: OAuthCredential) => cred,
			toAuth: async (cred: OAuthCredential) => ({ apiKey: cred.access }),
		};

		const fauxOpenAIBase = fauxProvider({
			provider: "openai",
			models: [{ id: "gpt-4o-oauth", name: "GPT-4o via ChatGPT" }],
		});
		const fauxOpenAI = {
			...fauxOpenAIBase.provider,
			auth: { oauth: chatgptOAuth },
		};

		const claudeOAuth: OAuthAuth = {
			name: "Anthropic (Claude Pro/Max)",
			isSubscription: true,
			loginLabel: "Sign in with Claude",
			login: async (interaction: ProviderAuthInteraction) => {
				interaction.notify({
					type: "auth_url",
					url: "https://claude.ai/mock-oauth",
				});
				return {
					type: "oauth",
					access: "mock-claude-access-token",
					refresh: "mock-claude-refresh-token",
					expires: Date.now() + 3600_000,
				};
			},
			refresh: async (cred: OAuthCredential) => cred,
			toAuth: async (cred: OAuthCredential) => ({ apiKey: cred.access }),
		};

		const fauxAnthropicBase = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
		});
		const fauxAnthropic = {
			...fauxAnthropicBase.provider,
			auth: { oauth: claudeOAuth },
		};

		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider(fauxOpenAI);
		models.setProvider(fauxAnthropic);

		const runtime = createGuardedAssistantRuntime({
			databasePath,
			workspace,
			models,
			credentialsOptions,
			openExternal: (url) => {
				surfacedUrls.push(url);
			},
		});

		runtime.subscribeOAuth((_providerId, event) => {
			surfacedEvents.push(event);
		});

		// 1. ChatGPT OAuth login flow
		const loginResult = await runtime.startOAuthLogin("openai");
		expect(loginResult.success).toBe(true);

		// Assert URL was opened with openExternal
		expect(surfacedUrls).toContain("https://auth.openai.com/mock-authorize?client_id=pi");

		// Assert device code event was surfaced to subscribers
		const deviceCodeEvent = surfacedEvents.find(
			(e) => typeof e === "object" && e !== null && "type" in e && (e as { type: string }).type === "device_code",
		) as { type: string; userCode: string; verificationUri: string } | undefined;
		expect(deviceCodeEvent).toBeDefined();
		expect(deviceCodeEvent?.userCode).toBe("MOCK-CODE-4321");
		expect(deviceCodeEvent?.verificationUri).toBe("https://auth.openai.com/mock-device");

		// Verify connection status
		const status = await runtime.getConnectionStatus("openai");
		expect(status.connected).toBe(true);
		expect(status.authMethod).toBe("oauth");
		expect(status.error).toBeNull();

		// Check SQLite: tokens must NEVER be stored in SQLite
		const db = new Database(databasePath, { readonly: true });
		const allRows = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
		for (const { name } of allRows) {
			const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
			const json = JSON.stringify(rows);
			expect(json).not.toContain(fakeAccessToken);
			expect(json).not.toContain(fakeRefreshToken);
		}
		db.close();

		// 2. Claude sign-in opt-in toggle is off by default
		expect(runtime.getClaudeOptIn()).toBe(false);

		// Attempting Claude OAuth while opt-in is off must fail
		await expect(runtime.startOAuthLogin("anthropic")).rejects.toThrow(/opt-in/i);

		// Enable opt-in toggle and login
		runtime.setClaudeOptIn(true);
		expect(runtime.getClaudeOptIn()).toBe(true);
		const claudeLoginResult = await runtime.startOAuthLogin("anthropic");
		expect(claudeLoginResult.success).toBe(true);

		const claudeStatus = await runtime.getConnectionStatus("anthropic");
		expect(claudeStatus.connected).toBe(true);
		expect(claudeStatus.authMethod).toBe("oauth");
	});

	test("Google account sign-in is explicitly not offered", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-google-reject-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);

		const { credentialsOptions } = createTestCredentials(databasePath);
		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, credentialsOptions });

		// Attempting OAuth login for Google must be rejected explicitly
		await expect(runtime.startOAuthLogin("google")).rejects.toThrow(/not offered|not supported/i);

		// Google connection status indicates api-key auth only
		const status = await runtime.getConnectionStatus("google");
		expect(status.authMethod).toBe("api-key");
	});

	test("Model picker groups models by connection and failing connections stay listed offering re-sign-in", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-grouping-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);

		let refreshShouldFail = false;

		const failingOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: "access-token-1",
				refresh: "refresh-token-1",
				expires: Date.now() + 3600_000,
			}),
			refresh: async () => {
				if (refreshShouldFail) throw new Error("Invalid OAuth refresh token (expired or revoked)");
				return {
					type: "oauth",
					access: "access-token-2",
					refresh: "refresh-token-2",
					expires: Date.now() + 3600_000,
				};
			},
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const fauxOpenAIBase = fauxProvider({
			provider: "openai",
			models: [
				{ id: "gpt-6-luna", name: "GPT-4o" },
				{ id: "gpt-6-sol", name: "gpt-6-sol" },
			],
		});
		const fauxOpenAI = {
			...fauxOpenAIBase.provider,
			auth: { oauth: failingOAuth },
		};

		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider(fauxOpenAI);

		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });

		// Perform initial login
		const login = await runtime.startOAuthLogin("openai");
		const oauthConnId = login.connection!.id;

		// List models: models must be grouped with connectionId and connectionName
		let modelList = await runtime.listModels();
		expect(modelList.length).toBeGreaterThan(0);
		for (const m of modelList.filter((m) => m.provider === "openai")) {
			expect(m.connectionId).toBe(oauthConnId);
			expect(m.connectionName).toContain("ChatGPT");
		}

		// Now simulate expired token and refresh failure
		refreshShouldFail = true;
		await credStore.modify(`connection-${oauthConnId}`, async (curr) => {
			if (curr?.type === "oauth") {
				return { ...curr, expires: Date.now() - 50_000 };
			}
			return curr;
		});

		// Connection status reflects failure with error message
		const status = await runtime.getConnectionStatus(oauthConnId);
		expect(status.connected).toBe(false);
		expect(status.error).toContain("Invalid OAuth refresh token");

		// Acceptance criterion: Picker grouped by connection; failing connections stay listed
		modelList = await runtime.listModels();
		const failingModels = modelList.filter((m) => m.connectionId === oauthConnId);
		expect(failingModels.length).toBe(2);
		expect(failingModels.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-6-sol"]);

		// Re-sign in restores connected status
		refreshShouldFail = false;
		const relogin = await runtime.startOAuthLogin("openai");
		expect(relogin.success).toBe(true);

		const restoredStatus = await runtime.getConnectionStatus("openai");
		expect(restoredStatus.connected).toBe(true);
		expect(restoredStatus.error).toBeNull();
	});

	test("Token refresh works across restarts and nothing secret in SQLite", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-restart-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);

		let refreshCalled = false;

		const refreshableOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: "initial-expired-access",
				refresh: "initial-refresh-token",
				expires: Date.now() - 60_000, // Expired already!
			}),
			refresh: async (cred) => {
				refreshCalled = true;
				return {
					...cred,
					access: "refreshed-shiny-access-token",
					expires: Date.now() + 3600_000,
				};
			},
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const fauxOpenAIBase = fauxProvider({
			provider: "openai",
			models: [{ id: "gpt-6-luna", name: "GPT-4o" }],
		});
		const fauxOpenAI = {
			...fauxOpenAIBase.provider,
			auth: { oauth: refreshableOAuth },
		};

		// Step 1: Initial runtime saves OAuth connection with expired token
		const { store: credStore1, credentialsOptions } = createTestCredentials(databasePath);
		const models1 = createModels({ credentials: credStore1 });
		models1.setProvider(fauxOpenAI);
		const runtime1 = createGuardedAssistantRuntime({ databasePath, workspace, models: models1, credentialsOptions });
		await runtime1.startOAuthLogin("openai");
		runtime1.close();

		// Check SQLite: no tokens in SQLite!
		const db = new Database(databasePath, { readonly: true });
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
		for (const { name } of tables) {
			const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
			const json = JSON.stringify(rows);
			expect(json).not.toContain("initial-expired-access");
			expect(json).not.toContain("initial-refresh-token");
			expect(json).not.toContain("refreshed-shiny-access-token");
		}
		db.close();

		// Step 2: Open fresh runtime across restart on the same database
		const models2 = createModels();
		models2.setProvider(fauxOpenAI);
		const runtime2 = createGuardedAssistantRuntime({ databasePath, workspace, models: models2, credentialsOptions });
		runtimes.push(runtime2);

		// Resolve auth through runtime: triggers automatic token refresh
		const status = await runtime2.getConnectionStatus("openai");
		expect(refreshCalled).toBe(true);
		expect(status.connected).toBe(true);

		// Credential store now holds the refreshed token under connection id
		const credStore2 = new BunSecretCredentialStore(databasePath, credentialsOptions);
		const stored = await credStore2.read(`connection-${status.id}`);
		expect(stored?.type).toBe("oauth");
		if (stored?.type === "oauth") {
			expect(stored.access).toBe("refreshed-shiny-access-token");
		}
	});

	test("Default model is remembered for new conversations and switching model mid-conversation is tracked", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-defaults-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Defaults Project" });
		if (!state.project) throw new Error("Expected project to be open.");

		const faux = fauxProvider({
			provider: "anthropic",
			models: [
				{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			],
		});
		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider(faux.provider);

		const runtime = createGuardedAssistantRuntime({
			databasePath,
			workspace,
			models,
			credentialsOptions,
			getApiKey: async () => "test-key",
		});

		// Create conversation 1 and update selection
		const conv1 = runtime.createConversation(state.project.id);
		runtime.updateConversationSelection(conv1.id, "claude-sonnet-4-5", "high");

		// Verify conversation 1 selection updated
		const loaded1 = runtime.loadConversation(conv1.id);
		expect(loaded1?.model).toBe("claude-sonnet-4-5");
		expect(loaded1?.thinking).toBe("high");

		// Create conversation 2: must inherit default selection from last chosen model & thinking
		const conv2 = runtime.createConversation(state.project.id);
		expect(conv2.model).toBe("claude-sonnet-4-5");
		expect(conv2.thinking).toBe("high");

		// Mid-conversation model switch
		runtime.updateConversationSelection(conv1.id, "claude-haiku-4-5", "low");
		const switched = runtime.loadConversation(conv1.id);
		expect(switched?.model).toBe("claude-haiku-4-5");
		expect(switched?.thinking).toBe("low");
	});

	test("listModels marks saved default model as isDefault when provider connection is saved", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-list-models-default-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "ListModels Default Project" });
		if (!state.project) throw new Error("Expected project to be open.");

		const anthropicFaux = fauxProvider({
			provider: "anthropic",
			models: [
				{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			],
		});
		const openaiFaux = fauxProvider({
			provider: "openai",
			models: [
				{ id: "gpt-6-luna", name: "GPT-6 Luna" },
				{ id: "gpt-6-sol", name: "GPT-6 Sol" },
			],
		});

		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider(anthropicFaux.provider);
		models.setProvider(openaiFaux.provider);

		const runtime = createGuardedAssistantRuntime({
			databasePath,
			workspace,
			models,
			credentialsOptions,
		});
		runtimes.push(runtime);

		const anthropicConn = await runtime.setAssistantApiKey("anthropic", "sk-ant-test-key");
		const openaiConn = await runtime.setAssistantApiKey("openai", "sk-openai-test-key");

		const conv = runtime.createConversation(state.project.id);
		runtime.updateConversationSelection(conv.id, openaiConn.id, "gpt-6-sol", "medium");

		const modelList = await runtime.listModels();
		expect(modelList.length).toBe(4);

		const defaultModels = modelList.filter((m) => m.isDefault);
		expect(defaultModels).toHaveLength(1);
		expect(defaultModels[0]).toMatchObject({
			id: "gpt-6-sol",
			connectionId: openaiConn.id,
			isDefault: true,
		});

		const nonDefaultModels = modelList.filter((m) => !m.isDefault);
		expect(nonDefaultModels).toHaveLength(3);
		for (const m of nonDefaultModels) {
			expect(m.isDefault).toBe(false);
		}

		// Updating the default selection shifts isDefault to the new selection
		runtime.updateConversationSelection(conv.id, anthropicConn.id, "claude-sonnet-4-5", "high");
		const updatedList = await runtime.listModels();
		const updatedDefaults = updatedList.filter((m) => m.isDefault);
		expect(updatedDefaults).toHaveLength(1);
		expect(updatedDefaults[0]).toMatchObject({
			id: "claude-sonnet-4-5",
			connectionId: anthropicConn.id,
			isDefault: true,
		});
		for (const m of updatedList.filter((m) => m.id !== "claude-sonnet-4-5" || m.connectionId !== anthropicConn.id)) {
			expect(m.isDefault).toBe(false);
		}
	});

	test("OpenAI API-key and ChatGPT sign-in coexist, stream with distinct credentials, survive restarts, and removal of one leaves the other intact", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-coexist-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		const state = await workspace.createProject({ name: "Coexistence Project" });
		if (!state.project) throw new Error("Expected project to be open.");

		const openaiApiKey = "sk-secret-key-111";
		const chatgptToken = "token-chatgpt-222";
		const receivedKeys: string[] = [];

		const chatgptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: chatgptToken,
				refresh: "refresh-tok-222",
				expires: Date.now() + 3600_000,
			}),
			refresh: async (cred) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const openaiFauxBase = fauxProvider({
			provider: "openai",
			models: [{ id: "gpt-6-luna", name: "GPT-4o" }],
		});
		const customOpenAIProvider = {
			...openaiFauxBase.provider,
			auth: {
				apiKey: {
					name: "OpenAI API key",
					resolve: async ({ credential }: { credential?: { key?: string } }) => ({ auth: { apiKey: credential?.key } }),
				},
				oauth: chatgptOAuth,
			},
			streamSimple: (model: unknown, context: unknown, options?: { apiKey?: string }) => {
				if (options?.apiKey) receivedKeys.push(options.apiKey);
				return (openaiFauxBase.provider.streamSimple as Function)(model, context, options);
			},
		};
		const { credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels();
		models.setProvider(customOpenAIProvider as never);

		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });

		// (a) An OpenAI API-key connection and a ChatGPT sign-in coexist:
		const apiKeyConn = await runtime.setAssistantApiKey("openai", openaiApiKey);
		const oauthResult = await runtime.startOAuthLogin("openai");
		const oauthConn = oauthResult.connection!;

		expect(apiKeyConn.id).not.toBe(oauthConn.id);
		expect(apiKeyConn.auth_method).toBe("api-key");
		expect(oauthConn.auth_method).toBe("oauth");

		const connections = await runtime.listConnections();
		expect(connections.length).toBe(2);
		expect(connections.map((c) => c.id).sort()).toEqual([apiKeyConn.id, oauthConn.id].sort());

		// Both are listed in model picker
		const modelList = await runtime.listModels();
		expect(modelList.some((m) => m.connectionId === apiKeyConn.id && m.connectionName.includes("API key"))).toBe(true);
		expect(modelList.some((m) => m.connectionId === oauthConn.id && m.connectionName.includes("ChatGPT"))).toBe(true);

		// Both stream with their own credentials:
		// Conversation 1 using API-key connection
		openaiFauxBase.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t_api_key (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created via API key.")]),
		]);
		const conv1 = runtime.createConversation(state.project.id);
		await runtime.sendMessage(conv1.id, "Create t_api_key", "gpt-6-luna", "medium", apiKeyConn.id);
		expect(receivedKeys[receivedKeys.length - 1]).toBe(openaiApiKey);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_api_key");

		// Conversation 2 using ChatGPT sign-in connection
		openaiFauxBase.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t_oauth (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created via ChatGPT.")]),
		]);
		const conv2 = runtime.createConversation(state.project.id);
		await runtime.sendMessage(conv2.id, "Create t_oauth", "gpt-6-luna", "medium", oauthConn.id);
		expect(receivedKeys[receivedKeys.length - 1]).toBe(chatgptToken);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_oauth");

		// (c) A conversation bound to the sign-in connection keeps using it after a restart:
		runtime.close();
		const runtime2 = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime2);

		openaiFauxBase.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t_oauth_restarted (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created after restart.")]),
		]);
		await runtime2.sendMessage(conv2.id, "Create t_oauth_restarted", "gpt-6-luna");
		expect(receivedKeys[receivedKeys.length - 1]).toBe(chatgptToken);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_oauth_restarted");

		// (b) Removing one leaves the other working:
		await runtime2.removeAssistantConnection(oauthConn.id);
		expect((await runtime2.listConnections()).map((c) => c.id)).toEqual([apiKeyConn.id]);

		// Conversation 1 (API key) still works after removing ChatGPT connection
		openaiFauxBase.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t_api_still_works (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Still works.")]),
		]);
		await runtime2.sendMessage(conv1.id, "Create t_api_still_works", "gpt-6-luna");
		expect(receivedKeys[receivedKeys.length - 1]).toBe(openaiApiKey);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_api_still_works");

		// Conversation 2 (whose connection was removed) throws error asking for a model
		await expect(runtime2.sendMessage(conv2.id, "Should fail", "gpt-6-luna")).rejects.toThrow(/connection for this conversation was removed/i);

		// (d) Nothing secret in SQLite:
		const db = new Database(databasePath, { readonly: true });
		const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
		for (const { name } of tables) {
			const rows = db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all();
			const json = JSON.stringify(rows);
			expect(json).not.toContain(openaiApiKey);
			expect(json).not.toContain(chatgptToken);
		}
		db.close();
	});

	test("Migrates pre-#78 database and legacy anthropic-api-key secret to connection-<id>", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-legacy-mig-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");

		const legacyKey = "sk-ant-pre78-legacy-secret-key-9999";

		// 1. Seed pre-#78 SQLite schema and row with id = 'anthropic'
		const workspaceInitial = await createDesignWorkspace({ databasePath });
		const state = await workspaceInitial.createProject({ name: "Legacy Project" });
		if (!state.project) throw new Error("Expected project to be created.");
		const projectId = state.project.id;
		await workspaceInitial.close();

		// Seed pre-#78 row with id = 'anthropic' and conversation
		const db = new Database(databasePath);
		db.exec(`
			CREATE TABLE IF NOT EXISTS assistant_provider_connections (
				id TEXT PRIMARY KEY,
				auth_method TEXT NOT NULL,
				credential_name TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS assistant_conversations (
				id TEXT PRIMARY KEY,
				project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
				title TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				provider TEXT,
				model TEXT,
				thinking TEXT
			);
			CREATE TABLE IF NOT EXISTS assistant_messages (
				conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
				sequence INTEGER NOT NULL,
				role TEXT NOT NULL,
				kind TEXT,
				payload TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				PRIMARY KEY (conversation_id, sequence)
			);
			CREATE TABLE IF NOT EXISTS assistant_settings (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				model TEXT,
				thinking TEXT
			);
			CREATE TABLE IF NOT EXISTS assistant_project_observations (
				conversation_id TEXT PRIMARY KEY REFERENCES assistant_conversations(id) ON DELETE CASCADE,
				revision INTEGER NOT NULL,
				snapshot TEXT
			);
		`);
		db.run(
			"INSERT INTO assistant_provider_connections (id, auth_method, credential_name, created_at, updated_at) VALUES ('anthropic', 'api-key', 'anthropic-api-key', 1000, 1000)",
		);
		db.run(
			"INSERT INTO assistant_conversations (id, project_id, title, created_at, updated_at, provider, model, thinking) VALUES ('conv-legacy', ?, 'Legacy Chat', 1000, 1000, 'anthropic', 'claude-sonnet-4-5', 'medium')",
			[projectId],
		);
		db.close();

		// 2. Seed legacy secret into in-memory backend under 'anthropic-api-key'
		const { backend, credentialsOptions } = createTestCredentials(databasePath);
		await backend.set({
			service: credentialsOptions.service!,
			name: "anthropic-api-key",
			value: legacyKey,
		});
		// 3. Open workspace and runtime (which triggers migration)
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		await workspace.openProject({ projectId });
		const receivedKeys: string[] = [];
		const fauxAnthropicBase = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
		});
		const customAnthropicProvider = {
			...fauxAnthropicBase.provider,
			auth: {
				apiKey: {
					name: "Anthropic API key",
					resolve: async ({ credential }: { credential?: { key?: string } }) => ({ auth: { apiKey: credential?.key } }),
				},
			},
			streamSimple: (model: unknown, context: unknown, options?: { apiKey?: string }) => {
				if (options?.apiKey) receivedKeys.push(options.apiKey);
				return (fauxAnthropicBase.provider.streamSimple as Function)(model, context, options);
			},
		};

		const models = createModels();
		models.setProvider(customAnthropicProvider as never);
		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);

		// Assert the connection is connected
		const connections = await runtime.listConnections();
		expect(connections.length).toBe(1);
		const conn = connections[0]!;
		expect(conn.providerId).toBe("anthropic");
		expect(conn.authMethod).toBe("api-key");
		expect(conn.connected).toBe(true);
		expect(conn.error).toBeNull();
		expect(conn.id).not.toBe("anthropic"); // UUID assigned

		// Assert it streams with that key
		fauxAnthropicBase.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t_migrated (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Migrated!")]),
		]);

		await runtime.sendMessage("conv-legacy", "Create t_migrated", "claude-sonnet-4-5");
		expect(receivedKeys).toContain(legacyKey);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_migrated");

		// Assert legacy secret is gone from in-memory test backend
		const legacySecret = await backend.get({
			service: credentialsOptions.service!,
			name: "anthropic-api-key",
		});
		expect(legacySecret).toBeNull();

		// Assert secret is preserved under connection-<id>
		const credStore = new BunSecretCredentialStore(databasePath, credentialsOptions);
		const migratedSecret = await credStore.read(`connection-${conn.id}`);
		expect(migratedSecret?.type).toBe("api_key");
		if (migratedSecret?.type === "api_key") {
			expect(migratedSecret.key).toBe(legacyKey);
		}

		// Assert idempotency: restarting runtime does not re-delete or fail
		runtime.close();
		const runtimeRestart = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtimeRestart);
		const connections2 = await runtimeRestart.listConnections();
		expect(connections2.length).toBe(1);
		expect(connections2[0]?.connected).toBe(true);
		expect(connections2[0]?.id).toBe(conn.id);
	});
	test("ChatGPT sign-in gets a stable installation id, and a failed first sign-in leaves no connection behind", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-device-id-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);

		const deviceIds: string[] = [];
		let failNextLogin = true;
		const deviceOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async (_interaction, options) => {
				const deviceId = options?.getDeviceId?.();
				if (!deviceId) throw new Error("Sign in with ChatGPT requires a device ID (UUID) for this installation");
				deviceIds.push(deviceId);
				if (failNextLogin) throw new Error("The browser sign-in was cancelled.");
				return { type: "oauth", access: "device-access", refresh: "device-refresh", expires: Date.now() + 3600_000 };
			},
			refresh: async (cred: OAuthCredential) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};
		const fauxOpenAI = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-luna", name: "GPT-4o" }] });
		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider({ ...fauxOpenAI.provider, auth: { oauth: deviceOAuth } });
		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);

		const failed = await runtime.startOAuthLogin("openai");
		expect(failed.success).toBe(false);
		expect(failed.error).toContain("cancelled");
		expect((await runtime.listConnections()).filter((c) => c.providerId === "openai" && c.authMethod === "oauth" && c.connected)).toHaveLength(0);
		expect(new Database(databasePath).query("SELECT COUNT(*) AS n FROM assistant_provider_connections WHERE auth_method = 'oauth'").get()).toEqual({ n: 0 });

		failNextLogin = false;
		const succeeded = await runtime.startOAuthLogin("openai");
		expect(succeeded.success).toBe(true);
		runtime.close();
		runtimes.splice(runtimes.indexOf(runtime), 1);

		const reopened = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(reopened);
		failNextLogin = true;
		await reopened.startOAuthLogin("openai");
		expect((await reopened.listConnections()).some((c) => c.providerId === "openai" && c.authMethod === "oauth" && c.connected)).toBe(true);

		expect(deviceIds).toHaveLength(3);
		expect(deviceIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
		expect(new Set(deviceIds).size).toBe(1);
	});
	test("ChatGPT sign-in keeps the paste prompt open until it is answered or the callback server wins", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-oauth-prompt-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);

		let callbackWins = false;
		const promptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async (interaction) => {
				// Mirrors pi's flow: a paste prompt races the local callback server.
				const manualAbort = new AbortController();
				const manual = interaction.prompt({
					type: "manual_code",
					message: "Paste the final redirect URL here:",
					placeholder: "http://127.0.0.1:1455/auth/callback",
					signal: manualAbort.signal,
				}).then((input) => {
					if (!input.includes("code=")) throw new Error("Pasted URL has no authorization code");
					return input;
				});
				const callback = new Promise<string>((resolve) => {
					if (callbackWins) setTimeout(() => resolve("callback-code"), 50);
				});
				try {
					const code = await Promise.race([manual, callback]);
					return { type: "oauth", access: `access-for-${code.length}`, refresh: "r", expires: Date.now() + 3600_000 };
				} finally {
					manualAbort.abort();
				}
			},
			refresh: async (cred: OAuthCredential) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};
		const fauxOpenAI = fauxProvider({ provider: "openai", models: [{ id: "gpt-6-luna", name: "GPT-4o" }] });
		const { store: credStore, credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels({ credentials: credStore });
		models.setProvider({ ...fauxOpenAI.provider, auth: { oauth: promptOAuth } });
		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);
		const events: Array<{ type?: string; promptId?: string; success?: boolean }> = [];
		runtime.subscribeOAuth((_providerId, event) => events.push(event as { type?: string }));

		// 1. The prompt is not answered with an empty string; the designer pastes the URL.
		const pasted = runtime.startOAuthLogin("openai");
		await new Promise((resolve) => setTimeout(resolve, 100));
		const prompt = events.find((event) => event.type === "prompt");
		expect(prompt?.promptId).toBeString();
		expect(events.some((event) => event.type === "login_finished")).toBe(false);
		expect(runtime.answerOAuthPrompt(prompt!.promptId!, "http://127.0.0.1:1455/auth/callback?code=abc&state=s")).toBe(true);
		expect((await pasted).success).toBe(true);
		expect(events.some((event) => event.type === "prompt_closed" && event.promptId === prompt!.promptId)).toBe(true);
		expect(events[events.length - 1]).toEqual({ type: "login_finished", success: true });

		// 2. The callback server wins: the open prompt is withdrawn and sign-in succeeds.
		events.length = 0;
		callbackWins = true;
		expect((await runtime.startOAuthLogin("openai")).success).toBe(true);
		const second = events.find((event) => event.type === "prompt");
		expect(events.some((event) => event.type === "prompt_closed" && event.promptId === second?.promptId)).toBe(true);

		// 3. Cancel ends a pending sign-in.
		events.length = 0;
		callbackWins = false;
		const cancelled = runtime.startOAuthLogin("openai");
		await new Promise((resolve) => setTimeout(resolve, 50));
		runtime.cancelOAuthLogin("openai");
		const cancelResult = await cancelled;
		expect(cancelResult.success).toBe(false);
		expect(events[events.length - 1]?.type).toBe("login_finished");
	});

	test("ChatGPT sign-in: no cost per turn or in totals, and only usable models in picker", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-chatgpt-cost-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		await workspace.createProject({ name: "ChatGPT Cost Test" });
		const state = workspace.getState();

		const chatgptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: "chatgpt-test-token",
				refresh: "refresh-tok-chatgpt",
				expires: Date.now() + 3600_000,
			}),
			refresh: async (cred) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const openaiFauxBase = fauxProvider({
			provider: "openai",
			models: [
				{
					id: "gpt-6-luna",
					name: "GPT-4o",
					contextWindow: 128000,
					cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
				},
				{
					id: "gpt-realtime-2.1",
					name: "GPT-Realtime-2.1",
					contextWindow: 128000,
					cost: { input: 4, output: 24, cacheRead: 0.4, cacheWrite: 0 },
				},
				{
					id: "gpt-4o-audio-preview",
					name: "GPT-4o Audio Preview",
					contextWindow: 128000,
					cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
				},
			],
		});

		const customOpenAIProvider = {
			...openaiFauxBase.provider,
			auth: {
				apiKey: {
					name: "OpenAI API key",
					resolve: async ({ credential }: { credential?: { key?: string } }) => ({ auth: { apiKey: credential?.key } }),
				},
				oauth: chatgptOAuth,
			},
			streamSimple: (model: unknown, context: unknown, options?: { apiKey?: string }) => {
				return (openaiFauxBase.provider.streamSimple as Function)(model, context, options);
			},
		};

		const { credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels();
		models.setProvider(customOpenAIProvider as never);

		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);

		const apiKeyConn = await runtime.setAssistantApiKey("openai", "sk-fake-openai-key");
		const oauthResult = await runtime.startOAuthLogin("openai");
		const oauthConn = oauthResult.connection!;

		// 1. Model picker criteria:
		// API-key connection gets the full catalog (including realtime and audio models)
		// ChatGPT OAuth connection allows only models in pi's Codex catalog
		const modelList = await runtime.listModels();
		const apiKeyModels = modelList.filter((m) => m.connectionId === apiKeyConn.id);
		const oauthModels = modelList.filter((m) => m.connectionId === oauthConn.id);

		expect(apiKeyModels.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-realtime-2.1", "gpt-4o-audio-preview"]);
		expect(oauthModels.map((m) => m.id)).toEqual(["gpt-6-luna"]);
		// Only models in pi's Codex catalog reach a ChatGPT sign-in; everything else stays API-key only.
		expect(oauthModels.every((m) => ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"].includes(m.id))).toBe(true);
		expect(oauthModels.some((m) => m.id.includes("realtime") || m.id.includes("audio"))).toBe(false);

		// Sending message with realtime model on OAuth connection should be rejected
		const convOAuth = runtime.createConversation(state.project!.id);
		await expect(
			runtime.sendMessage(convOAuth.id, "Hello", "gpt-realtime-2.1", "medium", oauthConn.id),
		).rejects.toThrow(/not usable/i);

		// 2. Cost tracking:
		// API-key connection tracks cost per turn and in total
		const convApiKey = runtime.createConversation(state.project!.id);
		openaiFauxBase.setResponses([
			fauxAssistantMessage([fauxText("Response via API key.")]),
		]);
		await runtime.sendMessage(convApiKey.id, "Create tables via API key", "gpt-6-luna", "medium", apiKeyConn.id);

		const loadedApiKey = runtime.loadConversation(convApiKey.id)!;
		expect(loadedApiKey.usages).toHaveLength(1);
		expect(typeof loadedApiKey.usages![0]!.cost).toBe("number");
		expect(loadedApiKey.usages![0]!.cost!).toBeGreaterThan(0);
		expect(typeof loadedApiKey.totalUsage?.cost).toBe("number");
		expect(loadedApiKey.totalUsage!.cost!).toBeGreaterThan(0);
		const apiKeyAssistantMsg = loadedApiKey.messages.find((m) => m.role === "assistant")!;
		const apiKeyPayload = apiKeyAssistantMsg.payload as { usage?: { cost?: unknown } };
		expect(apiKeyPayload.usage?.cost).toBeDefined();

		// ChatGPT OAuth connection shows NO cost per turn or in totals
		openaiFauxBase.setResponses([
			fauxAssistantMessage([fauxText("Response via ChatGPT OAuth.")]),
		]);
		await runtime.sendMessage(convOAuth.id, "Create tables via ChatGPT", "gpt-6-luna", "medium", oauthConn.id);

		const loadedOAuth = runtime.loadConversation(convOAuth.id)!;
		expect(loadedOAuth.usages).toHaveLength(1);
		expect(loadedOAuth.usages![0]!.cost).toBeNull();
		expect(loadedOAuth.totalUsage?.cost).toBeNull();
		expect(loadedOAuth.totalUsage!.inputTokens).toBeGreaterThan(0);
		expect(loadedOAuth.totalUsage!.outputTokens).toBeGreaterThan(0);
		const oauthAssistantMsg = loadedOAuth.messages.find((m) => m.role === "assistant")!;
		const oauthPayload = oauthAssistantMsg.payload as { usage?: { cost?: unknown } };
		expect(oauthPayload.usage?.cost).toBeUndefined();

		// Stored assistant message payload in SQLite directly has no usage.cost
		const db = new Database(databasePath, { readonly: true });
		const storedOAuthMsg = db.query<{ payload: string }, [string]>(
			"SELECT payload FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant'",
		).get(convOAuth.id);
		expect(storedOAuthMsg).toBeDefined();
		const rawOAuthPayload = JSON.parse(storedOAuthMsg!.payload);
		expect(rawOAuthPayload.usage?.cost).toBeUndefined();
	});

	test("switching a conversation from API key to ChatGPT sign-in preserves first turn cost and suppresses second turn cost across restarts", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-switch-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Switch Test" });
		const state = workspace.getState();

		const chatgptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: "chatgpt-test-token",
				refresh: "refresh-tok-chatgpt",
				expires: Date.now() + 3600_000,
			}),
			refresh: async (cred) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const openaiFauxBase = fauxProvider({
			provider: "openai",
			models: [
				{
					id: "gpt-6-luna",
					name: "GPT-4o",
					contextWindow: 128000,
					cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
				},
			],
		});

		const customOpenAIProvider = {
			...openaiFauxBase.provider,
			auth: {
				apiKey: {
					name: "OpenAI API key",
					resolve: async ({ credential }: { credential?: { key?: string } }) => ({ auth: { apiKey: credential?.key } }),
				},
				oauth: chatgptOAuth,
			},
			streamSimple: (model: unknown, context: unknown, options?: { apiKey?: string }) => {
				return (openaiFauxBase.provider.streamSimple as Function)(model, context, options);
			},
		};

		const { credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels();
		models.setProvider(customOpenAIProvider as never);

		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);

		const apiKeyConn = await runtime.setAssistantApiKey("openai", "sk-fake-openai-key");
		const oauthResult = await runtime.startOAuthLogin("openai");
		const oauthConn = oauthResult.connection!;

		// Start conversation with API-key connection
		const conversation = runtime.createConversation(state.project!.id);
		openaiFauxBase.setResponses([
			fauxAssistantMessage([fauxText("Turn 1 via API key.")]),
		]);
		await runtime.sendMessage(conversation.id, "Turn 1", "gpt-6-luna", "medium", apiKeyConn.id);

		let loaded = runtime.loadConversation(conversation.id)!;
		expect(loaded.usages).toHaveLength(1);
		const turn1Cost = loaded.usages![0]!.cost;
		expect(typeof turn1Cost).toBe("number");
		expect(turn1Cost!).toBeGreaterThan(0);
		expect(loaded.totalUsage?.cost).toBe(turn1Cost);

		// Switch connection to ChatGPT sign-in via updateConversationSelection
		runtime.updateConversationSelection(conversation.id, oauthConn.id, "gpt-6-luna");

		// Send Turn 2 via ChatGPT sign-in
		openaiFauxBase.setResponses([
			fauxAssistantMessage([fauxText("Turn 2 via ChatGPT sign-in.")]),
		]);
		await runtime.sendMessage(conversation.id, "Turn 2", "gpt-6-luna");

		loaded = runtime.loadConversation(conversation.id)!;
		expect(loaded.usages).toHaveLength(2);
		expect(loaded.usages![0]!.cost).toBe(turn1Cost);
		expect(loaded.usages![1]!.cost).toBeNull();
		expect(loaded.totalUsage?.cost).toBe(turn1Cost);

		// (c) Stored assistant message payloads for the sign-in turn have no usage.cost
		const msgs = loaded.messages.filter((m) => m.role === "assistant");
		expect(msgs).toHaveLength(2);
		const turn1Payload = msgs[0]!.payload as { usage?: { cost?: unknown } };
		const turn2Payload = msgs[1]!.payload as { usage?: { cost?: unknown } };
		expect(turn1Payload.usage?.cost).toBeDefined();
		expect(turn2Payload.usage?.cost).toBeUndefined();

		// Check raw stored payload in SQLite database directly
		const db = new Database(databasePath, { readonly: true });
		const storedMsgs = db.query<{ role: string; payload: string }, [string]>(
			"SELECT role, payload FROM assistant_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY sequence ASC",
		).all(conversation.id);
		expect(storedMsgs).toHaveLength(2);
		const rawTurn1Payload = JSON.parse(storedMsgs[0]!.payload);
		const rawTurn2Payload = JSON.parse(storedMsgs[1]!.payload);
		expect(rawTurn1Payload.usage?.cost).toBeDefined();
		expect(rawTurn2Payload.usage?.cost).toBeUndefined();

		// (b) After a restart, the same values come back
		runtime.close();
		const runtime2 = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime2);

		const reloaded = runtime2.loadConversation(conversation.id)!;
		expect(reloaded.usages).toHaveLength(2);
		expect(reloaded.usages![0]!.cost).toBe(turn1Cost);
		expect(reloaded.usages![1]!.cost).toBeNull();
		expect(reloaded.totalUsage?.cost).toBe(turn1Cost);
		const reloadedMsgs = reloaded.messages.filter((m) => m.role === "assistant");
		expect((reloadedMsgs[0]!.payload as { usage?: { cost?: unknown } }).usage?.cost).toBeDefined();
		expect((reloadedMsgs[1]!.payload as { usage?: { cost?: unknown } }).usage?.cost).toBeUndefined();
	});

	test("createConversation heals stale saved default model and updates saved default", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-stale-default-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Stale Default Test" });
		const state = workspace.getState();

		const chatgptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: "chatgpt-test-token",
				refresh: "refresh-tok-chatgpt",
				expires: Date.now() + 3600_000,
			}),
			refresh: async (cred) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const openaiFauxBase = fauxProvider({
			provider: "openai",
			models: [
				{
					id: "gpt-4",
					name: "GPT-4",
					contextWindow: 128000,
					cost: { input: 30, output: 60, cacheRead: 15, cacheWrite: 0 },
				},
				{
					id: "gpt-6-luna",
					name: "GPT-6 Luna",
					contextWindow: 128000,
					cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
				},
			],
		});

		const customOpenAIProvider = {
			...openaiFauxBase.provider,
			auth: { oauth: chatgptOAuth },
			streamSimple: (model: unknown, context: unknown, options?: { apiKey?: string }) => {
				return (openaiFauxBase.provider.streamSimple as Function)(model, context, options);
			},
		};

		const { credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels();
		models.setProvider(customOpenAIProvider as never);

		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);

		const oauthResult = await runtime.startOAuthLogin("openai");
		const oauthConn = oauthResult.connection!;

		// Set stale default selection in database: gpt-4 on ChatGPT sign-in connection
		const db = new Database(databasePath);
		db.exec(`INSERT OR REPLACE INTO assistant_settings (id, connection_id, model, thinking) VALUES (1, '${oauthConn.id}', 'gpt-4', 'medium')`);
		db.close();

		// createConversation returns a conversation with a usable Codex model (gpt-6-luna)
		const conversation = runtime.createConversation(state.project!.id);
		expect(conversation.connection_id).toBe(oauthConn.id);
		expect(conversation.model).toBe("gpt-6-luna");

		// The saved default in assistant_settings is updated
		const verifyDb = new Database(databasePath, { readonly: true });
		const updatedSetting = verifyDb.query<{ connection_id: string; model: string }, []>(
			"SELECT connection_id, model FROM assistant_settings WHERE id = 1",
		).get();
		verifyDb.close();
		expect(updatedSetting?.connection_id).toBe(oauthConn.id);
		expect(updatedSetting?.model).toBe("gpt-6-luna");
	});

	test("conversation stored with unusable model heals selection, succeeds on sendMessage, and records healed model", async () => {
		const directory = mkdtempSync(join(tmpdir(), "db-planner-conn-stale-conv-"));
		directories.push(directory);
		const databasePath = join(directory, "project.sqlite");
		const workspace = await createDesignWorkspace({ databasePath });
		workspaces.push(workspace);
		await workspace.createProject({ name: "Stale Conversation Test" });
		const state = workspace.getState();

		const chatgptOAuth: OAuthAuth = {
			name: "OpenAI (ChatGPT subscription)",
			isSubscription: true,
			loginLabel: "Sign in with ChatGPT",
			login: async () => ({
				type: "oauth",
				access: "chatgpt-test-token",
				refresh: "refresh-tok-chatgpt",
				expires: Date.now() + 3600_000,
			}),
			refresh: async (cred) => cred,
			toAuth: async (cred) => ({ apiKey: cred.access }),
		};

		const openaiFauxBase = fauxProvider({
			provider: "openai",
			models: [
				{
					id: "gpt-4",
					name: "GPT-4",
					contextWindow: 128000,
					cost: { input: 30, output: 60, cacheRead: 15, cacheWrite: 0 },
				},
				{
					id: "gpt-6-luna",
					name: "GPT-6 Luna",
					contextWindow: 128000,
					cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 },
				},
			],
		});

		const customOpenAIProvider = {
			...openaiFauxBase.provider,
			auth: { oauth: chatgptOAuth },
			streamSimple: (model: unknown, context: unknown, options?: { apiKey?: string }) => {
				return (openaiFauxBase.provider.streamSimple as Function)(model, context, options);
			},
		};

		const { credentialsOptions } = createTestCredentials(databasePath);
		const models = createModels();
		models.setProvider(customOpenAIProvider as never);

		const runtime = createGuardedAssistantRuntime({ databasePath, workspace, models, credentialsOptions });
		runtimes.push(runtime);

		const oauthResult = await runtime.startOAuthLogin("openai");
		const oauthConn = oauthResult.connection!;

		// Create a conversation initially, then store gpt-4 directly in database
		const conversation = runtime.createConversation(state.project!.id);
		const db = new Database(databasePath);
		db.exec(`UPDATE assistant_conversations SET connection_id = '${oauthConn.id}', model = 'gpt-4' WHERE id = '${conversation.id}'`);
		db.close();

		// Verify it was stored with gpt-4 and sending gpt-4 directly is rejected by runtime
		const loadedInitial = runtime.loadConversation(conversation.id)!;
		expect(loadedInitial.model).toBe("gpt-4");
		await expect(
			runtime.sendMessage(conversation.id, "Try unusable", "gpt-4", "medium", oauthConn.id),
		).rejects.toThrow(/not usable with ChatGPT/i);

		// Perform healing selection (as the sidebar does with pickUsableModel + updateConversationSelection)
		const availableModels = await runtime.listModels();
		const healed = pickUsableModel(availableModels, oauthConn.id, loadedInitial.model);
		expect(healed).not.toBeNull();
		expect(healed!.id).toBe("gpt-6-luna");
		runtime.updateConversationSelection(conversation.id, healed!.connectionId, healed!.id, "medium");

		// sendMessage succeeds with the fake model
		openaiFauxBase.setResponses([
			fauxAssistantMessage([fauxText("Message handled successfully.")]),
		]);
		await runtime.sendMessage(conversation.id, "Hello after healing", healed!.id, "medium", healed!.connectionId);

		// Loaded conversation records the healed model
		const loadedAfter = runtime.loadConversation(conversation.id)!;
		expect(loadedAfter.model).toBe("gpt-6-luna");
		expect(loadedAfter.connection_id).toBe(oauthConn.id);
		expect(loadedAfter.messages.some((m) => m.role === "assistant")).toBe(true);
	});
});
