/**
 * Differential fixtures for the Assistant's conversation store (`assistant-store.ts`): random
 * sessions of creating, appending to, renaming, retargeting and deleting conversations across two
 * Projects, with usage, observations and settings. After every call the answer is recorded with the
 * full state of both Projects' conversations. The clock and the ids a call would invent are fixed.
 *
 * Run from the repository root: bun tauri/fixtures/generate-assistant-store.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesignStore } from "../../src/bun/store";
import { openAssistantStore } from "../../src/bun/assistant-store";
import { seededRng } from "./lib/mutate";

const emptyDesign = { tables: [], relationships: [], manyToManyRelationships: [], viewport: { x: 0, y: 0, zoom: 1 } };

type Step = { op: string; args: unknown; result: unknown; state: unknown };

async function session(seed: number, length: number): Promise<Step[]> {
	const directory = mkdtempSync(join(tmpdir(), "db-planner-assistant-"));
	const realNow = Date.now;
	let clock = 5000;
	Date.now = () => (clock += 7);
	try {
		const path = join(directory, "assistant.sqlite");
		const designs = openDesignStore(path);
		for (const id of ["p1", "p2"]) designs.createProject({ id, name: id }, emptyDesign as never, { revision: 1, documentRevision: 1, savedAt: 1 }, `d-${id}`);
		const store = openAssistantStore(path);
		const rng = seededRng(seed);
		const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
		const steps: Step[] = [];
		const ids: string[] = [];
		const snapshot = () => {
			const projects = ["p1", "p2"].map((project) => ({ project, conversations: store.listConversations(project), latest: store.getLatestConversation(project)?.id ?? null }));
			return { projects, records: ids.map((id) => store.loadConversation(id)), defaults: store.getDefaultSelection(), cap: store.getMaxRequestsPerTurn() };
		};
		const record = (op: string, args: Record<string, unknown>, run: () => unknown) => {
			let result: unknown;
			try { result = { ok: run() ?? null }; } catch (error) { result = { error: error instanceof Error ? error.message : String(error) }; }
			steps.push({ op, args, result: JSON.parse(JSON.stringify(result)), state: JSON.parse(JSON.stringify(snapshot())) });
		};
		const texts = ["Add an orders table", "  spaced   out\n\ttext  ", "", "   ", "💥".repeat(100), "x".repeat(200), "é ñ ü", "line one  line two", "a b"];
		const payloads = (): unknown => pick([
			{ role: "user", content: pick(texts) }, { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 3 }, "plain string", 7, null, [1, 2, { id: "x" }],
			{ role: "toolResult", toolCallId: "t1", content: [], details: { nested: { id: 1.5 } }, isError: false }, { text: "Conversation initialized." }, { content: 5 }, { id: "client-id", content: "has id" },
		]);
		const message = (): Record<string, unknown> => {
			const value: Record<string, unknown> = { role: pick(["user", "assistant", "system", "toolResult"]), payload: payloads() };
			if (rng() < 0.4) value.kind = pick(["codex-thread", "opencode-thread", "assistant-context"]);
			if (rng() < 0.15) value.id = pick(["m-1", "m-2"]);
			if (rng() < 0.2) value.created_at = pick([1, 42, 9999]);
			return value;
		};
		const conversation = () => (ids.length === 0 || rng() < 0.06 ? "missing" : pick(ids));
		const target = (): string => pick(["codex", "opencode", "none", "x".repeat(5)]);
		for (let index = 0; index < length; index += 1) {
			const roll = rng();
			const project = pick(["p1", "p2", "p3-missing"]);
			if (roll < 0.17 || ids.length === 0) {
				const options: Record<string, unknown> = {};
				// A conversation made without an id gets a random one, so every call names its own.
				options.id = rng() < 0.15 && ids.includes(`c-${index - 1}`) ? `c-${index - 1}` : `c-${index}`;
				if (rng() < 0.3) options.title = pick(["Custom title", ""]);
				if (rng() < 0.6) Object.assign(options, { connectionId: target(), model: pick(["gpt-5", "default", null]), thinking: pick(["medium", "high", null]) });
				if (rng() < 0.2) options.provider = pick(["openai", null]);
				const first = message();
				record("createConversation", { project, first, options }, () => {
					const created = store.createConversation(project, first as never, options as never);
					if (!ids.includes(created.id)) ids.push(created.id);
					return created;
				});
			} else if (roll < 0.5) {
				const id = conversation();
				const next = message();
				record("appendMessage", { id, message: next }, () => store.appendMessage(id, next as never));
			} else if (roll < 0.58) {
				const id = conversation();
				const title = pick(["Renamed", "", "x".repeat(300)]);
				record("renameConversation", { id, title }, () => store.renameConversation(id, title));
			} else if (roll < 0.64) {
				const id = conversation();
				record("deleteConversation", { id }, () => store.deleteConversation(id));
			} else if (roll < 0.72) {
				const id = conversation();
				const args = { id, connectionId: pick([null, "codex", "opencode"]), model: pick(["gpt-5", "o3", ""]), thinking: pick(["low", "xhigh", "medium"]) };
				record("updateConversationSelection", args, () => store.updateConversationSelection(id, args.connectionId, args.model, args.thinking));
			} else if (roll < 0.77) {
				const args = { connectionId: pick([null, "codex"]), model: pick(["gpt-5", "o3"]), thinking: pick(["low", "high"]) };
				record("updateDefaultSelection", args, () => store.updateDefaultSelection(args.connectionId, args.model, args.thinking));
			} else if (roll < 0.82) {
				const limit = pick([1, 40, 500, 0, 501, 2.5, -3, 12]);
				record("setMaxRequestsPerTurn", { limit }, () => store.setMaxRequestsPerTurn(limit));
			} else if (roll < 0.88) {
				const id = conversation();
				const revision = Math.floor(rng() * 20);
				record("observeProjectRevision", { id, revision }, () => store.observeProjectRevision(id, revision));
			} else if (roll < 0.93) {
				const id = conversation();
				const revision = Math.floor(rng() * 20);
				const text = pick(["snapshot a", "snapshot b", ""]);
				record("observeProjectSnapshot", { id, snapshot: text, revision }, () => store.observeProjectSnapshot(id, text, revision));
			} else {
				const id = conversation();
				const usage = { inputTokens: Math.floor(rng() * 1000), outputTokens: Math.floor(rng() * 500), cacheReadTokens: Math.floor(rng() * 100), cost: pick([null, 0.25, 1.5]) };
				const turnId = pick(["t1", "t2", "t3"]);
				record("saveTurnUsage", { id, turnId, usage }, () => store.saveTurnUsage(id, turnId, usage));
			}
		}
		store.close();
		designs.close();
		return steps;
	} finally {
		Date.now = realNow;
		rmSync(directory, { recursive: true, force: true });
	}
}

const sessions = [] as Array<{ name: string; steps: Step[] }>;
for (let index = 1; index <= 10; index += 1) sessions.push({ name: `a${index}`, steps: await session(index * 7717, 80) });
mkdirSync(join(import.meta.dir, "data"), { recursive: true });
writeFileSync(join(import.meta.dir, "data/assistant-store.json"), `${JSON.stringify(sessions)}\n`);
const all = sessions.flatMap((entry) => entry.steps);
console.log(`assistant store: ${sessions.length} sessions, ${all.length} calls, ${all.filter((step) => (step.result as any).error).length} refused`);
