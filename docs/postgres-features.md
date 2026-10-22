# PostgreSQL feature model

This document describes the structured PostgreSQL features available in a
`Design`. The `Design` remains authoritative when a draft is invalid; SQL
generation reports errors and the disposable Sandbox is rebuilt from valid SQL.
No column notes or free-form SQL expression is emitted.

## Column types

`DesignColumn.type` remains a value from the shared `COLUMN_TYPE_DEFINITIONS`
registry. `typeParameters` stores optional `length`, `precision`, `scale`,
`dimensions`, and `array` values; these are numbers and a boolean, never SQL
text. Length parameters apply to `varchar`, `char`, and `bit`; precision and
scale apply to `numeric`; dimensions apply to `vector`, `halfvec`, and
`sparsevec`. A vector type requires positive dimensions. Numeric precision is
1–1000 and a scale requires precision; the scale range is -1000–1000. Arrays append PostgreSQL `[]` to the
element type. Structured defaults on arrays are currently rejected.

The registry includes the existing integer, UUID, boolean, date/time and JSON
types, plus `varchar`, `char`, `real`, `double precision`, `time`, `timetz`,
`timestamp`, `interval`, `bytea`, `json`, `inet`, `cidr`, `macaddr`, `money`,
`bit`, and pgvector's `vector`, `halfvec`, and `sparsevec`. Identity remains
limited to integer types. Vector columns require a positive dimension.

## Enum types

`Design.enumTypes` contains stable `{ id, name, labels }` definitions.
Enum-typed columns use `type: "enum"` plus `enumTypeId`; this reference survives
renames. SQL creates each enum before its tables and quotes each label as a
string literal. Enum names must be unique, and labels must be non-empty and
unique. A column must reference an existing enum. Older documents without
`enumTypes` load with an empty collection.

## Indexes

`DesignTable.indexes` is an ordered list of stable `DesignIndex` objects. An
index has an optional explicit name, access `method`, ordered `keys` addressed
by column id, `unique`, `nullsNotDistinct`, `includeColumnIds`, and structured
`with` options. A key may select an operator class, `asc`/`desc`, and `first` /
`last` null ordering. Generated names use the shared PostgreSQL identifier
planner and avoid collisions; explicit names are preserved and duplicate names
are validation errors.

Methods are `btree`, `hash`, `gin`, `gist`, `spgist`, `brin`, `hnsw`, and
`ivfflat`. Validation checks referenced key and INCLUDE columns, duplicate keys,
uniqueness support, hash's single non-unique key rule, INCLUDE method support,
sort-order support, `NULLS NOT DISTINCT` requiring uniqueness, GIN's array/JSONB
support, and pgvector method/type/operator-class compatibility. HNSW supports
`m` and `efConstruction`; IVFFlat supports `lists`; standard methods accept the
modeled method-specific storage options only. Vector indexing limits are 2000
dimensions for `vector`, 4000 for `halfvec`, 64000 for `bit`, and sparsevec is
not accepted by IVFFlat. Index SQL and the Sandbox catalog report are generated
from the same model. Existing documents without indexes normalize to an empty
list.

The model deliberately excludes partial and expression indexes: predicates and
expressions would need a structured model to keep semantics visible to ORM
generators. No raw SQL field was added.

## Unique constraints and primary keys

`DesignTable.uniqueConstraints` stores stable composite unique constraints with
ordered column ids, an optional name, and optional `nullsNotDistinct`. SQL
generates named constraints and the Sandbox enforces them. Missing or duplicate
columns and fewer than two columns are invalid. This is separate from unique
indexes because an ORM generator may need to preserve constraint semantics.

Primary keys remain single-column, consistent with ADR 0001 and the established
relationship model. Many-to-many endpoint-pair uniqueness remains a
relationship-owned composite constraint. Composite primary keys and arbitrary
composite foreign keys are not modeled.

## Relationships

`DesignRelationship.onDelete` and `onUpdate` accept `NO ACTION`, `RESTRICT`,
`CASCADE`, `SET NULL`, or `SET DEFAULT`. Missing fields in older documents mean
`NO ACTION`. `SET NULL` requires a nullable referencing column; `SET DEFAULT`
requires a structured column default. The SQL preview and Sandbox foreign-key
catalog report the selected actions.

## Intentionally omitted

Check constraints need a structured predicate vocabulary (for example a
positive-value comparison or a bounded range). They are omitted rather than
represented as SQL text. `COMMENT ON` is omitted; column notes remain design-time
intent and are never SQL. Partial/expression indexes are omitted for the same
structured-semantics reason. Citext is an extension and is not part of the
vanilla type registry.

## Handoff

ORM generators should read `COLUMN_TYPE_DEFINITIONS` for supported base types
and default support, and handle `typeParameters`, `enumTypeId`, `Design.enumTypes`,
`DesignTable.indexes`, `DesignTable.uniqueConstraints`, and the optional
relationship referential actions. Index key and INCLUDE references are stable
column ids, not names. Preserve index method, key order/null order/operator
class, uniqueness, null treatment, INCLUDE columns, and storage options when the
target ORM supports them. `vector`, `halfvec`, `sparsevec`, and HNSW/IVFFlat
indexes require pgvector in the target database. Old saved documents may omit
indexes, unique constraints, enum types, type parameters, or referential
actions; interpret those as empty/default values. ORM generators should report
unsupported target features instead of dropping semantics silently.

This implementation intentionally leaves out check constraints, comments,
partial/expression indexes, composite primary keys, and general composite
foreign keys because the current model has no structured representation for
them or ADR 0001 keeps the single-column key workflow authoritative.
