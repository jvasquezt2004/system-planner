# Feature parity: Tauri rewrite against the Electrobun app

Compared on 2026-11-09 at the head of the `rewrite` branch. The Electrobun app is the oracle; the
Assistant's own agent runtime (providers, API keys, OAuth, its tools) is out of scope by decision. The
Assistant will only mount over Codex and OpenCode.

How it was checked: every request and message in `AppRPCSchema` (`src/shared/rpc.ts`) against what the
Rust backend answers, then each feature against the evidence that backs it. "Verified" means a
differential fixture or oracle session recorded from the TypeScript code and replayed in Rust.

**Result: not at parity yet.** The remaining gaps are OpenCode and packaging; the
provider flows are dropped by decision. (The request audit has not been rerun since the Assistant
work; it was 93 of 119 before.)

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
| Scenario runs: the PostgREST emulation over the sandbox (filters, embeds, writes, upserts, RPC, roles and RLS), run lifecycle, result grids, request log | Scenario API fixtures (379 requests against the original, 41 of them refusals); run lifecycle test; run in the real window |
| Attached Project files (list, remove, attach, text for plain files and PDFs) | project-files fixtures; PDFs tested separately (a different extractor) |
| Project folder (the readable copy of the Project on disk, Reveal Project folder) | rendering fixtures on recorded Projects; sync behaviour tested directly |
| Existing databases open unchanged (schema, migrations, legacy shapes) | store fixtures including legacy databases |

## Not done

| Area | What is missing | Size |
| --- | --- | --- |
| **Assistant over Codex** (ADR 0003) | Working: conversations (own database), turns in the Project folder, streamed messages and tool use as events, the harness's questions as forms (637 cases against the original), approvals, stop, steering, status, model listing, Revert of a turn, and a real Codex run (opt-in test: one turn that calls `read_project`). Project tools: `read_project`, `read_system_design`, `edit_system_design` (layout engine checked over 11k cases), `read_walkthroughs`, `edit_walkthroughs`, `manage_code` (without TypeScript diagnostics), `apply_schema` (the DDL translation matches the original on 1.7k scripts and 874 file edits). `run_scenarios` (the view runs the code; checked with a fake view and with a real Codex turn). A real Codex turn in the app edited `schema.sql`, called `apply_schema` and `run_scenarios`, and Revert took it back. **Not done:** the DDL drop-confirmation flow (only `apply_ddl` used it, which harnesses do not have), and OpenCode (its harness and tool endpoint; selecting it reports that it is unavailable). | medium |
| Dropped by decision | provider API keys, OAuth login, connections, Claude opt-in, the Assistant's own models. The view still shows a "Provider connections" strip that should be replaced when the harness work lands. | small, with the harness |
| Packaging | CI builds on three platforms (untested until it runs); icons, signing, updater and the data location are undecided. The rewrite keeps its own database (`…/tauri-dev/schema-designer.sqlite`); sharing the Electrobun app's database is a cutover decision. | medium |

## Fixed rather than copied

Reading `schema.sql` back into a Design (`apply_schema`) differs from the original where the original
mis-reads what PostgreSQL's parser says (the parser's JSON leaves out zero, `false` and empty values,
and one field is looked up under the wrong name):

- `DEFAULT 0` and `DEFAULT false` are stored as the text `[object Object]`; here they keep their value.
- `numeric(10, 0)` keeps the whole table as raw SQL; here it is a numeric column with scale 0.
- Any Function with parameters is kept as raw SQL; here its parameters are read.
- A column's `COLLATE` is dropped without a trace; here the table is kept as raw SQL so it survives.
- Timestamps in the sandbox are in UTC (the original follows the machine's time zone); result-grid cells show PostgreSQL's text form of a timestamp.
- A Scenario run whose view went away (a page reload) is given up on after 45 seconds instead of blocking the next run for good.
- A comment above a statement stays with it, as in the original, but the parser is PostgreSQL 18's
  (the original's is 17).

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

- The Assistant with OpenCode, and with Codex beyond the one turn above.
- Real dialogs and the clipboard: the pickers and clipboard are behind a trait and tested with fakes.
  They compile and the app starts with them, but nothing has driven them in the window.
- Native clicks and typing: the window was driven through a debug-only bridge that runs scripts inside it, not through the desktop's input.
- Windows and macOS builds.
