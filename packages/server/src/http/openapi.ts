import { z } from 'zod';
import type { AnyOperation } from '../core/operation.js';
import { PERMISSIONS } from '../core/permissions.js';
import { toolName } from '../ops/index.js';

export const API_PREFIX = '/api/v1';

type JsonSchema = Record<string, unknown> & { properties?: Record<string, JsonSchema>; required?: string[] };

export function inputJsonSchema(op: AnyOperation): JsonSchema {
  const schema = z.toJSONSchema(op.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  delete schema.$schema;
  return schema;
}

export const pathParams = (path: string) => [...path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
export const openApiPath = (path: string) => API_PREFIX + path.replace(/:([A-Za-z]+)/g, '{$1}');

export function buildOpenApi(ops: AnyOperation[], info: { version: string; serverUrl?: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  for (const op of ops) {
    tags.add(op.group);
    const schema = inputJsonSchema(op);
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const params = pathParams(op.http.path);
    const method = op.http.method.toLowerCase();
    const parameters: unknown[] = params.map((p) => ({ name: p, in: 'path', required: true, schema: props[p] ?? { type: 'string' } }));
    let requestBody: unknown;
    if (method === 'get' || method === 'delete') {
      for (const [name, s] of Object.entries(props)) {
        if (params.includes(name)) continue;
        parameters.push({ name, in: 'query', required: required.has(name) && !('default' in s), schema: s, description: s.description });
      }
    } else {
      const bodyProps = Object.fromEntries(Object.entries(props).filter(([k]) => !params.includes(k)));
      const bodyRequired = [...required].filter((k) => !params.includes(k));
      requestBody = {
        required: bodyRequired.length > 0,
        content: { 'application/json': { schema: { ...schema, properties: bodyProps, required: bodyRequired.length ? bodyRequired : undefined } } },
      };
    }
    const description = [
      op.description ?? '',
      `\n\n**Permission:** \`${op.permission ?? 'any authenticated user'}\``,
      op.mcp === false ? '' : ` · **MCP tool:** \`${toolName(op.name)}\``,
      ` · **Operation:** \`${op.name}\``,
    ].join('');
    paths[openApiPath(op.http.path)] ??= {};
    paths[openApiPath(op.http.path)][method] = {
      operationId: op.name.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase()),
      summary: op.summary,
      description,
      tags: [op.group],
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses: {
        '200': op.file
          ? { description: 'File download', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }
          : { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        '400': { $ref: '#/components/responses/Error' },
        '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' },
        '404': { $ref: '#/components/responses/Error' },
        '409': { $ref: '#/components/responses/Error' },
      },
      'x-permission': op.permission,
      'x-mcp-tool': op.mcp === false ? undefined : toolName(op.name),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Streamline API',
      version: info.version,
      description:
        'Every operation available in the Streamline UI and MCP server is available here with identical permissions and validation. Authenticate with `Authorization: Bearer slt_…` (create a token under Profile → API tokens).\n\n' +
        Object.entries(PERMISSIONS)
          .map(([k, v]) => `- \`${k}\`: ${v}`)
          .join('\n'),
    },
    servers: info.serverUrl ? [{ url: info.serverUrl }] : undefined,
    tags: [...tags].map((name) => ({ name })),
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token (slt_…)' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sl_session', description: 'Browser session (requires X-CSRF-Token on writes)' },
      },
      responses: {
        Error: {
          description: 'Error',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {}, requestId: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
    },
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Self-contained HTML API reference (no external scripts, so it works under a strict CSP and offline). */
export function renderApiDocs(ops: AnyOperation[], version: string): string {
  const groups = new Map<string, AnyOperation[]>();
  for (const op of ops) groups.set(op.group, [...(groups.get(op.group) ?? []), op]);
  const typeOf = (s: JsonSchema): string => {
    if (Array.isArray(s.enum)) return (s.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
    if (s.type === 'array') return `${typeOf((s.items as JsonSchema) ?? {})}[]`;
    if (Array.isArray(s.anyOf)) return (s.anyOf as JsonSchema[]).map(typeOf).join(' | ');
    return String(s.type ?? 'any');
  };
  const section = (op: AnyOperation) => {
    const schema = inputJsonSchema(op);
    const req = new Set(schema.required ?? []);
    const rows = Object.entries(schema.properties ?? {})
      .map(
        ([k, s]) =>
          `<tr><td><code>${esc(k)}</code>${req.has(k) && !('default' in s) ? ' <b>*</b>' : ''}</td><td><code>${esc(typeOf(s))}</code></td><td>${esc(String(s.description ?? ''))}${'default' in s ? ` <i>(default ${esc(JSON.stringify(s.default))})</i>` : ''}</td></tr>`,
      )
      .join('');
    return `<section id="${esc(op.name)}"><h3><span class="m m-${op.http.method}">${op.http.method}</span> <code>${esc(API_PREFIX + op.http.path)}</code></h3>
<p><strong>${esc(op.summary)}</strong>${op.description ? `<br>${esc(op.description)}` : ''}</p>
<p class="meta">operation <code>${esc(op.name)}</code> · permission <code>${esc(op.permission ?? 'authenticated')}</code>${op.mcp === false ? ' · not exposed over MCP' : ` · MCP tool <code>${esc(toolName(op.name))}</code>`}</p>
${rows ? `<table><thead><tr><th>Field</th><th>Type</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="meta">No input.</p>'}</section>`;
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Streamline API reference</title>
<style>
:root{color-scheme:light dark;--fg:#111827;--bg:#fff;--muted:#6b7280;--line:#e5e7eb;--code:#f3f4f6}
@media (prefers-color-scheme:dark){:root{--fg:#e5e7eb;--bg:#0b1020;--muted:#9ca3af;--line:#1f2937;--code:#111827}}
body{font:15px/1.5 system-ui,sans-serif;margin:0;color:var(--fg);background:var(--bg)}
nav{position:fixed;top:0;bottom:0;width:260px;overflow:auto;border-right:1px solid var(--line);padding:16px;box-sizing:border-box;font-size:13px}
nav a{display:block;color:inherit;text-decoration:none;padding:2px 0}nav h4{margin:14px 0 4px}
main{margin-left:260px;padding:24px 40px;max-width:1000px}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px;text-align:left;vertical-align:top}
.m{font:600 12px monospace;padding:2px 6px;border-radius:4px;color:#fff}.m-GET{background:#2563eb}.m-POST{background:#16a34a}.m-PATCH{background:#d97706}.m-PUT{background:#7c3aed}.m-DELETE{background:#dc2626}
.meta{color:var(--muted);font-size:13px}section{border-top:1px solid var(--line);padding-top:8px;margin-top:24px}
@media (max-width:800px){nav{display:none}main{margin:0;padding:16px}}
</style></head><body>
<nav><strong>Streamline API v${esc(version)}</strong><p><a href="${API_PREFIX}/openapi.json">openapi.json</a></p>${[...groups.entries()]
    .map(([g, list]) => `<h4>${esc(g)}</h4>${list.map((op) => `<a href="#${esc(op.name)}">${esc(op.summary)}</a>`).join('')}`)
    .join('')}</nav>
<main><h1>Streamline API reference</h1>
<p>Base path <code>${API_PREFIX}</code>. Authenticate with <code>Authorization: Bearer slt_…</code>. Inputs for GET and DELETE are query parameters; other methods take a JSON body. Path parameters are shown as <code>:name</code>. Errors use <code>{"error":{"code","message","details","requestId"}}</code>.</p>
<p>The MCP endpoint is <code>/mcp</code> (Streamable HTTP, same bearer token). Each operation below is also an MCP tool.</p>
${[...groups.entries()].map(([g, list]) => `<h2>${esc(g)}</h2>${list.map(section).join('')}`).join('')}
</main></body></html>`;
}
