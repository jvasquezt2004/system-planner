# A local-first PostgreSQL schema designer

Build a desktop tool for designing database structures on an infinite canvas. This document records confirmed product decisions; unanswered questions remain open rather than becoming implicit requirements.

## Confirmed foundations

| Area | Decision |
| --- | --- |
| Purpose | Schema design, not database administration or production data browsing. |
| Canvas | Spreadsheet-styled table cards show column definitions, not stored records. |
| Editing | Selecting a table opens a side panel for editing its columns. |
| Column information | Edit names, types, primary-key status, nullability, uniqueness, default values, and notes. |
| Type coverage | Start with common PostgreSQL types: UUID, text, integers, numeric, boolean, dates/timestamps, and JSONB. Exact variants and parameters are implementation details within this subset. |
| Type presentation | Icons represent type families; the exact PostgreSQL type remains readable through labels or tooltips. |
| Primary keys | Support single-column primary keys initially. New tables start with an editable bigint identity primary key named id. |
| Junction-table keys | Generate a single-column id primary key, two required foreign-key columns, and a combined uniqueness constraint preventing duplicate associations. |
| Defaults | Use structured choices: no default, typed literals, current timestamp, UUID generation, or integer identity generation. |
| Relationships | Subtle connectors identify relationships; surrounding or stacked endpoint marks express cardinality. Selecting a relationship highlights its participating columns. Moving cards does not alter relationships. |
| Relationship constraints | Create real foreign keys; one-to-one relationships also require uniqueness on the referencing column. Many-to-many creation produces a named, visible, editable junction table. |
| Relationship creation | Users relate tables, not manually prepared columns. Automatically generate a matching foreign-key column referencing the other table's primary key, initially id. The generated column remains visible in the card, side panel, and SQL. Existing-column selection is not required in the initial workflow. |
| Relationship optionality | References are required by default. A Required toggle makes a reference optional by allowing the foreign-key column to be nullable. One-to-one means at most one match on each side; parent participation is not enforced. |
| Referential actions | Generate NO ACTION for foreign-key updates and deletes; configurable actions come later. |
| Project organization | Each project contains exactly one design. |
| Persistence | Autosave projects and their designs locally in SQLite, including unfinished drafts and canvas layout. Reopening restores the latest saved design, not an earlier version. |
| Deletion safeguards | Warn and list affected relationships before deleting a referenced table or column. Confirmation may remove those relationships, but must not silently delete other tables or their columns. Removing a relationship keeps the underlying columns and does not silently delete its junction table. |
| Undo/redo | Support design edits and canvas moves during the current session. Persisting undo history across restarts is deferred. Autosave is not an undo mechanism. |
| Authority | The saved design is authoritative and may be unfinished or invalid. |
| Sandbox | A disposable, rebuildable database preview of a valid design; sandbox data need not survive schema changes. Rebuild automatically after structural editing settles; layout-only edits do not rebuild it. |
| Failure behavior | A failed sandbox update must not discard the design. Distinguish the current draft from the last successfully applied version. |
| SQL | Generate a read-only PostgreSQL SQL preview with copy/export capability. When an incomplete draft cannot generate SQL, retain the last generatable SQL with an explicit out-of-date indicator and current errors. If PostgreSQL rejects generated SQL, show that attempted SQL alongside its sandbox error. |
| Installation | The app must work without requiring Docker. PGlite is the first runtime candidate to evaluate, not yet a verified integration. |
| Platform | Verify Windows first. Keep platform-specific operations isolated; do not claim macOS/Linux support before testing packaged builds. |

## Not in the first iteration

- Database administration and browsing production records.
- Connecting to and importing an existing database.
- Arbitrary SQL query execution or an editable SQL-to-canvas workflow.
- Preserving sandbox data across schema changes.
- Custom or extension-provided types, triggers, and functions.
- Multiple designs per project, design branching, and collaboration.
- General composite primary/foreign-key editing.
- Arbitrary handwritten default expressions and configurable foreign-key referential actions.

## First usable checkpoint

Deliver a narrow end-to-end workflow before expanding visual polish or schema coverage:

1. Create a project.
2. Add and edit tables and columns on the canvas.
3. Create a relationship backed by real constraints.
4. Autosave, close, and reopen the project.
5. Inspect generated SQL and automatic sandbox validation.

Refine the relationship notation through a visual prototype; its first appearance is not a permanent commitment.

## Scope status

The product rules for the first slice are agreed. The [build checklist](first-slice.md) consolidates implementation and acceptance checks; application implementation awaits final confirmation of that checklist.

## Implementation checks

- Verify PGlite in the Bun runtime and a packaged Windows Electrobun build before finalizing the sandbox integration.
- Keep the sandbox replaceable; PGlite's single-connection model is suitable for a local schema preview but is not a full PostgreSQL server deployment.

## References

- [Detailed feature spec](spec.md)
- [First-slice build checklist](first-slice.md)
- [Domain vocabulary](../GLOSSARY.md)
- [Why designs are separate from sandboxes](adr/0001-authoritative-design-and-rebuildable-sandbox.md)
- [Electrobun official repository](https://github.com/blackboardsh/electrobun)
- [PGlite official repository and runtime support](https://github.com/electric-sql/pglite)

No application implementation has been started as part of these design discussions.
