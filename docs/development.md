# Development notes

The repository is one Tauri project. The React view is in `src/` (built by Vite, configured in `vite.config.ts`)
and the Rust backend in `src-tauri/`.

```bash
bun install
bun run tauri dev        # run with hot reload
bun run tauri build      # package
bun run test             # view tests
bun run typecheck        # view types
cd src-tauri && cargo test --workspace
```

On a machine with little memory, build with `CARGO_BUILD_JOBS=3` and keep `TMPDIR`/`CARGO_TARGET_DIR`
on a real disk. Release steps (signing, updates) are in [release.md](release.md); what is and is not
verified is in [parity.md](parity.md).

## Driving the real window (debug builds only)

With `SCHEMA_DESIGNER_DEBUG_SOCKET=/path/to.sock` set, a debug build listens on that Unix socket, runs each
script it receives inside the app's window and sends back what the script returned. It is how the window
was tested without sending input to the desktop. Release builds do not contain it (`src-tauri/src/debug_bridge.rs`).
