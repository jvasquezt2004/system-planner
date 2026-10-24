import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

const SERVICE = "com.dbplanner.schema-designer";
const NAME_BY_PROVIDER: Readonly<Record<string, string>> = {
	anthropic: "anthropic-api-key",
	openai: "openai-credential",
	google: "google-credential",
};

function credentialSecretName(providerId: string): string {
	return NAME_BY_PROVIDER[providerId] ?? `${providerId}-credential`;
}
const PROTECT_SCRIPT = "$ErrorActionPreference='Stop'; $plain=[Console]::In.ReadToEnd(); $secure=ConvertTo-SecureString -String $plain -AsPlainText -Force; [Console]::Out.Write((ConvertFrom-SecureString -SecureString $secure))";
const UNPROTECT_SCRIPT = "$ErrorActionPreference='Stop'; $cipher=[Console]::In.ReadToEnd().Trim(); $secure=ConvertTo-SecureString -String $cipher; $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }";

/** pi-ai credential storage uses Bun.secrets; DPAPI ciphertext is the Windows fallback. */
export class BunSecretCredentialStore implements CredentialStore {
	private readonly writes = new Map<string, Promise<unknown>>();
	private readonly seenProviders = new Set<string>();
	private readonly fallbackPath: string | null;
	constructor(databasePath?: string) {
		this.fallbackPath = databasePath ? `${databasePath}.assistant-credentials.dpapi` : null;
	}

	async read(providerId: string, options?: { signal?: AbortSignal }): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const name = credentialSecretName(providerId);
		let raw: string | null;
		try {
			raw = await Bun.secrets.get({ service: SERVICE, name });
		} catch (error) {
			if (process.platform !== "win32") throw error;
			raw = null;
		}
		if (!raw) {
			const encrypted = this.readFallback(name);
			if (encrypted) {
				raw = await runDpapi(encrypted, false);
			}
		}
		if (!raw) return undefined;
		this.seenProviders.add(providerId);
		try {
			const parsed: unknown = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && "type" in parsed && (parsed.type === "api_key" || parsed.type === "oauth")) {
				return parsed as Credential;
			}
		} catch {
			// Plain legacy API key string
		}
		return { type: "api_key", key: raw };
	}

	async list(options?: { signal?: AbortSignal }): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const providerCandidates = new Set(["anthropic", "openai", "google", ...this.seenProviders]);
		if (this.fallbackPath && existsSync(this.fallbackPath)) {
			try {
				const parsed: unknown = JSON.parse(readFileSync(this.fallbackPath, "utf8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					for (const key of Object.keys(parsed)) {
						const matched = Object.entries(NAME_BY_PROVIDER).find(([, val]) => val === key)?.[0];
						if (matched) providerCandidates.add(matched);
						else if (key.endsWith("-credential")) providerCandidates.add(key.slice(0, -"-credential".length));
					}
				}
			} catch {
				// ignore malformed fallback listing
			}
		}
		const results: CredentialInfo[] = [];
		for (const providerId of providerCandidates) {
			const credential = await this.read(providerId, options);
			if (credential) results.push({ providerId, type: credential.type });
		}
		return results;
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: { signal?: AbortSignal },
	): Promise<Credential | undefined> {
		const name = credentialSecretName(providerId);
		const previous = this.writes.get(providerId) ?? Promise.resolve();
		let result: Credential | undefined;
		const write = previous.then(async () => {
			options?.signal?.throwIfAborted();
			const current = await this.read(providerId, options);
			result = await fn(current);
			if (result !== undefined) {
				const serialized = JSON.stringify(result);
				try {
					await Bun.secrets.set({ service: SERVICE, name, value: serialized });
					this.removeFallback(name);
					this.seenProviders.add(providerId);
				} catch (error) {
					if (process.platform !== "win32" || !this.fallbackPath) throw error;
					this.writeFallback(name, await runDpapi(serialized, true));
					this.seenProviders.add(providerId);
				}
			} else {
				result = current;
			}
		});
		this.writes.set(providerId, write);
		try {
			await write;
			return result;
		} finally {
			if (this.writes.get(providerId) === write) this.writes.delete(providerId);
		}
	}

	async delete(providerId: string, options?: { signal?: AbortSignal }): Promise<void> {
		const name = credentialSecretName(providerId);
		const previous = this.writes.get(providerId) ?? Promise.resolve();
		const write = previous.then(async () => {
			options?.signal?.throwIfAborted();
			try {
				await Bun.secrets.delete({ service: SERVICE, name });
			} catch (error) {
				if (process.platform !== "win32" || !this.fallbackPath) throw error;
			}
			this.removeFallback(name);
			this.seenProviders.delete(providerId);
		});
		this.writes.set(providerId, write);
		try {
			await write;
		} finally {
			if (this.writes.get(providerId) === write) this.writes.delete(providerId);
		}
	}

	private readFallback(name: string): string | null {
		if (!this.fallbackPath || !existsSync(this.fallbackPath)) return null;
		const parsed: unknown = JSON.parse(readFileSync(this.fallbackPath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("The DPAPI credential record is malformed.");
		const encrypted = Object.entries(parsed).find(([key]) => key === name)?.[1];
		if (typeof encrypted !== "string") throw new Error("The DPAPI credential record is malformed.");
		return encrypted;
	}

	private writeFallback(name: string, encrypted: string): void {
		if (!this.fallbackPath) throw new Error("DPAPI fallback storage is unavailable.");
		const stored = new Map<string, string>();
		if (existsSync(this.fallbackPath)) {
			const parsed: unknown = JSON.parse(readFileSync(this.fallbackPath, "utf8"));
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The DPAPI credential record is malformed.");
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value !== "string") throw new Error("The DPAPI credential record is malformed.");
				stored.set(key, value);
			}
		}
		stored.set(name, encrypted);
		writeFileSync(this.fallbackPath, JSON.stringify(Object.fromEntries(stored)), { mode: 0o600 });
	}

	private removeFallback(name: string): void {
		if (!this.fallbackPath || !existsSync(this.fallbackPath)) return;
		const parsed: unknown = JSON.parse(readFileSync(this.fallbackPath, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The DPAPI credential record is malformed.");
		const stored = new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
		stored.delete(name);
		if (stored.size === 0) unlinkSync(this.fallbackPath);
		else writeFileSync(this.fallbackPath, JSON.stringify(Object.fromEntries(stored)), { mode: 0o600 });
	}
}

async function runDpapi(value: string, protect: boolean): Promise<string> {
	const child = Bun.spawn([
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		protect ? PROTECT_SCRIPT : UNPROTECT_SCRIPT,
	], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	child.stdin.write(value);
	child.stdin.end();
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`Windows DPAPI credential operation failed: ${stderr.trim() || `exit ${exitCode}`}`);
	const result = protect ? stdout.trim() : stdout;
	if (!result) throw new Error("Windows DPAPI returned an empty credential.");
	return result;
}
