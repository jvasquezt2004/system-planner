# Relationships

Relating two table cards creates database-enforced associations. One-to-many and
one-to-one relationships create a foreign-key column on the referencing table.
Many-to-many relationships create a named, visible junction table whose columns
and additional association fields remain editable. Relationship identity uses
stable table and column ids, not names.

## Vocabulary

A **direct relationship** is one database-enforced association between a
**referencing** table and a **referenced** table. The referencing table stores
the generated **foreign-key column**; the referenced table is targeted through
its single-column primary key. An **optional reference** permits a missing
association; a **required reference** does not. Neither setting requires the
referenced table to have any children.

For direct relationships, cardinality says how many referencing records may
name the same referenced record:

- **one-to-many** (the default): any number may name the referenced record;
- **one-to-one**: at most one may name it, enforced by relationship-owned
  uniqueness on the referencing column.

A **many-to-many relationship** is a separate association form: records on either
side may pair with multiple records from the other side, stored as unique
endpoint pairs in a junction table.

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

A direct `DesignRelationship` stores one foreign-key edge. A many-to-many
association is stored separately as `DesignManyToManyAssociation`, which ties
the two endpoint table ids to the junction table id and its two child
relationship ids. The association owns both foreign keys and the pair-level
uniqueness; names are never identity.

The referenced column is resolved as the referenced table's current primary key
at SQL-generation time, so a demoted or missing key surfaces as a validation
error instead of silently detaching the relationship. Documents saved before
cardinality existed reopen as one-to-many.

## Creating a relationship

1. Click **relate** in a table card header. For one-to-many and one-to-one, that
   card becomes the referencing side. For many-to-many, it becomes the first
   endpoint.
2. Choose **many**, **one-to-one**, or **many-to-many** in the banner.
   One-to-many is preselected.
3. Click the card it references, or the second endpoint for many-to-many.
   Press `Esc` or **Cancel** to stop.

For one-to-many and one-to-one, the workspace creates one column on the
referencing table:

- name derived from the referenced table and key, for example `author_id`;
- the referenced key's exact type;
- no identity generation, no default, not unique, not a primary key;
- required by default (`NOT NULL`).

Name collisions never overwrite an existing column: if `author_id` already
exists, the generated column becomes `author_id_2`, and the existing column
keeps its identity, type, and nullability.

A many-to-many choice creates a new junction table named by concatenating the
endpoint table names (`StudentsCourses` by default; `_2`, `_3`, … resolve
collisions). Name allocation also skips existing PostgreSQL table, index, and
identity-sequence names. The canvas places it below the endpoints without
overlapping existing cards. The junction has its own generated identity primary
key and two required foreign-key columns. Each reference has the exact type of
its endpoint primary key. The junction is a regular editable table, so it can
be renamed, moved, and extended with association fields such as `grade`.

## Required and optional

The relationship-owned column's nullability is the source of truth for direct
one-to-many and one-to-one references. The **Required** control in the side panel
and the **Nullable** control in the column editor therefore cannot disagree:
switching Required off makes the column nullable, and making the column nullable
in the editor makes the reference optional. Turning Required back on makes it
`NOT NULL` again.

Both many-to-many endpoint columns are always required. Their Required controls
are disabled, and the column editor cannot make them nullable, unique, primary
keys, identity columns, or defaulted. Other junction columns remain editable.

An optional direct reference still has to name an existing row when present.
Neither direct cardinality requires a referenced record to participate. A
many-to-many endpoint may also have no associations.

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

ALTER TABLE "StudentsCourses"
  ADD CONSTRAINT "StudentsCourses_pair_key" UNIQUE ("student_id", "course_id");
