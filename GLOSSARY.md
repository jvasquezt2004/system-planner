# Schema Designer

Vocabulary for designing relational database structures and understanding their visual and SQL representations.

## Language

**Project**:
A named, locally saved workspace containing exactly one design.
_Avoid_: Collection of designs

**Design**:
The authoritative description of a planned database structure and its visual layout. A design may be unfinished or temporarily invalid.
_Avoid_: Sandbox, live database

**Sandbox**:
A disposable database preview built from a valid version of a design. It is not the authoritative design, and its data is not intended to be preserved.
_Avoid_: Design, production database

**Scenario**:
A named, saved, ordered series of data operations that a project keeps next to
its design and replays against a fresh sandbox to see how the design behaves
with records. The scenario is authoritative; the records it produces are not,
and a design change never migrates them. Each scenario starts empty and never
sees another scenario's records.
_Avoid_: Seed data, test data, migration

**Edge function**:
A named TypeScript server handler kept with its Project and invoked by Scenarios.
_Avoid_: Function (use **Function** for database routines), backend, serverless

**Scenario run**:
One execution of a scenario, on demand, against its own empty sandbox built
from a specific design revision. It is stale, never current, once the design
has moved past that revision. A run ends passed, failed, or errored.
_Avoid_: Test run, live data

**Expectation**:
An outcome a scenario states for one of its Sandbox API requests, such as
succeeding or failing with a particular PostgreSQL error. An unmet expectation
fails the run; an unexpected exception errors it.
_Avoid_: Assertion, test

**Sandbox API**:
The PostgREST-compatible interface a sandbox offers to scenarios. It covers a
documented subset of PostgREST and refuses anything outside it rather than
approximating.
_Avoid_: PostgREST, Supabase, backend


**Function**:
A named PostgreSQL routine with typed arguments, a declared return shape, and a handwritten SQL or PL/pgSQL body.
_Avoid_: Trigger (a function is called explicitly or by a trigger; it is not itself a trigger)


**Trigger**:
A named table rule that invokes a Function before or after selected row or
statement events.
_Avoid_: Function

**Table card**:
The spreadsheet-styled representation of a table on the canvas, showing its column definitions rather than stored records.
_Avoid_: Data grid, spreadsheet of records

**Relationship**:
An association between tables backed by database constraints. A many-to-many relationship is represented through a visible junction table.
_Avoid_: Decorative connection

**One-to-one relationship**:
A relationship in which at most one referencing-side record may name each
referenced-side record, enforced by uniqueness on the referencing column. It
does not require every referenced-side record to participate.
_Avoid_: Mandatory pairing on both sides

**Many-to-many relationship**:
An association where each record may pair with multiple records from the other
table, represented by an editable junction table with its own primary key and
unique endpoint pair.
_Avoid_: Hidden link table, composite endpoint key

**Relationship-owned constraints**:
The foreign key, one-to-one uniqueness, or many-to-many pair uniqueness that
exists because of a relationship. Removing the relationship removes exactly
these, never an independently configured column constraint.
_Avoid_: Column setting

**Required relationship**:
An association in which each referencing-side record must identify a related record. It does not require every referenced-side record to participate.
_Avoid_: Mandatory matching on both sides

**Junction table**:
An editable table that records associations between two tables in a many-to-many relationship and may contain additional columns describing those associations.
_Avoid_: Hidden link table

**Relationship indicator**:
A visual representation of a relationship: a subtle connector identifies the association, and surrounding or stacked endpoint marks express cardinality.
_Avoid_: Table containment

**Enclosure**:
The relationship indicator for one-to-many: a frame around the referencing
table card, headed with the referenced table's name ("Campus has many"
Students). It is derived from the relationship and follows its card; it never
means that position or placement defines structure.
_Avoid_: Group, container, nesting

**SQL preview**:
The read-only SQL representation generated from a design, shown in its own
view in place of the canvas, together with the sandbox's result. It can also
show the same design as schema code for an ORM.
_Avoid_: SQL editor

**Code format**:
One way the SQL preview can render a design: PostgreSQL, Prisma, Drizzle,
SQLAlchemy, or Django ORM. PostgreSQL is the reference; an ORM format is only
generated from a draft that already produces PostgreSQL.
_Avoid_: Dialect, export target

**Schema code**:
The read-only, generated ORM source for one code format. It is derived from
the design, never edited, and never shown out of date.
_Avoid_: Migration, ORM model editor

**Structured default**:
A column's automatic value chosen from the fixed options its type supports:
none, a typed literal, current timestamp, UUID generation, or identity
generation. Never a handwritten SQL expression.
_Avoid_: Default expression, SQL default

**Typed literal**:
A default value written in the category of its column's type — text, whole
number, number, boolean, date, time, timestamp, or JSON — and encoded as a value in
the generated SQL.
_Avoid_: Literal SQL

**Row-level security**:
A PostgreSQL table feature that filters which rows a database role may read or modify, according to policies attached to the table.
_Avoid_: Row permissions

**Policy**:
A named PostgreSQL rule on a table that permits or restricts rows for selected roles, commands, and handwritten conditions.
_Avoid_: Access control list

**Index**:
A table-level PostgreSQL access structure over ordered column keys, optionally
unique, covering additional columns, and using a selected access method.
_Avoid_: Query, constraint (unless the index enforces a declared unique constraint)

**Index key**:
One ordered column reference in an index, identified by stable column id and
optionally carrying ordering and operator-class choices.
_Avoid_: Index expression

**Access method**:
The PostgreSQL index implementation selected for an index, such as B-tree,
GIN, HNSW, or IVFFlat.
_Avoid_: Index type (ambiguous with column type)

**Operator class**:
The PostgreSQL operator family that defines how an index key is compared or
searched.
_Avoid_: Operator

**Enum type**:
A named PostgreSQL type whose allowed values are a fixed, ordered set of labels.
_Avoid_: Lookup table

**Vector column**:
A column using a pgvector vector, halfvec, or sparsevec type with a structured
dimension parameter.
_Avoid_: Embedding (unless that is the column's domain meaning)

**Composite unique constraint**:
A table constraint that prevents repeated combinations of two or more columns.
_Avoid_: Unique columns (which suggests each is independently unique)

**Referential action**:
The configured PostgreSQL action for updating or deleting a row referenced by a
foreign key.
_Avoid_: Cascade (unless the action is specifically CASCADE)
