# Feature parity: Tauri rewrite against the Electrobun app

Compared on 2026-11-09 at the head of the `rewrite` branch. The Electrobun app is the oracle; the
Assistant's own agent runtime (providers, API keys, OAuth, its tools) is out of scope by decision. The
Assistant will only mount over Codex and OpenCode.

How it was checked: every request and message in `AppRPCSchema` (`src/shared/rpc.ts`) against what the
Rust backend answers, then each feature against the evidence that backs it. "Verified" means a
differential fixture or oracle session recorded from the TypeScript code and replayed in Rust.

**Result: not at parity yet.** 93 of 119 requests are answered. Of the 26 that are not, 7 are the
dropped provider flows, 3 are Scenario runs, 1 is gone now (the Project folder), and the rest are the
Assistant harness.

## Done and verified

| Area | Evidence |
| --- | --- |
| Projects and Designs: create, open, rename, create Design, last view, import/export of a Project | workspace oracle (16 sessions, 3.6k calls, plus a transfer session with 160 damaged imports) |
| Database design: tables, columns, types, defaults, relationships (1:n, 1:1, n:m), indexes, enums, unique constraints, Functions, triggers, policies, removals with confirmation | workspace oracle, SQL generation fixtures (642 designs), normalizer fixtures |
| SQL generation and the PostgreSQL sandbox preview (pglite-oxide) | fixtures; real window shows "Accepted rev. 10 / Current rev. 10" |
| System design: Services, Groups, Components, Connections, collapse, focus, viewport, Arrange | workspace oracle, op fixtures |
| Walkthroughs: all edits and repairs | workspace oracle, op fixtures |
| Undo/Redo across Design, System design, Walkthroughs, Scenarios, Edge functions (names, grouping, per design) | history fixtures (1.8k calls), workspace oracle |
| Scenario and Edge function edits (create, rename, remove, edit source) | workspace oracle |
| SQL preview and ORM code: copy and export; System design SVG/PNG export; Project export/import files | transfer fixtures (160 cases) |
| ORM code generation (Prisma, Drizzle, SQLAlchemy, Django) | runs in the view from `src/shared`, unchanged |
| Attached Project files (list, remove, attach, text for plain files and PDFs) | project-files fixtures; PDFs tested separately (a different extractor) |
| Project folder (the readable copy of the Project on disk, Reveal Project folder) | rendering fixtures on recorded Projects; sync behaviour tested directly |
| Existing databases open unchanged (schema, migrations, legacy shapes) | store fixtures including legacy databases |

## Not done

| Area | What is missing | Size |
| --- | --- | --- |
| **Scenario runs** | `beginScenarioRun`, `handleSandboxApiRequest`, `finishScenarioRun` and the result grids: the PostgREST emulation over the sandbox database (`scenario-api.ts`, ~1,000 lines). Scenarios can be written and saved but not run. | large |
| **Assistant over Codex/OpenCode** (ADR 0003) | Done and tested: the conversation store (matches the original over 800 recorded calls), the Codex app-server client and session (against a fake server), and the tool bridge that validates and serialises the harness's calls. Not done: turn orchestration and the events the sidebar renders, the conversation requests (list, create, rename, delete, send, stop, continue, status, revert, DDL confirmation, harness questions), the Project tools themselves (read, System design, Walkthroughs, code, `apply_schema`), turn tracking and Revert, and OpenCode with its MCP endpoint. `apply_schema` needs a PostgreSQL parser. | large |
| Dropped by decision | provider API keys, OAuth login, connections, Claude opt-in, the Assistant's own models. The view still shows a "Provider connections" strip that should be replaced when the harness work lands. | small, with the harness |
| Assistant entry points into the history | `applyAssistantDesign`, `restoreAssistantProjectSnapshot` (they use the history that is already ported) | with the harness |
| Packaging | CI builds on three platforms (untested until it runs); icons, signing, updater and the data location are undecided. The rewrite keeps its own database (`…/tauri-dev/schema-designer.sqlite`); sharing the Electrobun app's database is a cutover decision. | medium |

## Known differences that remain

These are deliberate or not reachable from the view; each is also noted where it arises in `PLAN.md`.

- A hand-damaged design (a column without `nullable`) is refused with a typed error on import; the
  original stores it as it is.
- Objects inside indexes, triggers and policies keep no unknown keys; a policy without `using` or
  `withCheck` gets empty text.
- A list edit that differs from the stored one only in key order is a no-op here and a change there.
- Node's error text for file-system failures is reproduced for the common cases (exists, missing,
  permission, name too long); others read as Rust's.
- A project name cut at the 60-unit limit in the middle of a surrogate pair gives a file name with a
  lone surrogate in the original; here the pair is dropped.

## Not tested

- Real dialogs and the clipboard: the pickers and clipboard are behind a trait and tested with fakes.
  They compile and the app starts with them, but nothing has driven them in the window.
- Clicks and typing in the window (no synthetic input).
- Windows and macOS builds.
