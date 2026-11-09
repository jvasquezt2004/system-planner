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

const prompt = harnessSystemPrompt(SYSTEM_PROMPT).replace("and use only its project tools", "and use the Project tools for Project content");
writeFileSync(join(import.meta.dir, "../src-tauri/crates/assistant/data/harness-prompt.txt"), prompt);
console.log(`assistant prompt: ${prompt.length} characters`);
