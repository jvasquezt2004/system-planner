# Build the first usable local PostgreSQL schema designer

## Problem Statement

A schema designer wants to plan a relational database visually without first preparing SQL or manually wiring foreign-key columns. Conventional relationship diagrams do not make table structure and relationship cardinality easy enough to understand at a glance. The designer wants spreadsheet-styled table cards on an infinite canvas, a focused column editor, and relationship indicators that communicate multiplicity through surrounding or stacked marks.

Designing is an unfinished, iterative activity. The designer must be able to save an incomplete or temporarily invalid design without losing work because PostgreSQL rejects it. They also need to inspect the SQL their design produces and know whether a real database engine accepts it, without installing Docker or managing a PostgreSQL server.

The current application is an Electrobun desktop starter, not an existing schema designer. This spec defines a narrow, complete Windows-first workflow rather than a database administration product or full PostgreSQL modeling suite.

## Solution

Provide a local desktop design workspace in which each named project contains exactly one authoritative design. The designer adds and arranges spreadsheet-styled table cards, selects a table to edit its columns in a side panel, and relates tables directly. The application automatically creates the foreign-key columns and constraints needed for one-to-one, one-to-many, and many-to-many relationships. Many-to-many relationships produce visible, editable junction tables.

Use subtle connectors to identify relationships and surrounding or stacked endpoint marks to communicate cardinality, rather than physically nesting table cards. Keep exact type names readable alongside type-family symbols. Ordinary references are required by default, with a toggle to make them optional.

Autosave the design and its layout in local SQLite independently of database validity. Generate a read-only SQL preview with copy/export and automatically validate structural edits in a disposable, Docker-free sandbox. Clearly distinguish the current design, the last generatable SQL, and the last successfully applied sandbox. Confirmation safeguards and session undo/redo protect against accidental edits; reopening restores the latest saved design, not an earlier version.

## User Stories

