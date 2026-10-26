# Schema Designer

Vocabulary for designing and explaining systems, including their architecture,
relational database structures, and authored walkthroughs.

## Language

**Project**:
A named, locally saved workspace representing one system, with its System design,
linked database Designs, and supporting project content.
_Avoid_: Database design, unrelated collection of systems

**Design**:
The authoritative description of a planned database structure and its visual layout. A design may be unfinished or temporarily invalid.
_Avoid_: System design, sandbox, live database

**System design**:
The authoritative description of a Project's planned system architecture,
including its components, connections, and service boundaries.
_Avoid_: Database design, running system

**Component**:
An element of a System design representing an actor, client, computing unit,
resource, or supporting capability. It has one owning Service or sits at system
scope as a shared or independent element.
_Avoid_: Table card, deployed resource

**Service**:
A named part of a System design with explicit ownership of its components.
It can be shown as an expanded boundary or a collapsed endpoint and can
participate directly in Connections.
_Avoid_: Visual group, deployment boundary

**Service ownership**:
The explicit assignment of a Component to one Service. Using a Component
through a Connection or placing it visually near a Service does not confer
ownership.
_Avoid_: Proximity, shared ownership

**Group**:
A named, non-owning organization of parts of a System design, such as a business
domain, region, or network boundary. Membership is explicit, and Groups may
nest or overlap without changing Service ownership.
_Avoid_: Service, Enclosure, owner

**Connection**:
A directed, labeled description of a possible interaction between Components
or Services. Multiple Connections may join the same endpoints; their existence
does not determine a Walkthrough's order of events.
_Avoid_: Relationship, executed request

**Database component**:
A Component representing a database, optionally linked to a Design for supported
schema detail. Multiple Database components may intentionally share a Design
without representing the same database contents.
_Avoid_: Design, sandbox

**Shared schema**:
A database Design intentionally linked from multiple Database components.
Its schema changes apply to every linked Component, without implying shared
database contents or a shared running database.
_Avoid_: Shared database, copied schema

**Service view**:
A focused view of a Service and its contents from the same authoritative
System design used by the system overview.
_Avoid_: Independent diagram, copied service

**Walkthrough**:
A saved, authored explanation of how an interaction moves through a System
design, presented through sequences, explicit parallel steps, finite
repetitions, and coordinated animations. A Project may keep multiple named
Walkthroughs.
_Avoid_: Scenario, simulation, execution

**Sandbox**:
A disposable database preview built from a valid version of a design. It is not the authoritative design, and its data is not intended to be preserved.
_Avoid_: Design, production database

**Scenario**:
A named, saved, ordered series of data operations belonging to one database
Design and replayed against its own fresh Sandbox. The Scenario is authoritative;
its resulting records are disposable, never shared with another Scenario, and
never migrated when the Design changes.
_Avoid_: Seed data, test data, migration

**Edge function**:
A named TypeScript server handler belonging to one database Design and invoked
by that Design's Scenarios against their Sandbox.
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

## Assistant

**Assistant**:
The AI agent inside a Project that reads and changes its System design,
database Designs, Walkthroughs, Scenarios, and Edge functions on the designer's
behalf. Its changes are ordinary project changes the designer can keep refining
by hand.
_Avoid_: Copilot, bot, AI

**Conversation**:
One saved exchange between the designer and the Assistant, belonging to
exactly one project. A project may hold many conversations.
_Avoid_: Chat thread, session

**Assistant turn**:
One designer message and everything the Assistant does in response to it. Its
project changes can be reverted together.
_Avoid_: Step, run (reserved for Scenario run)

**Provider connection**:
One configured way of reaching a model vendor, either an API key or an account
sign-in. The same vendor reached by key and by sign-in is two connections.
_Avoid_: Provider (ambiguous between vendor and credential), account

**Model**:
A language model offered through a provider connection and chosen for a
conversation.
_Avoid_: Engine, LLM
