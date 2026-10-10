# REST API and MCP

Both interfaces expose the same operations (`streamline ops` lists them, and so does `GET /api/v1/meta/operations`). Permissions, validation, auditing and webhooks are identical.

## Authentication

| Client | Credential |
| --- | --- |
| Browser | Session cookie `sl_session` (HttpOnly, SameSite=Lax). Every write must send the `X-CSRF-Token` header returned by `/api/v1/auth/session` or `/api/v1/auth/login` |
| Scripts, integrations | `Authorization: Bearer slt_…` (create one under **Profile → API tokens** or `token.create`) |
| AI agents (MCP) | `Authorization: Bearer slt_…`. Cookies are never accepted on `/mcp` |

Tokens are stored as SHA-256 hashes and shown once. A token can be `read` (read-only operations only) or `write` (everything the account may do). It can expire, and it can be revoked. Disabling a user invalidates all of that user's sessions and tokens immediately.

**Service accounts** (`kind: service`) can't sign in interactively. Give each agent or integration its own service account with the narrowest role that works, so its audit trail stays clear.

## REST conventions

- Base path: `/api/v1`. Spec: `/api/v1/openapi.json`. Human-readable reference: `/api/docs`
- GET and DELETE take inputs as query parameters (lists may be comma-separated or repeated). Other methods take a JSON body
- Most `get` operations accept a UUID or the human reference (`PRC-0003`, `RSK-001`, team or system name)
- Lists return `{ items, total, limit, offset }`
- Errors return `{ "error": { "code", "message", "details", "requestId" } }`. Status codes: 400 validation (with field errors), 401, 403 (`forbidden`, `csrf_failed`), 404, 409 (`conflict`: stale `expectedRevision` or a duplicate name), 423 (account locked), 429
- Every response carries `X-Request-Id`, which you can correlate with logs and the audit log

### Common recipes

```bash
H="Authorization: Bearer $TOKEN"; B=https://streamline.example.com/api/v1

curl -H "$H" "$B/processes?status=published&tag=SOX"
curl -H "$H" "$B/processes/PRC-0003"                       # metadata + nodes + edges
curl -H "$H" "$B/search?q=vendor%20bank&types=step,risk"
curl -H "$H" "$B/analytics/team-interactions?statuses=published"
curl -H "$H" "$B/analytics/risk-control-matrix"
curl -H "$H" -o p.bpmn "$B/processes/PRC-0003/export?format=bpmn"
curl -H "$H" -o all.json "$B/export"                       # complete repository

# Create a process with its diagram in one call (positions optional)
curl -H "$H" -H 'content-type: application/json' -X POST "$B/processes" -d '{
  "name": "Access request", "ownerTeamId": "…", "tags": ["security"],
  "nodes": [
    {"id":"s","type":"start","label":"Request raised"},
    {"id":"a","type":"task","label":"Manager approves","teamId":"…"},
    {"id":"d","type":"decision","label":"Approved?"},
    {"id":"p","type":"task","label":"Provision access","teamId":"…","systemIds":["…"]},
    {"id":"e","type":"end","label":"Done"}
  ],
  "edges": [
    {"source":"s","target":"a"},{"source":"a","target":"d"},
    {"source":"d","target":"p","label":"Yes"},{"source":"d","target":"e","label":"No"},
    {"source":"p","target":"e"}
  ]}'
```

### Webhooks

Subscribe a URL (`webhook.create`, admin) to operation names such as `process.publish`, wildcards such as `process.*`, or `*`. Each delivery is a POST with this shape:

```json
{"event":"process.publish","at":"2026-01-01T00:00:00Z",
 "actor":{"id":"…","name":"Dana","channel":"ui"},
 "target":{"type":"process","id":"…"}, "data":{ …operation result… }}
```

To verify a delivery, compute `sha256=HMAC_SHA256(secret, X-Streamline-Timestamp + "." + rawBody)` and compare it with `X-Streamline-Signature`. Reject old timestamps to prevent replay.

## MCP server

- **Endpoint:** `POST /mcp` (Streamable HTTP, stateless, JSON responses). **Stdio:** `STREAMLINE_TOKEN=slt_… streamline mcp` (connects straight to the database)
- **Tools:** one per operation, named with underscores (`process_create`, `search_query`, `analytics_teamInteractions`, …). `tools/list` returns only the tools the token is allowed to call. Read tools carry `readOnlyHint`, deletes carry `destructiveHint`
- **Resources:** `streamline://process/{ref}` returns each process as a Markdown narrative
- **Prompts:** `map_process` (guided interview → create the process), `review_process_controls`, `explain_team_handoffs`
- Errors (permission, validation, conflict) come back as tool results with `isError: true` and a machine-readable code, so agents can recover

### Client configuration

**Claude Code**

```bash
claude mcp add --transport http streamline https://streamline.example.com/mcp \
  --header "Authorization: Bearer slt_…"
```

**Clients with native remote MCP**

```json
{ "mcpServers": { "streamline": { "type": "http", "url": "https://streamline.example.com/mcp",
  "headers": { "Authorization": "Bearer slt_…" } } } }
```

**Stdio-only clients (via `mcp-remote`)**

```json
{ "mcpServers": { "streamline": { "command": "npx",
  "args": ["-y", "mcp-remote", "https://streamline.example.com/mcp", "--header", "Authorization:${STREAMLINE_TOKEN}"],
  "env": { "STREAMLINE_TOKEN": "Bearer slt_…" } } } }
```

### Tips for agents

1. Look up ids with `team_list`, `system_list`, `risk_list` and `control_list` (create missing entries if permitted).
2. Create a whole process with `process_create`, passing `nodes` and `edges`. Give new nodes temporary ids such as `n1`, and omit positions so the server lays the diagram out.
3. For restructuring, `process_get` and then `process_saveDiagram` with the full node list (keep existing ids) and `expectedRevision`.
4. `process_export` with `format: "markdown"` gives a readable summary to show the user.
5. Publishing requires `process:publish`, and by default someone other than the submitter. Agents normally stop at `process_submitForReview`.
