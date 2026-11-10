# 3. The Assistant only mounts over Codex and OpenCode

Status: accepted (2026-11-09), for the Tauri rewrite.

## Context

The Electrobun app had two kinds of Assistant: its own agent (a model runtime with provider API keys,
account sign-in, prompt compaction and its own tool loop) and two external harnesses, Codex and
OpenCode, that work in a copy of the Project on disk and call back into the app through Project tools.
The own agent turned out not to be useful, and it is the source of most of the Assistant's code and
of everything that stores credentials.

## Decision

1. **Only the harnesses stay.** The rewrite has no model runtime, no provider connections, no API keys,
   no account sign-in, no Claude opt-in and no prompt compaction. The harness owns the model, the
   conversation memory and its credentials; the app owns the Project.
2. **The Project is the boundary.** A harness can read the Project, and change it only through
   Project tools (System design, Walkthroughs, Scenarios and Edge functions, `apply_schema`) or by
   editing a Design's `schema.sql` in the Project folder and calling `apply_schema`. Everything else in
   the folder is a read-only copy. A harness's own file edits, shell commands and web access are its
   own and are never part of Revert.
3. **One Project change per turn.** Everything an Assistant turn changes is one history action, so one
   Undo or one Revert takes back the whole turn. The designer's own edits made during the turn are kept.
4. **Own database file.** The rewrite keeps its own SQLite file. It does not read or write the Electrobun
   app's database, and nothing is migrated from it: the Electrobun app is removed once the rewrite has
   parity. Conversations are stored with the Project data in that file.
5. **The view is unchanged.** The sidebar, transcript and request panels are the existing React code.
   The backend therefore produces the events and stored messages they already render
   (`assistant-transcript.ts` is the contract), and answers the same requests.
6. **The harness is a process we start, not configuration we change.** Codex runs as
   `codex app-server` over stdio, private to the app, and the user's Codex configuration is never
   modified. OpenCode is reached through its own server with the Project tools served to it over a
   loopback MCP endpoint guarded by a random bearer token that lives only as long as the harness.
7. **Tools are checked, not trusted.** Tool arguments are validated against the tool's schema before
   anything runs; calls from another thread or turn are refused; tool calls on one Project never run
   concurrently.

## Consequences

- The own agent is not ported at all, and the "Provider connections"
  strip in the sidebar is replaced by the two harnesses' status; the model picker lists both harnesses' models.
- Reading an edited `schema.sql` back into a Design (`apply_schema`) needs a PostgreSQL parser. The
  rewrite uses libpg_query through the `pg_query` crate, so the parse matches the server's.
- The Assistant cannot be verified end to end without Codex or OpenCode installed. The protocol layers
  are tested against a fake app-server; the Project tools and the store are tested against the original's
  behaviour with recorded sessions.

## Order of work

Progress, 2026-11-10: all eight steps are done. A real Codex turn and a real OpenCode turn each edited `schema.sql`, called `apply_schema` and were reverted in the app. The sidebar's provider section was replaced by the two harnesses' status. Left out on purpose: the DDL drop-confirmation flow (only `apply_ddl` used it) and TypeScript diagnostics in `manage_code`.

1. Conversation store (same tables, trimmed of everything provider-related), checked against the original.
2. Codex app-server client and session, tested against a fake server.
3. Turn orchestration: events to the view, stored messages, stop, status, requests the harness raises.
4. Project tools: read, System design, Walkthroughs, code (Scenarios and Edge functions).
5. Turn tracking and Revert.
6. `apply_schema` and the DDL translation.
7. OpenCode and its MCP endpoint.
8. `run_scenarios`, once Scenario runs exist.
