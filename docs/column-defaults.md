# Structured column defaults

A column's default is chosen from a fixed set of structured options. There is no
handwritten SQL-expression input: the side panel offers only choices the column
type supports, and a typed literal is encoded as a value.

## The five choices

| Choice | Stored as | Generated SQL |
| --- | --- | --- |
| No default | `{ kind: "none" }` | no `DEFAULT` clause |
| Typed literal | `{ kind: "literal", literalType, value }` | a quoted or numeric literal |
| Current timestamp | `{ kind: "currentTimestamp" }` | `DEFAULT CURRENT_TIMESTAMP` |
| Generate a UUID | `{ kind: "generateUuid" }` | `DEFAULT gen_random_uuid()` |
| Identity generation | `column.identity = true` | `GENERATED ALWAYS AS IDENTITY` |

The first four live in `DesignColumn.default`; identity keeps its existing
`DesignColumn.identity` flag because PostgreSQL treats it as a generation mode
rather than a `DEFAULT` expression. The editor presents identity and the four
default kinds as one choice, so the designer never has to reconcile two
overlapping controls. The stored shape keeps literals distinguishable from
database-generated values: a literal carries the category it was written in.

## Editor behavior

Selecting a column shows its **Default** control below the type picker:

- **Typed literal** reveals a value input for the column's literal category.
  Text and JSON use free text; boolean uses a `true`/`false` picker.
- **Current timestamp** appears only for `timestamptz`.
- **Generate a UUID** appears only for `uuid`.
- **Identity generation** appears only for integer types, and selecting it makes
  the column required because PostgreSQL identity columns are always `NOT NULL`.

Defaults, like the rest of the column editor, are a draft until **Apply
changes**. Applying one edit updates the card, the SQL preview, and the sandbox
together. The column list and table card mark a defaulted column with a `D`
badge whose tooltip shows the SQL value; identity keeps its `ID` badge.

## Compatibility

The type registry in `src/shared/column-types.ts` is the single source of truth
for both the picker and validation.

| Type | Literal category | Current timestamp | Generate UUID | Identity |
| --- | --- | --- | --- | --- |
| `bigint`, `integer`, `smallint` | whole number (range-checked) | no | no | yes |
| `text` | text | no | no | no |
| `uuid` | — | no | yes | no |
| `boolean` | `true` / `false` | no | no | no |
| `numeric` | number | no | no | no |
| `date` | ISO date | no | no | no |
| `timestamptz` | ISO timestamp with a zone | yes | no | no |
| `jsonb` | valid JSON | no | no | no |

Literal values are validated before SQL is generated:

- integers must be whole numbers inside the exact type's range;
- numerics must be plain decimal or exponent notation;
- booleans must be `true` or `false`;
- dates must be real calendar dates, including leap days;
- timestamps must include an explicit `Z` or offset;
- JSON must parse.

## Safety

Literal content is escaped by doubling single quotes, so quotes, semicolons,
comment markers, and SQL-looking text stay values. For example the text default
`O'Reilly; DROP TABLE "Books"; --` renders as:

```sql
DEFAULT 'O''Reilly; DROP TABLE "Books"; --'
```

A database-generated choice is a fixed, pre-approved expression
(`CURRENT_TIMESTAMP`, `gen_random_uuid()`, identity), never designer input.

## Incompatible choices

An incompatible type/default combination is a visible validation error, not a
silent reinterpretation:

- changing a column from `text` to `integer` keeps the text literal in the saved
  draft; the inspector warns that the column needs a whole-number default, the
  SQL preview becomes `Out of date` with the explicit error, and the sandbox
  keeps its last accepted revision;
- switching the type back restores the same literal, which becomes valid again;
- identity and a default cannot coexist; the draft is saved and blocks SQL until
  one is removed.

Validation errors name the table and column, for example:

```
Column "title" in table "Books" has an invalid default: the integer type needs a
whole number default, not a text value.
```

Shape errors (an unknown default kind or a non-text literal value) are rejected
by the workspace instead of being stored.

## Removing a default

Choosing **No default** clears the stored default. The generated column has no
`DEFAULT` clause, the sandbox catalog reports no default expression, and an
insert that omits the column receives `NULL` (or a not-null error when the column
is required).

## Persistence

Defaults are saved with the design document in local SQLite, restored when a
project is reopened, and included in the schema revision. A default change is a
structural edit: it advances the revision and rebuilds the sandbox. Documents
saved before defaults existed are normalized to `{ kind: "none" }`.

## Verification

Behavioral coverage uses the public workspace interface with real temporary
SQLite and the real PGlite sandbox:

```bash
bun test src/bun/workspace.test.ts
```

The defaults work is covered by tests that:

- store a text literal containing quotes, a statement-shaped payload, and a
  backslash, then insert a row and read back the exact value while confirming no
  extra table was created;
- apply numeric, boolean, date, timestamp, JSON, current-timestamp, UUID, and
  identity defaults, inspect PostgreSQL's own catalog default expressions, and
  insert twice to observe literal values, generated UUIDs, identity sequences,
  and timestamp defaults;
- remove a default and confirm the catalog and inserted rows have none;
- preserve defaults through a fresh workspace instance;
- retype a defaulted column and confirm the draft is preserved, SQL blocks with
  an actionable error, the sandbox stays on its last accepted revision, and
  restoring the type validates the same default again;
- keep malformed or out-of-range literal values in the saved draft as visible
  errors, reject identity-plus-default, and reopen the invalid draft.

The real Electrobun view was driven through WebView2 remote debugging against a
temporary database (`hutch run dev`, no Vite server). In one run:

1. Opened the seeded `Smoke Library` project, selected `Books`, and added a
   `title text` column with the literal
   `O'Reilly; DROP TABLE "Books"; --`. The inspector showed the `D` badge, the
   SQL preview showed the doubled-quote literal, and the sandbox accepted it.
2. Added `recorded_at timestamptz` with **Current timestamp**,
   `token uuid` with **Generate a UUID**, and `sequence bigint` with **Identity
   generation**. The SQL preview showed `CURRENT_TIMESTAMP`,
   `gen_random_uuid()`, and `GENERATED ALWAYS AS IDENTITY NOT NULL`.
3. Changed `title` to `integer`: the editor warned before applying, applying
   saved the draft with `BLOCKED BY VALIDATION` and the explicit invalid-default
   error, and the SQL preview showed `Out of date` with the previous SQL.
4. Restored `title` to `text` (the same literal became valid), then chose
   **No default** and applied; the SQL preview dropped the `DEFAULT` clause and
   the sandbox accepted the column without one.
5. Reloaded the real view: the card, SQL preview, and sandbox restored
   `CURRENT_TIMESTAMP`, `gen_random_uuid()`, and identity. Reading SQLite
   directly showed the same structured defaults in the saved document.

No arbitrary SQL expression field was introduced.
