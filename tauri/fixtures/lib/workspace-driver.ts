/**
 * Drives the real TypeScript workspace the way the view does, with everything that would make two
 * runs differ made deterministic: a stubbed sandbox, a clock the driver sets before each call, and
 * ids numbered per call. The Rust workspace is replayed through the same calls and must agree on
 * every settled state and on the sequence of states pushed along the way.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createDesignWorkspace, type DesignWorkspace } from "../../../src/bun/workspace";
import type { SchemaSandbox } from "../../../src/bun/sandbox";
import type { WorkspaceState } from "../../../src/shared/design";

/**
 * A sandbox that reports what a design would build without a database: one table per
 * `CREATE TABLE`, with its columns. Table names containing `reject_me` or `boom` fail, so the
 * failed sandbox states are exercised too.
 */
export function stubSandbox(): SchemaSandbox {
	return {
		async apply(sql) {
			if (sql.includes("reject_me")) return { ok: false, failure: "sql-rejected", error: "stub: rejected" };
			if (sql.includes("boom")) return { ok: false, failure: "sandbox-error", error: "stub: boom" };
			const tables = [...sql.matchAll(/CREATE TABLE "((?:[^"]|"")*)" \(\n([\s\S]*?)\n\);/g)].map((match) => ({
				name: match[1]!.replace(/""/g, '"'),
				columns: [...match[2]!.matchAll(/^ {2}"((?:[^"]|"")*)" (\S+)/gm)].map((column) => ({
					name: column[1]!.replace(/""/g, '"'),
					dataType: column[2]!,
					isIdentity: false,
					defaultExpression: null,
					nullable: true,
					primaryKey: false,
					unique: false,
				})),
			}));
			return { ok: true, tables, relationships: [] };
		},
		async dispose() {},
	};
}

/** FNV-1a 64-bit over UTF-8, shared with the Rust replay. */
export function fnv(text: string): string {
	let hash = 0xcbf29ce484222325n;
	for (const byte of new TextEncoder().encode(text)) {
		hash ^= BigInt(byte);
		hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
	}
	return hash.toString(16).padStart(16, "0");
}

/** JSON with sorted keys, so two runs that built the same value in different key order still agree. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** The part of a pushed state that shows what changed and when: revisions and statuses. */
export function trailEntry(state: WorkspaceState): string {
	const status = (value: { status?: string } | undefined) => value?.status ?? "-";
	return [
		`rev${state.revision}`,
		`save:${status(state.save)}`,
		`sql:${status(state.sql)}`,
		`sandbox:${status(state.sandbox)}`,
		`system:${status(state.systemSave)}`,
		`walkthrough:${status(state.walkthroughSave)}`,
		`view:${state.activeView}`,
		`design:${state.activeDesignId ?? "-"}`,
	].join(" ");
}

/** Per top-level field fingerprints of a state, which is what the fixtures store. */
export function fingerprints(state: unknown): Record<string, string> {
	return Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(state)) as Record<string, unknown>).map(([key, value]) => [key, fnv(canonical(value))]));
}

export type StepOutcome =
	| { ok: { fields: Record<string, string> } }
	| { ok: { value: unknown } }
	| { error: string };

/** Methods whose request carries a bare id and whose answer is a plan, not a state. */
const PLAN_METHODS: Record<string, (params: any) => unknown> = {
	describeSystemServiceRemoval: (params) => params.serviceId,
	describeSystemComponentRemoval: (params) => params.componentId,
	describeSystemConnectionRemoval: (params) => params.connectionId,
	describeRemoval: (params) => params,
};

export type Driver = {
	workspace: DesignWorkspace;
	/** Runs one call as the view would, returning its outcome, the full settled state, and the pushes it caused. */
	run(method: string, params: unknown, step: number): Promise<{ outcome: StepOutcome; state: WorkspaceState; trail: string[] }>;
	close(): Promise<void>;
};

export async function openDriver(directory: string): Promise<Driver> {
	mkdirSync(directory, { recursive: true });
	let clock = 1_000_000;
	let step = 0;
	let counter = 0;
	const workspace = await createDesignWorkspace({
		databasePath: join(directory, "workspace.sqlite"),
		createSandbox: stubSandbox,
		now: () => clock,
		createId: () => `id-${step}-${++counter}`,
	});
	let trail: string[] = [];
	workspace.subscribe((state) => trail.push(trailEntry(state)));
	return {
		workspace,
		async run(method, params, index) {
			clock = 1_000_000 + index * 1000;
			step = index;
			counter = 0;
			trail = [];
			let outcome: StepOutcome;
			try {
				const call = (workspace as unknown as Record<string, (arg: unknown) => unknown>)[method];
				if (!call) throw new Error(`The workspace has no ${method}.`);
				const plan = PLAN_METHODS[method];
				const result = await call.call(workspace, plan ? plan(params) : params);
				outcome = plan ? { ok: { value: JSON.parse(JSON.stringify(result)) } } : { ok: { fields: fingerprints(result) } };
			} catch (error) {
				outcome = { error: error instanceof Error ? error.message : String(error) };
			}
			return { outcome, state: JSON.parse(JSON.stringify(workspace.getState())) as WorkspaceState, trail };
		},
		close: () => workspace.close(),
	};
}