1. As a schema designer, I want to use the application locally on Windows without Docker or an installed PostgreSQL server, so that I can start planning without managing infrastructure.
2. As a schema designer, I want to create a named project containing one design, so that I have a clear workspace for a planned database.
3. As a schema designer, I want to reopen a saved project, so that I can continue work across application sessions.
4. As a schema designer, I want different projects to retain independent designs, so that work on one database does not alter another.
5. As a schema designer, I want my changes to save automatically, so that I do not depend on remembering a Save command.
6. As a schema designer, I want unfinished and temporarily invalid designs to save, so that I can work through incomplete ideas without losing them.
7. As a schema designer, I want table positions and canvas layout restored with my design, so that I do not have to rearrange my workspace after reopening it.
8. As a schema designer, I want saving failures to be visible, so that I do not mistake unsaved work for safely stored work.
9. As a schema designer, I want to pan and zoom an infinite canvas, so that I can navigate a design larger than the window.
10. As a schema designer, I want new tables to start with an editable id bigint identity primary key, so that I can begin with a useful default instead of configuring a key every time.
11. As a schema designer, I want to rename a table without disconnecting its relationships, so that refining names does not destroy its meaning.
12. As a schema designer, I want to move table cards without changing their relationships, so that layout remains independent of database structure.
13. As a schema designer, I want table cards to display column definitions rather than stored records, so that the canvas stays focused on structure.
14. As a schema designer, I want exact PostgreSQL type names to remain readable, so that visual shorthand does not hide the schema I am designing.
15. As a schema designer, I want type-family symbols with readable labels or tooltips, so that I can scan columns without memorizing unexplained icons.
16. As a schema designer, I want selecting a table to open its column editor in a side panel, so that I can edit details without cluttering every card.
17. As a schema designer, I want to add columns from that editor, so that I can expand a table's structure in one focused place.
18. As a schema designer, I want to rename columns without accidentally detaching their relationships, so that I can improve terminology safely.
19. As a schema designer, I want common PostgreSQL types including UUID, text, integers, numeric, boolean, dates/timestamps, and JSONB, so that I can represent ordinary application schemas.
20. As a schema designer, I want to edit single-column primary-key status, so that a table's identifier is not permanently fixed to the initial default.
21. As a schema designer, I want to control column nullability, so that the design expresses which values are required.
22. As a schema designer, I want to mark a column as unique, so that the generated schema can prevent duplicate values.
23. As a schema designer, I want to attach notes to columns, so that I can retain the intent behind a field.
24. As a schema designer, I want typed literal defaults for supported column types, so that I can define ordinary default values without writing SQL expressions.
25. As a schema designer, I want a current-timestamp default for timestamp columns, so that I can model common creation-time fields.
26. As a schema designer, I want UUID-generation defaults for UUID columns, so that I can model automatically generated UUID identifiers.
27. As a schema designer, I want identity generation for integer columns, so that I can model database-generated sequential identifiers.
28. As a schema designer, I want to remove a default value, so that I can return a column to having no automatic default.
29. As a schema designer, I want to relate tables directly and have foreign-key columns created automatically, so that I can focus on functionality rather than preparing the relationship's plumbing.
30. As a schema designer, I want to create a one-to-many relationship, so that I can express structures such as Authors and Books with a real foreign key.
31. As a schema designer, I want to create a one-to-one relationship with foreign-key uniqueness, so that the database enforces at most one matching record.
32. As a schema designer, I want to create a many-to-many relationship, so that I can express structures such as Students and Courses without manually building all linking constraints.
33. As a schema designer, I want the generated junction table to be named, visible, and editable, so that I can add association details such as enrollment date or grade.
34. As a schema designer, I want a junction table to prevent duplicate associations, so that a separate id does not accidentally allow the same pair to be recorded repeatedly.
35. As a schema designer, I want generated foreign-key columns to match the referenced primary-key type, so that I do not have to reconcile incompatible types manually.
36. As a schema designer, I want new ordinary references to be required by default, so that the initial relationship has a clear, conservative meaning.
37. As a schema designer, I want to make a reference optional through a Required toggle, so that I can represent records that do not yet have a related record.
38. As a schema designer, I want the interface to distinguish reference requirements from parent participation, so that I do not mistakenly believe every Author must have a Book or every one-to-one endpoint must have a match.
39. As a schema designer, I want multiple relationships between the same tables to remain distinct, so that author and editor references can coexist without ambiguity.
40. As a schema designer, I want subtle connectors that identify related tables, so that proximity alone does not determine which tables are associated.
41. As a schema designer, I want surrounding or stacked relationship indicators to express one and many, so that cardinality is easier to recognize than in a conventional line-only diagram.
42. As a schema designer, I want selecting a relationship to highlight its participating columns, so that I can trace the visual association to its actual foreign key.
43. As a schema designer, I want generated references to use NO ACTION for updates and deletes, so that the initial SQL never introduces cascading data changes without my intent.
44. As a schema designer, I want a warning listing affected relationships before deleting a referenced table or column, so that destructive edits are explicit.
45. As a schema designer, I want to cancel a dependency-affecting deletion without changing the design, so that inspecting a warning is safe.
46. As a schema designer, I want removing a relationship to retain its underlying columns, so that removing a constraint does not silently remove fields.
47. As a schema designer, I want junction tables and unrelated tables to remain unless I explicitly delete them, so that relationship cleanup does not cause hidden table deletion.
48. As a schema designer, I want to undo design edits during the current session, so that accidental changes are reversible even after autosave.
49. As a schema designer, I want to undo canvas moves, so that I can recover an arrangement I preferred.
50. As a schema designer, I want to redo undone changes during the session, so that I can compare and recover alternative editing steps.
51. As a schema designer, I want reopening behavior to be clear about restoring the latest saved state rather than an older version or undo history, so that I do not mistake autosave for version history.
52. As a schema designer, I want a read-only SQL preview generated from my visual design, so that I can understand its PostgreSQL representation without maintaining two competing editors.
53. As a schema designer, I want to copy the SQL preview, so that I can use it outside the designer.
54. As a schema designer, I want to export the SQL preview, so that I can retain or share the generated schema.
55. As a schema designer, I want structural edits to rebuild the sandbox automatically after editing settles, so that I receive database validation without an Apply step.
56. As a schema designer, I want layout-only changes to avoid rebuilding the sandbox, so that arranging cards does not trigger irrelevant database work.
57. As a schema designer, I want the sandbox to be disposable and rebuildable, so that changing a design does not require maintaining migrations or protecting sample data.
58. As a schema designer, I want sandbox failures to leave my current design intact, so that a database error cannot discard editing work.
59. As a schema designer, I want the last generatable SQL to remain visible with an out-of-date indicator and current errors when generation is blocked, so that I retain useful context without mistaking it for the latest draft.
60. As a schema designer, I want to inspect attempted SQL and its database error when the sandbox rejects it, so that I can understand what failed.
61. As a schema designer, I want the current draft to be visibly distinguished from the last successful sandbox version, so that an older preview is never presented as current.
62. As a schema designer, I want late results from older edits or another project to be ignored, so that validation feedback always belongs to the design I am viewing.
63. As a schema designer, I want a clear empty or blocked SQL state when no SQL has yet been generated, so that the interface does not imply a successful preview exists.
64. As a schema designer, I want the packaged Windows application to complete the workflow without a development server, so that development-mode behavior is not the only working version of the product.

