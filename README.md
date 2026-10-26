# Schema Designer

A local, Windows-first PostgreSQL schema designer. Each project holds one
authoritative design saved in local SQLite, with a read-only SQL preview and a
disposable PGlite sandbox that validates the generated schema. No Docker or
installed PostgreSQL server is required.

This slice supports named projects that autosave one independent design each,
including incomplete drafts, with visible save failures and project switching
that ignores stale work. Tables live as spreadsheet-styled cards on an infinite
canvas: add, select, rename, remove, drag, pan, and zoom, and the saved layout
returns on reopening. Selecting a table opens a focused column editor in an
inspector sheet: add, rename, retype, and remove columns, then edit the single-column
primary key, nullability, uniqueness, and notes for the supported common
PostgreSQL types, plus structured defaults: no default, typed literals, current
timestamp, UUID generation, or integer identity. A new table starts with a
default `id bigint` identity primary key. Moving cards or changing the viewport
saves layout without advancing the schema revision or rebuilding the sandbox,
and notes-only edits do the same. Relating two table cards creates a
one-to-many or one-to-one relationship: the referencing table gets a generated
foreign-key column with the referenced primary key's type, required by default
with a Required toggle, shown as a subtle connector with column highlighting —
a one-to-many relationship frames the "many" card in an enclosure headed with
the "one" table's name — and enforced with `NO ACTION` on updates and deletes. A
one-to-one relationship also owns uniqueness on that column, so at most one
referencing record may name the same referenced record, and the referencing
card shows `UQ` for it. A many-to-many relationship creates a named, visible
junction with its own identity primary key, two required matching references,
and unique endpoint pairs. The junction card carries an `M:N` mark and, because
it holds two one-to-many references, sits inside one enclosure per endpoint —
an indicator, never containment; the junction and added association fields
remain editable.
Deleting a referenced table or column lists affected relationships, associations,
and owned constraints and asks for confirmation; cancelling leaves the design
unchanged. Removing a direct relationship keeps its columns and drops only its
own foreign key and uniqueness. Removing a many-to-many association keeps its
junction and all columns and drops both foreign keys and pair uniqueness. The
generated SQL and sandbox check live in the SQL preview view, switched in place
of the canvas by the masthead. The project-level Functions and Triggers views
author PostgreSQL routines and table event rules; trigger effects execute in
Scenario runs, and removal confirmations list dependent Triggers. ORM schemas
name omitted trigger logic. The masthead also opens Scenarios and Edge
functions: projects keep named TypeScript client scenarios and server handlers
as saved content, independently of design undo/redo. The bundled Monaco editors
use the TypeScript language service and declarations generated from the last
successfully applied revision; diagnostics are warnings and never prevent
editing. Scenario and Edge function names and source autosave with visible save
status. The SQL preview includes Copy SQL, export, and the last successful
sandbox when the current draft is not yet accepted.
Undo and Redo buttons sit in the masthead next to the project name and revision
(`undo-button` and `redo-button`).

## Commands

```bash
hutch run install      # install dependencies
hutch run dev          # run the desktop app (bundled view, no HMR)
hutch run dev:hmr      # run with Vite HMR
hutch run build        # package the desktop app and setup executable
hutch run install:linux # build and install per-user Linux desktop app
hutch run uninstall:linux # remove installed Linux desktop app
bun test               # behavioral tests (real SQLite + real PGlite)
bunx tsc --noEmit      # typecheck
```

## Install on Linux

Schema Designer can be installed as a per-user desktop application on Linux with its own application launcher entry and window icon.

### Prerequisites

- **Hutch**: provides the Electrobun runtime and toolchains (`~/.hutch/bin/hutch` or in `PATH`).
- **librsvg** (`rsvg-convert`): renders application icons from the brand SVG.
  - Arch: `sudo pacman -S librsvg`
  - Ubuntu/Debian: `sudo apt install librsvg2-bin`
  - Fedora: `sudo dnf install librsvg2-tools`

### Install

From the repository checkout:

```bash
scripts/install-linux.sh
# or
hutch run install:linux
```

This builds the stable app, extracts and installs the application files into `~/.local/share/schema-designer/`, creates the launcher at `~/.local/bin/schema-designer`, renders and installs the icons across sizes (16, 24, 32, 48, 64, 128, 256, 512, and scalable SVG) into the hicolor theme, writes `~/.local/share/applications/schema-designer.desktop` with `StartupWMClass=SchemaDesigner`, and refreshes desktop and icon caches.

### Run

Launch "Schema Designer" from your desktop application launcher or app menu, or start it from the terminal:

```bash
schema-designer
```

Ensure `~/.local/bin` is in your `PATH`.

### Upgrade

Re-run the installer at any time:

```bash
scripts/install-linux.sh
```

The installer is idempotent and replaces the previous installation atomically in `~/.local/share/schema-designer/` without touching user data.

### Uninstall

To remove the installed application, launcher script, desktop entry, and icons:

```bash
scripts/uninstall-linux.sh
# or
hutch run uninstall:linux
```

### Data locations

User databases and credentials are kept separate from the installed application files and are never deleted by upgrades or uninstalls:

