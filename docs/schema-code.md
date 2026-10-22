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
