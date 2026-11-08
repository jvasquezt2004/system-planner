# Tauri rewrite plan

Status: planning. The Electrobun app in `src/` stays the shipping app until this
folder reaches parity (see "Definition of parity"). Nothing here changes `src/`
until phase 0 deliberately introduces a shared RPC seam.

## Decisions (agreed with the owner)

| Question | Decision |
| --- | --- |
| Frontend | Keep the React/Vite frontend (`src/mainview`, `src/shared` TS). Only the Bun main process (`src/bun`) is rewritten in Rust. |
| Sandbox database | `pglite-oxide` (PGlite WASM under Wasmtime). Prototype first; fall back only if the spike fails. |
| Assistant | Port only the Codex app-server and OpenCode harness paths. The built-in pi-ai/pi-agent-core runtime, provider connections and account OAuth are dropped. **This is an intentional behaviour change**, recorded as an ADR in phase 6. |
| Layout | Self-contained `tauri/` folder on the `rewrite` branch. |

## What exists today

Electrobun app: a Bun main process (`src/bun`, ~16k lines non-test) serving a
React view (`src/mainview`, ~19k lines) over typed RPC (`src/shared/rpc.ts`,
~100 requests, 9 view-to-main messages, 9 main-to-view messages).

| Concern | Today (Bun) | In Rust |
| --- | --- | --- |
| RPC | `electrobun/rpc` | Tauri `#[tauri::command]` + `Channel`/events |
| Persistence | `bun:sqlite` (`store.ts`, `assistant-store.ts`, `project-files.ts`) | `rusqlite`, same file and schema |
| Workspace operations | `workspace.ts` (3.8k lines) | `workspace` module |
| SQL generation | `sql.ts`, `sql-preview.ts` | port; golden-tested against TS output |
| Schema code (Prisma, Drizzle, SQLAlchemy, Django) | `src/shared/schema-code` | port (see "Shared code") |
| SQL parsing | `@pgsql/parser` (libpg_query WASM) | `pg_query` crate (PG 17) |
| Sandbox + Scenario DB | PGlite + pgvector | `pglite-oxide` |
| Sandbox API (PostgREST subset) | `scenario-api.ts` | port |
| Scenario / Edge function execution | webview workers (supabase-js, `typescript`) | **unchanged**, stays in the webview |
| Dialogs, clipboard, open path | `Utils.*` | `tauri-plugin-dialog`, `-clipboard-manager`, `-opener` |
| Project folder mirror | `project-folder.ts` | port |
| Project files (PDF text) | `unpdf` | Rust PDF text extraction crate (choose in phase 5) |
| Assistant harnesses | `codex-app-server.ts`, `opencode-harness.ts`, `opencode-mcp.ts`, `codex-project-tools.ts` | port with `tokio` child processes + a loopback MCP server |
| SVG/PNG export | view renders, main writes the file | main writes the file (trivial) |

Things that stay TypeScript because they run in the webview: React views,
canvases, Monaco, walkthrough playback, scenario and edge-function workers,
`system-design-svg`/`png` rendering.

## Architecture

```
tauri/
  PLAN.md
  package.json          # thin: scripts that run the shared Vite root
  src-tauri/
    Cargo.toml          # workspace root
    tauri.conf.json     # devUrl http://localhost:5173, frontendDist ../../dist
    capabilities/       # dialog, clipboard, opener only
    crates/             # added as phases need them
      domain/           # design, system-design, walkthrough models + operations (serde)
      store/            # rusqlite, migrations, project transfer
      sql/              # SQL generation, pg_query-based tools
      schema-code/      # ORM generators
      sandbox/          # pglite-oxide, Sandbox API emulator
      assistant/        # codex + opencode harnesses, project tools
    src/                # tauri app: commands, state push, window, plugins
```

Frontend wiring: the existing Vite root (`src/mainview`) is reused by path so
there is one UI codebase while both backends exist, and **`src/mainview` is not
modified at all**. `tauri/vite.config.ts` aliases `electrobun/view` and
`electrobun/rpc` to shims in `tauri/shims/` that keep the call shape the view
already uses (`rpc.request.<name>(params)`, `rpc.send.<name>(params)`, message
handlers) and carry it over two Tauri commands, `rpc_request` and
`rpc_message`, with backend pushes arriving as the `rpc-message` event. Rust
dispatches on the method name in `src-tauri/src/rpc.rs`, so porting a request
means adding one match arm. Long streams (Assistant events) can move to
`Channel` later without touching the view contract.

