# Streamline

Enterprise process mapping with one shared core behind the **web UI**, the **REST API**, an **MCP server for AI agents**, and the **CLI**.

Map how work gets done: processes made of steps and flows, the teams that run each step, the business systems they use, and the risks and controls involved. Then search across all of it, see how teams hand work to each other, and govern changes through review, versioning and an audit trail.

```
 Browser UI ──► REST /api/v1 ─┐
 Scripts, BI ─► REST /api/v1 ─┤
 AI agents ───► MCP  /mcp ────┼──► Executor ──► Operations ──► PostgreSQL / SQLite
 Ops / jobs ──► CLI ──────────┘   authenticate · authorize (RBAC) · validate ·
                                  transaction · audit · webhooks
```

Every action is an **operation** (`process.create`, `node.update`, `analytics.teamInteractions`, …) with one input schema, one permission and one handler. The REST routes, the OpenAPI spec, the MCP tool list and the CLI are all generated from the same registry, so anything a person can do in the UI an AI agent can do over MCP, under the same rules and with the same audit record. See [docs/architecture.md](docs/architecture.md).

## Features

**Process mapping**
- Visual editor: start/end, task, decision, sub-process, event, document, system and note shapes; drag-and-drop palette; connect by dragging; labelled outcomes
- Swimlane auto-layout by responsible team, plus a flow auto-layout; the server also lays out diagrams created through the API or AI with no coordinates
- Each step records team, role, duration, inputs, outputs, business systems, risks, controls and work instructions
- Diagram quality checks: missing start or end, dead ends, unlabelled decisions, steps with no team, unlinked sub-processes
- Step-by-step procedure view and a risk & control coverage view for each process

**Governance**
- Lifecycle: draft → in review → published → archived. Each publish creates an immutable numbered version
- Segregation of duties: the person who submits a process can't approve it (configurable)
- Version history with compare, view and restore; periodic re-certification with due dates on the dashboard
- Optional team-ownership enforcement: only the owning team may edit a process
- Comments on processes or on individual steps; a per-process activity history
- Optimistic concurrency, so people and AI agents can't silently overwrite each other's edits

**Insight**
- Keyword search across processes, steps, teams, systems, risks and controls, ranked, with highlighted snippets
- **Team interaction map**: a weighted, directed graph of handoffs between teams, derived from every diagram. Click a link to see the exact steps behind it
- **Process landscape**: every process grouped by area or owner, with sub-process call links
- Risk & control matrix with gap detection: risks without controls, risks that occur in a process where none of their controls run, ineffective controls, orphan controls
- Business-system impact: which processes and teams depend on each application
- Dashboard: status mix, reviews due, risk heat and control effectiveness

**Integration and data out**
- REST API with an OpenAPI 3.1 spec (`/api/v1/openapi.json`) and a built-in reference (`/api/docs`)
- MCP server at `/mcp` (Streamable HTTP) or over stdio. Every operation is a tool, filtered to the caller's permissions, plus process resources and guided prompts
- Export a process as **BPMN 2.0** (lanes and diagram layout included), Mermaid, Markdown or JSON. Re-import JSON across environments
- Full repository export (`GET /api/v1/export`) for backups and data warehouses; CSV export from every list
- Signed outbound webhooks (HMAC-SHA256) for any operation, with wildcards

**Enterprise and security**
- SSO via OpenID Connect (Entra ID, Okta, Google, Auth0, Keycloak…) with group-to-role mapping, and/or local passwords (scrypt, lockout, password policy)
- RBAC roles (viewer, editor, approver, admin) with 13 fine-grained permissions
- API tokens: hashed, scoped read-only or read/write, with expiry and revocation. Service accounts for integrations and AI agents
- Audit log of every change and every denied attempt, recording who did it, which channel (UI/API/MCP/CLI), from which IP, with the request id
- CSRF protection, strict CSP and security headers, rate limiting, SSRF-guarded webhooks
- Runs non-root on a read-only filesystem. See [docs/security.md](docs/security.md)

**Portable deployment**
- One container image; all configuration comes from environment variables, and `*_FILE` secrets are supported
- PostgreSQL for production, SQLite for single-node or evaluation use. Migrations run automatically
- Docker Compose, a Helm chart (HPA, PDB, NetworkPolicy, hardened pod security), and guides for AWS, Azure and Google Cloud. See [docs/deployment.md](docs/deployment.md)
- Stateless app tier (sessions live in the database, MCP is stateless), so it scales horizontally

## Quick start

**Docker, with demo data:**

```bash
docker build -t streamline .
docker run -p 8080:8080 \
  -e PUBLIC_URL=http://localhost:8080 \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD='Admin-Password-123' \
  -e SEED_DEMO_DATA=true \
  -v streamline-data:/data streamline
```

Open http://localhost:8080 and sign in as `admin@example.com` / `Admin-Password-123`.

**With PostgreSQL:** `cp .env.example .env`, fill in the secrets, then `docker compose up -d`.

**From source (Node.js 22+):**

```bash
npm install
npm run build                     # web UI + server
cd packages/server
SEED_DEMO_DATA=true BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
BOOTSTRAP_ADMIN_PASSWORD='Admin-Password-123' npm start
```

For development, run `npm run dev` (API on :8080) and `npm run dev:web` (UI with hot reload on :5173).

## Connect an AI assistant

```bash
# A service account for the agent (prints a token once)
docker exec <container> node /app/dist/cli.js create-service-account \
  --name "Process agent" --email agent@svc.local --role editor

# Claude Code
claude mcp add --transport http streamline https://streamline.example.com/mcp \
  --header "Authorization: Bearer slt_…"
```

The **API & MCP access** page in the UI has ready-to-copy configs for other clients. See [docs/api-and-mcp.md](docs/api-and-mcp.md).

## CLI (the "system path")

```bash
streamline serve | migrate | seed-demo | ops
streamline create-admin --email a@b.com --name "Ada"
streamline create-service-account --name "BI extract" --email bi@svc.local --role viewer --scope read
streamline op process.list --input '{"status":"published"}'          # runs as system
streamline op process.publish --input '{"id":"PRC-0003"}' --token slt_…  # runs as a user
STREAMLINE_TOKEN=slt_… streamline mcp                               # MCP over stdio
```

## Repository layout

```
packages/server   Node.js / TypeScript: operations, executor, REST, MCP, CLI, migrations, tests
packages/web      React + React Flow single-page app (talks only to the public API)
deploy/helm       Helm chart
docs/             Architecture, API & MCP, security, deployment
```

## Testing

```bash
npm test                                                            # SQLite
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test  # PostgreSQL
npm run typecheck
```

The suite covers RBAC and read-only tokens, segregation of duties, team ownership, the lifecycle, versions, diff and revert, diagram editing, import and export, search, the team graph, the RCM, CSRF, sessions and lockout, MCP tool filtering and execution, signed webhooks and SSRF guards. It also has a parity test that runs the same action through the executor, REST and MCP and checks they give identical results.
