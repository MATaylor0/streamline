import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ADMIN_EMAIL, createTestApp, type TestContext } from './helpers.js';
import { toolName } from '../src/ops/index.js';

let t: TestContext;
let baseUrl: string;

beforeAll(async () => {
  t = await createTestApp();
  await t.server.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `http://127.0.0.1:${(t.server.server.address() as AddressInfo).port}`;
});
afterAll(async () => t.close());

async function mcpClient(token: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

const parse = (res: any) => JSON.parse(res.content[0].text);

describe('REST API', () => {
  it('exposes every operation as a route and documents it in OpenAPI', async () => {
    const res = await t.server.inject({ method: 'GET', url: '/api/v1/openapi.json' });
    const spec = res.json();
    const count = Object.values(spec.paths as Record<string, object>).reduce((n, p) => n + Object.keys(p).length, 0);
    expect(count).toBe(t.app.executor.list().length);
    expect(spec.paths['/api/v1/processes/{id}'].get.operationId).toBe('processGet');
    const docs = await t.server.inject({ method: 'GET', url: '/api/docs' });
    expect(docs.headers['content-type']).toContain('text/html');
  });

  it('requires authentication and reports errors consistently', async () => {
    const res = await t.server.inject({ method: 'GET', url: '/api/v1/processes' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: 'unauthorized', requestId: expect.any(String) });
    const bad = await t.server.inject({ method: 'GET', url: '/api/v1/processes', headers: { authorization: 'Bearer slt_nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('works with bearer tokens: CRUD, validation, 404, file downloads', async () => {
    const editor = await t.user('editor');
    const api = t.api(editor.token);
    const created = await api('POST', '/processes', { name: 'REST process', summary: 'via REST' });
    expect(created.status).toBe(201);
    const got = await api('GET', `/processes/${created.body.ref}`);
    expect(got.body.name).toBe('REST process');
    expect((await api('PATCH', `/processes/${created.body.id}`, { name: '' })).status).toBe(400);
    expect((await api('GET', '/processes/does-not-exist')).status).toBe(404);
    const list = await api('GET', '/processes?q=rest&status=draft&limit=5');
    expect(list.body.items.map((p: any) => p.name)).toContain('REST process');
    const file = await api('GET', `/processes/${created.body.id}/export?format=bpmn`);
    expect(file.headers['content-disposition']).toMatch(/attachment; filename=".*\.bpmn"/);
    expect(file.body).toContain('bpmn:definitions');
    expect((await api('DELETE', `/processes/${created.body.id}`)).status).toBe(403); // editors cannot hard-delete
  });

  it('uses cookie sessions with CSRF protection for the browser', async () => {
    const { cookie, csrf } = await t.login();
    const session = await t.server.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, user: { email: ADMIN_EMAIL, role: 'admin' } });
    const noCsrf = await t.server.inject({ method: 'POST', url: '/api/v1/teams', headers: { cookie }, payload: { name: 'X' } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_failed');
    const ok = await t.server.inject({ method: 'POST', url: '/api/v1/teams', headers: { cookie, 'x-csrf-token': csrf }, payload: { name: 'Cookie team' } });
    expect(ok.statusCode).toBe(201);
    const audit = await t.run('audit.list', { operation: 'team.create' });
    expect(audit.items[0].channel).toBe('ui');
    const out = await t.server.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.statusCode).toBe(200);
    const after = await t.server.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie } });
    expect(after.json().authenticated).toBe(false);
  });

  it('locks accounts after repeated failed sign-ins', async () => {
    const u = await t.user('viewer');
    for (let i = 0; i < 5; i++) {
      const r = await t.server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: 'wrong-password' } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await t.server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: u.email, password: u.password } });
    expect(locked.statusCode).toBe(423);
    await t.run('user.update', { id: u.id, unlock: true });
    await t.login(u.email, u.password);
  });

  it('stops honouring tokens of disabled users', async () => {
    const u = await t.user('editor');
    expect((await t.api(u.token)('GET', '/me')).status).toBe(200);
    await t.run('user.update', { id: u.id, status: 'disabled' });
    expect((await t.api(u.token)('GET', '/me')).status).toBe(401);
  });

  it('serves health and readiness probes', async () => {
    expect((await t.server.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    expect((await t.server.inject({ method: 'GET', url: '/readyz' })).json()).toMatchObject({ status: 'ready' });
  });
});

