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
import { BunSecretCredentialStore } from "./assistant-credentials";

const directories: string[] = [];
const workspaces: DesignWorkspace[] = [];
const runtimes: AssistantRuntime[] = [];

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
			models: [{ id: "gpt-4o", name: "GPT-4o" }],
		});
		const googleFaux = fauxProvider({
			provider: "google",
			models: [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
		});

		const models = createModels({ credentials: new BunSecretCredentialStore(databasePath) });
		models.setProvider(openaiFaux.provider);
		models.setProvider(googleFaux.provider);

		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
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
		await runtime.sendMessage(conversation.id, "Create items table", "gpt-4o");

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

		const models = createModels({ credentials: new BunSecretCredentialStore(databasePath) });
		models.setProvider(fauxOpenAI);
		models.setProvider(fauxAnthropic);

		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			openExternal: (url) => {
				surfacedUrls.push(url);
			},
		});
		runtimes.push(runtime);

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

		const runtime = createAssistantRuntime({ databasePath, workspace });
		runtimes.push(runtime);

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
				{ id: "gpt-4o", name: "GPT-4o" },
				{ id: "o1", name: "o1" },
			],
		});
		const fauxOpenAI = {
			...fauxOpenAIBase.provider,
			auth: { oauth: failingOAuth },
		};

		const models = createModels({ credentials: new BunSecretCredentialStore(databasePath) });
		models.setProvider(fauxOpenAI);

		const runtime = createAssistantRuntime({ databasePath, workspace, models });
		runtimes.push(runtime);

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
		const credStore = new BunSecretCredentialStore(databasePath);
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
		expect(failingModels.map((m) => m.id)).toEqual(["gpt-4o", "o1"]);

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
			models: [{ id: "gpt-4o", name: "GPT-4o" }],
		});
		const fauxOpenAI = {
			...fauxOpenAIBase.provider,
			auth: { oauth: refreshableOAuth },
		};

		// Step 1: Initial runtime saves OAuth connection with expired token
		const credStore1 = new BunSecretCredentialStore(databasePath);
		const models1 = createModels({ credentials: credStore1 });
		models1.setProvider(fauxOpenAI);
		const runtime1 = createAssistantRuntime({ databasePath, workspace, models: models1 });
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
		const runtime2 = createAssistantRuntime({ databasePath, workspace, models: models2 });
		runtimes.push(runtime2);

		// Resolve auth through runtime: triggers automatic token refresh
		const status = await runtime2.getConnectionStatus("openai");
		expect(refreshCalled).toBe(true);
		expect(status.connected).toBe(true);

		// Credential store now holds the refreshed token under connection id
		const credStore2 = new BunSecretCredentialStore(databasePath);
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
		const models = createModels({ credentials: new BunSecretCredentialStore(databasePath) });
		models.setProvider(faux.provider);

		const runtime = createAssistantRuntime({
			databasePath,
			workspace,
			models,
			getApiKey: async () => "test-key",
		});
		runtimes.push(runtime);

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
			models: [{ id: "gpt-4o", name: "GPT-4o" }],
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

		const models = createModels();
		models.setProvider(customOpenAIProvider as never);

		const runtime = createAssistantRuntime({ databasePath, workspace, models });
		runtimes.push(runtime);

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
		await runtime.sendMessage(conv1.id, "Create t_api_key", "gpt-4o", "medium", apiKeyConn.id);
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
		await runtime.sendMessage(conv2.id, "Create t_oauth", "gpt-4o", "medium", oauthConn.id);
		expect(receivedKeys[receivedKeys.length - 1]).toBe(chatgptToken);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_oauth");

		// (c) A conversation bound to the sign-in connection keeps using it after a restart:
		runtime.close();
		const runtime2 = createAssistantRuntime({ databasePath, workspace, models });
		runtimes.push(runtime2);

		openaiFauxBase.setResponses([
			fauxAssistantMessage([
				fauxToolCall("apply_ddl", { sql: "CREATE TABLE t_oauth_restarted (id integer PRIMARY KEY);" }),
			], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("Created after restart.")]),
		]);
		await runtime2.sendMessage(conv2.id, "Create t_oauth_restarted", "gpt-4o");
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
		await runtime2.sendMessage(conv1.id, "Create t_api_still_works", "gpt-4o");
		expect(receivedKeys[receivedKeys.length - 1]).toBe(openaiApiKey);
		expect(workspace.getState().design?.tables.map((t) => t.name)).toContain("t_api_still_works");

		// Conversation 2 (whose connection was removed) throws error asking for a model
		await expect(runtime2.sendMessage(conv2.id, "Should fail", "gpt-4o")).rejects.toThrow(/connection for this conversation was removed/i);

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
});
