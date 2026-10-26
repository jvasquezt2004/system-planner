# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The current web interface is packaged as an Electrobun desktop application.
The expansion continues as a local desktop product; the platform value describes
its interface technology. Hosted editing, cloud synchronization, and live
collaboration are outside the initial expansion.

## Users

Developers designing and explaining systems before building them, including
their services, resources, interactions, and database schemas.

## Product Purpose

Expand the existing database schema designer into a system-design workspace.
A Project represents one system, with one authoritative System design, linked
database Designs, and multiple authored Walkthroughs. The system overview,
focused Service views, and database detail describe connected parts of the same
Project.

## Operating Context

The current application stores Projects locally and offers database editing,
generated SQL/schema source, disposable database sandboxes, executable
Scenarios, Edge functions, and a Project-scoped Assistant. The expansion keeps
database execution distinct from illustrative architecture playback.

## Capabilities and Constraints

- Explicit Service ownership is independent of placement and non-owning Groups.
- Directed, labeled Connections can join Components or Services, including
  multiple Connections between the same endpoints.
- Generic and Custom components describe the planned system, with optional
  provider/technology presentation and descriptive properties.
- Database components may remain conceptual or link to editable database
  Designs; multiple Components may intentionally share a schema Design.
- Walkthroughs support sequences, parallel steps, finite repetitions, and
  coordinated component/connection reactions with illustrative timing.
- Existing executable content is scoped to its database Design and runs
  against fresh disposable sandboxes. Cross-database execution is deferred.
- Manual and Assistant editing both operate on ordinary Project content.
  Project-wide Undo, whole-turn Revert, and concurrent manual editing must
  preserve later work and detect conflicts.
- Existing Projects retain their database Design and executable content when
  migrated into the expanded model.
- Designing, saving, and Walkthrough playback work offline; Assistant model
  providers require network access. Verify packaged Windows and Linux behavior;
  macOS verification is separate future work.
- Keep the existing visual identity and use recognizable SVG component artwork
  with coordinated reactions and a reduced-motion presentation of the same steps.
- New Projects open in the system overview; existing Projects retain their
  database view after migration. Reopening restores the last-used view.
- Portable editable Project import/export and static SVG/PNG exports belong to
  the expansion. Imports create new Projects; portable files omit provider
  credentials and conversation history. Animated standalone HTML comes later.
- Behavioral simulation is desired for a future phase; scope and fidelity are
  undecided. Initial Walkthrough playback does not execute service behavior.
- Delivery proceeds through technical proof, architecture foundation, complete
  editor, Walkthroughs, and portability/release checks. Concrete library and
  implementation choices must satisfy the technical proof.

## Evidence on Hand

- [Current implementation and commands](README.md)
- [Agreed expansion specification](docs/system-design.md)
- [Component catalog](docs/system-components.md)
- [Implementation plan and validation gates](docs/system-design-build-plan.md)
- [Canonical vocabulary](GLOSSARY.md)
- [Architecture decisions](docs/adr/)
- Existing UI assets, CSS, and responsive screenshots under `src/mainview/` and
  `docs/screenshots/`.

## Product Principles

- Design and explain systems before requiring executable implementations.
- Preserve one authoritative model across overview and detail views.
- Distinguish ownership, organization, and usage explicitly.
- Keep unfinished work and identify problems without silently rewriting intent.
- Make Assistant changes ordinary, editable, and reversible Project changes.
