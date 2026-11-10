
## Driving the real window (debug builds only)

With `SCHEMA_DESIGNER_DEBUG_SOCKET=/path/to.sock` set, a debug build listens on that Unix socket, runs each
script it receives inside the app's window and sends back what the script returned. It is how the window
was tested without sending input to the desktop. Release builds do not contain it (`src-tauri/src/debug_bridge.rs`).
