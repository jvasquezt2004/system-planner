# System design artwork

The 29 illustrations in this directory were copied from the MCP **System
Diagram Component Library** project. The category files retain its SVG geometry
and numeric Motion keyframes. `kit.tsx` adapts the shared frame to the existing
application: a 160 × 120 illustration inside the card, application ink and paper
tokens, and the source library's category accent colors. The card owns its frame
and the Component name below the illustration.

`../system-artwork.tsx` maps every catalog kind to its illustration. Custom
Components retain their selected icon inside the imported Custom illustration.

## Playback invariants

- Idle artwork is static. Only an endpoint's active Walkthrough reaction supplies
  artwork time; completed playback and reduced motion use the idle pose.
- `componentArtworkTime` derives elapsed seconds from the winning endpoint
  reaction and its active timeline occurrence, including parallel steps and finite
  repetitions. Pause, seek, and speed changes therefore follow the same authored
  clock as Connection playback.
- `timeline-motion.tsx` samples the imported numeric keyframes into ordinary SVG
  attributes. Its `motion` facade and the `Spin` helper do not start independent
  timers, Motion playback, or SMIL animation. Keep this property when adding art.
- A component plays its action once, including delayed effects and mirrored
  returns, then holds its final pose. It does not loop while waiting for a step.
- Playback reserves the sender's full animation before message travel and the
  destination's full animation afterward. The saved duration remains the base
  travel/hold timing; the compiled presentation adds the time needed to finish
  artwork. Parallel branches wait for their longest expanded branch, and repeat
  occurrences reserve their own complete actions.
- `animation-durations.ts` records completion budgets. A render-based regression
  checks them against every actual Motion effect and Spin duration.
- Static SVG/PNG exports use the same artwork renderer in its idle pose.

This follows [ADR 0010](../../../docs/adr/0010-drive-svg-playback-from-one-authored-timeline.md).

## Layout compatibility and verification

Cards are 180 × 196, with shared automatic layout spacing sized for their taller
illustrations. Existing saved positions are preserved. The explicit, undoable
**Arrange** action can recover overlapping layouts from older Projects.

Coverage lives in `../system-artwork.test.tsx`, `../system-design-svg.test.tsx`,
and `../system-design-view.test.tsx`: catalog coverage, static exports, authored
time sampling, endpoint reactions, labels, and the older-layout recovery affordance.
