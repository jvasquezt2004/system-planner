# Schema code (ORM formats)

The SQL preview can show the design in five **code formats**: PostgreSQL (the
reference) and the ORM formats Prisma, Drizzle, SQLAlchemy, and Django ORM.

## Contract

- Registry: `src/shared/schema-code/index.ts` (`SCHEMA_CODE_FORMATS`,
  `generateOrmSchema`). Shared types: `src/shared/schema-code/types.ts`.
- One module per ORM, each exporting a single pure generator
  `(design: Design) => SchemaCodeGeneration`:
  - `src/shared/schema-code/prisma.ts` → `generatePrismaSchema`
  - `src/shared/schema-code/drizzle.ts` → `generateDrizzleSchema`
  - `src/shared/schema-code/sqlalchemy.ts` → `generateSqlAlchemyModels`
  - `src/shared/schema-code/django.ts` → `generateDjangoModels`
- A generator only receives a design the PostgreSQL generator accepted
  (`src/bun/sql.ts`), so it never re-validates the draft. It returns
  `{ ok: false, errors }` only for what the ORM itself cannot represent; when an
  ORM can express a feature only partially, it emits the closest equivalent
  plus a comment that says what PostgreSQL will additionally need.
- Generators are deterministic: same design, same text, tables and columns in
  design order, ending with a single newline.
- Generators run in the view, so they must stay pure TypeScript importing only
  from `src/shared`, plus the pure `planSchemaObjectNames` from `src/bun/sql.ts`
  (it imports only `src/shared`), which gives the exact foreign-key, unique
  constraint, and index names the SQL uses, keyed by design object id.
- Shared sample designs live in `src/shared/schema-code/fixtures.ts`; every
  fixture is checked against the PostgreSQL generator and the sandbox in
  `src/bun/schema-code.test.ts`, so generator tests can rely on them.
- Index capabilities and operator classes come from `src/shared/index-methods.ts`;
  the model itself is documented in `docs/postgres-features.md`.

## View

`src/mainview/sql-preview.tsx` adds a code-format switch. An ORM format shows
its schema code only while the draft's PostgreSQL is current; otherwise it
shows the validation errors instead of an older schema. Copy and export carry a
`SchemaCodeSnapshot` (format, revision, code) through the `copySchemaCode` and
`beginSchemaCodeExport` requests; an export file name must end in the format's
extension.

## Naming

All ORM formats name models and relationships through
`src/shared/schema-code/naming.ts`, so the same design reads the same way in
every ORM. It plans names as lowercase words; each generator applies its
language's casing and reserved-word rules and always maps back to the exact
database names.

| Concept | Rule | Blog example |
|---|---|---|
| Model | singular table name (`modelWords`) | `users` → User |
| Forward relation | FK column without `id`, else referenced model | `author_id` → author |
| Back-reference | referencing table plural; singular for one-to-one | comments, profile |
| Repeated FK pair | back-reference prefixed with the forward role | authorPosts, editorPosts |
| Self-reference `parent` | back-reference `children` | Comment.children |
| Many-to-many | each endpoint gets the other's plural | Post.tags, Tag.posts |

Collisions with column names or other relations fall back to a qualified name
(`author_ref`, `posts_via_post_tag`) and finally a numeric suffix.