## Implementation Decisions

### Confirmed product and architecture decisions

- Retain the existing Electrobun, React, Vite, and Tailwind stack. Electrobun is not Electron; use its own native/view interfaces and bundled-asset workflow.
- Keep the canvas and editor in the React view. Keep SQLite persistence and sandbox execution in the Bun main process, with typed communication between the view and main process.
- Respect the existing architectural decision: the design is authoritative; the sandbox is a rebuildable preview. Neither database availability nor semantic schema validity may be a prerequisite for retaining a draft.
- Each named project owns exactly one design. Persist its structure and visual layout in local SQLite, using saves that cannot leave a partially written design presented as complete. Exact storage normalization is an implementation detail, not a requirement to mirror the planned PostgreSQL schema in SQLite tables.
- Table cards represent schema structure, not data records. Selecting a table opens its column editor; panning, zooming, and moving cards are layout operations rather than schema changes.
- Support the agreed common PostgreSQL type families. The type picker, validation, structured defaults, and SQL generation must agree on the supported variants and parameters. Symbols indicate type families and must not be the only way to identify a type.
- Begin with single-column primary keys. A new table starts with an editable bigint identity primary key named id. UUID or another supported key type may replace that initial choice.
- Support structured defaults only: none, compatible typed literals, current timestamp for timestamp columns, UUID generation for UUID columns, and identity generation for integer columns. Reject incompatible choices as validation errors rather than silently changing their meaning.
- Relationship creation is table-to-table. The interaction must make the referencing and referenced roles clear without requiring the designer to prepare or select a foreign-key column. Generate a distinct column matching the referenced primary-key type, not its identity-generation or default settings. Never overwrite an existing column silently.
- One-to-many creates a foreign key on the many side. One-to-one also creates uniqueness on the referencing column. References initially target primary keys rather than arbitrary unique columns.
- Many-to-many creates a visible, named, editable junction table with its own single-column id primary key, two required foreign-key columns, and combined uniqueness on the pair. The combined uniqueness is a targeted junction-table capability, not general composite primary/foreign-key editing.
- Ordinary references are required by default. Switching off Required makes the referencing column nullable. Keep that toggle consistent with column nullability. One-to-one establishes a maximum of one match, and no relationship in this slice enforces that every referenced-side record participates.
- Use NO ACTION for foreign-key updates and deletes. Do not introduce cascading behavior automatically.
- Use subtle connectors to identify relationships and surrounding or stacked endpoint marks to express cardinality. Highlight participating columns on selection and distinguish separate relationships between the same tables. Physical card containment and position do not define relationships. Exact drawing details remain deliberately adjustable after the first prototype.
- Warn about relationship dependencies before deleting a referenced table or column, and make cancellation leave the design unchanged. Confirmed deletion can remove affected relationships, but must not silently delete other tables or their columns. Removing a relationship removes its relationship-owned constraints, not its underlying columns, and must not silently delete a junction table.
- Support session undo/redo for design edits and layout changes. Autosave the resulting current design after undo or redo. Reopening restores the latest saved design, not an earlier version or the prior session's undo history.
- Generate PostgreSQL SQL in one direction from the design and expose it read-only, with copy/export. An incomplete draft that cannot generate SQL retains the last generatable SQL with explicit stale status and errors. If no previous SQL exists, show an empty/blocked state. A database rejection shows the attempted SQL and its error rather than presenting the previous success as current.
- Debounce automatic sandbox rebuilds after structural editing settles. Layout-only changes save layout without rebuilding the database. A failed candidate rebuild leaves the authoritative design and last successful preview intact.
- The application must not require Docker or a separately installed PostgreSQL server. PGlite is the first candidate because its PostgreSQL WebAssembly runtime supports Bun; it is not yet a verified dependency of this application. Verify its required capabilities and packaged Windows operation before finalizing it, and retain a replaceable sandbox implementation.
- Windows is the initial verification target. Keep platform-specific operations localized, but make no macOS/Linux support claim until packaged builds have been tested there.

### Proposed module interface and implementation invariants

These are technical proposals synthesized for the spec, not additional product commitments already confirmed by the designer.

