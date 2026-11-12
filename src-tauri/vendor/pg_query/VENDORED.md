# Vendored `pg_query` 18.1.0

This is [pg_query.rs](https://github.com/pganalyze/pg_query.rs) 18.1.0 (MIT) with its bundled
[libpg_query](https://github.com/pganalyze/libpg_query) (BSD-3-Clause), copied from crates.io, with one change.

**What changed.** The published crate's `build.rs` runs `bindgen` to generate Rust bindings for the C API on every
build. `bindgen` needs LLVM's `libclang`, which a Windows machine usually does not have, so the app could not be
built there without installing LLVM. Here the bindings are generated once and committed:

- `src/bindings_generated.rs` holds the bindings, limited to the `pg_query_*` functions, `PgQuery*` types and the
  `PG_*VERSION*` constants the crate uses (the full output also contained the C library headers' platform details).
  It uses only `c_int`, `c_char` and `usize`, so it is the same on every platform.
- `src/bindings.rs` includes that file instead of the generated one.
- `build.rs` no longer calls `bindgen` or `protoc`; `src/protobuf.rs` is the crate's own pre-generated copy.
- The `bindgen`, `prost-build` and `clippy` build dependencies are gone from `Cargo.toml`.

The C library is still compiled with the `cc` crate (the MSVC compiler on Windows).

**To update it.** Take the new release from crates.io, repeat these changes, and regenerate the bindings with
`bindgen` (allow-listing `pg_query_.*`, `PgQuery.*` and the `PG_*VERSION*` variables, layout tests off) on any
machine that has LLVM. The `[patch.crates-io]` entry in `../../Cargo.toml` points the build here.
