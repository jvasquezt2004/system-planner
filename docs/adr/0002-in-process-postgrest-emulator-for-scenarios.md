# Emulate PostgREST in-process for scenarios

Scenarios are TypeScript that uses the real `@supabase/supabase-js` client, so that interacting with a design feels like interacting with a Supabase project. The client's `fetch` is replaced so its PostgREST requests are answered by our own in-process emulator that translates them into SQL against a PGlite sandbox, instead of running the real PostgREST server. Keeping the product free of Docker, an installed PostgreSQL server, and per-OS server binaries outweighs exact fidelity: real PostgREST needs a networked, pooled PostgreSQL that PGlite's single embedded connection does not provide, and the Supabase CLI's Docker-free runtime is alpha and does not support Windows.

## Consequences

- The goal is full parity with what supabase-js can ask of PostgREST, reached incrementally. At any moment the emulator implements a documented subset. Requests outside it fail loudly with an explicit "not supported by the sandbox" error rather than approximating real behaviour, so a scenario never appears to pass on semantics the real server would not share.
- The initial Sandbox API subset supports one-record `insert` with `Prefer: return=representation`, and `select=*` with exactly one `eq` filter. Every other request feature returns `PGRST_SANDBOX_UNSUPPORTED`; PostgreSQL errors retain their SQLSTATE in the PostgREST error body.
- Scenario code is familiar supabase-js, but compatibility with a real Supabase project is not promised.
- If the subset proves too small or too unfaithful, the fallback is the real PostgREST (optionally via the Supabase stack) on Docker, accepted as an opt-in requirement rather than a default.