describe('MCP server', () => {
  it('rejects unauthenticated clients', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('lists only the tools the caller may use', async () => {
    const viewer = await t.user('viewer');
    const admin = await t.user('admin');
    const vc = await mcpClient(viewer.token);
    const ac = await mcpClient(admin.token);
    const vt = (await vc.listTools()).tools.map((x) => x.name);
    const at = (await ac.listTools()).tools.map((x) => x.name);
    expect(vt).toContain('process_list');
    expect(vt).not.toContain('process_create');
    expect(at).toContain('process_create');
    expect(at).toContain('user_create');
    expect(at).not.toContain('token_create'); // credentials stay out of AI channels
    // Every non-excluded operation is a tool for an admin.
    const expected = t.app.executor.list().filter((o) => o.mcp !== false).map((o) => toolName(o.name));
    expect(at.sort()).toEqual(expected.sort());
    const tool = (await ac.listTools()).tools.find((x) => x.name === 'process_delete')!;
    expect(tool.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    await vc.close();
    await ac.close();
  });

  it('lets an AI agent build, query and govern a process end-to-end', async () => {
    const agent = await t.user('editor', { kind: 'service' });
    const c = await mcpClient(agent.token);
    const team = parse(await c.callTool({ name: 'team_create', arguments: { name: 'AI Ops' } }));
    const created = parse(
      await c.callTool({
        name: 'process_create',
        arguments: {
          name: 'Incident triage',
          ownerTeamId: team.id,
          nodes: [
            { id: 'n1', type: 'start', label: 'Alert fires' },
            { id: 'n2', type: 'task', label: 'Triage incident', teamId: team.id },
            { id: 'n3', type: 'end', label: 'Resolved' },
          ],
          edges: [
            { source: 'n1', target: 'n2' },
            { source: 'n2', target: 'n3' },
          ],
        },
      }),
    );
    expect(created.nodes).toHaveLength(3);
    const search = parse(await c.callTool({ name: 'search_query', arguments: { q: 'triage' } }));
    expect(search.items[0].title).toBe('Incident triage');
    const submitted = parse(await c.callTool({ name: 'process_submitForReview', arguments: { id: created.id } }));
    expect(submitted.status).toBe('in_review');

    // Permission errors come back as tool errors, not protocol failures.
    const denied = await c.callTool({ name: 'process_publish', arguments: { id: created.id } });
    expect(denied.isError).toBe(true);

    const invalid = await c.callTool({ name: 'process_create', arguments: { name: '' } });
    expect(invalid.isError).toBe(true);
    expect((invalid.content as any)[0].text).toContain('validation_error');

    // Resources and prompts.
    const resources = await c.listResources();
    expect(resources.resources.some((r) => r.name.includes('Incident triage'))).toBe(true);
    const read = await c.readResource({ uri: `streamline://process/${created.ref}` });
    expect((read.contents[0] as any).text).toContain('# ');
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toContain('map_process');

    const audit = await t.run('audit.list', { actorId: agent.id, operation: 'process.create' });
    expect(audit.items[0].channel).toBe('mcp');
    await c.close();
  });
});

describe('transport parity', () => {
  it('produces identical results and rules through executor, REST and MCP', async () => {
    const editor = await t.user('editor');
    const input = { name: 'Parity', summary: 'same everywhere' };
    const direct = await t.run('process.create', input, editor.actor, 'cli');
    const rest = (await t.api(editor.token)('POST', '/processes', input)).body;
    const c = await mcpClient(editor.token);
    const mcp = parse(await c.callTool({ name: 'process_create', arguments: input }));
    await c.close();
    const shape = (p: any) => ({ name: p.name, summary: p.summary, status: p.status, nodes: p.nodes.map((n: any) => n.type) });
    expect(shape(rest)).toEqual(shape(direct));
    expect(shape(mcp)).toEqual(shape(direct));
    const audit = await t.run('audit.list', { actorId: editor.id, operation: 'process.create' });
    expect(audit.items.map((a: any) => a.channel).sort()).toEqual(['api', 'cli', 'mcp']);
  });
});
