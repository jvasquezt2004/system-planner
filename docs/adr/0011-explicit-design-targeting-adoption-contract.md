# Explicit Design targeting adoption contract

A database Design represents an authoritative planned database structure and its visual layout within a Project. In the expanded system-design model (ADR-0005, ADR-0009), a Project can contain zero or more linked database Designs, and each executable artifact (Scenario, Edge function, sandbox run) belongs to its specific owning Design.

To migrate the codebase safely without disrupting existing callers or breaking desktop builds, database targeting follows an **Expand / Migrate / Contract** adoption sequence:

1. **#119 — Expand (this slice):**
   - Introduces explicit, stable Design identity (`id: string`) in SQLite persistence and transactional migration for legacy databases.
   - Associates executable artifacts (`scenarios`, `edge_functions`, `scenario_documents`, `edge_function_documents`) with the owning `design_id`.
   - Preserves incomplete drafts, schema content, object IDs, table positions, and conversations without loss or modification.
   - Attaches target identity (`designId`) and revisions to saves (`SaveState`), preview work (`SqlState`, `SandboxState`, `SandboxSnapshot`), and scenario runs (`ScenarioRun`).
   - Exposes additive explicit-target workspace and RPC forms (`designId?: string` on actions and requests) while providing a temporary compatibility path where omitted `designId` targets the active design.

2. **#120 — Migrate manual schema and preview (downstream):**
   - Updates the React view boundary, canvas, table inspector, routine views, and SQL preview to pass explicit `designId` on all schema and layout mutations.
   - Verifies that generated SQL, applied snapshots, revisions, and completion guards remain bound to the target Design even when views change.

3. **#121 — Migrate Scenarios, Edge functions, and Assistant tools (downstream):**
   - Binds Scenario and Edge function editing, handler lookup, and sandbox execution to the owning Design target explicitly.
   - Updates Assistant reads, DDL tools, code artifact updates, and Scenario runs to supply explicit `designId` throughout asynchronous operations.

4. **#122 — Contract (downstream):**
   - Retires the implicit compatibility fallback once all manual and Assistant callers supply explicit `designId`.
   - Requires explicit `designId` on all database-targeting operations.

5. **#124 — Multiple database Designs (downstream):**
   - Introduces multi-design creation, selection, and switching in the project workspace, linking Database components in the System design to independent or shared database Designs.
