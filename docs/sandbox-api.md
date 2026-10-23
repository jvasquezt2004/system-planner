# Sandbox API

The Sandbox API is the in-process PostgREST-compatible interface used by Scenarios. It operates on a fresh Sandbox for each Scenario run. Unsupported requests return `PGRST_SANDBOX_UNSUPPORTED`; they are not approximated.

## Supported reads

| Feature | Supported form | Notes |
| --- | --- | --- |
| Projection | `select=*`, a comma-separated list of applied column names, nested related-resource embeds, or an omitted `select` parameter | Embeds resolve against applied foreign keys. Many-to-one and one-to-one embeds return an object or `null`; one-to-many and many-to-many embeds return arrays. `!<foreign-key-or-column>` disambiguates relationships; `!inner` excludes parent records without a match. Missing relationships return PostgREST-shaped `PGRST200` (400); ambiguous embeds return `PGRST201` (300), relationship candidates, and disambiguation hints. |
| Filters | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not`, `or`; `resource.column=operator.value` for embedded filters | Filter columns must exist in the applied table or embedded resource. `or` supports comma-separated simple filter expressions; `*` is an alias for `%` in `like` and `ilike` patterns. |
| Ordering | `order=column.asc` or `resource.order=column.desc`; multiple columns and `nullsfirst`/`nullslast` | Embedded ordering applies to that resource's records. |
| Limit and offset | Non-negative integer `limit`/`offset`; `resource.limit` limits embedded records | Exact-count responses include the top-level filtered total; HTTP 206 indicates that the returned page is partial. |
| Range | Inclusive `Range: start-end` with the `items` range unit | Returns `Content-Range` as `start-end/total` when exact count is requested, otherwise `start-end/*`; empty results use `*/total` or `*/*`. Exact-count responses use HTTP 206 when the requested page is partial. |
| Count | `.select(columns, { count: "exact" })` and `head: true` | Counts matching top-level rows, not embedded records. Exact counts are computed under the request identity, so row-level security applies. HEAD returns no body. `planned` and `estimated` counts are unsupported. |
| Single row | `single()` | Returns one JSON object. Zero or multiple records produce `PGRST116` with HTTP 406. |
| Maybe single row | `maybeSingle()` | Returns one JSON object or `null` for no records; multiple records produce the normal cardinality error. |

Selected values are serialized by PostgreSQL into JSONB before the Sandbox API returns them, preserving PostgreSQL's JSON representation for the applied column types. All identifiers are quoted; filter values are bound parameters.

## Supported writes

| Feature | Supported form | Notes |
| --- | --- | --- |
| Insert | `POST` with one record or an array of records | Bulk inserts use the union of record keys. Omitted keys become `NULL` by default; `Prefer: missing=default` uses database defaults. |
| Update | `PATCH` with supported filters | Update filters use the same operators as reads. |
| Delete | `DELETE` with supported filters | |
| Upsert | `POST` with `Prefer: resolution=merge-duplicates` or `resolution=ignore-duplicates`; optional `on_conflict=column[,column]` | Without `on_conflict`, the applied table's primary key is used. Conflict targets must identify an applicable unique constraint. |
| Return | `Prefer: return=minimal` or `return=representation`; `.select(columns)` requests a projected representation, including related-resource embeds | Minimal is the default. Insert/upsert responses use HTTP 201; update/delete use 204 when minimal and 200 with representation. `count: "exact"` on writes reports the affected top-level row count in `Content-Range`. |
| Constraint errors | PostgreSQL constraint errors retain SQLSTATE and PostgREST status mapping | Requests are transactional: any error rolls back every row in that request. |

Triggers in the applied design execute during supported writes according to
their configured timing, events, and row or statement level. BEFORE row
triggers may change the returned row; AFTER triggers can write related records
that subsequent Sandbox API requests can observe.

## Row-level security

Scenario requests execute in a transaction under the request's `anon`,
`authenticated`, or `service_role` database role with the request's JWT claims.
PostgreSQL policies therefore apply to reads and writes exactly as they do in
the design-check sandbox. `auth.uid()`, `auth.role()`, and `auth.jwt()` read
those transaction-local claims. The Supabase-compatible `service_role` bypasses
row-level security; tables with RLS disabled are unaffected by their policies.
Result grids continue to use the privileged role and include all rows.

## Function calls

`POST /rest/v1/rpc/<name>` calls a design Function with a JSON object of named
arguments, matching `supabase.rpc(name, args)`. Scalar and single composite
results are returned as JSON values; set-returning Functions return JSON arrays.
Every call runs in the request's identity transaction, so `auth.uid()`,
`auth.role()`, `auth.jwt()`, and row-level security apply inside the Function.

Named table-row composite and set-returning results accept `.select(...)` and use
the same relationship-embed serialization as table reads. Anonymous `TABLE`
results support column projections but have no relationship metadata; scalar
results do not support projections.

`GET` is supported only for `stable` and `immutable` Functions and accepts
arguments as query parameters. Unknown Functions and argument-name mismatches
return `PGRST202`. Filters, ordering, limits, and ranges on set-returning
results are not implemented and return `PGRST_SANDBOX_UNSUPPORTED`.

## Unsupported read features

The Sandbox API refuses aliases, JSON-path projections, CSV and explain responses, planned or estimated count preferences, unsupported filter operators or syntax, and unimplemented query options. The error names the unsupported feature and uses the `PGRST_SANDBOX_UNSUPPORTED` code.
