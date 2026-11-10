# Schema Designer on Tauri

The desktop app: a Rust backend (`src-tauri`) and the React view in `../src/mainview`, which Vite builds
with two import aliases (`electrobun/rpc`, `electrobun/view`) pointing at the adapters in `shims/` so the
view talks to the backend through Tauri commands and events.

```bash
cd tauri
bun install              # once
cargo tauri dev          # run
cargo tauri build        # package
cd src-tauri && cargo test --workspace
```

On a machine with little memory, build with `CARGO_BUILD_JOBS=3` and keep `TMPDIR`/`CARGO_TARGET_DIR`
on a real disk. Release steps (signing, updates) are in [RELEASE.md](RELEASE.md); what is and is not
verified is in [PARITY.md](PARITY.md).


## Driving the real window (debug builds only)

With `SCHEMA_DESIGNER_DEBUG_SOCKET=/path/to.sock` set, a debug build listens on that Unix socket, runs each
script it receives inside the app's window and sends back what the script returned. It is how the window
was tested without sending input to the desktop. Release builds do not contain it (`src-tauri/src/debug_bridge.rs`).
