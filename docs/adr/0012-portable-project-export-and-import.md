# Portable Project export and import

A Project can be exported to a single versioned file and imported as a separate Project. The file is the designer's backup and transfer format, so it has to round-trip everything the designer authored and nothing the machine should keep private.

## Decisions

- **Versioned document.** The file carries `format: "schema-designer.project"` and `version: 1`. An import refuses any other format, and any version it cannot read, with a message that names the version.
- **Contents.** The Project name and active Design, the active view, the System design (Components, Services, Groups, Connections, saved viewport, and collapsed Services), every database Design with its Scenarios and Edge function source, and the named Walkthroughs.
- **Excluded by construction.** Provider credentials and Assistant conversations are not read when exporting. An import reads only the listed fields, so any other top-level field is ignored and never stored.
- **Fresh identities.** An import creates a new Project and new Design identities, since Design ids are unique across the store. Every Database component's link follows its Design, so two components that shared one Design still share the imported one (a Shared schema). Other ids are scoped to their Project or Design and stay as authored.
- **Malformed versus repairable.** Structure is validated before anything is written. A missing or repeated identity, a link to a Design or Component the file does not contain, or a System design or Walkthrough list that cannot load is malformed, and the import is refused with the problem named. A Walkthrough step whose Connection is missing, or whose route no longer matches its Connection, is unfinished work. It round-trips with its repair state.
- **Atomic.** The whole Project, its Designs, Scenarios, Edge functions, System design, and Walkthroughs are written in one store transaction. A failure keeps nothing: no Project, no partial Design, and the open Project stays open.
- **No execution.** An import stores Scenario and Edge function source and never runs it. Scenario runs remain a designer action.
- **Files.** Export writes a new file, named by Project, a date stamp, and a suffix. It never overwrites a file. Import reads one file of at most 64 MB. Each step goes through a native picker and a cancelled picker changes nothing.

## Consequences

- Opening a Project still shows its first Design, so the exported active Design is restored on import but not across an ordinary reopen. This predates export.
- A focused Service view is not stored in the System design, so it is not exported. The export carries the saved viewport and collapsed Services.
- Design content is checked by the same normalizer that loads stored Designs. Full schema validation is not repeated at import; the generated SQL preview still reports any Design that cannot produce PostgreSQL.
- Animated HTML and SVG/PNG diagram exports are separate formats and are not covered here.
