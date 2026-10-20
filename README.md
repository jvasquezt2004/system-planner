# Schema Designer

A local, Windows-first PostgreSQL schema designer. Each project holds one
authoritative design saved in local SQLite, with a read-only SQL preview and a
disposable PGlite sandbox that validates the generated schema. No Docker or
installed PostgreSQL server is required.

This slice supports named projects that autosave one independent design each,
including incomplete drafts, with visible save failures and project switching
that ignores stale work. Tables live as spreadsheet-styled cards on an infinite
canvas: add, select, rename, remove, drag, pan, and zoom, and the saved layout
returns on reopening. Selecting a table opens a focused column editor in the
side panel: add, rename, retype, and remove columns, then edit the single-column
primary key, nullability, uniqueness, and notes for the supported common
PostgreSQL types. A new table starts with a default `id bigint` identity primary
key. Moving cards or changing the viewport saves layout without advancing the
schema revision or rebuilding the sandbox, and notes-only edits do the same.
Relationship workflows arrive in later tickets.

## Commands

```bash
hutch run install      # install dependencies
hutch run dev          # run the desktop app (bundled view, no HMR)
hutch run dev:hmr      # run with Vite HMR
hutch run build        # package the Windows app and setup executable
bun test               # behavioral tests (real SQLite + real PGlite)
bunx tsc --noEmit      # typecheck
```

## Architecture

- `src/shared/design.ts` — domain vocabulary and observable workspace state.
- `src/shared/column-types.ts` — the shared registry of supported PostgreSQL
  types and type families used by the picker, validation, SQL, and sandbox.
- `src/shared/rpc.ts` — typed Electrobun RPC schema between Bun and the view.
- `src/bun/workspace.ts` — the public design workspace interface used by the
  React view and behavioral tests. Autosave, SQL generation, and sandbox
  orchestration stay behind it.
- `src/bun/store.ts` — atomic local SQLite persistence (one design per project).
- `src/bun/sql.ts` — one-way PostgreSQL SQL generation with explicit errors for
  incomplete designs.
- `src/bun/sandbox.ts` — disposable PGlite preview and catalog inspection.
- `src/mainview/App.tsx` — project list, panels, and workspace actions.
- `src/mainview/table-inspector.tsx` — selected table, column list, and the
  focused column editor.
- `src/mainview/column-type-badge.tsx` — shared type-family symbol.
- `src/mainview/canvas.tsx` — infinite canvas, table cards, pan/zoom, and card
  drag previews.

The design is authoritative; the sandbox is a rebuildable preview. Sandbox
failure never discards a saved design.

## Local data

The packaged app stores its SQLite database at:

```
%LOCALAPPDATA%\com.dbplanner.schema-designer\stable\<install-root>\schema-designer.sqlite
```

Set `DB_PLANNER_DATABASE_PATH` to override it (used by the packaged smoke check).

## PGlite packaging

PGlite resolves `pglite.wasm`, `pglite.data`, and `initdb.wasm` relative to the
bundled main process. `electrobun.config.ts` copies those assets into
`Resources/app/bun/`; removing them breaks the packaged sandbox even though
development still works. The verification procedure and recorded result live in
[docs/packaged-windows-smoke-check.md](docs/packaged-windows-smoke-check.md).

## Documentation

- [GLOSSARY.md](GLOSSARY.md) — canonical domain terms.
- [docs/spec.md](docs/spec.md) — product spec for the full application.
- [docs/projects-and-autosave.md](docs/projects-and-autosave.md) — project
  switching, autosave behavior, save failures, and stale-save isolation.
- [docs/canvas-and-layout.md](docs/canvas-and-layout.md) — table cards, canvas
  pan/zoom, layout persistence, and structural-versus-layout edits.
- [docs/column-editing.md](docs/column-editing.md) — the focused column editor,
  supported types, keys, nullability, uniqueness, notes, and incomplete drafts.
- [docs/adr](docs/adr) — architecture decisions.
- [docs/packaged-windows-smoke-check.md](docs/packaged-windows-smoke-check.md) —
  packaged Windows verification.
