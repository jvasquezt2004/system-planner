# Table cards, layout, and the canvas

The design canvas arranges **table cards** that describe schema structure. A
card lists column definitions — names, exact PostgreSQL type names, a
type-family symbol, key/identity/uniqueness markers, a note marker, and
nullability — never stored records. Card position, canvas pan, and zoom are
layout, not database structure. All column editing happens in the focused
side panel described in [column-editing.md](column-editing.md).

A many-to-many junction is an ordinary editable table card marked `M:N`; its
connectors show the two endpoint relationships.

## Using the canvas

- **Add table** — name a table in the canvas toolbar and submit. The new table
  starts with the default `id bigint` identity primary key and lands near the
  centre of the current view, cascaded so repeated additions do not stack.
- **Select** — press a card (or focus it and press Enter/Space). The inspector
  panel shows that table's details. Selecting is view-only state; it is not
  saved and does not create a schema revision.
- **Rename** — edit the name in the inspector and submit. Renaming keeps the
  table's stable internal identity, so positions and relationships stay attached
  to the same table.
- **Remove** — the inspector lists affected relationships and requires
  confirmation. Cancel leaves the design unchanged. Confirming removes affected
  relationships but preserves junction tables and unrelated tables.
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
| Create, edit, or remove a relationship | advances | regenerated and rebuilt after editing settles | yes |
| Edit column notes | unchanged | unchanged and **not** rebuilt | yes |
| Move a card, pan, zoom | unchanged | unchanged and **not** rebuilt | yes |


A card drag is committed as one move when the pointer is released. Undoing or
redoing that move restores the card position in one step and saves the layout
without advancing the schema revision or restarting SQL/sandbox validation.

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
overlap, sit beside each other, or are far apart are the same schema.
Relationship connectors and endpoint marks communicate cardinality; position
never defines relationship structure.

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
