# Scenario expectations

A Scenario can inspect each Sandbox API response with the `expect` global. Expectations record results without throwing, so later Scenario code still runs after an unmet expectation. A Scenario run is `failed` when at least one expectation is unmet, `passed` when all are met, and `errored` when an unexpected exception escapes.

```ts
const inserted = await supabase.from("Books").insert({ title: "Example" }).select("*");
expect(inserted).succeeds();
expect(inserted).returnsDataEqual([{ id: 1, title: "Example" }]);

const rejected = await supabase.from("Books").insert({ title: null }).select("*");
expect(rejected).fails("23502");
```

The supported checks are:

- `succeeds()` — the request has no error.
- `fails()` — the request has an error.
- `fails(code)` — the request error's code matches a PostgreSQL SQLSTATE or PostgREST error code.
- `returnsDataEqual(expected)` — the request's returned data deeply equals the expected value.

The Scenarios view lists every expectation's description, whether it was met, and its result message. A failed request does not itself fail a Scenario run; only an unmet expectation does. An uncaught exception remains an errored run even if expectations were already recorded.
