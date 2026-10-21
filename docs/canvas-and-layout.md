# Table cards, layout, and the canvas

The design canvas arranges **table cards** that describe schema structure. A
card lists column definitions — names, exact PostgreSQL type names, a
type-family symbol, key/identity/uniqueness markers, a note marker, and
nullability — never stored records. Card position, canvas pan, and zoom are
layout, not database structure. All column editing happens in the focused
side panel described in [column-editing.md](column-editing.md).

## Using the canvas

- **Add table** — name a table in the canvas toolbar and submit. The new table
  starts with the default `id bigint` identity primary key and lands near the
  centre of the current view, cascaded so repeated additions do not stack.
- **Select** — press a card (or focus it and press Enter/Space). The inspector
  panel shows that table's details. Selecting is view-only state; it is not
  saved and does not create a schema revision.
- **Rename** — edit the name in the inspector and submit. Renaming keeps the
  table's stable internal identity, so positions and (in later tickets)
  relationships stay attached to the same table.
- **Remove** — the inspector removes the table after an inline confirmation.
  Unrelated tables are untouched. Dependency warnings for referenced tables
  arrive with the relationship tickets.
- **Pan** — drag empty canvas. **Zoom** — mouse wheel over the canvas (around
  the pointer), or the `−`, `+`, and `100%` controls (around the view centre).
  The grid moves and scales with the canvas.
- **Drag cards** — press and drag a card. A press without movement selects
  without moving.

## Structural edits versus layout edits

| Edit | Schema revision | SQL preview / sandbox | Saved |
| --- | --- | --- | --- |
| Add, rename, remove a table | advances | regenerated and rebuilt after editing settles | yes |
| Add, edit, or remove a column | advances | regenerated and rebuilt after editing settles | yes |
| Edit column notes | unchanged | unchanged and **not** rebuilt | yes |
| Move a card, pan, zoom | unchanged | unchanged and **not** rebuilt | yes |

### SQL preview and sandbox feedback

Structural edits are saved immediately. SQL generation and the disposable
sandbox rebuild are debounced until editing settles; no Apply action is
required. While validation is pending, the SQL preview identifies the current
draft revision and, when one exists, the earlier SQL revision still shown.

When a draft cannot generate SQL, the last generatable SQL remains visible as
out of date with its own revision and the current actionable validation errors.
If no SQL has been generated, the preview is empty and blocked instead of
implying that a valid preview exists. Layout-only edits do not advance the
schema revision or restart sandbox work.

Generated SQL and sandbox acceptance are separate outcomes. A PostgreSQL
rejection shows the attempted SQL and database error while retaining the design
and the last successful sandbox revision. A failed first build has no prior
successful sandbox to display. Sandbox data is disposable and is not migrated
between revisions.
A sandbox startup or catalog-inspection failure is reported as a sandbox error,
not as PostgreSQL rejecting the SQL.

Preview work is scoped to project identity and schema revision. A completion
from an older revision or a project that is no longer open cannot replace the
active preview state.

#### Copying and exporting SQL

Copy and export use the immutable SQL snapshot displayed when the action
starts; they do not regenerate SQL from a newer draft or synchronize SQL back
to the design. The current, checking, stale, and rejected sandbox statuses
remain unchanged in their panels. When no SQL is available, the filename field
and both actions are disabled. Copy/export failures and file-dialog cancellation
are reported without changing the design.

Electrobun 2.0.4 exposes a native file/folder chooser but no save dialog. The
SQL panel therefore supplies the `.sql` filename, then the native chooser
selects a destination folder. The main process creates a new file and does not
overwrite an existing file with the same name.

Column editing keeps the same distinction: structure and notes are saved with
the design document, but notes describe intent rather than schema, so they
do not rebuild the database preview. See
[column-editing.md](column-editing.md) for the side panel and type coverage.

Layout is saved with the same design document. Every stored write carries a
monotonic document revision separate from the schema revision, so a delayed
older save (structure or layout) can never replace a newer document. Reopening
a project restores the latest saved table positions and the pan/zoom viewport
together with the schema.

The canvas deliberately has no notion of containment or proximity: cards that
overlap, sit beside each other, or are far apart are the same schema. That
leaves room for relationship connectors in later tickets without position ever
deciding structure.

## Verification

Behavioral tests use the public workspace interface with real temporary SQLite
and the real PGlite sandbox:

```bash
bun test src/bun/workspace.test.ts
```

Coverage added for this work:

- adding a table at a requested canvas position with the default key;
- renaming a table without changing its identity, including regenerated SQL and
  a rebuilt sandbox;
- saving a rename that makes the draft temporarily invalid (stale SQL, last
  applied sandbox kept);
- removing one table without removing unrelated tables, verified again after
  reopening;
- an unknown removal target reporting an error with the design unchanged;
- moving a card with the schema revision, SQL preview, and applied sandbox
  untouched and no new sandbox rebuild (a counting wrapper around the real
  sandbox records rebuilds);
- reopening a project restoring card positions and the viewport while keeping
  the structural revision;
- a layout save landing while an older structural save is still delayed,
  proving the newer document wins;
- bursts of rapid structural edits retain the previous SQL and applied sandbox
  while waiting, then automatically apply only the settled design;
