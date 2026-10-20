# One-to-many relationships

Relating two table cards creates a real foreign key. The designer never
prepares or selects a foreign-key column: the referencing side receives a
generated column, and the association stays identified by column ids rather than
by names.

## Vocabulary

A **relationship** is one association between a **referencing** table (the
"many" side) and a **referenced** table (the "one" side). The referencing table
stores the generated **foreign-key column**; the referenced table is targeted
through its single-column primary key. An **optional reference** permits a
missing association; a **required reference** does not. Neither setting requires
the referenced table to have any children.

The stored shape is deliberately small:

```ts
type DesignRelationship = {
  id: string;
  referencingTableId: string;
  referencingColumnId: string; // the generated foreign-key column
  referencedTableId: string;   // its primary key is the target
};
```

The referenced column is resolved as the referenced table's current primary key
at SQL-generation time, so a demoted or missing key surfaces as a validation
error instead of silently detaching the relationship.

## Creating a relationship

1. Click **relate** in a table card header. That card becomes the referencing
   side.
2. Click the table card it references. Press `Esc` or **Cancel** to stop.

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
rule requires a referenced record to participate.

## Generated SQL

Foreign keys are emitted after every table exists, so card order never has to
satisfy a dependency:

```sql
ALTER TABLE "Books"
  ADD CONSTRAINT "Books_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "Authors" ("id") ON UPDATE NO ACTION ON DELETE NO ACTION;
```

`NO ACTION` is fixed for this ticket: the initial schema never cascades an
update or delete without the designer's intent. The read-only SQL preview, the
sandbox, and the design always describe the same constraint.

## Visual indicators

A subtle connector joins the two participating column rows. The referenced
("one") end carries a single perpendicular mark; the referencing ("many") end
carries three stacked marks. Selecting a relationship — by clicking the
connector or its row in the side panel — highlights exactly the columns that
participate. Moving cards changes only the connector's path, never the
association. Foreign-key columns also carry an `FK` badge on their row.

## Editing and validation

- Renaming a table or column keeps the relationship: identity is by id.
- Multiple relationships between the same pair of tables are separate
  associations, so author and editor references coexist.
- Changing a participating column's type away from the referenced key's type
  keeps the relationship in the saved draft and blocks SQL with a visible
  "needs matching types" error. Incompatible edits are never auto-fixed.
- Removing a relationship removes only its constraint. Its columns stay.
- Removing a participating column or a referenced table requires confirmation.

## Deletion safeguards

`describeRemoval` reports what a destructive edit would take with it, listing
each affected relationship as `Referencing.column → Referenced.column`.
Removing without confirmation is refused while relationships are affected, so
cancelling is always safe: the design is unchanged.

A confirmed removal deletes only its target and the affected relationships.
Other tables, other columns, and the retained foreign-key columns of removed
relationships stay exactly as they were.

## Sandbox inspection

The applied sandbox reports the foreign keys PostgreSQL actually created:
constraint name, both participating tables and columns, and the update and
delete rules. Behavioral tests read those reported constraints and also exercise
the generated SQL against a real PGlite database: required references reject
`NULL` and unknown parents, optional ones allow absence, and `NO ACTION` refuses
to orphan a referencing row.
