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
2. **Workspace and RPC. (in progress, see "Phase 2 progress")** Project/design/system-design/walkthrough operations,
   undo/redo and project history, state push. UI usable for editing with no SQL
   preview yet.
3. **SQL and schema code.** `sql.ts`, SQL preview, the four ORM generators,
   `pg_query`-based helpers. Golden tests against TS output.
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