- Introduce a deep design workspace module with one primary application interface for opening projects, applying design/layout actions, undoing/redoing, and observing current workspace state. The React view and behavioral tests should use the same interface rather than reaching into storage, reducers, SQL helpers, or sandbox orchestration independently.
- Its observable state should identify the current project/design revision, save outcome, generation errors, SQL availability and revision, and sandbox outcome/applied revision. This makes unfinished, unsaved, stale, failed, and successfully applied states distinguishable without exposing internal orchestration.
- Keep persistence, SQL generation/validation, and sandbox execution as internal collaborators behind that interface. Do not introduce separate public adapters merely to provide mocking points where behavior does not actually vary.
- Use stable internal identities for tables, columns, and relationships, independent of editable names. Detect naming conflicts and incompatible key edits explicitly; preserve the draft and report errors rather than silently disconnecting or reinterpreting relationships.
- Validate the shape of incoming workspace actions while permitting semantically incomplete designs. Quote identifiers and encode typed literals safely so that names, notes, and default values cannot become unintended SQL statements.
- Associate saves and asynchronous preview results with project identity and design revision. Older saves/results must not replace newer state or contaminate a different project after a switch. Structural and layout changes must remain distinguishable.
- Keep the current design, last generatable SQL, and last successfully applied sandbox as separate concepts. Retain preview availability only where it genuinely exists; a failed first build cannot claim a last successful preview.

## Testing Decisions

### Confirmed primary seam

Use the design workspace module's public application interface as the single primary behavioral test seam. Exercise the same actions and observable state used by the React view, with real temporary SQLite storage and a real disposable PostgreSQL-compatible sandbox. This is a new seam because the starter has no existing schema-design interface to reuse.

Keep ordinary feature tests at this high level instead of creating independent mock-based suites for every internal collaborator. Use narrowly controlled I/O failures or scheduling only where necessary to verify failure and race behavior; normal database behavior must be demonstrated with real databases.

A thin packaged-application smoke test should traverse the real React view and Electrobun typed communication to catch wiring, rendering, bundled-asset, and Windows runtime failures that an in-process workspace test cannot detect. This verifies the existing user-entry path rather than introducing another internal mocking seam. Do not assume Electron-specific automation works with Electrobun. Automation tooling remains an implementation choice; record manual packaged checks explicitly if automation is not yet available.

### Test quality and prior art

- Good tests perform externally meaningful actions and assert observable design state, persistence, user-visible status, or actual database behavior. They should survive moving internal functions or changing orchestration.
- Do not assert private reducer calls, helper names, internal call order, exact debounce durations, or SQL whitespace as the primary proof of correctness.
- Validate SQL chiefly by execution, catalog inspection, and constraint enforcement, rather than only comparing generated strings. Internal test inserts/queries are verification tools, not a user-facing arbitrary-query feature.
- The current starter has a counter view and native window bootstrap, with no feature tests, configured feature test runner, SQLite implementation, sandbox implementation, or typed design-workspace communication. There is no existing feature-test prior art to follow. Do not represent generated framework/devkit tests as tests of this application.
- The primary module under test is the design workspace as a whole, including its observable persistence, relationship editing, SQL generation, and sandbox behavior. Verify the canvas/editor and native bridge through a small number of real application workflow checks instead of duplicating all core assertions at every layer.

### Required behavioral coverage

