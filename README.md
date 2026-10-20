# Schema Designer

A local, Windows-first PostgreSQL schema designer. Each project holds one
authoritative design saved in local SQLite, with a read-only SQL preview and a
disposable PGlite sandbox that validates the generated schema. No Docker or
installed PostgreSQL server is required.

This is the first vertical slice: create a project, add a table with a default
`id bigint` identity primary key, autosave, reopen, and inspect the generated
SQL and real sandbox result. The canvas, column editor, and relationship
workflows arrive in later tickets.

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
- `src/shared/rpc.ts` — typed Electrobun RPC schema between Bun and the view.
- `src/bun/workspace.ts` — the public design workspace interface used by the
  React view and behavioral tests. Autosave, SQL generation, and sandbox
  orchestration stay behind it.
- `src/bun/store.ts` — atomic local SQLite persistence (one design per project).
- `src/bun/sql.ts` — one-way PostgreSQL SQL generation with explicit errors for
  incomplete designs.
- `src/bun/sandbox.ts` — disposable PGlite preview and catalog inspection.
- `src/mainview/App.tsx` — minimal React UI.

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
- [docs/adr](docs/adr) — architecture decisions.
- [docs/packaged-windows-smoke-check.md](docs/packaged-windows-smoke-check.md) —
  packaged Windows verification.
