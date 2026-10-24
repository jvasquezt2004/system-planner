# Sandbox API

The Sandbox API is the in-process PostgREST-compatible interface used by Scenarios. It operates on a fresh Sandbox for each Scenario run. Unsupported requests return `PGRST_SANDBOX_UNSUPPORTED`; they are not approximated.

Requests for tables absent from the applied design return HTTP 404 with
`PGRST205` and the message `Could not find the table 'public.<name>' in the
schema cache`. When a close table name exists, the error's `details` field is
`Perhaps you meant the table 'public.<table>'`; `hint` remains `null`. This is
distinct from `PGRST_SANDBOX_UNSUPPORTED`, which remains for unsupported
features.

## Supported reads

| Feature | Supported form | Notes |
| --- | --- | --- |
| Projection | `select=*`, a comma-separated list of applied column names, nested related-resource embeds, or an omitted `select` parameter | Supports double-quoted column, resource, and relationship-hint identifiers, including names with spaces or capitals. Embeds resolve against applied foreign keys. Many-to-one and one-to-one embeds return an object or `null`; one-to-many and many-to-many embeds return arrays. `!<foreign-key-or-column>` disambiguates relationships; `!inner` excludes parent records without a match. Missing relationships return PostgREST-shaped `PGRST200` (400); ambiguous embeds return `PGRST201` (300), relationship candidates, and disambiguation hints. |
| Filters | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not`, `or`; `resource.column=operator.value` for embedded filters | Filter columns must exist in the applied table or embedded resource. `or` supports comma-separated simple filter expressions; `*` is an alias for `%` in `like` and `ilike` patterns. |
| Ordering | `order=column.asc` or `resource.order=column.desc`; multiple columns and `nullsfirst`/`nullslast` | Embedded ordering applies to that resource's records. |
| Limit and offset | Non-negative integer `limit`/`offset`; `resource.limit` limits embedded records | Exact-count responses include the top-level filtered total; HTTP 206 indicates that the returned page is partial. |
| Range | Inclusive `Range: start-end` with the `items` range unit | Returns `Content-Range` as `start-end/total` when exact count is requested, otherwise `start-end/*`; empty results use `*/total` or `*/*`. Exact-count responses use HTTP 206 when the requested page is partial. |
| Count | `.select(columns, { count: "exact" })` and `head: true` | Counts matching top-level rows, not embedded records. Exact counts are computed under the request identity, so row-level security applies. HEAD returns no body. `planned` and `estimated` counts are unsupported. |
| Single row | `.single()` | Applies to reads and returned write representations. Returns one JSON object. Zero or multiple records produce `PGRST116` with HTTP 406. |
| Maybe single row | `.maybeSingle()` | Returns one JSON object or `null` for no records; multiple records produce the normal cardinality error. Applies to reads and returned write representations. |

Selected values are serialized by PostgreSQL into JSONB before the Sandbox API returns them, preserving PostgreSQL's JSON representation for the applied column types. All identifiers are quoted; filter values are bound parameters.

## Supported writes

| Feature | Supported form | Notes |
| --- | --- | --- |
| Insert | `POST` with one record or an array of records | Bulk inserts use the union of record keys. Omitted keys become `NULL` by default; `Prefer: missing=default` uses database defaults. Empty objects insert rows with `DEFAULT VALUES`; a missing required value without a default surfaces the PostgreSQL `23502` constraint error. |
| Update | `PATCH` with supported filters | Update filters use the same operators as reads. |
| Delete | `DELETE` with supported filters | |
| Upsert | `POST` with `Prefer: resolution=merge-duplicates` or `resolution=ignore-duplicates`; optional `on_conflict=column[,column]` | Without `on_conflict`, the applied table's primary key is used. Conflict targets must identify an applicable unique constraint. |
| Return | `Prefer: return=minimal` or `return=representation`; `.select(columns)` requests a projected representation, including related-resource embeds | Minimal is the default. Insert/upsert responses use HTTP 201; update/delete use 204 when minimal and 200 with representation. `count: "exact"` on writes reports the affected top-level row count in `Content-Range`. |
| Constraint errors | PostgreSQL constraint errors retain SQLSTATE and PostgREST v14 HTTP status mapping | Requests are transactional: any error rolls back every row in that request. PostgreSQL class 22 and `23502`/`23514`/`P0001` map to 400; `23503`/`23505` map to 409; `42P01`/`42883` map to 404; `25006` maps to 405; class 08 maps to 503. `42501` maps to 401 for `anon`, otherwise 403. `PTxyz` codes select the corresponding HTTP status. Other PostgreSQL errors map to 400. |
Single-object `Accept: application/vnd.pgrst.object+json` also applies to
write representations requested with `.select()`. Exactly one affected row
returns an object; zero or multiple affected rows return `PGRST116` (406).

Triggers in the applied design execute during supported writes according to
their configured timing, events, and row or statement level. BEFORE row
triggers may change the returned row; AFTER triggers can write related records
that subsequent Sandbox API requests can observe.
When a column in an `UPDATE OF` list is removed from a design, that column is
removed from the list. If it was the last listed column, the `UPDATE OF` filter
is dropped and the trigger runs for every update.

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

## Edge function invocation

`supabase.functions.invoke(name, { body })` is routed by the Scenario run driver
to the saved Edge function source in a fresh locked-down worker. The worker
supports `Deno.serve`, `Deno.env.get` for `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
and `SUPABASE_SERVICE_ROLE_KEY`, and imports of
`jsr:@supabase/supabase-js@2`, `npm:@supabase/supabase-js@2`,
`https://esm.sh/@supabase/supabase-js@2`, and `@supabase/supabase-js`.
The bundled supabase-js client sends its Sandbox API traffic to the same run.
The incoming `Authorization` header is available to the handler, but is never
injected into its clients. An anon-key client without configured `Authorization`
acts as `anon`; explicitly forwarding the incoming header, for example through
`global.headers.Authorization`, makes it act as the caller, so user claims and
RLS apply. The service-role key executes requests as `service_role`; other
Authorization values pass through unchanged. Other runtime imports are refused
before the handler executes, and network, WebSocket, XMLHttpRequest, and
script-import access are unavailable to the handler.

The handler's response is returned through supabase-js. A thrown or rejected
handler returns HTTP 500 with `{ "error": "<message>" }`; a handler that never
calls `Deno.serve` returns HTTP 500 with a diagnostic message. Unknown names
return 404. These non-2xx responses are surfaced by supabase-js as
`FunctionsHttpError`. Edge functions cannot invoke other Edge functions; a
nested invocation is refused with an explicit error.

Invocations share the Scenario run timeout. Stop and timeout terminate the
Scenario worker and all active Edge function workers. Each Scenario run records
the project's Edge function revision; any Edge function edit makes existing
runs stale, independently of the design revision.

The run request log includes the invocation and its response, with Sandbox API
requests attributed to that invocation. Handler console output is labelled
with the Edge function name; writes are included in the run's result grids.

## Unsupported read features

The Sandbox API refuses aliases, JSON-path projections, CSV and explain responses, planned or estimated count preferences, unsupported filter operators or syntax, and unimplemented query options. The error names the unsupported feature and uses the `PGRST_SANDBOX_UNSUPPORTED` code.
