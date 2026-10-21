# Relationships

Relating two table cards creates a real foreign key. The designer never
prepares or selects a foreign-key column: the referencing side receives a
generated column, and the association stays identified by column ids rather than
by names. The same interaction creates one-to-many and one-to-one relationships.

## Vocabulary

A **relationship** is one association between a **referencing** table and a
**referenced** table. The referencing table stores the generated **foreign-key
column**; the referenced table is targeted through its single-column primary
key. An **optional reference** permits a missing association; a **required
reference** does not. Neither setting requires the referenced table to have any
children.

**Cardinality** says how many referencing records may name the same referenced
record:

- **one-to-many** (the default): any number may name it;
- **one-to-one**: at most one may name it, enforced by relationship-owned
  uniqueness on the referencing column.

The stored shape is deliberately small:

```ts
type DesignRelationship = {
  id: string;
  cardinality: "one-to-many" | "one-to-one";
  referencingTableId: string;
  referencingColumnId: string; // the generated foreign-key column
  referencedTableId: string;   // its primary key is the target
};
```

The referenced column is resolved as the referenced table's current primary key
at SQL-generation time, so a demoted or missing key surfaces as a validation
error instead of silently detaching the relationship. Documents saved before
cardinality existed reopen as one-to-many.

## Creating a relationship

1. Click **relate** in a table card header. That card becomes the referencing
   side, which always stores the reference.
2. Choose **many** or **one-to-one** in the banner. One-to-many is preselected.
3. Click the table card it references. Press `Esc` or **Cancel** to stop.

The workspace then creates one column on the referencing table:

- name derived from the referenced table and key, for example `author_id`;
- the referenced key's exact type;
- no identity generation, no default, not unique, not a primary key;
- required by default (`NOT NULL`).

Name collisions never overwrite an existing column: if `author_id` already
exists, the generated column becomes `author_id_2`, and the existing column
keeps its identity, type, and nullability.

## Required and optional

The relationship-owned column's nullability is the single source of truth. The
**Required** control in the side panel and the **Nullable** control in the
column editor therefore cannot disagree: switching Required off makes the column
nullable, and making the column nullable in the editor makes the reference
optional. Turning Required back on makes it `NOT NULL` again.

An optional reference still has to name an existing row when it is present. No
rule requires a referenced record to participate — for either cardinality.

## One-to-one uniqueness

A one-to-one relationship owns a uniqueness constraint on its referencing
column. Uniqueness is not stored as the column's own `Unique` setting, so the
relationship and the column editor never compete for ownership:

- the card shows `FK` and `UQ` on the referencing column; the inspector labels
  the relationship **one-to-one**;
- the database rejects a second referencing record naming the same referenced
  record;
- an optional one-to-one reference may be absent, and several referencing
  records may be absent at once, because PostgreSQL treats `NULL`s as distinct
  under a unique constraint;
- the referenced record may have no match at all.

An independently configured unique column still renders its own inline `UNIQUE`.
When that setting already supplies uniqueness, the relationship does not repeat
it, and removing the relationship leaves the column's constraint in place.

The inspector's **One-to-one** control converts an existing relationship both
ways without recreating its column.

## Generated SQL

Foreign keys and relationship-owned uniqueness are emitted after every table
exists, so card order never has to satisfy a dependency:

```sql
ALTER TABLE "Books"
  ADD CONSTRAINT "Books_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "Authors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
ALTER TABLE "Books"
  ADD CONSTRAINT "Books_author_id_key" UNIQUE ("author_id");
```

The uniqueness statement appears only for a one-to-one relationship that owns
uniqueness. `NO ACTION` is fixed: the initial schema never cascades an update or
delete without the designer's intent. The read-only SQL preview, the sandbox,
and the design always describe the same constraints.

## Visual indicators

A subtle connector leaves the referenced table's key row. Cardinality is read
from what it reaches:

- one-to-many: an **enclosure** — a frame drawn around the referencing ("many")
  card, headed with the referenced table's name, as in `CAMPUS has many`
  around `Students`. The connector meets the frame with a small square port,
  and a dotted lead continues to the foreign-key row. A table with several
  parents gets one concentric frame per relationship; when the same parent
  frames a table twice (author and editor), each heading adds `via <column>`.
- one-to-one: no frame; one mark at each end of the connector.

An enclosure is an indicator, not containment. It is derived from the
relationship, follows its card wherever it is dragged, and never means that a
card placed inside it belongs to the parent: position still never defines
structure.

