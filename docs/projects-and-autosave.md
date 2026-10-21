# Projects and reliable autosave

Each project is a named, locally saved workspace that owns exactly one design.
The design and its layout are stored together in SQLite; there is no version
history, branching, or second design per project.

## Using projects

- The **Projects** panel lists every saved project. The active project is marked
  `open`; click another project to switch to it.
- **New project** creates and immediately opens a separate, empty design.
- Switching projects replaces the canvas and table list with that project's
  design. No table, column, or layout from another project is reused.
- The application reopens the most recently updated project on a fresh start.
  Reopening restores the latest saved design, not an earlier save or the
  previous session's undo stack.

## Autosave behavior

Every available design edit is applied to the in-memory draft immediately and
then saved automatically. Saving does not wait for semantic schema validity, so
unfinished or temporarily invalid designs are retained; a design that cannot
produce SQL still keeps its saved tables and layout.

The save badge is the only save report:

- `Saving…` while a save is in flight.
- `Saved` with a timestamp after the latest revision was written.
- `Save failed` with the error. The current draft stays editable in memory, and
  pausing does not make the failure disappear. A later edit retries the whole
  latest draft.

Saves carry both project identity and design revision. Older saves cannot
replace a newer saved design, and a save or sandbox result that completes after
a project switch cannot change the active project's design or save feedback.
The SQLite write itself is revision-guarded and transactional, so an
out-of-order completion also cannot overwrite a newer stored document.

Layout-only edits (moving a card, panning, zooming) are saved the same way but
never advance the schema revision or rebuild the sandbox. They carry their own
monotonic document revision so a delayed structural save cannot roll back a
newer layout. See [canvas-and-layout.md](canvas-and-layout.md).

SQL generation and sandbox acceptance are separate from autosave: preview
validation never blocks saving or discards the authoritative design. Revisioned
SQL and sandbox feedback states are documented in
[canvas-and-layout.md](canvas-and-layout.md).

## Session undo and redo

Undo and redo are kept in memory for each project during the current application
session. Switching projects selects that project's own undo/redo state; a change
in one project can never be applied to another. Creating a project starts with
an empty stack.

Undo and redo apply a complete saved design change and autosave the result.
Structural reversals receive a new schema revision and use the regular SQL and
sandbox preview pipeline. Layout-only reversals save the document without
advancing the schema revision or rebuilding the sandbox.

Closing the application discards undo/redo availability. Reopening restores the
latest autosaved design with no session undo history. Autosave is not rollback
or version history.

## Verification

Behavioral tests use the public workspace interface with real temporary SQLite:

```bash
bun test src/bun/workspace.test.ts src/bun/undo-redo.test.ts
```

They cover project listing/opening/switching, an incomplete invalid draft
restored by a fresh workspace, rapid edits with inverted save completion order,
a storage failure that keeps the draft and clears on the next edit, and an
in-flight save from the previous project being ignored after a switch. Preview
cases use real SQLite and PGlite to cover debounced edits, empty and stale SQL,
database rejection with the last successful sandbox retained, and older results
ignored after a newer revision or project switch.

`src/bun/undo-redo.test.ts` uses real SQLite and PGlite to cover structured
defaults, table renames, one-step card moves, all three relationship forms,
relationship removals retaining generated columns and junction tables, confirmed
table and column dependency deletions, branching, project isolation, and reopen
without persisted undo history.

The real Electrobun view/main path was also exercised in the dev build through
WebView2 remote debugging with a temporary database. Creating `Alpha` and
`Beta`, adding one table to each, and switching between them showed only the
selected project's table, with `Saved` feedback each time:

```text
beta:  {"header":"Beta","save":"Saved","tables":["Beta table"],"projects":["Betaopen","Alpha"]}
alpha: {"header":"Alpha","save":"Saved","tables":["Alpha table"],"projects":["Beta","Alphaopen"]}
beta:  {"header":"Beta","save":"Saved","tables":["Beta table"],"projects":["Betaopen","Alpha"]}
```

The same run left both projects and their independent designs in SQLite. A
packaged Windows build was not rebuilt for this check; the packaged procedure is
recorded in [packaged-windows-smoke-check.md](packaged-windows-smoke-check.md).

A separate real desktop walkthrough used `hutch run dev`, a temporary SQLite
file, an isolated WebView2 profile, and remote debugging port 9312. It created
an Authors/Books one-to-many relationship, cancelled a dependency warning
without changing the design, then confirmed table deletion. Undo restored
Authors, its relationship, and an accepted PGlite preview; Redo removed Authors
while retaining `Books.author_id`. After relaunching against the same database,
the latest design reopened at revision 7 with Undo and Redo disabled.
