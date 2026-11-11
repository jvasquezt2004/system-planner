# Releasing Schema Designer (Tauri)

What CI already does (`.github/workflows/tauri.yml`): runs the Rust tests, the view's tests and type check, and builds the app on Linux, macOS and Windows. A Linux `.deb` has been built and the release
binary started locally; macOS and Windows have not been run by a person.

## Data

The app keeps one SQLite file, `schema-designer.sqlite`, in its data directory
(`~/.local/share/com.dbplanner.schema-designer/` on Linux, the platform equivalent elsewhere), plus the
Project folders in `~/Schema Designer`. `DB_PLANNER_DATABASE_PATH` and `DB_PLANNER_PROJECTS_PATH` override
them. It does not read the Electrobun app's database and nothing is migrated from it (ADR 0003).

## Before the first public release

These need secrets or accounts, so they are not done here:

1. **Signing.** macOS: an Apple Developer ID certificate and notarization credentials
   (`APPLE_CERTIFICATE`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` for `tauri-action`). Windows: a code
   signing certificate (`bundle.windows.certificateThumbprint` or a signing command). Linux needs none.
2. **Updater.** Add `tauri-plugin-updater`, generate a key pair with `cargo tauri signer generate`, put the
   public key in `plugins.updater.pubkey` and the private key in `TAURI_SIGNING_PRIVATE_KEY`, and publish the
   update manifest next to the release assets.
3. **Release workflow.** Run `tauri-apps/tauri-action` on a version tag to attach the bundles to a GitHub
   release.

## Assistant harnesses

The Assistant needs the Codex CLI (`codex login`) or OpenCode (`opencode auth login`) on the user's machine;
the app starts them itself and never changes their configuration.