1. Create independent projects, edit their designs, save, and reopen through a fresh workspace instance against the same temporary SQLite storage. Verify names, schema structure, notes, and layout, including an incomplete draft.
2. Exercise saving failures and rapid edits. Never report unsaved work as persisted or let an older completion replace the newest saved design. Verify project-switch isolation.
3. Exercise each supported type family and compatible structured default. Confirm generated SQL accepts the intended values and generation modes. Verify incompatible choices are visible validation failures and literal/identifier escaping preserves content without executing unintended statements.
4. Create one-to-many relationships without preparing columns. Inspect the actual matching foreign key and ensure a generated foreign-key column does not inherit identity or UUID-generation defaults from the referenced key. Handle naming collisions without overwriting existing fields.
5. Create one-to-one relationships and demonstrate both referential integrity and uniqueness. Confirm that optional references permit absence while required references reject absence. Do not claim that every referenced row must participate.
6. Create a many-to-many relationship. Verify the visible junction design, its own primary key, its two required references, and actual rejection of duplicate pairs. Add an association column and preserve it through save/reopen.
7. Create multiple relationships between the same tables, rename tables and columns, and verify each relationship still identifies its intended fields. Moving cards must leave the schema meaning unchanged.
8. Verify NO ACTION behavior with referenced records in the sandbox: prohibited parent deletes/key updates must not silently cascade or clear references.
9. Cancel dependency-affecting deletions and verify no design change. Confirm a deletion and inspect exactly the affected relationships. Remove a relationship while retaining its columns and junction table. Undo and redo edits and moves, preserving a consistent design and autosaving the resulting state.
10. Start with no generated SQL, then produce valid SQL, then make the draft incomplete. Verify empty, current, and stale SQL states without losing the draft. Exercise a sandbox rejection and ensure the attempted SQL/error remains inspectable while the last successful preview remains clearly older.
11. Make structural changes and observe automatic preview updates after settling. Make layout-only changes and verify the saved layout changes without advancing the applied schema revision. The test must not depend on an internal scheduler's method calls.
12. Complete preview work out of order, including across project switches. Verify that only the appropriate latest revision can become the current result. A failed candidate must not discard the last successful preview or the design.
13. Through the actual view, verify pan/zoom, table selection and side-panel editing, readable type indicators, relationship endpoint marks, participating-column highlighting, deletion warnings, and SQL copy/export. Exact pixel appearance is not frozen by this spec.
14. Verify SQLite and the candidate sandbox in Bun and a packaged Windows Electrobun application before building substantial UI around an unproven integration. Then run the complete create/edit/relate/save/close/reopen/inspect workflow without a development server, Docker, or an installed PostgreSQL server.
15. Use Authors/Books for ordinary references, People/Books with separate author/editor references for disambiguation, Users/Profiles for one-to-one, and Students/Courses with an editable enrollment junction for many-to-many. Include a required-to-optional change and a temporarily invalid draft in the final workflow checks.

## Out of Scope

- Database administration, production record browsing, or a user-facing arbitrary SQL query tool.
- Connecting to or importing an existing database.
- Editable SQL, SQL-to-canvas import, or bidirectional SQL synchronization.
- Stored data displayed as spreadsheet content inside table cards.
- Preserving sandbox data, migrating live databases, or generating production migration histories across design edits.
- Requiring Docker, a separate PostgreSQL installation, or a managed remote database for the primary workflow.
- General composite primary/foreign-key editing or relationship targets other than primary keys. The generated junction's pair-uniqueness constraint remains in scope.
- Custom or extension-provided types, PostgreSQL extensions as a modeling feature, general check-constraint authoring, triggers, functions, and complete PostgreSQL feature coverage.
- Arbitrary handwritten default expressions or configurable referential actions beyond NO ACTION.
- A required existing-column selection step when creating relationships.
- Literal containment of table cards, mutual physical nesting for many-to-many, or inferring relationships from proximity.
- Enforcing that every referenced-side record participates in a relationship, including total participation on both ends of one-to-one.
- Multiple designs per project, branching, collaboration, design version history, or persistent undo history across application restarts.
- Guaranteed macOS/Linux support before testing packaged builds on those platforms.
- Finalized visual notation, exhaustive visual polish, or a scale/performance guarantee for very large schemas in the first slice.

## Further Notes

- The user-facing scope is synthesized from the completed design discussion and uses the established project vocabulary and design-authority architectural decision. No application implementation or compatibility prototype has been completed as part of this spec.
- The user confirmed the design workspace's public application interface as the primary behavioral test seam, using real temporary SQLite storage and a real disposable sandbox, supplemented by a thin packaged-Windows application smoke check.
- Deliver a narrow vertical slice first. Begin with a SQLite/PGlite packaged-Windows compatibility check, then implement persistent editing, real relationships, live SQL/sandbox feedback, and the complete packaged workflow. Keep tests and relevant documentation with each behavioral work unit.
- PGlite's single-connection embedded model is appropriate to evaluate for a local preview, but does not establish equivalence to a full multi-connection PostgreSQL server or support for every server capability. Do not treat the candidate as validated until the integration checks pass.
- Exact type variants/parameters, UI styling, test runner, storage normalization, and debounce duration are implementation details within the agreed requirements. They must not silently expand the product scope.
- Autosave protects against losing successfully saved work; confirmation and session undo protect against accidental edits. Reopening is not a rollback mechanism.
- The configured issue tracker is GitHub Issues for jvasquezt2004/db-planner, and the canonical triage labels are available. No existing issues were found during the duplicate check. Publish this spec with the `ready-for-agent` triage label only; no additional triage, approval, or priority labels are required.
