# Drizzle schema code mapping

The generator targets drizzle-orm 0.45.4 and drizzle-kit 0.31.11. It uses the
stable `relations()` API in that release. Current Drizzle documentation describes
`defineRelations()` as the Relational Queries v2 API and installs it from the
release-candidate channel; it is not the stable API available in drizzle-orm
0.45.4.

## Types and defaults

- TypeScript table variables use camel-cased `modelWords`; table and column
  database names remain unchanged in `pgTable()` and column builder arguments.
  Column and relation properties use unquoted camelCase keys.
- `bigint` uses `{ mode: "bigint" }`, preserving PostgreSQL's full signed
  64-bit range in JavaScript. `numeric` keeps Drizzle's string mode to preserve
  decimal precision.
- `date`, `timestamp`, and `timestamptz` use string mode. `time` and `timetz`
  already use string values in pg-core.
- `bytea` and `money` use `customType` because pg-core 0.45.4 has no native
  builders for those PostgreSQL types. Other registry types use pg-core
  builders, including arrays, enums, and pgvector's `vector`, `halfvec`,
  `sparsevec`, and `bit`.
- UUID and current-time defaults use `.defaultRandom()` and `.defaultNow()`.
  Structured literals are emitted as typed JavaScript values through
  `.default(value)`, including parsed JSON values; no SQL expressions are
  generated for literal defaults.

## Names, relations, and constraints

Model and relation property names come from the shared naming plan in
`src/shared/schema-code/naming.ts`. A one-to-one back-reference uses `one()`;
one-to-many back-references use `many()`. Drizzle's `relationName` is emitted for
repeated foreign-key pairs and self-references, with a readable alias derived
from the model and forward relation (for example, `post_author` or `comment_parent`).

The stable `relations()` API models many-to-many relationships through the
visible junction table, so the generated endpoint relations are `postTags`; it
does not provide the newer v2 `through` API for direct `Post.tags` / `Tag.posts`
relations.

Foreign keys to earlier-declared tables use a named `foreignKey()` and preserve
the PostgreSQL constraint name and referential actions. Self-references and
references to later-declared tables use inline `.references()` to avoid
initialization-order errors. Drizzle 0.45.4 does not let `.references()` name a
foreign-key constraint, so one grouped comment above the table lists those
names for a raw SQL migration.

Drizzle 0.45.4 does not model `INCLUDE` columns or `NULLS NOT DISTINCT` on unique
indexes. The generator retains the index and places the required raw SQL
migration follow-up in a comment above that index. Composite unique
constraints, including `NULLS NOT DISTINCT`, are represented directly.

The schema is code, not a migration. Install the pgvector extension in the
database before applying migrations containing vector types or indexes.
