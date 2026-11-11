# 4. The Electrobun app is removed and its recordings are frozen

Status: accepted (2026-11-10).

## Context

The Tauri app was written to reproduce the Electrobun app, using the TypeScript code as an oracle: scripts ran
the real code and recorded what it did, and the Rust crates replay those recordings (`src-tauri/fixtures/data`).
Once the Tauri app had parity, keeping a second backend only to regenerate recordings had a cost and no user.

## Decision

1. The Electrobun app, its TypeScript backend (`src/bun`), the fixture generators and everything that built or
   packaged them are removed. The last commit that has them is `2e78461`.
2. The recordings stay, as frozen fixtures. They are the specification of the behaviour the rewrite matched. A
   Rust change that breaks one is a behaviour change to decide on; it is not regenerated away.
3. Four behaviours the original got wrong are fixed in the Rust code on purpose and listed in
   `docs/parity.md` ("Fixed rather than copied"); the recordings leave out the inputs that reach them.
4. The view (`src/mainview`, `src/shared`) stays and is shared by the Tauri build. `src/shared/sql.ts` stays for the
   ORM code generators, with the test that checks their object names against PostgreSQL.

## Consequences

- To extend a recording, check out `2e78461` beside the current tree, run its fixtures, and copy `fixtures/data` back.
- CI no longer regenerates fixtures; it runs the Rust tests, the view's tests and its type check.
