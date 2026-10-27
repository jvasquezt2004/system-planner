# Architecture Canvas Library Evaluation

**Ticket:** [#117 — Prove the architecture canvas and SVG playback in packaged apps](https://github.com/jvasquezt2004/db-planner/issues/117)  
**Parent:** [#116 — System-design workspaces with linked schemas and animated Walkthroughs](https://github.com/jvasquezt2004/db-planner/issues/116)

## Decision context

The current architecture model represents Services as owners, Groups as non-owning overlapping memberships, and Connections as independently identified graph edges. The Custom Canvas supports those relationships directly in its own model. A UI library's grouping or connection helpers should not become authoritative if their invariants conflict with this model.

React Flow's `parentId` is a single optional string, so its built-in parent/child flow cannot directly represent one component owned by a Service and simultaneously present in multiple overlapping Groups. React Flow's `addEdge()` helper also suppresses duplicate edges with matching source/target/handles; a multigraph consumer would need a different edge insertion path. These are API-shape constraints, not evidence that React Flow cannot be adapted with custom state and rendering.

## Packaged proof findings

The current proof implementation is in `src/mainview/architecture-proof/` and `scripts/verify-packaged-proof.ts`. It runs through the built desktop app's native WebView instead of relying only on source-module tests.

The observed Linux WebKitGTK run passed all 16 required checks. It exercised component drag and connected-path updates, an overlapping Group drag with single movement of its member, Service collapse/expand and focus, parallel SVG paths, native path sampling, timeline controls and stepping, reduced motion, bundled font loading, no external HTTP(S) assets, and in-WebView SVG-to-PNG export. Exact host, user-agent, viewport, and measured export values are recorded in `docs/packaged-canvas-proof-evidence.md`; the per-run JSON report is `build/webview-proof-report.json`.

The GitHub Actions workflow builds and runs separate Linux WebKitGTK and Windows WebView2 packages. Windows compatibility remains unverified until the Windows job passes and its report is inspected. The recommendation below is limited to the observed model needs and Linux proof; it does not claim cross-platform equivalence before that job succeeds.

## Trade-offs

| Concern | Custom Canvas | React Flow |
| --- | --- | --- |
| Service ownership plus overlapping Groups | The app's explicit owner and set-like Group membership can be represented directly. | Built-in `parentId` is single-parent; overlapping membership needs a separate model/rendering layer. |
| Parallel edges | Each Connection remains independently identified and can have its own route. | `addEdge()` suppresses duplicate endpoint/handle edges; use another insertion strategy for multigraph data. |
| Authored playback and seeking | Existing canvas uses an authored timeline and SVG path sampling; Linux packaged behavior passed the recorded proof. | Custom playback remains possible, but would need to integrate with its rendering model. |
| Maintenance | Keeps this domain's graph and geometry logic in application code. | Provides mature node/edge interactions, but its built-in grouping and edge helpers do not encode all current domain requirements. |

## Recommendation

Continue with the Custom Canvas for this architecture model: it represents the required ownership, overlapping-group, and parallel-edge relationships without turning a UI library's single-parent hierarchy or duplicate-edge helper into the data model. Reassess only if the product requirements change or a candidate's custom model/rendering costs justify adoption. Confirm the Windows WebView2 CI result before claiming packaged cross-platform validation.