- a draft with no prior SQL shows an empty blocked state, while a later invalid
  draft identifies the available SQL revision, current draft revision, and
  validation errors separately;
- a real PGlite syntax rejection exposes the attempted generated SQL and error
  without replacing the last successful sandbox;
- a sandbox runtime failure has a distinct observable category and is not
  reported as PostgreSQL rejecting SQL;
- delayed PGlite completions from an older schema revision or another project
  cannot replace the current preview.

The real Electrobun view was driven through WebView2 remote debugging against a
temporary database (`hutch run dev`, no Vite dev server). Verified in one run:

1. Created project `Library`, added `Authors` and `Books` from the canvas
   toolbar; cards showed `id bigint` with `PK`/identity/required markers and the
   inspector exposed the selected table.
2. Renamed `Authors` to `Novelists` in the inspector: the card header, SQL
   preview (`CREATE TABLE "Novelists"`), and sandbox (`schema revision 4`)
   updated while the schema revision stayed stable for layout edits.
3. Dragged `Books` by (+120, +90), panned the background by (+70, −50), and
   wheel-zoomed to `127%`. The schema revision remained `4`, the sandbox stayed
   at applied revision `4` (no rebuild), and every change reported `Saved`.
4. Reading SQLite directly showed `revision = 4`, `document_revision = 6`, the
   moved card positions, and the viewport `{ x: 21.99, y: −152.13, zoom:
   1.2712 }`.
5. Relaunching restored the same cards at the same screen positions
   (`Novelists` 393,233; `Books` 607,404), `127%` zoom, schema revision `4`,
   current SQL, and an accepted sandbox.
6. Removing `Books` through the inspector's confirmation left `Novelists`
   alone, advanced the schema revision to `5`, regenerated the SQL, and applied
   revision `5` in the sandbox; reopening kept the removal and the layout.

### Ticket #10 native preview smoke

A separate WebView2 run used `hutch run dev`, a temporary SQLite database, a
temporary `WEBVIEW2_USER_DATA_FOLDER`, and remote debugging port `9310`. The
launcher logged that the Vite server was not running and loaded
`views://mainview/index.html`; no page from port `5173` was used.

| Design state | SQL preview | Sandbox |
| --- | --- | --- |
| Valid `Books`, revision 2 | Current, generated from revision 2 | Accepted, revision 2 |
| Duplicate `Books`, revision 3 | Out of date, revision 2 SQL retained with the duplicate-name error | Out of date, last success revision 2 |
| Rename duplicate to `Volumes`, revision 4 | Current, generated from revision 4 | Accepted, revision 4 |
| Duplicate `Books` again, revision 5 | Out of date, revision 4 SQL retained with the error | Out of date, last success revision 4 |
| Rename back to `Volumes`, revision 6 | Current, generated from revision 6 | Accepted, revision 6 |

A packaged Windows build was produced with `hutch run build`
(`build/stable-win-x64/Schema Designer-Setup.exe`). Its main bundle shipped the
new view assets beside `pglite.wasm`, `pglite.data`, and `initdb.wasm`. Running
the packaged stable main process with this database printed
`[workspace] database=... project=Library sql=current sandbox=applied`, and the
packaged `views://` page, driven through WebView2 debugging, showed the restored
`127%` canvas, the `Novelists` card at its saved position, schema revision `5`,
current SQL, and an accepted sandbox. `electrobun.config.ts` and the PGlite
asset wiring were unchanged by this work; the full packaged procedure remains in
[packaged-windows-smoke-check.md](packaged-windows-smoke-check.md).

### Ticket #11 native SQL transfer smoke

The real Electrobun development app ran from `hutch run dev` with a temporary
SQLite database, a temporary `WEBVIEW2_USER_DATA_FOLDER`, and WebView2 remote
debugging on port `9311`. The launcher reported that Vite was not running and
loaded `views://mainview/index.html`.

Behavioral coverage is `bun test src/bun/sql-preview.test.ts`. It uses the
public workspace with temporary SQLite and PGlite, writes actual files, and
checks current, stale, rejected, empty, cancellation, error, and in-flight
snapshot behavior.

- With `Library` revision 2 and `Books` current/accepted, **Copy SQL** wrote the
  displayed SQL to the Windows system clipboard; `Get-Clipboard -Raw` matched
  the preview text.
- **Export SQL** opened Electrobun's native folder chooser and saved
  `schema.sql` in the selected temporary folder. Reading the file matched the
  displayed preview exactly.
- Adding a duplicate `Books` produced an out-of-date preview at revision 2 and
  a blocked draft at revision 3. Copy retained the revision 2 SQL and its
  out-of-date status. Cancelling the native folder chooser reported
  `Export cancelled.` and created no file.

The packaged stable build was produced by `hutch run build`. Its
`SchemaDesigner/Resources/<hash>.tar.zst` app archive was extracted to a
temporary runtime folder (without installing over the existing stable app) and
launched with a temporary SQLite database, a separate WebView2 user-data folder,
and debugging port `9311`. No dev server or port `5173` was used. In the real
packaged view, `Ticket11 Packaged` / `Events` reached revision 2 with SQL
`Current` and sandbox `Accepted`; **Copy SQL** matched `Get-Clipboard -Raw`,
and **Export SQL** created `packaged.sql` whose contents exactly matched the
displayed preview.
