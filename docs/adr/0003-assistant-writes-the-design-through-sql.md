# The Assistant writes the design through SQL DDL

The Assistant expresses schema changes as PostgreSQL DDL (`CREATE TABLE`, `ALTER TABLE … RENAME/ADD/DROP`, `CREATE INDEX/TYPE/FUNCTION/TRIGGER/POLICY`, `COMMENT ON`), which is parsed and translated into the same design changes a hand edit produces. The design stays authoritative (ADR-0001): SQL is only an input language, never a second source of truth. This partially reverses the first slice's "no editable SQL-to-canvas workflow"; models write SQL far more reliably and cheaply than they drive dozens of structured tool schemas, and function, trigger, and policy bodies are already SQL.

## Considered Options

- One structured tool per workspace action: predictable, but verbose tool schemas cost tokens on every request and models are weaker at them than at DDL.
- Applying DDL to a scratch sandbox and diffing its catalog: loses stable identity (a rename becomes drop and add), notes, and relationship intent.

## Consequences

- Translation preserves stable ids: `RENAME` keeps the table or column identity.
- DDL the design cannot represent is rejected back to the Assistant with an explicit error rather than approximated.
