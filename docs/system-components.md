# System component catalog

The component families, kinds, common properties, descriptive annotations, and
reaction direction below were agreed during the system-design interview. They
describe the intended expansion rather than implemented features; exact artwork
and animation implementation remain open.

## Common contract

- Every Component has a kind and a visible name, with a useful default name on
  creation. Technology/provider branding, description, notes, and descriptive
  key/value annotations are optional.
- Service ownership, Group membership, and Connections are modeled explicitly,
  rather than inferred from icon type or screen position.
- Kind-specific properties describe the planned system. A scheduling, retention,
  routing, or delivery annotation does not execute that behavior during playback.
- Walkthroughs use shared actions: send, receive, process, succeed, and fail.
  An optional operation selects an appropriate visual preset, such as upload,
  cache hit, or enqueue. The explanation and optional example payload accompany
  the step.
- Reactions are illustrative and temporary. Queue depth, cache contents, stored
  objects, and similar persistent resource state are not inferred by playback.
- Custom Components use a chosen icon or shape, a name, optional annotations,
  and the same shared actions. Arbitrary executable behavior is outside this
  catalog's initial scope.

## Annotations and reactions by kind

| Family | Kind | Optional descriptive detail | Example visual reactions |
| --- | --- | --- | --- |
| Actors and clients | Person | Role, intention | Initiate interaction, receive result |
| Actors and clients | Browser | App, URL | Send request, receive response |
| Actors and clients | Mobile app | Platform, app | Send request, receive response |
| Actors and clients | External system | Provider, responsibility | Send or receive interaction |
| Traffic and networking | DNS | Zone, record description | Receive query, resolve, fail |
| Traffic and networking | CDN | Content, cache policy | Cache hit/miss, fill, deliver |
| Traffic and networking | Load balancer | Routing strategy, targets | Receive, forward to authored target |
| Traffic and networking | API gateway | Routes, protocols, authentication | Receive, check, forward, reject |
| Traffic and networking | Proxy | Role, protocols | Receive, forward, return |
| Compute | Application | Responsibility, technology | Receive, process, complete |
| Compute | API | Operations, protocols | Receive request, process, respond |
| Compute | Worker | Job or message type | Receive job, process, succeed/fail |
| Compute | Scheduled job | Schedule description, task | Trigger, process, send |
| Compute | Serverless handler | Trigger, runtime description | Activate, process, return |
| Data | Database | Engine, database kind, optional Design link | Read, write, return, fail |
| Data | Cache | Engine, key description, expiry policy | Hit, miss, set, invalidate |
| Data | Object-storage bucket | Object purpose, prefix, lifecycle description | Upload, download, delete |
| Data | File storage | Volume, mount, protocol | Read, write, return |
| Data | Search index | Indexed subject, indexing approach | Index, search, return results |
| Messaging | Queue | Message type, delivery/retry description | Enqueue, release, acknowledge, retry |
| Messaging | Topic | Event type, subscriber description | Publish, deliver along authored branches |
| Messaging | Event bus | Event types, routing description | Receive, route, deliver |
| Messaging | Event stream | Event type, partition/retention description | Append, consume, replay |
| Supporting capabilities | Identity provider | Authentication method, issuer | Authenticate, issue token, deny |
| Supporting capabilities | Secrets store | Secret references, consuming roles | Request, retrieve, deny |
| Supporting capabilities | Configuration | Configuration scope, consumers | Fetch, deliver update |
| Supporting capabilities | Observability | Logs, metrics, traces, alert purpose | Receive telemetry, record, alert |
| Custom | Custom | Chosen icon/shape and descriptive annotations | Shared send/receive/process/succeed/fail presets |

## Catalog registry

`src/shared/component-catalog.ts` is the common registry for the client, traffic,
compute, data, and messaging kinds: each entry gives the kind, label, family, optional descriptor
keys stored in the Component's properties, operation presets (such as
"Cache hit" or "Rejected"), artwork name, and reaction preset. The editor
palette, the Inspector, playback, and later Assistant tools and exporters read
kinds from this list. Descriptor values are optional annotations; no entry
requires a vendor or configures executable network behavior. A Serverless
handler is a descriptive Component only: it never runs or links an Edge function
(a database Design's server handler), and a Scheduled job's schedule is text
that playback does not execute.

## Reaction registry contract

Walkthrough playback reads reactions through `src/shared/component-reactions.ts`.
Each kind maps to a preset that supplies the visible wording for the five shared
actions. Kinds without a preset use the generic wording. Artwork and wording can
change per kind without changing the authored timeline, which stays the same for
every kind (ADR-0010).

- `reactionPresetFor(kind)` resolves the preset for a kind, falling back to generic.
- Kind-specific presets come from the catalog registry (`component-catalog.ts`),
  which `KIND_REACTION_PRESETS` collects. An operation preset replaces the
  destination's wording when a step names it, such as "Cache hit" on a CDN.
- Presets style reactions only. A preset cannot change durations, arrival time,
  the route, or the step order.
- A bucket and a queue draw one transient item that slides in while it receives
  and out while it sends. The item follows the step's reaction on the shared
  clock and is absent during the outcome, so playback never shows a stored
  object count, cache contents, or queue depth.

## Technology variations

The catalog treats technology names as optional refinements of a kind,
rather than separate executable components. For example, relational, document,
key/value, graph, vector, or analytical database descriptions can all use a
Database component; editable schema detail remains limited to what the existing
schema editor supports. A vector capability can also be described on a relational
database rather than forcing it into a mutually exclusive category.

Specialized external providers can use an External system or a branded Custom
component. Specialized infrastructure can initially use Custom components and
Groups; deployment configuration is outside the initial expansion. Containers,
machines, clusters, and placement descriptions do not imply executable deployment
semantics.
