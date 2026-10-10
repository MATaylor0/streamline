import { useMemo, useState } from 'react';
import { Content } from '../components/Layout';
import { PageHeader, Tabs } from '../components/ui';
import { CopyBox, TokenManager } from '../components/Tokens';
import { IconExternal } from '../components/icons';
import { getManifest } from '../api';
import { useAuth } from '../auth';
import { download } from '../api';

type Tab = 'mcp' | 'api' | 'ops';

export function IntegrationsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('mcp');
  const origin = window.location.origin;
  const ops = useMemo(() => [...(getManifest()?.values() ?? [])].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)), []);

  const claudeCode = `claude mcp add --transport http streamline ${origin}/mcp --header "Authorization: Bearer <your token>"`;
  const desktop = JSON.stringify(
    {
      mcpServers: {
        streamline: {
          command: 'npx',
          args: ['-y', 'mcp-remote', `${origin}/mcp`, '--header', 'Authorization:${STREAMLINE_TOKEN}'],
          env: { STREAMLINE_TOKEN: 'Bearer <your token>' },
        },
      },
    },
    null,
    2,
  );
  const generic = JSON.stringify({ mcpServers: { streamline: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: 'Bearer <your token>' } } } }, null, 2);

  return (
    <Content>
      <PageHeader
        title="API & MCP access"
        subtitle="Everything you can do in this UI is also available to scripts (REST API) and AI assistants (MCP) — with the same permissions, validation and audit trail."
        actions={
          <>
            <a className="btn" href="/api/docs" target="_blank" rel="noreferrer">
              <IconExternal /> API reference
            </a>
            {can('data:export') && (
              <button className="btn" onClick={() => void download('export.all')}>
                Download full export (JSON)
              </button>
            )}
          </>
        }
      />
      <div className="card" style={{ marginBottom: 16 }}>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            ['mcp', 'Connect an AI assistant (MCP)'],
            ['api', 'REST API'],
            ['ops', `Operation catalogue (${ops.length})`],
          ]}
        />
        <div className="card-body stack">
          {tab === 'mcp' && (
            <>
              <p style={{ margin: 0 }}>
                Streamline exposes a <strong>Model Context Protocol</strong> server at <code>{origin}/mcp</code> (Streamable HTTP). Every operation becomes a tool; the assistant only sees tools your token permits. Changes it makes appear in the audit log with the channel <span className="badge purple">AI / MCP</span>.
              </p>
              <div className="alert info small">Tip: ask an administrator to create a dedicated <strong>service account</strong> (Users &amp; access) for shared agents, so their activity is attributable and their role can be limited.</div>
              <h3>Claude Code</h3>
              <CopyBox value={claudeCode} />
              <h3>Claude Desktop / clients that only support stdio</h3>
              <pre>{desktop}</pre>
              <h3>Clients with native remote MCP support</h3>
              <pre>{generic}</pre>
              <p className="muted small" style={{ margin: 0 }}>
                The server also provides resources (<code>streamline://process/PRC-0001</code> as Markdown) and prompts such as <code>map_process</code> and <code>review_process_controls</code>.
              </p>
            </>
          )}
          {tab === 'api' && (
            <>
              <p style={{ margin: 0 }}>
                Base URL <code>{origin}/api/v1</code>. Send <code>Authorization: Bearer &lt;token&gt;</code>. Machine-readable spec: <a href="/api/v1/openapi.json">openapi.json</a> (import into Postman, Swagger, or generate a client).
              </p>
              <h3>Examples</h3>
              <pre>{`# List published processes
curl -H "Authorization: Bearer $TOKEN" "${origin}/api/v1/processes?status=published"

# Full process with diagram
curl -H "Authorization: Bearer $TOKEN" "${origin}/api/v1/processes/PRC-0001"

# Export BPMN 2.0
curl -H "Authorization: Bearer $TOKEN" -o p.bpmn "${origin}/api/v1/processes/PRC-0001/export?format=bpmn"

# Keyword search
curl -H "Authorization: Bearer $TOKEN" "${origin}/api/v1/search?q=invoice"

# Team handoff graph (for BI tools)
curl -H "Authorization: Bearer $TOKEN" "${origin}/api/v1/analytics/team-interactions"

# Everything, for a data warehouse or backup
curl -H "Authorization: Bearer $TOKEN" -o export.json "${origin}/api/v1/export"`}</pre>
            </>
          )}
          {tab === 'ops' && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Operation</th>
                    <th>REST</th>
                    <th>MCP tool</th>
                    <th>Permission</th>
                    <th>You</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.map((o) => (
                    <tr key={o.name}>
                      <td>
                        <code>{o.name}</code>
                        <div className="muted small">{o.summary}</div>
                      </td>
                      <td className="nowrap">
                        <code>
                          {o.method} {o.path}
                        </code>
                      </td>
                      <td>{o.mcpTool ? <code>{o.mcpTool}</code> : <span className="muted small">API/UI only</span>}</td>
                      <td>
                        <code className="small">{o.permission ?? 'signed in'}</code>
                      </td>
                      <td>{o.allowed ? <span className="badge green">allowed</span> : <span className="badge">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <TokenManager />
    </Content>
  );
}
