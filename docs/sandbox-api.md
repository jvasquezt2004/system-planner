# Sandbox API

The Sandbox API is the in-process PostgREST-compatible interface used by Scenarios. It operates on a fresh Sandbox for each Scenario run. Unsupported requests return `PGRST_SANDBOX_UNSUPPORTED`; they are not approximated.

## Supported reads

| Feature | Supported form | Notes |
| --- | --- | --- |
| Projection | `select=*`, a comma-separated list of applied column names, or an omitted `select` parameter | An omitted projection returns all columns. Aliases, embeds, JSON paths, and other projection expressions are unsupported. |
| Filters | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `not`, `or` | Filter column names must exist in the applied table. `or` supports comma-separated simple filter expressions; `*` is an alias for `%` in `like` and `ilike` patterns. |
| Ordering | `order=column.asc` or `order=column.desc`; multiple columns and `nullsfirst`/`nullslast` | Order columns must exist in the applied table. |
| Limit and offset | Non-negative integer `limit` and `offset` query parameters | Results are returned as JSON arrays. Without an exact count, these responses use HTTP 200. |
| Range | Inclusive `Range: start-end` with the `items` range unit | Returns `Content-Range`; without an exact count, range responses use HTTP 200. An empty result returns `*/*`. |
| Single row | `single()` | Returns one JSON object. Zero or multiple records produce `PGRST116` with HTTP 406. |
| Maybe single row | `maybeSingle()` | Returns one JSON object or `null` for no records; multiple records produce the normal cardinality error. |

Selected values are serialized by PostgreSQL into JSONB before the Sandbox API returns them, preserving PostgreSQL's JSON representation for the applied column types. All identifiers are quoted; filter values are bound parameters.

## Existing write support

A single-record `insert` with `Prefer: return=representation` and `select=*` is supported. Other write forms remain unsupported.

## Unsupported read features

The Sandbox API refuses embedding, aliases, JSON-path projections, CSV and explain responses, count preferences, unsupported filter operators or syntax, and unimplemented query options. The error names the unsupported feature and uses the `PGRST_SANDBOX_UNSUPPORTED` code.
