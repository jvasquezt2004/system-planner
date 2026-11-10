/**
 * Writes the harness system prompt from the original, as the Assistant gives it to Codex and OpenCode
 * (minus the two sentences that depend on the Project folder, which the runtime adds). The text is
 * embedded in the Rust crate, so it cannot drift from the original.
 *
 * Run from the repository root: bun tauri/fixtures/export-assistant-prompt.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SYSTEM_PROMPT, harnessSystemPrompt } from "../../src/bun/assistant-runtime";
import { CUSTOM_ICONS } from "../../src/shared/component-catalog";
import { SYSTEM_COMPONENT_KINDS, SYSTEM_CONNECTION_SIDES } from "../../src/shared/system-design";

const prompt = harnessSystemPrompt(SYSTEM_PROMPT).replace("and use only its project tools", "and use the Project tools for Project content");
writeFileSync(join(import.meta.dir, "../src-tauri/crates/assistant/data/harness-prompt.txt"), prompt);
console.log(`assistant prompt: ${prompt.length} characters`);

// The values the tool schemas list, so the Rust schemas cannot drift from the original's.
writeFileSync(
	join(import.meta.dir, "../src-tauri/crates/assistant/data/tool-enums.json"),
	`${JSON.stringify({ componentKinds: SYSTEM_COMPONENT_KINDS, customIcons: CUSTOM_ICONS, connectionSides: SYSTEM_CONNECTION_SIDES })}\n`,
);