- **Stable channel database**: `~/.local/share/com.dbplanner.schema-designer/stable/schema-designer.sqlite`
- **Development channel database**: `~/.local/share/com.dbplanner.schema-designer/dev/schema-designer.sqlite`
- **Credentials**: Stored in your system keyring / Secret Service.

## Architecture

- `src/shared/design.ts` — domain vocabulary and observable workspace state,
  including Scenarios and Edge functions as project content.
- `src/shared/column-types.ts` — the shared registry of supported PostgreSQL
  types and type families used by the picker, validation, SQL, and sandbox.
- `src/shared/column-defaults.ts` — the structured default vocabulary, literal
  validation, safe encoding, and display used by the editor and SQL generation.
- `src/shared/relationships.ts` — resolving relationship participants, naming
  generated foreign-key columns, and describing affected dependencies.
- `src/shared/postgres-identifiers.ts` — UTF-8-aware PostgreSQL identifier
  limits and collision-safe suffixes.
- `src/shared/rpc.ts` — typed Electrobun RPC schema between Bun and the view.
- `src/bun/workspace.ts` — the public design workspace interface used by the
  React view and behavioral tests. Autosave, SQL generation, and sandbox
  orchestration stay behind it.
- `src/bun/store.ts` — atomic local SQLite persistence for each project's
  design, Scenarios, and Edge functions.
- `src/bun/sql.ts` — one-way PostgreSQL SQL generation with explicit errors for
  incomplete designs.
- `src/bun/sandbox.ts` — disposable PGlite preview and catalog inspection.
- `src/mainview/App.tsx` — masthead, project switching, the inspector sheet,
  confirmation dialogs, and workspace actions.
- `src/mainview/table-inspector.tsx` — selected table, column list, the
  focused column editor, and relationship controls.
- `src/mainview/sql-preview.tsx` — the SQL preview view shown in place of the
  canvas: generated SQL with copy, plus the sandbox result.
- `src/mainview/scenario-view.tsx` — saved Scenario list and editor for names
  and TypeScript source, with independent save status.
- `src/mainview/edge-functions-view.tsx` — saved Edge function list and Monaco
  editor with Deno and supabase-js declarations, independent of design history.
- `src/mainview/index.css` — the editorial design tokens (paper, ink, rules,
  the blue-pencil accent, status colours) mapped onto shadcn/ui's slots.
- `src/mainview/components/ui/` — shadcn/ui components (Radix-based),
  restyled with those tokens. Add more with `bunx shadcn@latest add <name>`.
- `src/mainview/column-type-badge.tsx` — shared type-family symbol.
- `src/mainview/canvas.tsx` — infinite canvas, table cards, pan/zoom, card drag
  previews, relationship connectors and enclosures, and relating one card to
  another.

The design is authoritative; the sandbox is a rebuildable preview. Sandbox
failure never discards a saved design.

## Local data

The packaged app stores its SQLite database at:

- **Windows**: `%LOCALAPPDATA%\com.dbplanner.schema-designer\stable\<install-root>\schema-designer.sqlite`
- **Linux**: `~/.local/share/com.dbplanner.schema-designer/stable/schema-designer.sqlite`

Development runs store the database under `.../dev/schema-designer.sqlite`.
Set `DB_PLANNER_DATABASE_PATH` to override it (used by the packaged smoke check).

## PGlite packaging

PGlite resolves `pglite.wasm`, `pglite.data`, and `initdb.wasm` relative to the
bundled main process. `electrobun.config.ts` copies those assets into
`Resources/app/bun/`; removing them breaks the packaged sandbox even though
development still works. The verification procedure and recorded result live in
[docs/packaged-windows-smoke-check.md](docs/packaged-windows-smoke-check.md).

## Documentation

- [docs/system-design.md](docs/system-design.md) — agreed system-design expansion
  (planned behavior), with the [component catalog](docs/system-components.md) and
  [implementation plan](docs/system-design-build-plan.md).
- [GLOSSARY.md](GLOSSARY.md) — canonical domain terms.
- [docs/spec.md](docs/spec.md) — product spec for the full application.
- [docs/projects-and-autosave.md](docs/projects-and-autosave.md) — project
  switching, autosave behavior, save failures, and stale-save isolation.
- [docs/canvas-and-layout.md](docs/canvas-and-layout.md) — table cards, canvas
  pan/zoom, layout persistence, and structural-versus-layout edits.
- [docs/column-editing.md](docs/column-editing.md) — the focused column editor,
  supported types, keys, nullability, uniqueness, notes, and incomplete drafts.
- [docs/column-defaults.md](docs/column-defaults.md) — structured defaults,
  typed literals, database-generated values, validation, and safe encoding.
- [docs/relationships.md](docs/relationships.md) — one-to-many, one-to-one, and
  many-to-many associations, generated foreign keys, junction editing,
  cardinality indicators, and deletion safeguards.
- [docs/adr](docs/adr) — architecture decisions.
- [docs/packaged-windows-smoke-check.md](docs/packaged-windows-smoke-check.md) —
  packaged Windows verification.