Tauri's picker is a modal request/response, so the Electrobun "begin* then
completed message" dance in `index.ts` can collapse into plain async commands,
but the adapter must still present the same client interface to the UI.

### Shared code (`src/shared`, ~11k lines)

The backend validates and mutates the same models the UI renders, so Rust needs
its own copies of `design`, `system-design`, `walkthrough`, `relationships`,
`column-types`, `column-defaults`, `index-methods`, `component-catalog`, etc.
To prevent drift:

- Rust is authoritative; derive TS types with `specta`/`tauri-specta` (or
  `ts-rs`) and check them in CI, rather than hand-copying.
- The existing TS tests are the executable spec. Phase 1 builds a **fixture
  harness**: TS emits JSON fixtures (inputs + expected outputs) per module and
  Rust tests replay them.

## Phases

Each phase ends with the Rust app doing that slice end to end, behind the
unchanged UI.

0. **Toolchain and scaffold. (done, see "Phase 0 results")** Rust 1.93+,
   `tauri-cli` v2, window opens the existing UI against a stub backend.
   Spike `pglite-oxide`: boot, bootstrap SQL, `CREATE EXTENSION vector`, startup
   time, behaviour of two sandboxes alive at once. **Gate: if pgvector or
   startup is unusable, stop and revisit the sandbox decision.**
1. **Domain and storage. (core done, see "Phase 1 results")** Models, `rusqlite`
   store, migrations. Opens an existing `schema-designer.sqlite` created by the
   Electrobun app and writes back to it without loss. The fixture harness
   (`tauri/fixtures`) landed here. Still to port from this phase: the pure
   model operations in `system-design.ts` / `walkthrough.ts` / `workspace.ts`
   (add, move, remove, describe-removal, repair, ...), which phase 2 needs.
2. **Workspace and RPC. (first slice running, see "Slice results")** Project/design/system-design/walkthrough operations,
   undo/redo and project history, state push. UI usable for editing with no SQL
   preview yet.
3. **SQL and schema code. (SQL generation done, see "Phase 3 progress")**
   `sql.ts`, SQL preview, the four ORM generators, `pg_query`-based helpers.
   Golden tests against TS output.
4. **Sandbox and Scenarios.** Design check, Scenario runs, Sandbox API emulator,
   result grids, edge function invocation plumbing.
5. **Files and portability.** Project export/import (`.dbplanner.json`), project
   files and PDF text, project folder mirror, SQL/schema/SVG/PNG exports.
6. **Assistant (harnesses).** Codex app-server, OpenCode serve + loopback MCP,
   project tools, turn tracking and revert for those paths, DDL confirmation.
   First task: audit which of `assistant-turn-tracker`, `assistant-ddl`,
   `assistant-store` and `assistant-schema-file` are harness-independent and
   keep those. Write the ADR for dropping the pi runtime (supersedes ADR-0004
   in part) and decide what the UI does with connections, API keys, OAuth,
   request cap and Claude opt-in controls.
7. **Packaging and cutover.** Linux installer (replace `scripts/install-linux.sh`
   logic), CI proof, Windows packaging check, README/doc updates, remove
   Electrobun/Hutch/Bun backend.

## Definition of parity

The rewrite replaces Electrobun only when all of these hold:

1. Opens an existing Electrobun database and every Project round-trips.
2. For every module with a TS test file, the Rust implementation passes the
   replayed fixtures (76 test files in the repo today).
3. The packaged-proof flow (`scripts/verify-packaged-proof.ts`) and the
   end-to-end System design workflow (issue 147) pass against the Tauri build.
4. Screenshot comparison of the README views at the existing breakpoints.
5. Every intentional difference is listed below.

## Intentional differences

- Assistant: pi-ai/pi-agent-core runtime, provider connections, API keys and
  ChatGPT/Claude account sign-in are removed. Codex and OpenCode remain.
  (Pending ADR in phase 6.)

## Phase 0 results

Spike: `tauri/spikes/pglite` (release build, Linux x64, `pglite-oxide` 0.5.1).
It replays the setup in `src/bun/sandbox.ts`.

