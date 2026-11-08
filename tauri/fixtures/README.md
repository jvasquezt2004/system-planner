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
| `generate-walkthrough-ops.ts` | the Walkthrough editing functions in `walkthrough.ts` | `data/walkthrough-ops.json` | `crates/domain/tests/walkthrough_ops.rs` |
| `generate-columns.ts` | `columnDefaultProblem`, `renderDefaultExpression`, `renderColumnType` | `data/columns.json` | `crates/domain/tests/columns.rs` |
| `generate-identifiers.ts` | `postgres-identifiers.ts` (UTF-8 byte arithmetic) | `data/identifiers.json` | `crates/domain/tests/columns.rs` |
| `export-column-types.ts` | `column-types.ts` | `src-tauri/crates/domain/data/column-types.json` (embedded, not a fixture) | `crates/domain/src/column_types.rs` |
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
