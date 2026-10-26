# System-design expansion

This is the agreed product specification for expanding the database designer
into a system-design workspace. It describes intended behavior, not implemented
features. The existing database-focused application remains the baseline until
the expansion is built; older first-slice documentation describes that baseline.

Implementation tracker: [#116 — System-design workspaces with linked schemas and animated Walkthroughs](https://github.com/jvasquezt2004/db-planner/issues/116).

See the [component catalog](system-components.md) and the
[implementation plan](system-design-build-plan.md) for component contracts,
codebase integration, migration, checkpoints, and acceptance checks.

## Agreed direction

- The primary purpose is designing and explaining systems before building them.
- A Project represents one system. Its System design connects to database
  Designs, including distinct Designs for different databases in the Project.
- Existing projects retain their current database Design in the expanded model.
- The initial playback capability is a saved, authored Walkthrough with
  coordinated animations as interactions move through the architecture.
- Behavioral simulation is desired for a future phase or session. Its state
  model, fidelity, and supported components remain undecided.
- Existing database Scenarios keep their executable meaning. Walkthroughs do
  not silently replace them or imply that infrastructure has executed.

## Architecture model

- Components have one owning Service or sit at system scope as shared or
  independent resources. Connections describe usage rather than ownership.
- Changing ownership is explicit; moving a Component visually does not by
  itself transfer it to another Service.
- A shared queue used by two Services remains one system-scope Component with
  Connections from the Services that use it.
- Service boundaries express ownership. Purely visual groups and deployment
  boundaries have different meanings. Services own Components rather than
  other Services; larger organizational boundaries use separate Groups.
- Groups are named, non-owning, and nestable. They can organize business
  domains, regions, or network boundaries without transferring ownership.
- Group membership is explicit and may overlap. Drawing or resizing a box does
  not change membership; moving a Group moves its members together, with each
  actual Component moving once even when memberships overlap.
- Database components can remain conceptual. A supported database can link to
  an existing Design or create one, then use the existing database-design views
  for schema detail. Architecture can represent other database kinds without
  promising editable relational schemas for them.
- Multiple Database components may intentionally link to one database Design,
  such as a primary and replica sharing a schema. Identify Shared schema links
  visibly. Schema edits apply everywhere linked, without implying common
  database contents; independent schemas use separate Designs.
- The system overview and focused Service views show the same underlying
  System design. A Service can be expanded or collapsed; editing a Component
  in either view changes the same Component.
- Connections are directed and labeled. Multiple Connections can exist between
  the same endpoints, including directly between Services for microservice
  architecture. Interaction type and protocol are optional while sketching.
- Connections describe possible interactions. A Walkthrough references those
  Connections and determines which interactions occur and in what order.
- Provide automatic Connection routing with optional attachment-side and bend
  point adjustments. Playback follows the same visible path. Rearranging the
  layout changes geometry without changing authored step order or durations.

## Component catalog direction

Use generic components, optional technology/provider branding, and custom
components. Branding does not by itself promise provider-specific behavior.
The following families and kinds, along with the common contract and proposed
properties/reactions in [the component catalog](system-components.md), are
agreed. Exact artwork and animation implementation remain to be specified.

| Family | Starting components |
| --- | --- |
| Actors and clients | Person, browser, mobile app, external system |
| Traffic and networking | DNS, CDN, load balancer, API gateway, proxy |
| Compute | Application, API, worker, scheduled job, serverless handler |
| Data | Database, cache, object-storage bucket, file storage, search index |
| Messaging | Queue, topic, event bus, event stream |
| Supporting capabilities | Identity provider, secrets store, configuration, observability |
| Custom | A Component defined by the designer |

- Components start with a kind and visible name, with optional technology,
  description, notes, and descriptive properties. Kind-specific properties do
  not execute infrastructure behavior during Walkthrough playback.
- Custom Components support the shared actions. Specialized infrastructure can
  initially use Custom components and Groups; deployment configuration is
  outside the initial expansion.

## Removing elements

- Removing a Group removes its grouping and keeps its contents.
- Removing a Service boundary releases its Components to system scope.
- Removing a Database component retains its linked Design, Scenarios, and Edge
  functions.
- Deleting contents is a separate, explicit action showing affected items and
  Walkthroughs. Connections whose actual endpoint is removed are listed as
  affected; Component-to-Component Connections survive removal of their
  surrounding boundary.

## Walkthrough authoring and playback

- A Project can save multiple named Walkthroughs for distinct interactions,
  such as an image upload, cached read, or failure path.
- Designers and the Assistant can both author and revise Walkthroughs.
- Editable steps reference actual Connections and can include a title,
  explanation, and optional example message or payload. Moving or renaming
  architecture elements preserves their references.
- Support sequences, explicit parallel steps, and finite repetitions. Success
  and failure paths are authored alternatives selected for playback, without
  requiring runtime condition evaluation or simulated failures.
- Animations follow the interaction: activate sender, animate message travel,
  react at the destination on arrival, then show authored processing or
  completion effects where appropriate.
- Component-specific reactions interpret a shared action vocabulary through
  reusable animation presets. Examples include a bucket absorbing an object,
  a queue receiving or releasing a message, and a worker showing processing.
- Timing is illustrative and editable. SVG component artwork and connector
  reactions use coordinated playback; exact timing defaults and rendering
  implementation must be validated in the technical proof.
- Save incomplete architecture and Walkthrough drafts. Renames and layout edits
  preserve references; deletion or redirection of referenced elements preserves
  the Walkthrough but marks affected steps for repair or review. Do not silently
  reroute the explanation. Playback requires valid references and resolution of
  redirection review by accepting the changed route or repairing the step.
- During playback, collapsed Services summarize their internal activity through
  Service animation and the current step's explanation. Designers can expand a
  Service to see its internal interactions.
- A Connection authored between Services remains service-level when expanded;
  no internal route is invented. Component-level Connections keep their actual
  endpoints when their Services are collapsed.
- Playback controls include Play/Pause, Next/Previous step, Restart, step
  selection, and speed adjustment. Automatic camera following is optional.
- Structural or Walkthrough edits stop playback so it can restart from updated
  content. Pan, zoom, and Service expansion remain available during playback.

## Existing database execution

- Each database Design has its own Scenarios, Edge functions, SQL routines,
  Triggers, and sandbox results. Executable content is bound to that Design,
  rather than whichever schema view happens to be open.
- Each Scenario runs against its own fresh sandbox for its database Design.
- Existing executable project content stays with its original database Design
  when migrated into the expanded Project model.
- System-wide Walkthroughs span architecture visually. Cross-database execution
  and executable handlers shared across Designs are deferred.

## Assistant editing

- The Assistant can edit architecture, database detail, and Walkthroughs within
  one request. Its changes remain manually editable project content.
- It can arrange architecture layouts when requested. Ordinary edits preserve
  existing layout except where placement of new elements requires otherwise.
- Whole-turn Revert covers all artifacts changed in that Assistant turn,
  including architecture layout, database detail, and Walkthroughs.
- Revert checks for conflicts with subsequent manual edits. Conflicts identify
  affected items and leave the Project unchanged until resolved. Independent
  edits elsewhere do not prevent Revert, and Revert does not discard later
  manual work or apply only part of the Assistant turn.
- Ordinary Undo follows one Project-wide content history across views. An
  Assistant turn is one undoable action; drags and typing form useful groups.
- Navigation, selection, pan, and zoom stay outside content history. Undo names
  the action it will reverse.
- Manual editing remains available while the Assistant works. Relevant content
  changed since an Assistant read must be reread and accounted for before its
  edit applies, rather than overwritten. Independent edits proceed normally.

## Visual and navigation direction

- Preserve the current app identity: paper, ink, blue accent, and typography.
  Add recognizable SVG component artwork in that visual language.
- Components remain calm while editing and activate during playback.
  Reduced-motion playback uses static highlights and explanations to convey the
  same steps.
- New Projects open in the system overview. Existing Projects initially retain
  their familiar database view after migration; reopening restores the last-used
  view.
- The overview leads to focused Service views, Walkthroughs, and linked database
  workspaces. A focused Service view retains context for external Connections.
- Database workspaces expose their existing schema, SQL, routines, Scenarios,
  and Edge functions. The Assistant stays Project-scoped across navigation.

## Portability and platform

- Export/import a portable editable Project with architecture, database Designs,
  Walkthroughs, layout, and executable source. Imports create new Projects and
  preserve existing ones. Repairable draft references and review state survive
  round-trip; format validation does not require every Walkthrough to be playable.
- Portable files omit provider credentials and conversation history.
- Support static SVG and PNG diagram exports. Animated standalone HTML export
  is a later addition.
- Continue the local desktop product. Designing, saving, and playback work
  offline; Assistant model providers require network access.
- Verify packaged Windows and Linux behavior. Hosted editing, cloud
  synchronization, live collaboration, and macOS verification remain future work.

## Delivery checkpoints

1. Technical proof: packaged canvas behavior, overlapping Groups, multiple
   Connections between identical endpoints, and synchronized SVG pause/seek.
2. Architecture foundation: Project migration, Services, Components, Connections,
   persistence, database links, and Assistant editing.
3. Complete editor: full catalog, Groups, collapsed/focused views, Shared schemas,
   routing controls, and Project-wide history/conflict handling.
4. Walkthroughs: manual and Assistant authoring, parallel steps, repetitions,
   component reactions, and playback controls.
5. Portability and release checks: Project import/export, SVG/PNG export,
   migration checks, and packaged verification.

Checkpoints contribute to the whole agreed scope; they do not replace it with a
smaller feature. Behavioral simulation and animated HTML export follow separately.

## Engineering validation still required

- Select the canvas library only after validating domain ownership independent
  of overlapping Groups, collapsed projections, multiple Connections, and native
  WebView behavior. React Flow is a candidate, not an accepted dependency.
- Prove deterministic playback timing and seeking, including parallel steps,
  finite repetitions, and geometry changes.
- Prove Project-wide history and whole-turn Revert with concurrent manual edits;
  no implementation may silently discard later work or partially revert a turn.
- Finalize tool schemas, storage migrations, timing defaults, and export format
  versioning within the agreed product behavior.
- A behavioral simulator's fidelity and supported runtime components remain a
  future design session.

## Decisions and vocabulary

- [Glossary](../GLOSSARY.md)
- [Projects represent systems with linked database Designs](adr/0005-projects-represent-systems-with-linked-database-designs.md)
- [Explain system behavior through authored Walkthroughs first](adr/0006-authored-walkthroughs-before-system-simulation.md)
- [Keep Service ownership explicit in one shared System design](adr/0007-explicit-service-ownership-in-one-system-model.md)
- [Revert Assistant changes across project artifacts together](adr/0008-assistant-turn-revert-spans-project-artifacts.md)
- [Scope existing database execution to each database Design](adr/0009-scope-database-execution-to-each-design.md)
- [Drive SVG playback from one authored timeline](adr/0010-drive-svg-playback-from-one-authored-timeline.md)