```

The single-column uniqueness statement appears only for a one-to-one
relationship that owns uniqueness. Many-to-many pair uniqueness is composite:
neither endpoint column is individually unique. `NO ACTION` is fixed: the
initial schema never cascades an update or delete without the designer's intent.
The read-only SQL preview, the sandbox, and the design always describe the same
constraints.

## Visual indicators

A subtle connector joins the two participating column rows. Cardinality uses
endpoint marks:

- one-to-many: three stacked marks at the referencing end and one mark at the
  referenced end;
- one-to-one: one mark at each end;
- many-to-many: the junction card carries an `M:N` badge and connects to each
  endpoint with a one-to-many edge. The diagram uses connectors, never table
  containment.

Selecting a relationship — by clicking its connector or its row in the side
panel — highlights exactly the participating foreign-key and primary-key
columns. Moving cards changes only connector paths, never association identity.
Foreign-key columns carry an `FK` badge; one-to-one uniqueness adds `UQ`.
Many-to-many pair uniqueness is table-level and does not make either endpoint
column individually unique.

## Editing and validation

- Renaming an endpoint table, junction table, or column keeps the relationship:
  identity is by id.
- Multiple relationships between the same pair of tables are separate
  associations, so author and editor references coexist.
- Additional junction columns are ordinary editable association fields.
- Both many-to-many endpoint references stay required. The editor blocks
  nullable, unique, primary-key, identity, and default settings on those
  relationship-owned columns; name, type, and notes remain editable.
- Changing a participating column's type away from the referenced key's type
  keeps the relationship in the saved draft and blocks SQL with a visible
  "needs matching types" error. Incompatible edits are never auto-fixed.
- Removing either child link of a many-to-many relationship removes both foreign
  keys, pair uniqueness, and association metadata. The junction and all its
  columns stay.
- Removing a participating column or endpoint table requires confirmation.
  Confirmed endpoint deletion removes both links but preserves the junction and
  its other columns.

## Deletion safeguards

`describeRemoval` groups a many-to-many association as
`Many-to-many: Students ↔ Courses via StudentsCourses; 2 foreign keys + unique
pair`. Direct relationships are listed as `Referencing.column →
Referenced.column` with their owned constraints (`foreign key`, or
`foreign key + unique`). Removing without confirmation is refused while
relationships are affected, so cancelling is always safe: the design is
unchanged.

A confirmed removal deletes only its target and the affected relationships.
Removing an endpoint or junction reference column removes the grouped
association's constraints but retains the junction and its non-target columns.
Other tables, independent column settings, and independent constraints are
untouched.

## Sandbox inspection

The applied sandbox reports the foreign keys PostgreSQL actually created:
constraint name, both participating tables and columns, and the update and
delete rules. Its catalog reports per-column uniqueness only for single-column
constraints; a composite many-to-many pair key does not falsely mark each
foreign-key column unique. Behavioral tests exercise the generated SQL against
a real PGlite database: required references reject `NULL` and unknown parents,
duplicate pairs fail while distinct pairs pass, and `NO ACTION` refuses to
orphan a referencing row.

## Verification

### Workspace tests

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

`bun test src/bun/many-to-many.test.ts` exercises the public workspace seam with
real SQLite persistence and real PGlite:

- generated visible junctions with an identity primary key, required references
  matching different endpoint key types (`bigint` and `uuid`), `NO ACTION`
  rules, and a unique endpoint pair; distinct pairs pass, duplicate pairs,
  `NULL`s, and unknown parents fail;
- junction and endpoint renames, reference-column and additional association-
  field renames, stable relationship ids, and layout surviving save/reopen;
- grouped dependency plans, safe cancellation, confirmed endpoint deletion
  retaining the junction and its fields, and relationship removal retaining
  columns while removing both foreign keys and pair uniqueness;
- junction names skip existing identity sequences and PostgreSQL-generated
  primary-key and unique-index names, including truncated and auto-suffixed
  identifiers;
- pair constraints deconflict with unique indexes on other tables and editable
  unique association fields;
- required junction references resist nullable, unique, primary-key, identity,
  and default edits.

### Desktop smoke runs

The real Electrobun desktop view was driven through WebView2 remote debugging
against an isolated temporary database and profile (`hutch run dev`, port
`9309`; no Vite server):

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

A separate many-to-many desktop run:

1. Created project `School` with `Students` and `Courses`, chose
   **many-to-many**, and clicked the other endpoint. The new `StudentsCourses`
   card appeared below the endpoints, carried the `M:N` badge, and connected to
   both endpoint cards. It was selected for editing.
2. The SQL preview showed its identity `id`, required `student_id` and
   `course_id`, both `NO ACTION` foreign keys, and the composite
   `StudentsCourses_pair_key`; the real sandbox accepted schema revision 4.
3. Renamed the junction to `Enrollments` and added the editable `grade` text
   field. Removing the association removed both foreign keys and pair
   uniqueness while preserving `Enrollments` and all four columns; the sandbox
   accepted revision 8.
4. Recreated the association, renamed the junction, and added `grade` again.
   Restarted the app with the same temporary database: revision 13 restored the
   `Enrollments` name, both M:N links, `grade`, and the junction's saved layout.
5. The endpoint-removal dialog grouped the dependency as
   `Many-to-many: Students ↔ Courses via Enrollments; 2 foreign keys + unique
   pair`. Cancelling left revision 13 unchanged. Confirming deletion of
   `Students` produced revision 14, retained `Enrollments` and its four columns,
   and removed both foreign keys and pair uniqueness; the sandbox accepted the
   resulting schema.

The packaged Windows build was also exercised from an isolated extraction of
`hutch run build` (no Vite server and no install over the existing user app),
with a temporary SQLite database, WebView2 profile, and remote-debugging port
`9309`:

1. Created `School`, `Students`, and `Courses`; relating the endpoints produced
   a visible `StudentsCourses` card and an accepted sandbox with the identity
   key, required references, `NO ACTION` foreign keys, and pair uniqueness.
2. Renamed the junction to `Enrollments`, added a `grade` text field with a
   note, and confirmed the current SQL and accepted sandbox at revision 7.
   Nullability, uniqueness, primary-key, and default controls were disabled
   for a generated reference; its name, type, and notes remained editable.
3. Closed and relaunched the packaged app against the same temporary database.
   Revision 7 restored `Enrollments`, both many-to-many links, `grade`, its
   note, current SQL, and the accepted sandbox.

