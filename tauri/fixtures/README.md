# Parity fixtures

The Electrobun app's TypeScript is the oracle for the Rust rewrite. These scripts
run the real TypeScript code and record what it does; the Rust crates replay the
recordings and must agree. Nothing here changes `src/`.

```bash
cd tauri
bun run fixtures          # regenerate everything under fixtures/data
cargo test --workspace    # from tauri/src-tauri, with CARGO_TARGET_DIR/TMPDIR on a real disk
```

Generation is deterministic (seeded), so regenerating without changing the
TypeScript produces a byte-identical `data/`. A diff after regenerating means the
TypeScript behaviour or a generator changed.

| Generator | Oracle | Writes | Replayed by |
| --- | --- | --- | --- |
| `generate-normalizers.ts` | `normalizeSystemDesign`, `normalizeWalkthroughs` | `data/system-design.json`, `data/walkthroughs.json` | `crates/domain/tests/normalizers.rs` |
| `generate-designs.ts` | `normalizeDesign`, driven through the real workspace's project load | `data/designs.json` | `crates/domain/tests/normalizers.rs` |
| `generate-store.ts` | `openDesignStore` and every `DesignStore` method | `data/store-ops.json`, `data/store-legacy.json` | `crates/store/tests/fixtures.rs` |
| `generate-system-ops.ts` | the System design editing functions in `system-design.ts` | `data/system-ops.json` | `crates/domain/tests/system_ops.rs` |
| `generate-layout.ts` | the layout engine (`computeSystemLayout`, `frameAroundMembers`) and spot helpers over every design the System design fixtures produced | `data/layout.json` | `crates/domain/tests/layout.rs` |
| `generate-walkthrough-ops.ts` | the Walkthrough editing functions in `walkthrough.ts` | `data/walkthrough-ops.json` | `crates/domain/tests/walkthrough_ops.rs` |
| `generate-design-sql.ts` | `generateDesignSql`, `renderSchemaFile`, `planSchemaObjectNames`, `postgresSchemaRelationNames`, relationship resolution, removal plans, `indexMethodProblem` | `data/design-sql.json` (edits + results, SQL as a hash) | `crates/domain/tests/design_sql.rs` |
| `generate-columns.ts` | `columnDefaultProblem`, `renderDefaultExpression`, `renderColumnType` | `data/columns.json` | `crates/domain/tests/columns.rs` |
| `generate-identifiers.ts` | `postgres-identifiers.ts` (UTF-8 byte arithmetic) | `data/identifiers.json` | `crates/domain/tests/columns.rs` |
| `generate-folder.ts` | the Project folder rendering (`renderProjectFolder`, `folderSlug`) over the exports the workspace sessions recorded | `data/folder.json` | `crates/folder/tests/fixtures.rs` |
| `generate-harness-form.ts` | the harness question forms (`harness-form.ts`) over hand-written and mutated Codex questions, JSON Schemas and answers | `data/harness-form.json` | `crates/assistant/tests/form.rs` |
| `export-assistant-prompt.ts` | the harness system prompt (`harnessSystemPrompt(SYSTEM_PROMPT)`) | `src-tauri/crates/assistant/data/harness-prompt.txt` (embedded, not a fixture) | `crates/assistant/src/runtime.rs` |
| `generate-assistant-store.ts` | the Assistant's conversation store: random sessions of creating, appending, renaming, retargeting, deleting, usage and settings | `data/assistant-store.json` | `crates/assistant/tests/store.rs` |
| `generate-project-files.ts` | attached files: naming and type rules, text read from non-PDF files, the project file store | `data/project-files.json` | `crates/files/tests/fixtures.rs` |
| `generate-transfer.ts` | the SQL/ORM copy and export, System design SVG/PNG export and Project file export/import actions, run against fake pickers and clipboard | `data/transfer.json` (results, clipboard text, files left behind) | `crates/transfer/tests/fixtures.rs` |
| `generate-history.ts` | the Project history (`project-history.ts`): record, coalesce, fold Assistant turns, step | `data/history.json` (a fingerprint of the whole history after every call) | `crates/domain/tests/history.rs` |
| `generate-workspace.ts` | the whole `createDesignWorkspace`, driven through the calls the view makes (stub sandbox, fixed clock and ids) | `data/workspace-sessions.json` (outcomes as field fingerprints, push trails, final database fingerprint) | `crates/workspace/tests/oracle.rs` |
| `export-column-types.ts` | `column-types.ts` | `src-tauri/crates/domain/data/column-types.json` (embedded, not a fixture) | `crates/domain/src/column_types.rs` |
| `export-index-methods.ts` | `index-methods.ts` | `src-tauri/crates/domain/data/index-methods.json` (embedded, not a fixture) | `crates/domain/src/index_methods.rs` |
| `export-catalog.ts` | `component-catalog.ts` | `src-tauri/crates/domain/data/component-catalog.json` (embedded, not a fixture) | `crates/domain/src/catalog.rs` |

