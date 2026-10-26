# Packaged Canvas & SVG Playback Proof Evidence

**Ticket:** [#117 — Prove the architecture canvas and SVG playback in packaged apps](https://github.com/jvasquezt2004/db-planner/issues/117)  
**Parent:** [#116 — System-design workspaces with linked schemas and animated Walkthroughs](https://github.com/jvasquezt2004/db-planner/issues/116)  
**Date:** 2026-10-26  

---

## 1. Scope and Acceptance Requirements

Ticket #117 requires demonstrating:
- Components, Service endpoints, parallel labeled Connections between identical endpoints, and independently overlapping/nested Groups without deriving ownership from geometry.
- Dragging, focusing, collapsing, routing, and selection while preserving actual endpoint identities.
- Message arrival plus component reactions, Play/Pause, seeking, speed adjustment, and reduced-motion presentation from one authored clock.
- Static SVG/PNG export feasibility and offline asset/font loading in the actual native WebViews, with separate Linux and Windows evidence recorded.
- Comparison of candidate graph editor (React Flow) vs Custom Canvas, covering single-parent visual grouping and duplicate-edge helper constraints.

---

## 2. Linux Packaged Environment Evidence

### Environment Specifications
- **Operating System:** Linux 7.2.8-9-omarchy x86_64
- **Runtime:** Bun 1.4.4
- **Packaging Toolkit:** Electrobun 2.0.4, Hutch CLI 0.28.1 (Cottontail 0.7.2)
- **Native GUI Toolkit:** GTK 3.24.43, WebKit2GTK 4.1 / WebKitGTK 2.46
- **Display Server:** X11 / Wayland (XWayland)

### Build & Packaging Verification
The stable Linux build was executed using Hutch:
```bash
hutch electrobun build --env=stable
```
Output:
- Build folder: `build/stable-linux-x64/SchemaDesigner/`
- Binary launcher: `bin/launcher`
- Bundled Bun runtime: `bin/bun`
- Native wrappers: `bin/libNativeWrapper.so`, `bin/libElectrobunCore.so`, `bin/libasar.so`
- Payload archive: `Resources/*.tar.zst` containing bundled React views, WebAssembly modules (`pglite.wasm`, `libpg-query.wasm`), and offline fonts.

### Execution Log from Packaged Launcher
```
Launcher starting on linux...
Current directory: /tmp/packaged-linux-app/SchemaDesigner/bin
Spawning: /tmp/packaged-linux-app/SchemaDesigner/bin/bun /tmp/packaged-linux-app/SchemaDesigner/bin/../Resources/main.js
Child process spawned with PID 24455
[LAUNCHER] Loaded identifier: com.dbplanner.schema-designer, name: SchemaDesigner, channel: stable
[LAUNCHER] Loading app code from flat files
=== ELECTROBUN NATIVE WRAPPER VERSION 1.0.2 === GTK EVENT LOOP STARTED ===
setJSUtils called but using map-based approach instead of callbacks
GlobalShortcut: Setting callback (callback=0x7f20beca5b60)
GlobalShortcut: Starting event loop thread
GlobalShortcut: X11 display opened successfully for shortcuts
GlobalShortcut: Event loop ready
Schema Designer started! 1
[workspace] database=.../schema-designer.sqlite project=People-archiver sql=current sandbox=applied
```

### Automated Packaged Verifier Run (`scripts/verify-packaged-proof.ts`)
```
=== ARCHITECTURE CANVAS & SVG PLAYBACK TECHNICAL PROOF VERIFIER ===
Platform: linux (x64)
Runtime: Bun 1.4.4

[1/5] Verifying packaged application payload & offline assets (Linux)...
  ✓ Packaged build directory exists for Linux: .../build/stable-linux-x64
  ✓ Package contents: SchemaDesigner
  ✓ Bundled assets verified: 129 files in dist/assets
  ✓ Offline bundled font files verified: 32 fonts found (IBM Plex Sans, Mono, Newsreader)

[2/5] Validating domain model & geometry-independent ownership...
  ✓ Service ownership is explicit (Upload API owned by Ingestion, Image Worker by Processing)
  ✓ Shared queue and database exist at system scope
  ✓ Shared schema link verified between Primary and Replica databases
  ✓ Overlapping Group 'Compliance Boundary' spans Service-owned and system-scope components
  ✓ Deduplicated Group movement verified: overlapping member moved exactly once (dx: 40, dy: 25)

[3/5] Validating duplicate-endpoint Connections and Service collapse projection...
  ✓ Parallel labeled connections verified between identical endpoints: "POST /upload" and "GET /upload/status"
  ✓ Service collapse projection verified: connection visually projects to collapsed service card
  ✓ Authoritative endpoint identity preserved: connection.targetId remains 'comp-api'

[4/5] Validating Walkthrough timeline: parallel completion, finite retry, seeking...
  ✓ Compiled timeline: 7 scheduled steps, total duration 8.30s
  ✓ Parallel step coordination verified: Worker writes to Storage Bucket and Database concurrently
  ✓ Deterministic time-derived state verified: seeking backwards reconstructs exact identical state
  ✓ Reduced motion presentation verified: particles disabled while static step highlights remain
  ✓ Finite retry explanation verified: cycle 1 illustrates failure/retry, cycle 2 illustrates success

[5/5] Testing static SVG export and React Flow candidate constraints...
  ✓ Standalone SVG export generated (1140x610px, 13514 bytes) at .../build/proof-export.svg
  ✓ SVG contains zero external HTTP/HTTPS assets and embeds self-contained font styling
  ✓ Standalone PNG rasterization verified (87217 bytes written to .../build/proof-export.png)
  ✓ React Flow addEdge() constraint confirmed: duplicate source/target edges are dropped by helper

==================================================================
PACKAGED MODEL & ASSET LOGIC CHECKS PASSED FOR LINUX
------------------------------------------------------------------
Scope verified by this script:
  • Packaged application build artifact & font presence on Linux
  • Explicit Service ownership & system-scope components
  • Overlapping groups & deduplicated member movement
  • Duplicate-endpoint parallel connections & service collapse projection
  • Deterministic timeline compilation, parallel branches, and retry states
  • Standalone SVG export XML generation
  • React Flow candidate constraint checks (single parentId, addEdge duplicate drop)

OUTSTANDING ACCEPTANCE CHECKS (Requires live in-WebView session):
  • Live in-WebView pointer dragging & service focus/collapse in WebKitGTK
  • Live SVG particle motion & path sampling (SVGGeometryElement.getPointAtLength)
  • Live in-WebView canvas PNG export and offline font rendering
==================================================================
```

---

## 3. Windows Packaged Environment Evidence & CI Procedure

### Environment Baseline (from prior art in `docs/packaged-windows-smoke-check.md`)
- **OS:** Windows x64
- **Runtime:** Bun 1.4.2+, WebView2 runtime supplied by Windows
- **Packaging:** `hutch run build` produces `build/stable-win-x64/Schema Designer-Setup.exe`
- **Asset path:** `Resources\app\views\mainview`

### Continuous Integration Workflow (`.github/workflows/packaged-proof.yml`)
To establish Windows native WebView execution evidence on real Windows runners without relying on unconfigured local machines, a GitHub Actions workflow is provided:
```yaml
name: Packaged Proof Verification
on:
  pull_request:
    branches: [main]
  push:
    branches: ["agent/**", "main"]
  workflow_dispatch:

jobs:
  windows-proof:
    name: Windows Packaged Proof (WebView2)
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun x electrobun prepare
      - run: bun test src/shared/architecture-proof.test.ts src/mainview/architecture-proof/svg-export.test.ts
      - run: bun x tsc --noEmit
      - run: bun x vite build
      - run: bun x electrobun build --env=stable
      - run: bun scripts/verify-packaged-proof.ts
```

### Execution Log from Packaged Windows Runner (GitHub Actions Run 40408810102)
```
=== ARCHITECTURE CANVAS & SVG PLAYBACK TECHNICAL PROOF VERIFIER ===
Platform: win32 (x64)
Runtime: Bun 1.4.4

[1/5] Verifying packaged application payload & offline assets (Windows)...
  ✓ Packaged build directory exists for Windows: D:\a\db-planner\db-planner\build\stable-win-x64
  ✓ Package contents: Schema Designer
  ✓ Bundled assets verified: 129 files in dist/assets
  ✓ Offline bundled font files verified: 32 fonts found (IBM Plex Sans, Mono, Newsreader)

[2/5] Validating domain model & geometry-independent ownership...
  ✓ Service ownership is explicit (Upload API owned by Ingestion, Image Worker by Processing)
  ✓ Shared queue and database exist at system scope
  ✓ Shared schema link verified between Primary and Replica databases
  ✓ Overlapping Group 'Compliance Boundary' spans Service-owned and system-scope components
  ✓ Deduplicated Group movement verified: overlapping member moved exactly once (dx: 40, dy: 25)

[3/5] Validating duplicate-endpoint Connections and Service collapse projection...
  ✓ Parallel labeled connections verified between identical endpoints: "POST /upload" and "GET /upload/status"
  ✓ Service collapse projection verified: connection visually projects to collapsed service card
  ✓ Authoritative endpoint identity preserved: connection.targetId remains 'comp-api'

[4/5] Validating Walkthrough timeline: parallel completion, finite retry, seeking...
  ✓ Compiled timeline: 7 scheduled steps, total duration 8.30s
  ✓ Parallel step coordination verified: Worker writes to Storage Bucket and Database concurrently
  ✓ Deterministic time-derived state verified: seeking backwards reconstructs exact identical state
  ✓ Reduced motion presentation verified: particles disabled while static step highlights remain
  ✓ Finite retry explanation verified: cycle 1 illustrates failure/retry, cycle 2 illustrates success

[5/5] Testing static SVG export and React Flow candidate constraints...
  ✓ Standalone SVG export generated (1140x610px, 13514 bytes) at D:\a\db-planner\db-planner\build\proof-export.svg
  ✓ SVG contains zero external HTTP/HTTPS assets and embeds self-contained font styling
  ℹ Standalone CLI PNG rasterizer not available on this runner (in-browser canvas rasterization tested in suite).
  ✓ React Flow addEdge() constraint confirmed: duplicate source/target edges are dropped by helper

==================================================================
PACKAGED MODEL & ASSET LOGIC CHECKS PASSED FOR WINDOWS
------------------------------------------------------------------
Scope verified by this script:
  • Packaged application build artifact & font presence on Windows
  • Explicit Service ownership & system-scope components
  • Overlapping groups & deduplicated member movement
  • Duplicate-endpoint parallel connections & service collapse projection
  • Deterministic timeline compilation, parallel branches, and retry states
  • Standalone SVG export XML generation
  • React Flow candidate constraint checks (single parentId, addEdge duplicate drop)

OUTSTANDING ACCEPTANCE CHECKS (Requires live in-WebView session):
  • Live in-WebView pointer dragging & service focus/collapse in WebView2
  • Live SVG particle motion & path sampling (SVGGeometryElement.getPointAtLength)
  • Live in-WebView canvas PNG export and offline font rendering
==================================================================
```

---

## 4. Current Status of Native Evidence & Outstanding Acceptance Work

### What Has Been Conclusively Proven
1. **Packaged Build & Bundled Assets:** Both Linux (`build/stable-linux-x64`) and Windows (`build/stable-win-x64`) packages build with Electrobun; `dist/assets` packages 32 offline font files and zero external network URLs.
2. **Domain Model Invariants:** Explicit Service ownership, system-scope sharing, and overlapping/nested Groups operate independently of placement; group movement deduplicates overlapping member translations.
3. **Multigraph Topology & View Projection:** Parallel labeled connections calculate distinct non-overlapping curved paths; collapsing a Service visually projects endpoints while preserving authoritative entity IDs.
4. **Authored Timeline Scheduling:** Deterministic timeline compiles parallel execution branches, finite retries with transient error display, reverse seeking, and reduced-motion presentation.
5. **Candidate Library Constraints:** React Flow's single `parentId` limitation and `addEdge()` duplicate suppression constraints have been empirically proven, provisionally justifying the Custom Canvas approach.

### What Remains Outstanding for Full Acceptance (#117)
The current verifier runs source modules within the Bun CLI process and inspects filesystem packages; it does not drive the live rendered native WebView. Full acceptance requires:
1. **Live in-WebView DOM Interaction:** Establishing a remote debugging session (CDP on WebView2, WebKitGTK inspector on Linux) to trigger and observe pointer drag events, service collapse/expand toggles, and focus navigation inside the running WebView.
2. **Live SVG Path Motion in WebKitGTK and WebView2:** Validating that `getPointAtLength()` samples smoothly along rendered `<path>` elements and animated message markers update component DOM states across frame rates without rendering artifacts.
3. **In-WebView Offline Font Loading & PNG Canvas Rasterization:** Exercising `HTMLCanvasElement.toDataURL("image/png")` inside the running native WebView to verify that bundled fonts render into the canvas context without tainted canvas security errors or font substitution.

Until these live in-WebView checks are automated or manually evidenced, PR #149 remains a **Draft PR** referencing `Refs #117`.
