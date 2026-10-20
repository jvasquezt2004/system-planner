# First usable slice: design, save, and validate a schema

Build a narrow Windows-first workflow that turns table-to-table design gestures into real PostgreSQL constraints, saves the design locally, and validates generated SQL without Docker.

**Status:** Scope consolidated from the design discussion; awaiting final confirmation before application implementation.

See the [detailed feature spec](spec.md) for user stories, implementation decisions, and the proposed behavioral test seam.

## User-visible acceptance checklist

### Design and save

- [ ] Create and reopen named projects, each containing exactly one design.
- [ ] Autosave the design and canvas layout in local SQLite, including incomplete drafts.
- [ ] Show save failures clearly rather than claiming unsaved work is safe.
- [ ] Reopening restores the latest saved design. It does not restore an older version or the previous session's undo stack.

### Edit on the canvas

- [ ] Pan and zoom the canvas; add, move, select, and delete spreadsheet-styled table cards.
- [ ] Show column names, readable types, and type-family symbols; never show stored records as card content.
- [ ] Open a side panel to edit column names, supported types, primary-key status, nullability, uniqueness, structured defaults, and notes.
- [ ] Start new tables with an editable id bigint identity primary key; support single-column primary keys.
- [ ] Provide session undo/redo for design changes and canvas moves.

### Relate tables

- [ ] Create one-to-one, one-to-many, and many-to-many relationships by relating tables, without preparing foreign-key columns manually.
- [ ] Automatically create a matching foreign-key column referencing the selected table's primary key; do not silently overwrite existing columns.
- [ ] Add uniqueness to the referencing column for one-to-one relationships.
- [ ] Create a visible, editable junction table for many-to-many, with its own id, two required references, and combined uniqueness preventing duplicate associations.
- [ ] Make ordinary references required by default, with an optional nullable setting. Do not imply every parent must have children.
- [ ] Generate NO ACTION for updates and deletes.
- [ ] Identify each relationship with a subtle connector and communicate cardinality through surrounding/stacked endpoint marks. Selecting a relationship highlights its columns.
- [ ] Distinguish multiple relationships between the same tables. Card positions do not determine schema meaning.
- [ ] Confirm dependency-affecting deletions. Removing a relationship retains its columns; it does not silently delete a junction table or other tables.

### Inspect and validate

- [ ] Generate read-only PostgreSQL SQL with copy/export.
- [ ] Automatically rebuild a disposable sandbox after structural edits settle, but not after layout-only changes.
- [ ] Keep unfinished or invalid editing work independent of sandbox success.
- [ ] If generation is blocked, retain the last generatable SQL with a stale indicator and current errors. If PostgreSQL rejects generated SQL, show the attempted SQL and its error.
- [ ] Distinguish the current draft from the last successfully applied sandbox version; do not let stale asynchronous results replace newer status.
- [ ] Run without Docker or a separately installed PostgreSQL server.

## Delivery order

Each work unit includes the tests and documentation that verify its behavior. These are implementation boundaries, not a request to create commits or pull requests automatically.

| Work unit | Finished behavior | Verification |
| --- | --- | --- |
| 1. Prove native dependencies | SQLite persistence and a minimal PGlite schema work in Bun and can be packaged for Windows. | Save/reopen a temporary design; execute and inspect a schema in PGlite; run the packaged app without a development server. Treat PGlite as a candidate until this passes. |
| 2. Persist and edit a design | A minimal project UI supports table/column edits and canvas layout, saved through Electrobun's typed bridge. | Validate design changes and serialization; exercise save/reopen, unfinished drafts, and save failures. |
| 3. Create constrained relationships | Table gestures generate columns, constraints, and visible junction tables; destructive edits and undo behave predictably. | Test all three cardinalities, optionality, multiple references, pair uniqueness, deletion, and undo/redo. |
| 4. Keep SQL and sandbox current | The read-only SQL panel and automatic sandbox reflect structural edits, with explicit errors and revision status. | Execute generated schemas, inspect actual database constraints, reject invalid drafts without losing them, and test stale-result handling. |
| 5. Verify the complete Windows workflow | The packaged app supports the full create/edit/relate/save/reopen/inspect loop. | Run an Authors/Books example and a Students/Courses junction example; verify deletion safeguards, session undo, SQL export, and operation without Docker. |

## Boundaries

Keep the canvas and editor in React. Keep local storage and database operations in the Bun main process, accessed through Electrobun APIs rather than Electron patterns. The design remains authoritative and the sandbox replaceable.

The supported type families, structured defaults, and deferred features are recorded in [the design scope](design.md). Shared terms are defined in [the glossary](../GLOSSARY.md).
