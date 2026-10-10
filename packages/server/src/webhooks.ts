import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { DomainEvent, Services } from './core/operation.js';
import { ValidationError } from './core/errors.js';
import { nowIso, parseJson } from './lib/util.js';
import type { Logger } from 'pino';

export const WEBHOOK_EVENTS_HELP =
  'Operation names to subscribe to, e.g. ["process.publish"], wildcards like ["process.*"], or ["*"] for every change.';

interface WebhookRow {
  id: string;
  url: string;
  secret: string;
  events: string;
  active: number;
  failure_count: number;
}

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Guards against SSRF: webhooks may not target internal addresses unless explicitly allowed. */
export async function assertSafeWebhookUrl(url: string, allowPrivate: boolean): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ValidationError('Webhook URL must be http(s)');
  if (allowPrivate) return;
  if (u.protocol !== 'https:') throw new ValidationError('Webhook URL must use https');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) throw new ValidationError('Webhook URL must be publicly routable');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new ValidationError(`Cannot resolve webhook host ${host}`);
  if (addresses.some(isPrivateAddress)) throw new ValidationError('Webhook URL resolves to a private network address');
}

export function matchesEvent(patterns: string[], event: string): boolean {
  return patterns.some((p) => p === '*' || p === event || (p.endsWith('.*') && event.startsWith(p.slice(0, -1))));
}

export function sign(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

async function post(services: Services, hook: WebhookRow, payload: unknown): Promise<{ ok: boolean; status: string }> {
  try {
    await assertSafeWebhookUrl(hook.url, services.config.WEBHOOK_ALLOW_PRIVATE_NETWORKS);
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const res = await fetch(hook.url, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Streamline-Webhooks/1',
        'x-streamline-timestamp': timestamp,
        'x-streamline-signature': sign(hook.secret, timestamp, body),
      },
      body,
    });
    return { ok: res.ok, status: String(res.status) };
  } catch (err) {
    return { ok: false, status: `error: ${(err as Error).message}`.slice(0, 200) };
  }
}

const MAX_FAILURES = 20;

async function record(services: Services, hook: WebhookRow, result: { ok: boolean; status: string }) {
  const failures = result.ok ? 0 : hook.failure_count + 1;
  await services.db
    .updateTable('webhooks')
    .set({
      last_status: result.status,
      last_delivery_at: nowIso(),
      failure_count: failures,
      // Auto-disable endpoints that keep failing.
      ...(failures >= MAX_FAILURES ? { active: 0 } : {}),
    })
    .where('id', '=', hook.id)
    .execute();
}

/** Fire-and-forget delivery with three attempts and exponential backoff. */
export function createWebhookDispatcher(services: Services, log: Logger) {
  return (event: DomainEvent) => {
    void (async () => {
      const hooks = await services.db.selectFrom('webhooks').selectAll().where('active', '=', 1).execute();
      for (const hook of hooks) {
        if (!matchesEvent(parseJson<string[]>(hook.events, []), event.event)) continue;
        let result = { ok: false, status: '' };
        for (let attempt = 0; attempt < 3 && !result.ok; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 1000 * 4 ** attempt));
          result = await post(services, hook, event);
        }
        if (!result.ok) log.warn({ webhook: hook.id, event: event.event, status: result.status }, 'webhook delivery failed');
        await record(services, hook, result);
      }
    })().catch((err) => log.error({ err }, 'webhook dispatch error'));
  };
}

export async function deliverTest(services: Services, hook: WebhookRow) {
  const result = await post(services, hook, { event: 'ping', at: nowIso(), data: { message: 'Streamline webhook test' } });
  await record(services, hook, result);
  return result;
}
