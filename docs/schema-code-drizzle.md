# Drizzle schema code mapping

The Drizzle generator targets PostgreSQL schemas using drizzle-orm 0.45.4 and
drizzle-kit 0.31.11. It emits camelCase TypeScript keys while passing each
design table and column name unchanged to pg-core. It uses the stable
`relations()` API available in that release; the newer `defineRelations()` API
is not part of the installed stable package.

## Type and value choices

- `bigint` uses `{ mode: "number" }`; `numeric` keeps Drizzle's string mode to
  avoid losing decimal precision.
- `date`, `timestamp`, and `timestamptz` use string mode. `time` and `timetz`
  already use string values in pg-core.
- `bytea` and `money` use `customType` because pg-core 0.45.4 has no native
  builders for those PostgreSQL types. Other registry types use pg-core
  builders, including arrays, enums, and pgvector's `vector`, `halfvec`,
  `sparsevec`, and `bit`.
- UUID and current-time defaults use `.defaultRandom()` and `.defaultNow()`.
  Typed literal defaults are rendered by the shared structured-default helper
  and passed as `sql.raw()`; they cannot contain user-authored SQL expressions.

## Relationships and constraints

The generator emits a named `foreignKey()` for references to tables already
declared, and uses `.references()` for self-references and forward references.
Drizzle 0.45.4 does not let `.references()` set the foreign-key name, so those
columns carry a generated comment with the SQL constraint name to preserve in a
raw SQL migration. Each relationship also gets both `relations()` directions;
many-to-many associations use the visible junction table and its named pair
unique constraint.

Drizzle 0.45.4 does not model INCLUDE columns or `NULLS NOT DISTINCT` on unique
indexes. The generator retains the index and emits an adjacent comment with the
raw SQL migration change needed to preserve that option. Composite unique
constraints, including `NULLS NOT DISTINCT`, are represented directly.

The schema is code, not a migration. Install the pgvector extension in the
database before applying migrations containing vector types or indexes.
