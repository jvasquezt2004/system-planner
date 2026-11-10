# Feature parity: the Tauri app against the Electrobun app it replaced

Compared on 2026-11-10 at the head of the `rewrite` branch, before the Electrobun app and its TypeScript backend were removed (last commit that has them: `2e78461`). It was the oracle; the
Assistant's own agent runtime (providers, API keys, OAuth, its tools) is out of scope by decision. The
Assistant will only mount over Codex and OpenCode.

How it was checked: every request and message in `AppRPCSchema` (`src/shared/rpc.ts`) against what the
Rust backend answers, then each feature against the evidence that backs it. "Verified" means a
differential fixture or oracle session recorded from the TypeScript code and replayed in Rust.

**Result: at parity, with the gaps listed below.** All 119 requests of the original's RPC contract are answered (the provider flows were removed from the contract and the view). What is not done is listed under "Not done" and "Not tested".

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
| Assistant over Codex and OpenCode (ADR 0003) | Conversations in the app's own database (matches the original over 800 calls), turns in the Project folder, streamed messages and tool use, the harness's questions as forms (637 cases), approvals, stop, steering, model and sign-in listing, Revert of a turn. Project tools: `read_project`, `read_system_design`, `edit_system_design` (layout engine over 11k cases), `read_walkthroughs`, `edit_walkthroughs`, `manage_code`, `apply_schema` (DDL translation against the original on 1.7k scripts and 874 edits), `run_scenarios`. Real Codex turn in the app (edited `schema.sql`, `apply_schema`, `run_scenarios`, Revert); real OpenCode turn through the loopback MCP endpoint (opt-in test) |
| Attached Project files (list, remove, attach, text for plain files and PDFs) | project-files fixtures; PDFs tested separately (a different extractor) |
| Project folder (the readable copy of the Project on disk, Reveal Project folder) | rendering fixtures on recorded Projects; sync behaviour tested directly |
| Existing databases open unchanged (schema, migrations, legacy shapes) | store fixtures including legacy databases |

## Not done

| Area | What is missing | Size |
| --- | --- | --- |
| TypeScript diagnostics for Assistant code edits | `manage_code` writes Scenarios, Edge functions and Function bodies but cannot run the TypeScript compiler, so its result says no diagnostics are available. | small |
| DDL drop confirmation | Only the original's own-agent `apply_ddl` used it; harnesses edit `schema.sql` and call `apply_schema`, which needs no confirmation step. | none for harnesses |
| Release signing and updates | Need certificates and keys; the steps are in `RELEASE.md`. | medium |

Removed by decision (ADR 0003): provider API keys, OAuth sign-in, connections, Claude opt-in, the Assistant's
own models and request cap. The sidebar now shows the two harnesses and their status.

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

- The Assistant with Codex beyond the real turns described above, and with OpenCode beyond one read-only turn.
- Real dialogs and the clipboard: the pickers and clipboard are behind a trait and tested with fakes.
  They compile and the app starts with them, but nothing has driven them in the window.
- Native clicks and typing: the window was driven through a debug-only bridge that runs scripts inside it, not through the desktop's input.
- Windows and macOS builds.
