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

**SQL preview**:
The read-only SQL representation generated from a design.
_Avoid_: SQL editor

**Structured default**:
A column's automatic value chosen from the fixed options its type supports:
none, a typed literal, current timestamp, UUID generation, or identity
generation. Never a handwritten SQL expression.
_Avoid_: Default expression, SQL default

**Typed literal**:
A default value written in the category of its column's type — text, whole
number, number, boolean, date, timestamp, or JSON — and encoded as a value in
the generated SQL.
_Avoid_: Literal SQL
