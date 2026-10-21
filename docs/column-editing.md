# Column editing in the focused side panel

Selecting a **table card** opens that table's inspector in the right-hand panel.
The inspector is the only place columns are edited; cards stay a read-only view
of the table's structure.

## Using the column editor

- **Add column** — appends a column named `column` (or `column_2`, `column_3`, …)
  with type `text`, nullable, not unique, not a key, and no notes. The new
  column is selected for editing immediately.
- **Select a column** — click a row in the Columns list. The editor below shows
  that column's name, type, default, key settings, nullability, uniqueness, and
  notes.
- **Apply changes** — column edits are a draft until applied. Applying one edit
  updates the card, the SQL preview, and the sandbox together. `Reset` discards
  the draft. Background saves and sandbox results never overwrite a draft in
  progress.
- **Default** — choose no default, a typed literal, current timestamp for
  `timestamptz`, UUID generation for `uuid`, or identity generation for integer
  types. See [column-defaults.md](column-defaults.md) for the compatibility
  matrix, value formats, and validation rules.
- **Remove column** — inline confirmation, then removal. The column's stable
  identity disappears with it; other columns keep theirs. If relationships use
  the column, the warning lists affected links; cancel to keep the design
  unchanged or confirm to remove them. Removing a many-to-many link preserves
  its junction table and remaining columns.
- **Notes** — design intent stored with the column. Notes never appear in SQL
  and do not change the schema revision or rebuild the sandbox.

Renaming a column, changing its type, or toggling its key settings keeps the
column's stable identity. Associated metadata — notes, uniqueness, defaults, and
relationships — therefore survives a rename.

## Supported types

The type picker, validation, SQL generation, and sandbox share one registry in
`src/shared/column-types.ts`. Every entry is an exact PostgreSQL type name.

| Family | Symbol | Exact types | Identity allowed |
| --- | --- | --- | --- |
| Integer | `#` | `bigint`, `integer`, `smallint` | yes |
| Text | `T` | `text` | no |
| UUID | `U` | `uuid` | no |
| Boolean | `B` | `boolean` | no |
| Numeric | `N` | `numeric` | no |
| Date/time | `D` | `date`, `timestamptz` | no |
| JSON | `{}` | `jsonb` | no |

The picker groups options by family and shows both the exact type and a readable
label. Cards and the inspector show the same symbol with a tooltip naming the
family, plus the exact type name, so a symbol is never the only identification.
Type parameters (such as `numeric(10, 2)`) are deliberately outside this slice.

## Keys, nullability, and uniqueness

- A table has **one single-column primary key**. Checking `Primary key` on a
  column demotes any previous key column in the same edit. A key is always
  required and already unique, so the editor turns off `Nullable` and `Unique`
  for it.
- Clearing the key is allowed. The draft stays saved, the SQL preview becomes
  out of date, and validation reports that the table needs exactly one primary
  key column.
- Contradictory drafts cannot be presented as valid SQL. A nullable primary key
  or nullable identity column is saved but blocks generation with an explicit
  error, both in the inspector and in the SQL panel.
- `Unique` renders a real `UNIQUE` constraint. A primary key does not repeat it.
- Identity generation is one of the structured default choices. Changing a
  column's type out of the integer family clears identity in the same visible
  edit, because identity cannot apply to another family. The editor warns before
  applying that change. Other incompatible defaults are kept in the draft and
  reported as validation errors instead of being silently reinterpreted; see
  [column-defaults.md](column-defaults.md).

## Incomplete drafts

A saved design may be unfinished. Duplicate column names, a missing key, an
empty table, or an incompatible identity setting are saved normally:

- the card and inspector keep showing the draft;
- the SQL panel keeps the last generatable SQL with an `Out of date` status and
  the current errors;
- the sandbox keeps its last accepted revision instead of claiming the invalid
  draft was applied.

Applying an edit, adding a column, or removing a column advances the schema
revision. A notes-only edit saves the design document without advancing the
schema revision or rebuilding the sandbox, just like layout.

## Verification

Behavioral tests use the public workspace interface with real temporary SQLite
and the real PGlite sandbox:

```bash
bun test src/bun/workspace.test.ts
```

Coverage added for this work:

- adding, renaming, retyping, and removing columns while keeping stable column
  identities and the owning table's identity, including a rename after notes
  and uniqueness were set (the metadata survives) and save/reopen in a fresh
  workspace;
- notes and uniqueness persisting through a fresh workspace instance;
- every registered type applied in a real sandbox, checked against PostgreSQL's
  independent catalog names (`timestamptz` → `timestamp with time zone`, etc.);
- moving the single-column primary key to another column and demoting the old
  key in the sandbox catalog;
- clearing the key leaving a saved incomplete draft with stale SQL and an
  actionable error, then reopening that draft;
- a nullable primary key blocked by validation while the draft stays saved;
- a notes-only edit leaving the schema revision, SQL preview, applied sandbox,
  and sandbox rebuild count unchanged;
- identity cleared when the key type leaves the integer family, verified in SQL
  and the sandbox;
- actual constraint behaviour in a real PGlite instance: duplicate primary keys
  and duplicate unique values rejected, required columns refusing `NULL`, and
  nullable columns accepting omission;
- structured defaults: safe literal encoding, current timestamp, UUID
  generation, identity generation, removal, persistence, and incompatible
  combinations (see [column-defaults.md](column-defaults.md)).

The real Electrobun desktop view was driven through WebView2 remote debugging
against a temporary database (`hutch run dev`, no Vite server). In one run:

1. Created project `Library` and table `Readers`; added a column.
2. Renamed it to `email`, made it required and unique, and added the note
   `Login address`; the card showed `email text UQ ! ✎`, the SQL preview showed
   `"email" text NOT NULL UNIQUE`, and the sandbox accepted revision 4.
3. Changed the key column to `uuid`: the editor warned that identity would be
   cleared, the card switched to a `U` symbol without the `ID` badge, the SQL
   became `"id" uuid NOT NULL`, and sandbox revision 5 accepted it.
4. Checked `Primary key` on `email`: `id` lost `PK`, `email` gained `PK` and lost
   its separate `UQ`, the SQL moved to `PRIMARY KEY ("email")`, and revision 6
   was accepted.
5. Unchecked `email`'s key: revision 7 was saved, the inspector showed
   `Blocked by validation — Table "Readers" needs exactly one primary key
   column.`, the SQL panel showed `Out of date` with the last good SQL, and the
   sandbox stayed at accepted revision 6. Re-checking the key restored current
   SQL and applied revision 8.
6. Added and removed a column through the confirmation: final revision 10 with
   two columns, current SQL, and accepted sandbox.
7. Reading SQLite directly showed revision 10 and the saved document with
   `email` as the required primary key, its note, and both stable column ids.
8. Relaunching the app restored `Readers` with the `✎` note marker, `PK`,
   `uuid` type, schema revision 10, current SQL, and an accepted sandbox.

The canvas still renders only table structure: column changes update the card's
names, types, key/unique/identity/note marks and nullability, never stored
records.