| Check | Result |
| --- | --- |
| First open with pgvector | 415 ms |
| Second open in the same process | 71 ms |
| Supabase bootstrap SQL (roles, `auth.uid()`, default privileges) | 15 ms |
| `CREATE EXTENSION vector`, vector column, HNSW index | 8 ms |
| `SET LOCAL ROLE authenticated` + `set_config('request.jwt.claim.sub')` + `auth.uid()` | works |
| Vector nearest-neighbour query | works |
| `information_schema` catalog query | 5 ms |
| Unique violation | surfaces as an error; SQLSTATE is available as `PgliteError::database_error().code` (read from the crate source, to be exercised in phase 4) |
| Two databases alive at once | works |

**Gate passed.** Notes from getting there:

- 0.5.1 builds on wasmer (precompiled AOT artifacts), not Wasmtime as first
  assumed. MSRV is 1.93.
- A fresh lockfile does not build: cargo picks `virtual-net` 0.702.1, which adds
  a `NetworkError` variant that `wasmer-wasix` 0.702.0-alpha.3 does not handle.
  Pin it: `cargo update -p virtual-net --precise 0.702.0-alpha.3`. The spike's
  committed `Cargo.lock` carries the pin; the app's must too.
- The crate depends on alpha wasmer releases, so upgrades need care.

Scaffold: `cargo check` passes for `tauri/src-tauri`, and the unmodified
`src/mainview` builds through `tauri/vite.config.ts` with no Electrobun code in
the bundle.

## Phase 1 results

New crates under `tauri/src-tauri/crates`, each held to the TypeScript oracle by
fixtures (`tauri/fixtures/README.md`):

| Crate | Ported | Verified by |
| --- | --- | --- |
| `schema-domain` | System design, Walkthrough and database Design models; `normalizeSystemDesign`, `normalizeWalkthroughs`, `normalizeDesign`; JS-semantics helpers (`trim`, UTF-16 `length`, `Math.round`, `String(value)`) | 1242 + 1073 fuzzed cases (error text included) and 86 Design cases; typed models round-trip every accepted document |
| `schema-store` | Every `DesignStore` method, all four migrations, import | a 59-step scripted session with a final dump, plus three legacy-schema databases |

Cross-checks beyond the fixtures:

- A copy of the real dev database (4 Projects) reads identically through the
  TypeScript and Rust stores, and the TypeScript store reads it identically
  after Rust has opened it. Your original file was not opened or modified.
- A database the Rust store builds from the script reads identically in TypeScript.
- Each suite was mutation-checked: deliberately breaking the port (a name limit,
  `Math.round` tie-breaking, `<` vs `<=` on revisions, the legacy owner
  fallback, rollback) makes the right tests fail. This found two gaps in the
  first corpus, both fixed.

Findings worth remembering:

- rusqlite's bundled SQLite starts with `foreign_keys` **on**; Bun's starts
  **off**, and the migrations depend on that. `Store::open` sets it explicitly.
- `Math.round` rounds ties toward +infinity and Rust's `round` does not; the
  difference only shows for negative values after the x100 scaling.
- `normalizeDesign` keeps unknown fields on tables, columns and relationships
  but drops unknown top-level ones. The typed model keeps the former in `extra`.
- Only the document normalizers and the store are ported so far. Column type
  registry, default validation, SQL rendering and every editing operation are
  still TypeScript-only.

## Phase 2 progress

The pure editing layer is ported and verified; the workspace around it is not.

| Ported | Source | Verified by |
| --- | --- | --- |
| System design operations (Services, Groups, Components, Connections, collapse, focus, removal plans) | `system-design.ts` | 12 sessions, 1680 steps, 705 of them rejected |
| Walkthrough operations (Walkthroughs, steps, parallel/repeat blocks, move, repair, accept redirection, impact on Connections, step status) | `walkthrough.ts` | 10 sessions, 1600 steps, 1017 of them rejected |
| Component catalog identity data | `component-catalog.ts` | generated from the TypeScript source and embedded |

Both suites were mutation-checked (five deliberate breaks each, all caught).

Design points settled here:

- `Patch<T>` models a changes-object field that is absent, `null`, or set,
  reproducing the `"field" in changes` checks. Over RPC an `undefined` field
  never arrives, so absent and `null` are the only two states that matter.
- The operations return the design unchanged when nothing differs, as the
  originals do. The originals detect that with `JSON.stringify`, which also
  depends on key order, so a no-op can produce a re-ordered but equal document in
  TypeScript. Content is identical either way; the workspace must compare by
  content, not by identity, when deciding whether to record history.

