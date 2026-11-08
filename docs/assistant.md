# Assistant

The Assistant can run an installed Codex CLI inside the Project sidebar. The
app launches a private `codex app-server` process and attaches its Project
tools to the app's thread; it does not install a global MCP server or modify
Codex configuration. Codex uses its own sign-in, default model, tools, and
configuration. Install the CLI on the desktop app's `PATH` and run `codex
login` before selecting **Codex (default model)** or another Codex model. The settings panel reports
whether Codex is available and signed in. The model list comes live from Codex (`model/list`), so new models appear without an app update, and the effort selector offers the efforts each selected model supports (including `ultra` where available); the choice is sent as `effort` on every turn. Existing provider connections and
their Conversations remain available.

The app stores the Codex thread ID with the Conversation and resumes it after a
restart. Codex starts in the user's home directory, so its own sandbox,
permissions, and configured tools govern access to files and commands there.
The sidebar presents command, file, and additional-permission requests and
Codex questions. MCP form, URL, and native user-verification requests are
supported when the installed Codex and platform provide them. Project tools use
the same target checks, destructive DDL confirmation, and Project turn history
as the existing Assistant. Revert covers Project changes, not external file or
shell effects. Stopping keeps already-applied changes.

Start a new Conversation when switching between Codex and a provider
connection. Their histories are managed by different runtimes; switching
Codex models within a Conversation is supported.

The Codex app-server dynamic-tool interface is experimental; the installed CLI
must support it. Codex owns its thread context and compaction, and the app uses
the CLI's configured reasoning settings. The provider-specific
request cap, model picker, and usage accounting described below apply to the
existing provider runtime, not to Codex.

The default-model choice captures the CLI's configured model when the Codex
thread is created. Start a new Conversation to pick up a changed CLI default.

## Existing provider runtime

The existing provider runtime uses `pi-agent-core` in the Bun main process. Conversations and transcript messages are stored in the application SQLite database; messages retain model tool calls and results. Deleting a project cascades its conversations. Provider credentials are kept outside SQLite through Bun's OS secret store. On Windows only, an unavailable secret-store operation falls back to a sibling `.assistant-credentials.dpapi` file containing current-user DPAPI ciphertext; the API key is supplied to PowerShell over stdin, not a command-line argument or plaintext file. No plaintext fallback exists.

The provider model picker uses the pi-ai catalogs. Model and thinking selections persist per conversation and as the defaults for new conversations. Every conversation uses its own stable ID as the pi-agent-core session ID and is bound to its project at message, tool, and confirmation boundaries. Each turn is also bound to the design that was open when it started: a tool or confirmation refuses rather than retargeting if another design is opened during the turn, and Revert restores only that design, refusing until it is open again. The system prompt and tool definitions are fixed; the current project is read through `read_project` before changes. Before a user message, the runtime compares the full schema/design snapshot (including column notes), Scenarios, and Edge function definitions with the last observed snapshot; a change note is appended to both the persisted transcript and the live agent context. Transcript writes are append-only.

`read_project` returns the authoritative design, freshly generated PostgreSQL SQL (including column notes as `COMMENT ON COLUMN`), sandbox state, Functions, Triggers, Policies, Scenarios, Edge functions, and Scenario run results. `apply_ddl` uses the pure-WASM `libpg-query` parser and applies the supported subset as one workspace change. Unsupported or invalid DDL fails without partially applying a batch. A destructive drop with dependents pauses the turn until a one-shot confirmation bound to the displayed project, revision, target set, and complete removal plan. Changes within one Assistant turn share one undo entry even across intervening hand edits; those hand edits remain independently undoable. New tables are laid out without moving existing cards.

The sidebar renders saved messages and live pi events through one transcript model. Text deltas update one in-progress assistant message; tool execution events update expandable cards with a running state. Assistant text parts are shown without provider signatures or non-text content. Sending the first message creates its Conversation and titles it from that message. Destructive-change cards derive their actionable state from persisted confirmation events plus the runtime's live pending state; after restart unresolved cards are no longer actionable. Cards list the Relationships and constraints in the removal plan. Revert is offered only when the latest Assistant turn changed project content, ignoring viewport changes. Revert restores the Assistant turn's project artifacts atomically and preserves independent manual edits that arrive while persistence is pending.

## Code tools

`manage_code` creates, renames, and removes Scenarios and Edge functions, and writes or exact-string-edits their TypeScript source or a design Function body. Exact-string edits must find one occurrence; zero or multiple matches return the observed count without saving. Source writes use the existing workspace actions, preserving autosave, save-failure state, and stale-save protection. Each Assistant tool call captures and returns its Project and active Design IDs; mutations carry those IDs and reject results if either target changes while the operation is pending.

After every Scenario or Edge function source write, the Bun runtime checks the source with the TypeScript compiler API using the shared declaration generators and module-path declarations from `src/shared/scenario-types.ts` and `src/shared/edge-function-types.ts`, the same definitions used by Monaco. Function bodies are SQL and return an explicit note that TypeScript diagnostics do not apply. Function-body writes use the Assistant design-history path, so they undo and redo together with other design changes in that turn. The transcript displays source changes as diff cards linked to the corresponding editor. TypeScript standard-library declarations and the referenced Supabase package declarations are copied beside the bundled main process; runtime diagnostics resolve them there in packaged apps and from the repository root in development/tests. The documented Sandbox API subset in [sandbox-api.md](sandbox-api.md) is included in the fixed system prompt; prompt text and tool definitions do not vary by request.

## Scenario runs

`run_scenarios` starts one saved Scenario or all saved Scenarios through the view's Scenario run driver and waits for completion. Each run carries its originating Project and Design IDs plus schema, Scenario-source, and Edge-function revisions; a target switch or source edit cannot attach a late result to another Design, and revision changes mark a completed run stale. Runs use the same workspace lifecycle as manual runs, remain visible and stale in the Scenarios view, and queue behind an active run. The tool returns run status and staleness, up to 20 failed expectations, at most 20 trailing console lines, a request summary capped at 50 request kinds, and up to three sampled rows for each of ten result grids; neither the run tool nor `read_project` sends whole grids to the model. Stop is reported as `stopped`; transcript run cards link back to the saved Scenario.

The model-request cap defaults to 40 requests per Assistant turn and is adjustable from the Assistant settings (1–500). The cap is stored in application SQLite and survives restarts. While a turn is streaming, the composer accepts steering messages; pi-agent-core delivers them after the current tool call. Stop aborts the turn without undoing already-applied project changes.

## Credential verification

The Windows credential fallback is platform-specific and cannot be exercised by the Linux test suite. Before release, build and run the packaged Windows application and verify both paths: with Bun's secret store available, save/restart/read/remove an Anthropic key and confirm no key appears in SQLite; with the store unavailable, repeat and confirm the adjacent fallback file contains only DPAPI ciphertext, can be decrypted only by the same Windows user, and is removed on credential deletion. Do not use a live provider call for this storage check.

## OpenCode

The Assistant can also run an installed OpenCode. The app launches a private
`opencode serve` on loopback with a random password for each Conversation. The
Project tools reach it through a loopback MCP server (random port and bearer
token) that is passed to that process by environment, so OpenCode's own
configuration files and other OpenCode sessions never see them. The Assistant's
instructions are attached to the session, not to global config. OpenCode runs in
the Project folder (see below) and keeps its own providers, models,
MCP servers, skills and permissions; its permission prompts appear in the
sidebar. The model list and each model's reasoning variants come from OpenCode
itself, and the effort selector offers only what the chosen model supports.
Install OpenCode and run `opencode auth login` first. Questions from either
harness (OpenCode forms, Codex's `request_user_input` and simple MCP form
prompts) appear in the sidebar as one form with text, choice, number, yes/no and
multi-select fields; **Skip** tells the harness the question was cancelled.
Answers are validated against the form before they are sent. Claude Code is not offered; see ADR-0014.

## Project folder

While the app is open, the open Project is mirrored to
`~/Schema Designer/<project>/` (override with `DB_PLANNER_PROJECTS_PATH`):
`system-design.md`, `walkthroughs.json`, and per Design `schema.sql`, scenarios
and edge functions. The database stays authoritative. Everything is a read-only
copy, rewritten as the Project changes, except each Design's `schema.sql`, which
is the way Codex and OpenCode change the schema: they edit the file with their own
file tools and call the `apply_schema` tool, which reads it back into the Design
(see SQL below). An edit that has not been applied is never overwritten. Codex and
OpenCode run with this folder as their working directory. Folders of deleted
Projects are left in place. **Show project folder** (Project menu, and a button in the
Assistant sidebar) syncs the folder and opens it in the system file manager.

## SQL

The schema is PostgreSQL (ADR-0015). Statements the Design models become tables,
columns, indexes, enum types, functions, triggers, policies and comments. Anything
else, such as views, sequences, domains, extensions, `CHECK` constraints,
expression indexes, or tables using them, is kept as raw SQL in the Design and
runs with the generated schema. PostgreSQL checks the result on a throwaway
database first, so a rejected statement changes nothing. Data statements are not
part of a Design; use a Scenario. Tables kept as raw SQL do not appear on the canvas.

- **Codex and OpenCode** edit `designs/<design>/schema.sql` and call `apply_schema`.
  The file is read by name: tables, columns and the rest that still exist keep their
  identity, canvas position and notes, so adding a column or deleting an index line
  changes only that. Renaming something in the file reads as a removal plus an
  addition. An empty file is refused rather than deleting the schema. The file is
  rewritten from the Design after each apply.
- **Provider connections** have no files, so they send statements through
  `apply_ddl`; `ALTER TYPE`, `DROP INDEX`, `DROP TYPE` and `IF [NOT] EXISTS` work,
  `DROP INDEX` also accepts the generated name of an editor-made index or a unique
  constraint, and `DROP` removes SQL kept for an object.

## Project files

**Attach** in the Assistant sidebar adds files to the open Project (ADR-0016): a
specification, a PDF, notes. They give the Assistant background about a feature
without pasting it into the chat. Text is read from PDF and plain-text files when
they are attached; images, scanned PDFs, password-protected PDFs and Word
documents are kept and marked "no text". Limits are 20 MB per file and 50 per
Project, and Project export does not include them.

- **Codex and OpenCode** find them in the Project folder under `context/`; a PDF
  also has a `.txt` copy beside it. They are read-only copies.
- **Provider connections** read them with `read_project_file`: with no arguments
  it lists the files, with a name it returns the text in parts of about 30,000
  characters.

The Assistant is told to use the files as reference and never to follow
instructions written inside them.
