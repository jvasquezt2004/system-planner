# Packaged Windows smoke check

Ticket #2 requires the minimal design workflow to run from a packaged Windows
application without Vite, Docker, or a separately installed PostgreSQL server,
and requires PGlite's Bun capabilities and bundled runtime assets to be verified
before the sandbox is treated as selected.

## Verified environment

- Windows x64 (the machine used during implementation)
- Bun 1.4.2
- Electrobun 2.0.4 (devkit-projected, `hutch 0.28.1`)
- `@electric-sql/pglite` 0.5.10
- WebView2 runtime supplied by Windows

## Result

Passed.

- `hutch run build` produced `build/stable-win-x64/Schema Designer-Setup.exe`.
- Installing that setup package placed the app under
  `%LOCALAPPDATA%\com.dbplanner.schema-designer\stable\app`.
- The packaged main bundle at
  `Resources\app\bun\index.js` bundled PGlite's JavaScript.
- `pglite.wasm`, `pglite.data`, and `initdb.wasm` were copied beside the bundle
  as `Resources\app\bun\pglite.wasm`, `pglite.data`, and `initdb.wasm`.
- Starting the installed launcher opened the real React view from
  `views://mainview/index.html`; the WebView2 log shows the bundled HTML, JS,
  and CSS being read from `Resources\app\views\mainview`.
- The packaged Bun process auto-opened a seeded project and applied the
  generated schema with PGlite. Observed output:

  ```
  [workspace] database=...\smoke.sqlite project=Smoke Library sql=current sandbox=applied
  ```
- The real packaged React view was driven through WebView2 remote debugging.
  Entering a project and table from the rendered UI produced:

  ```
  SCHEMA DESIGNER
  Library
  Saved
  TABLES
  revision 2
  Books
  id bigint PK identity required
  SQL PREVIEW
  Current
  CREATE TABLE "Books" (
    "id" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    PRIMARY KEY ("id")
  );
  SANDBOX CHECK
  Accepted
  ```
- The same run wrote the project and table into the real SQLite database, and
  closing and relaunching the packaged app restored them with the SQL preview
  current and the sandbox accepted.

No development server, Docker daemon, or local PostgreSQL installation was
running during the check.

## Procedure

From the repository root:

```bash
# 1. Build the packaged Windows app and setup package.
hutch run build

# 2. Install it (this also creates shortcuts and an uninstall entry).
./"build/stable-win-x64/Schema Designer-Setup.exe"

# 3. Seed a real SQLite database with one project and a default-id table.
SMOKE_DB="$TEMP/db-planner-smoke.sqlite"
bun scripts/seed-smoke-database.ts "$SMOKE_DB"
```

Then either open the installed **Schema Designer** shortcut, or run the packaged
main process directly to capture the workspace diagnostic:

```bash
APP="$LOCALAPPDATA/com.dbplanner.schema-designer/stable/app"
cd "$APP/bin"
DB_PLANNER_DATABASE_PATH="$SMOKE_DB" \
  timeout 45 ./bun.exe ../Resources/app/bun/index.js
```

Expect `Schema Designer started!` followed by a `[workspace]` line whose
`sandbox` value is `applied`.

To drive the actual view, launch with WebView2 remote debugging enabled:

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
DB_PLANNER_DATABASE_PATH="$SMOKE_DB" \
  "$APP/bin/launcher.exe" &

curl -s http://127.0.0.1:9222/json
```

Connect to the page's `webSocketDebuggerUrl` and use `Runtime.evaluate` to set
`input[placeholder="Library"]` and click **Create project**, then set
`input[placeholder="Books"]` and click **Add table**. React controlled inputs
need the native value setter followed by an `input` event. Read
`document.body.innerText` and the `[data-testid="sql-preview"]` text to confirm
`Saved`, `Current`, and `Accepted`. Inspect the SQLite file after the run to
confirm the same project/table was persisted, then relaunch and re-read the page
to confirm restoration.

## Integration limitations recorded

- PGlite is an embedded, single-connection PostgreSQL build. It is suitable for
  a disposable local preview, not equivalent to a full multi-connection
  PostgreSQL server or every server capability.
- The sandbox builds a fresh in-memory database for each applied revision. It
  does not preserve sandbox data, migrations, or connections between edits.
- The packaged build depends on the Windows WebView2 runtime and was only
  verified on Windows x64. No macOS or Linux claim is made until packaged builds
  are tested there.
- PGlite's WebAssembly and data assets must be copied beside the bundled Bun
  main process. Omitting `pglite.wasm`, `pglite.data`, or `initdb.wasm` from
  `electrobun.config.ts` makes the packaged sandbox fail even though development
  works.
- Autosave plus sandbox validation can exceed Electrobun's 1-second default RPC
  request timeout. The view sets `maxRequestTime` to 60 seconds; the packaged UI
  check caught this when the first packaged request reported a timeout after the
  design had already been saved and applied.