Still to port for this phase, in dependency order:

1. `system-design-operations.ts` and `walkthrough-operations.ts`: id
   generation, Assistant attribution, and the removal plans that combine a
   design plan with Walkthrough impact.
2. `project-history.ts`: Undo/Redo across System design, Walkthroughs, Scenarios
   and Edge functions, including grouped Assistant turns.
3. The database Design operations in `workspace.ts` (tables, columns,
   relationships, indexes, enums, Functions, Triggers, policies). These need the
   column type registry and default validation first.
4. Save scheduling, revisions and the `WorkspaceState` that drives the view,
   including the SQL and sandbox state (so phase 3's SQL generation matters here).
5. The `rpc_request` handlers and the state push.

## Phase 3 progress

SQL generation is ported with its dependencies, ahead of the rest of Phase 2's
workspace so the first end-to-end slice (create a project, add a table, see its
SQL) has something to show.

| Ported | Source | Verified by |
| --- | --- | --- |
| Column type registry, `renderColumnType` | `column-types.ts` | generated from the TS source; 450 renderings |
| Default validation and SQL rendering | `column-defaults.ts` | 563 validations (224 accepted), 450 renderings |
| Identifier naming (63-byte limit, `makeObjectName`) | `postgres-identifiers.ts` | 760 cases |
| Index access methods and operator classes | `index-methods.ts` | generated from the TS source; checked through the SQL cases |
| Relationship resolution, naming, removal plans | `relationships.ts` | 642 cases |
| Design to PostgreSQL, schema file, planned names | `sql.ts` | 642 cases, 260 accepted, 382 refused, 137 distinct errors, 14 distinct warnings |

Findings:

- `JSON.parse` accepts numbers beyond f64 (`1e999`); `serde_json` does not. JSON
  defaults are validated for syntax only. A lone surrogate escape is the one
  remaining difference and is not in the corpus.
- JavaScript's `\d` and `\s` differ from Rust's; patterns spell out ASCII digits and
  the JavaScript whitespace set (`js::SPACE_CLASS`).
- `Object.entries(index.with)` is insertion-ordered and validation messages and
  the rendered `WITH (...)` follow it, so `serde_json` now runs with
  `preserve_order` and index options are an ordered map.
- The first rich test Design was SQL-invalid (a trigger function with an
  argument). The generator's "unmodified base must be accepted" check caught it.
- Mutation checks on `sql.rs`, `relationships.rs` and `index_methods.rs`: 10 of
  12 breaks caught; the two survivors are equivalent mutants (a redundant
  reservation of explicit index names, and a trigger-event clause that only
  matters for a Design whose events name another table's column).

Still to port for this phase: `sql-preview.ts` (copy and export actions) and the
four ORM generators in `src/shared/schema-code` (Prisma, Drizzle, SQLAlchemy,
Django, about 3.5k lines with their naming helpers).

## Slice results

The first end-to-end slice runs: the unmodified React view on the Rust backend,
with real autosave to SQLite and a real PostgreSQL validating the SQL preview.

What it covers: `getWorkspaceState`, `createProject`, `openProject`,
`setActiveView`, `addTable`, `renameTable`, `moveTable`, `addColumn`,
`updateColumn`, `setViewport`, plus honest empty answers for the Assistant's
read-only lists. New crates: `schema-sandbox` (PGlite through `pglite-oxide`, the
catalog queries of `sandbox.ts`) and `schema-workspace` (state, edits, autosave,
debounced preview).

Evidence:

- A demo Project seeded through the workspace (`cargo run -p schema-workspace
  --example seed -- <db>`) opened in the real window and rendered correctly:
  Project name, Design, the table card with its columns and PK/identity/unique
  badges, "Saved", "rev. 10", "2 tables". Checked by capturing only the window.
- Tests: 8 workspace tests (state trail in order, restart persistence, layout and
  notes not moving the schema revision, invalid drafts staying saved with the
  last good SQL, the original error messages, primary-key demotion, the real
  sandbox) and one RPC test that sends the view's exact JSON.
- Latency, release build, real sandbox: a schema edit settles in about 300 ms
  (180 ms debounce plus about 120 ms to build and check). A layout-only edit
  (move a table, pan) takes about 2 ms. The call returns once the preview has
  settled, as the original's does.

Design decisions the slice settled:

- Threads and channels, not an async runtime. Workspace methods are blocking; Tauri
  commands run them with `spawn_blocking`. A debounced preview is a thread that waits on
  a cancel channel, so a newer edit wakes and ends it at once.
- Every call returns the **settled** state (it waits for its preview, or for the
  edit that replaces it). The view applies each response, so a response that
  returned early would arrive as a stale `checking` state and overwrite newer pushes.
- State is typed where the workspace reasons about it (`Design`, `SystemDesign`) and
  JSON for the tagged status unions (`save`, `sql`, `sandbox`), which are only built
  and read.

Known gaps seen in the slice:

- **System overview is not wired.** It is the view a new Project opens on. The
  System design and Walkthrough operations are ported and fixture-verified but have no
  RPC handlers yet, so the primary view cannot edit anything.
- No Undo/Redo (the buttons render disabled; history is not ported).
- The Project files panel shows `listProjectFiles` as not implemented; the Assistant
  lists answer empty.
- Not exercised in the real window: clicks and typing. Synthetic input would go to
  whichever window has focus, so interaction is covered by tests and by hand.
- Opening a Project shows SQL "Not run" and sandbox "Not available" until the first
  edit. By the original's code this is the same (opening schedules no preview),
  but it should be compared side by side with the Electrobun app.
- ~~The slice has no differential test of the workspace state machine itself.~~ (done, see "Workspace oracle and database edits").

Next, in the order the results suggest:

1. ~~Wire the System design and Walkthrough handlers~~ (done, see "System overview results").
2. ~~A differential oracle for the workspace~~ (done): drive the TypeScript workspace with a
   stubbed sandbox through scripted sessions, record the settled state after each call
   and the ordered status trail it pushes, and replay them against Rust.
3. ~~The remaining Design edits~~ (done) and Undo/Redo.
4. Project files, exports and imports (native dialogs), then Scenarios and the
   Assistant harnesses.

## System overview results

The System overview, the view a new Project opens on, now runs on the Rust backend.
`Workspace::request` routes the view's JSON to typed handlers (about 60 calls), and the
Tauri layer is a thin wrapper.

Wired: every Service, Group, Component and Connection edit; collapse, focus and
viewport; the three removal plans with their Walkthrough impact; linking a Database
component and creating a Design for it; opening, creating and renaming Designs; and
every Walkthrough edit. All of them use the fixture-verified operations from
`schema-domain`. Reads of other stores' tables (`listProjectFiles`,
`getAssistantRequestCap`) come from the same SQLite file, empty or the default when
the table does not exist, as in the original.

Found by reading the original while wiring this:

- **Opening builds the preview at once.** `activateDesign` ends by generating and
  checking the SQL immediately (no debounce) when the Design has tables. The first
  slice showed "Not run / Not available" on open, which was wrong; the window now
  reads "Saved | Accepted rev. 10 | Current rev. 10". Switching Designs behaves the same.
- Every System design and Walkthrough handler names a history action and a coalesce key
  (typing in one field merges into one Undo step). They are computed and passed to one
  `record_history` hook that does nothing until history is ported.
- "Nothing changed" is decided by content here. The original compares `JSON.stringify`
  output, which also depends on key order, so it can save a no-op that Rust skips.

Evidence: 8 new tests through `Workspace::request` with the view's JSON (persistence
across restart, no-op edits not saved, presentation outside content, removal impact on
Walkthrough steps, authoring rules and error messages, linking and creating Designs,
preview on open), 3 for the table reads, and the real window rendering a seeded system
(`cargo run -p schema-workspace --example seed -- <db> system`).

