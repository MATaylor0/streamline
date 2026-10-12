# Architecture

## One core, four doors

Every access path converges on a single **executor** that runs named **operations**. Nothing in the UI, API, MCP server or CLI touches the database directly.

```
┌──────────────┐   cookie session + CSRF   ┌──────────────────────────────────────────────┐
│  Web UI      │──────────┐                │ Executor.execute(op, input, actor, meta)     │
└──────────────┘          │                │                                              │
┌──────────────┐  Bearer  ├─► REST router ─►  1. resolve operation                          │
│ API clients  │──────────┘  (generated)   │  2. authorize: role → permission, token scope │
└──────────────┘                           │  3. validate input (zod schema)               │
┌──────────────┐  Bearer                   │  4. run handler (writes in a DB transaction)  │
│ AI agents    │─────────► MCP server ────►│     + resource rules (team ownership, SoD…)   │
└──────────────┘          (generated)      │  5. audit (success / denied / error, channel) │
┌──────────────┐  token or system          │  6. emit event → webhooks (after commit)      │
│ CLI / jobs   │─────────► CLI ───────────►│                                              │
└──────────────┘                           └──────────────┬───────────────────────────────┘
                                                          ▼
                                             Kysely ─► PostgreSQL | SQLite
```

### Operations (`packages/server/src/ops`)

An operation is declared once:

```ts
defineOp({
  name: 'process.publish',            // also the webhook event name; MCP tool = process_publish
  group: 'Process lifecycle',         // docs grouping
  summary: 'Approve and publish a process',
  permission: 'process:publish',      // RBAC
  kind: 'write',                      // read | write | delete → transaction, MCP hints
  http: { method: 'POST', path: '/processes/:id/publish' },
  input: z.object({ id: Id, changeNote: z.string().max(2000).default('') }),
  handler: async (ctx, input) => { … },
});
```

From the registry the server generates:

| Artifact | Source |
| --- | --- |
| REST routes `/api/v1/...` | `http` + `input` (path params, query for GET/DELETE, JSON body otherwise) |
| OpenAPI 3.1 + HTML reference | `input` → JSON Schema, `summary`, `description`, `permission` |
| MCP tools | name `process_publish`, JSON Schema, annotations (`readOnlyHint`, `destructiveHint`), filtered per caller |
| CLI | `streamline ops`, `streamline op <name>` |
| UI client | the SPA fetches `meta.operations` and calls operations by name, so it uses the public API like any other client |
| Webhook events | operation name, e.g. `process.*` |

A handful of operations are deliberately kept out of MCP (`mcp: false`): password changes and resets, and minting API tokens. AI channels should never handle credentials. They remain available through the UI and API.

### Actors and channels

- **Actor**: a human user, a service account (via API token), or `system` (CLI without a token, bootstrap, demo seeding). Service accounts are the recommended identity for AI agents and integrations.
- **Channel**: `ui` | `api` | `mcp` | `cli` | `system`. It is recorded on every audit row, so you can tell what an AI agent changed apart from what a person changed.
- **Token scope**: `read` tokens can only exercise read permissions, even when the underlying account could do more.

### Business rules live in the core

The following are enforced in operation handlers, not in the UI, so they apply on every path:
- Segregation of duties on publish
- Team-ownership editing restrictions
- Optimistic concurrency (`expectedRevision`)
- Edits to published or in-review processes return them to draft
- Archived processes are read-only
- Referential validation (teams, systems, risks, controls, linked processes)
- At least one active administrator must always remain

## Data model

```
teams ─< team_members >─ users ─< api_tokens, sessions
  │
processes ─< nodes ─< node_systems >─ systems
  │  │         ├──< node_risks >─ risks ─< risk_controls >─ controls
  │  │         └──< node_controls >─ controls
  │  └─< edges (source node → target node, label)
  ├─< process_tags >─ tags
  ├─< process_versions (immutable JSON snapshot per publish)
  └─< comments (optionally anchored to a node)
agents ─< agent_systems >─ systems        (AI agent register; agents.service_account_id → users)
nodes.agent_id / processes.agent_id → agents, with automation_level
  (manual | assisted | supervised | autonomous) and oversight text
audit_log · settings · webhooks · counters (PRC-0001, RSK-001, CTL-001)
```

- Identifiers are UUIDs. Humans also get stable references (`PRC-0001`, `RSK-001`, `CTL-001`), and most `get` operations accept either.
- Columns are portable: text timestamps (ISO 8601), integer booleans, JSON stored as text. The same migrations run on PostgreSQL and SQLite.
- **Snapshots** (`streamline.process.v1`) carry catalog references by both id and name. One format serves versioning (restore by id), export/import between environments (match by name, create missing entries) and duplication.

## Derived views

- **Team interaction map**: for every step owned by team A, follow outgoing flows (passing through unassigned gateways) to the next steps that have a team. Every A→B where A≠B counts as one handoff. Links carry the processes and step pairs behind them.
- **Process landscape**: processes as nodes, sub-process steps as call links.
- **AI delegation**: a step's responsible team stays accountable even when an agent does the work. With `includeAgents`, steps an agent *performs* (supervised or autonomous) are attributed to that agent in the interaction map, so handoffs to and from AI appear. `analytics.aiDelegation` builds the AI register and its governance gaps.
- **Risk & control matrix**: a risk counts as *controlled* in a process when at least one of its mitigating controls is performed on a step of that process.
- **Search**: AND across terms, OR across each entity's text fields (plus tag names for processes), LIKE-based so it works the same on both databases. Results are ranked by field weight and match type. A dialect-specific full-text index can replace this behind the same operation if the corpus gets large.

## Web UI (`packages/web`)

React 19, TanStack Query and React Flow. The UI holds no business logic beyond convenience checks: it hides buttons the user lacks permissions for, but the server is authoritative. The diagram editor saves through `process.saveDiagram`, which accepts the full node and edge set with temporary ids for new nodes. AI agents use the same operation.

## Scaling and state

- The app tier is stateless. Sessions are stored in the database, MCP runs in stateless Streamable HTTP mode, and migrations take a DB lock, so N replicas behind any load balancer just work.
- Rate limits are per replica, in memory. For strict global limits, also enforce them at the gateway.
- Webhook delivery is asynchronous (up to 3 attempts with backoff). Endpoints are auto-disabled after 20 consecutive failures.