## What each corpus covers

- **Normalizers** are fuzzed. Rich valid documents are mutated by a seeded RNG
  (`lib/mutate.ts`: delete, duplicate, swap ids, replace with wrong types,
  oversized text, rounding ties) and the oracle's output or error message is
  recorded for each. Roughly a third are accepted and two thirds rejected, so
  both paths are exercised, and error messages must match exactly.
- **Editing operations** are long random sessions. Arguments are built from the
  current document (existing ids, missing ids, blank and oversized names,
  rounding-tie coordinates, valid and invalid kinds, branch indexes) and a
  successful call becomes the next state. Roughly 40-65% of calls are rejected,
  so error ordering is exercised as much as results. The generators print a
  per-operation tally; an operation with no accepted or no rejected calls is
  a generator bug, not coverage.
- **SQL generation** mutates three base Designs (the rich and legacy ones from
  `designs.json`, plus a features Design with every index method, vectors, a
  foreign-key cycle, a self reference, a real many-to-many junction, policies,
  functions, triggers and raw statements). The mutator (`lib/design-mutate.ts`)
  knows what each field means, so it swaps a column type for another column type
  and an id for another id, and never produces a document a typed model cannot load.
  Only the edits are stored, replayed on the same base by the Rust test; generated
  SQL is compared by hash and length. `explain-design-sql.ts <case>` prints the
  expected text when a hash differs. Roughly 40% of cases are accepted, with 137
  distinct errors and 14 distinct warnings.
- **Designs** are hand-built variants of each field `normalizeDesign` touches,
  plus legacy shapes. `normalizeDesign` is private to `workspace.ts`, so the
  oracle opens a real Project through the real workspace.
- **Store operations** are a scripted session: ownership errors, stale-write
  rules (equal and older revisions are ignored, System design and Walkthroughs
  raise instead), rollbacks, atomic multi-document saves, and imports. Results
  include SQLite's own error text. A final dump reads everything back.
- **Legacy databases** (`legacy/*.sql`) are the schemas older versions wrote,
  loaded as plain SQL so they are readable. Random UUIDs minted by a migration
  are compared as `<uuid#n>` placeholders by first appearance.

## Known, deliberate differences

- A JSON default containing a lone surrogate escape (`"\ud800"`) is valid for
  JavaScript's `JSON.parse` and rejected by `serde_json`; it is not in the corpus.

- A Design whose `tables` is not a list: the oracle throws a JavaScript
  `TypeError` whose text is engine-specific, so those inputs are excluded.
- `String.prototype.slice` can cut a surrogate pair in half; Rust drops the
  whole character instead.

## Checking a real database

Opening a database migrates it in place, so work on copies, and keep the dump
off screen if the projects are private:

```bash
# TypeScript reads its copy and writes a normalized dump
bun my-ts-dump.ts copy-a.sqlite expected.json   # uses openDesignStore, dumpStore, normalizeUuids from lib/store-dump.ts
# Rust reads its own copy of the same database and compares
REAL_DB_COPY=copy-b.sqlite REAL_DB_EXPECTED=expected.json \
  cargo test -p schema-store --test fixtures real_database -- --ignored --nocapture
```

`OPS_DB_OUT=path.sqlite cargo test -p schema-store --test fixtures operation_script`
keeps the database the Rust store builds from the script, so the TypeScript store
can be pointed at it to confirm compatibility in the other direction.