Known gaps, now visible in the window:

- ~~**Arrange**~~ applying a computed layout is ported (see below). Computing one
  (`computeSystemLayout`, used by the Assistant's layout tool) is not.
- **Export SVG/PNG, project export/import, attaching files** need native dialogs.
- **Undo/Redo** still does nothing.
- Interaction in the real window is untested by me (no synthetic input).

## Workspace oracle and database edits

**Oracle.** `fixtures/generate-workspace.ts` drives the real TypeScript workspace with a
stubbed sandbox, a clock the driver sets before each call and ids numbered per call.
Eight random sessions of 400 calls plus five hand-written ones (`lib/workspace-scripts.ts`:
enums, cascades, relationships, functions and triggers, policies) record, for every call,
a fingerprint of each top-level field of the settled state (or the error message), the
ordered trail of states pushed while it ran, and, after a refusal or a plan, the state the
workspace holds. The database at the end of each session is fingerprinted too.
`crates/workspace/tests/oracle.rs` replays them and must agree on all of it. 3272 calls,
about a third refused, 83 distinct push shapes.

Mutation checks: 19 deliberate breaks of the port (cascades, wording of confirmations,
validation order, id order for junctions, de-duplication, dependency detection, and so on)
are each caught. The first random sessions let three survive (a trigger with duplicate
events, an INCLUDE list after a column is removed, dropping an enum a column uses); the
scripted sessions exist because of that.

What the oracle found while it was built:

- `removeWalkthroughBlock` looks the block up before anything else, so a missing block
  wins over a missing Walkthrough.
- `sameColumn` treats no `typeParameters` and `{}` as the same.
- The original's "nothing changed" check for System edits is `JSON.stringify`, which
  depends on key order. Updating `technology`, `description`, `designId` or `icon`
  deletes the key and adds it back at the end, so an edit that changes nothing but
  the order is still a change: it is saved and it is an Undo step. The Rust workspace
  now models that order for the optional keys of Components and Connections
  (`system::KeyOrders`) so the same edits count as changes. The earlier caveat about
  no-op edits no longer applies to System edits.

**Arrange.** `apply_system_layout` is ported and verified by the oracle (31 successful
calls, 12 refused: unknown cards, non-finite positions). Computing a layout is
`computeSystemLayout`, still unported.

**Database edits.** Remove table (with the relationships, triggers and association that
go with it), remove column (index keys and INCLUDE lists, unique constraints, trigger
columns, relationships), add / update / remove relationship (one-to-many, one-to-one,
many-to-many with its junction table), indexes, unique constraints, enum types,
Functions (with table dependency detection), remove Function, triggers, policies, and
`describeRemoval`. The checks and cascades are in `schema_domain::design_edits`
(raw JSON in, typed out, the original's messages and order of checks); relationship
creation and update are in `workspace/src/edits.rs`; `workspace/src/database.rs` decides
when a change counts.

Differences that remain, none reachable from the view:

- A list edit is "unchanged" when the serialized lists are equal, as in the original, but
  the typed Design always writes keys in one order, so a list that differs only in key order
  is a no-op here and a change there.
- Objects inside indexes, triggers and policies have no `extra` bag, so a key the app does
  not model is dropped rather than kept.
- A policy without `using` or `withCheck` gets empty text; the original keeps it absent.
- `updatePolicies` with something that is not a list is a `TypeError` in the original (its
  text is the JavaScript engine's); here it is "Policies must be a list.".
- Undo/Redo names for these edits (for example "Remove table “x”") are not recorded yet;
  they belong to the history port.

### Build environment note

On this machine `/tmp` is a 3.7 GB tmpfs. Cargo output for these crates fills
it ("Disk quota exceeded"). Build with `CARGO_TARGET_DIR` and `TMPDIR` on a real
disk, e.g. `export CARGO_TARGET_DIR=$HOME/.cache/db-planner-build/tauri-target
TMPDIR=$HOME/.cache/db-planner-build/tmp`.

## Risks

- **pglite-oxide** is young (first published Sept 2025) and depends on alpha
  wasmer releases (see above). Its single embedded backend owns one connection,
  so each Sandbox is its own instance; the spike showed that works.
- **Binary size**: the wasmer runtime plus the PGlite artifacts will enlarge the
  bundle compared with Electrobun. Not yet measured.
- **Webview differences**: Tauri on Linux uses WebKitGTK as Electrobun does, but
  Windows uses WebView2 in both; verify Monaco workers and the scenario worker
  under Tauri's `tauri://` origin and CSP.
- **Two sources of truth** for shared models until cutover; mitigated by type
  generation and fixtures.
- **Scope**: `workspace.ts` (3.8k lines) and `sql.ts` (1.1k) carry most of the
  behaviour; expect these to dominate the schedule.

## Open items

- PDF text extraction crate for project files.
- Whether `DB_PLANNER_DATABASE_PATH`, `DB_PLANNER_PROJECTS_PATH` and
  `SCHEMA_DESIGNER_PROOF_REPORT_PATH` keep their names (default: yes).
- Data directory: Electrobun uses
  `~/.local/share/com.dbplanner.schema-designer/stable/`; Tauri's app data dir
  must be pointed at the same path so existing users keep their data.