Selecting a relationship — by clicking the connector, an enclosure's heading,
or its row in the inspector — highlights exactly the columns that participate.
Selecting it on the canvas also opens the referencing table in the inspector.
Moving cards changes only the connector's path, never the association.
Foreign-key columns carry an `FK` badge, and relationship-owned uniqueness adds
a `UQ` badge.

## Editing and validation

- Renaming a table or column keeps the relationship: identity is by id.
- Multiple relationships between the same pair of tables are separate
  associations, so author and editor references coexist.
- Changing a participating column's type away from the referenced key's type
  keeps the relationship in the saved draft and blocks SQL with a visible
  "needs matching types" error. Incompatible edits are never auto-fixed.
- Removing a relationship removes only the constraints it owns. Its columns
  stay, and independent column settings are preserved.
- Removing a participating column or a referenced table requires confirmation.

## Deletion safeguards

`describeRemoval` reports what a destructive edit would take with it, listing
each affected relationship as `Referencing.column → Referenced.column` together
with the relationship-owned constraints that would go with it (`foreign key`,
or `foreign key + unique`). Removing without confirmation is refused while
relationships are affected, so cancelling is always safe: the design is
unchanged.

A confirmed removal deletes only its target and the affected relationships.
Other tables, other columns, and the retained foreign-key columns of removed
relationships stay exactly as they were; a retained column loses only the
uniqueness the relationship owned.

## Sandbox inspection

The applied sandbox reports the foreign keys PostgreSQL actually created:
constraint name, both participating tables and columns, and the update and
delete rules. Its catalog also reports the referencing column's uniqueness.
Behavioral tests read those reported constraints and also exercise the generated
SQL against a real PGlite database: required references reject `NULL` and
unknown parents, optional ones allow absence, one-to-one uniqueness rejects a
second match, and `NO ACTION` refuses to orphan a referencing row.

## Verification

`bun test src/bun/one-to-one.test.ts` covers, through the workspace interface
and real databases:

- one-to-one creation with a generated referencing column, a real foreign key,
  and catalog-confirmed uniqueness; duplicate non-null references and unknown
  parents are rejected, absence is rejected when required;
- optional one-to-one references accepting repeated `NULL`s while still
  rejecting a second match;
- converting a relationship between one-to-many and one-to-one, and rejecting an
  unsupported cardinality;
- cardinality and constraint ownership surviving column and table renames plus
  save/reopen in a fresh workspace;
- removing a relationship keeping its columns and dropping only relationship-
  owned constraints, while an independently configured unique column keeps its
  constraint;
- removal plans reporting `foreign key` versus `foreign key + unique`, refusing
  unconfirmed deletes, and confirmed table deletion retaining the referencing
  columns without the relationship-owned constraints.

The real Electrobun desktop view was driven through WebView2 remote debugging
against a temporary database (`hutch run dev`, no Vite server). In one run:

1. Created project `Library`, added `Authors` and `Books`, and moved the `Books`
   card clear of the cascade placement.
2. Clicked **relate** on `Books`, chose **one-to-one**, and clicked `Authors`.
   The banner stated that `Books` would store the reference; the connector
   reported `one-to-one`; `Books.author_id` showed `FK` and `UQ`; the inspector
   read `ONE-TO-ONE` and `Books.author_id → Authors.id · unique`; the SQL
   preview contained the `NO ACTION` foreign key and
   `Books_author_id_key UNIQUE`; the sandbox accepted revision 4 with
   `author_id · bigint · not null · unique`; and the new relationship was
   selected, highlighting exactly `Books.author_id` and `Authors.id`.
3. Switched **Required** off: the SQL dropped `NOT NULL`, kept the unique
   constraint, and the sandbox accepted `author_id · bigint · null · unique`.
   Reading the SQLite document showed `cardinality: "one-to-one"`, a nullable
   referencing column, and no independent `unique` setting on it.
4. Relaunched the app: the connector, `FK`/`UQ` badges, unchecked Required,
   nullable-unique sandbox column, and stored cardinality all returned.
5. Opened the table-removal confirmation for `Authors`: it listed
   `Books.author_id → Authors.id` with `foreign key + unique`. Cancelling left
   the schema revision and relationship unchanged.
6. Removed the link: the column stayed, both badges and both constraints went,
   and the sandbox no longer reported uniqueness.
7. Recreated the one-to-one relationship (generating `author_id_2`), then
   confirmed deleting `Authors`: the dialog listed `Books.author_id_2 →
   Authors.id` with `foreign key + unique`. The confirmed deletion kept both
   referencing columns and removed only the foreign key and uniqueness; the
   stored design retained the columns with no relationships, at schema revision
   8, reported `Saved`.
