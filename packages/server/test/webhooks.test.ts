import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { createTestApp, type TestContext } from './helpers.js';
import { assertSafeWebhookUrl, matchesEvent } from '../src/webhooks.js';
import { parseRoleMapping } from '../src/config.js';

let t: TestContext;
let receiver: Server;
let url: string;
const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

beforeAll(async () => {
  t = await createTestApp({ WEBHOOK_ALLOW_PRIVATE_NETWORKS: 'true' });
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});
afterAll(async () => {
  await t.close();
  receiver.close();
});

describe('webhooks', () => {
  it('delivers signed events for matching operations only', async () => {
    const hook = await t.run('webhook.create', { name: 'test', url, events: ['process.*'] });
    expect(hook.secret).toMatch(/^whsec_/);
    await t.run('team.create', { name: 'Not delivered' });
    const p = await t.run('process.create', { name: 'Hooked' });
    await (t.app.services.onEvent as unknown as { flush: () => Promise<void> }).flush();

    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ event: 'process.create', target: { type: 'process', id: p.id }, actor: { channel: 'cli' } });
    const expected = `sha256=${createHmac('sha256', hook.secret).update(`${headers['x-streamline-timestamp']}.${body}`).digest('hex')}`;
    expect(headers['x-streamline-signature']).toBe(expected);

    const [listed] = await t.run('webhook.list', {});
    expect(listed.lastStatus).toBe('204');
    expect(listed).not.toHaveProperty('secret');
  });

  it('matches wildcard patterns', () => {
    expect(matchesEvent(['*'], 'x.y')).toBe(true);
    expect(matchesEvent(['process.*'], 'process.publish')).toBe(true);
    expect(matchesEvent(['process.*'], 'team.create')).toBe(false);
    expect(matchesEvent(['process.publish'], 'process.publish')).toBe(true);
  });

  it('blocks private and non-https targets by default (SSRF protection)', async () => {
    await expect(assertSafeWebhookUrl('http://example.com/x', false)).rejects.toThrow(/https/);
    await expect(assertSafeWebhookUrl('https://127.0.0.1/x', false)).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://10.1.2.3/x', false)).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://[::1]/x', false)).rejects.toThrow(/private/);
    await expect(assertSafeWebhookUrl('https://localhost/x', false)).rejects.toThrow(/publicly/);
  });
});

describe('config', () => {
  it('parses SSO group-to-role mappings', () => {
    expect(parseRoleMapping('admin=Admins; editor=Analysts,Owners')).toEqual([
      { role: 'admin', groups: ['Admins'] },
      { role: 'editor', groups: ['Analysts', 'Owners'] },
    ]);
  });
});
