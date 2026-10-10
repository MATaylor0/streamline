import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Executor } from '../core/executor.js';
import type { Actor, AnyOperation, RequestMeta } from '../core/operation.js';
import { AppError } from '../core/errors.js';
import { toolName } from '../ops/index.js';
import { inputJsonSchema } from '../http/openapi.js';
import type { FileResult } from '../ops/exports.js';
import { VERSION } from '../version.js';

export const MCP_INSTRUCTIONS = `Streamline is an enterprise process-mapping repository. You act with the permissions of the token you were given; tools you cannot use are not listed.

Model:
- A process (ref like PRC-0001) has metadata (owner team, category, tags, status) and a diagram of nodes (steps) and edges (flows).
- Node types: start, end, task, decision (label outgoing edges e.g. "Yes"/"No"), subprocess (linkedProcessId = called process), event, document, system, note.
- Steps reference catalog items by id: teamId (who performs it), systemIds (business applications), riskIds, controlIds.
- Lifecycle: draft → submitForReview → in_review → publish (approver) → published; editing a published process makes it a draft again. Archive to retire.

Tips:
- Look up ids first with team_list, system_list, risk_list, control_list (create missing ones if permitted).
- Create a whole process in one call with process_create including nodes and edges; give new nodes temporary ids like "n1" and reference them from edges. Omit positions to auto-layout.
- To restructure a diagram use process_saveDiagram (send the complete node and edge list, keeping existing ids). For small changes use node_create / node_update / edge_create.
- Use search_query for keyword discovery and analytics_teamInteractions to understand cross-team handoffs.
- process_export with format=markdown gives a readable narrative of a process.`;

function serialize(op: AnyOperation, result: unknown) {
  if (op.file) {
    const f = result as FileResult;
    return { content: [{ type: 'text' as const, text: f.content }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
}

function errorResult(err: unknown) {
  if (err instanceof AppError) {
    const details = err.details ? `\n${JSON.stringify(err.details, null, 2)}` : '';
    return { isError: true, content: [{ type: 'text' as const, text: `${err.code}: ${err.message}${details}` }] };
  }
  return { isError: true, content: [{ type: 'text' as const, text: 'internal_error: The operation failed unexpectedly' }] };
}

/**
 * Builds an MCP server bound to one authenticated actor. Every tool maps 1:1 to
 * an operation and is executed by the shared executor, so permissions,
 * validation, auditing (channel "mcp") and webhooks behave exactly as in the UI
 * and REST API.
 */
export function buildMcpServer(executor: Executor, actor: Actor, meta: Omit<RequestMeta, 'channel'>): Server {
  const server = new Server(
    { name: 'streamline', version: VERSION, title: 'Streamline process repository' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: MCP_INSTRUCTIONS },
  );
  const m: RequestMeta = { ...meta, channel: 'mcp' };
  const tools = () => executor.allowed(actor).filter((op) => op.mcp !== false);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools().map((op) => ({
      name: toolName(op.name),
      title: op.summary,
      description: [op.summary, op.description].filter(Boolean).join('. '),
      inputSchema: inputJsonSchema(op) as { type: 'object'; properties?: Record<string, object> },
      annotations: {
        title: op.summary,
        readOnlyHint: op.kind === 'read',
        destructiveHint: op.kind === 'delete',
        idempotentHint: op.kind === 'read' || op.http.method === 'PUT',
        openWorldHint: false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const op = tools().find((o) => toolName(o.name) === req.params.name);
    if (!op) return errorResult(new AppError('not_found', `Unknown or unavailable tool: ${req.params.name}`, 404));
    try {
      return serialize(op, await executor.execute(op.name, req.params.arguments ?? {}, actor, m));
    } catch (err) {
      return errorResult(err);
    }
  });

  // Processes as readable resources (Markdown narratives) for retrieval-style use.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const page = await executor.execute<{ items: Array<{ id: string; ref: string; name: string; summary: string }> }>('process.list', { limit: 500, sort: 'ref' }, actor, m);
      return {
        resources: page.items.map((p) => ({
          uri: `streamline://process/${p.ref}`,
          name: `${p.ref} ${p.name}`,
          description: p.summary || undefined,
          mimeType: 'text/markdown',
        })),
      };
    } catch {
      return { resources: [] };
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: 'streamline://process/{ref}', name: 'Process narrative', description: 'Markdown description of a process by reference or id', mimeType: 'text/markdown' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const match = /^streamline:\/\/process\/(.+)$/.exec(req.params.uri);
    if (!match) throw new Error(`Unknown resource ${req.params.uri}`);
    const file = await executor.execute<FileResult>('process.export', { id: decodeURIComponent(match[1]), format: 'markdown' }, actor, m);
    return { contents: [{ uri: req.params.uri, mimeType: 'text/markdown', text: file.content }] };
  });

  const prompts = [
    {
      name: 'map_process',
      description: 'Interview the user and map a business process into Streamline',
      arguments: [{ name: 'process', description: 'Name or short description of the process', required: true }],
      text: (a: Record<string, string>) =>
        `Help me map the "${a.process}" process in Streamline. First check with search_query that it does not already exist. Ask me (one question at a time, at most 6 questions) about the trigger, the teams involved, the main steps, decision points, systems used, and known risks/controls. Look up existing teams, systems, risks and controls with the list tools and reuse them. Then create the process with process_create including all nodes and edges, and show me the result with process_export (format markdown).`,
    },
    {
      name: 'review_process_controls',
      description: 'Review a process for risk and control coverage gaps',
      arguments: [{ name: 'process', description: 'Process reference (e.g. PRC-0003) or id', required: true }],
      text: (a: Record<string, string>) =>
        `Review process ${a.process} for control gaps. Use process_get and analytics_riskControlMatrix. For each step, judge whether there are risks not identified, risks without a mitigating control in this process, or controls that are ineffective. Summarise findings in a table and propose concrete changes; do not modify anything until I confirm.`,
    },
    {
      name: 'explain_team_handoffs',
      description: 'Explain how a team interacts with other teams across all processes',
      arguments: [{ name: 'team', description: 'Team name', required: true }],
      text: (a: Record<string, string>) =>
        `Use team_get and analytics_teamInteractions to explain how the "${a.team}" team hands work to and receives work from other teams. Highlight the busiest handoffs, the processes they occur in, and any opportunities to reduce handoffs.`,
    },
  ];

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map(({ name, description, arguments: args }) => ({ name, description, arguments: args })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const p = prompts.find((x) => x.name === req.params.name);
    if (!p) throw new Error(`Unknown prompt ${req.params.name}`);
    return { description: p.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text(req.params.arguments ?? {}) } }] };
  });

  return server;
}
