/**
 * The UI is just another API client. It calls operations by name; the route
 * for each operation comes from the server's own catalogue (`meta.operations`),
 * so the UI, REST API and MCP tools can never drift apart.
 */

export interface OperationInfo {
  name: string;
  group: string;
  summary: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  mcpTool: string | null;
  permission: string | null;
  kind: 'read' | 'write' | 'delete';
  allowed: boolean;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }

  /** Flattens zod field errors into a readable sentence. */
  get friendly(): string {
    const d = this.details as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | undefined;
    const fields = d?.fieldErrors ? Object.entries(d.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`) : [];
    return [this.message, ...(d?.formErrors ?? []), ...fields].join(' — ');
  }
}

let csrfToken: string | null = null;
let manifest: Map<string, OperationInfo> | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request(method: string, url: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    throw new ApiError(res.status, payload.error?.code ?? 'error', payload.error?.message ?? res.statusText, payload.error?.details);
  }
  return res;
}

export async function rawJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await request(method, url, body);
  return (await res.json()) as T;
}

export async function loadManifest(): Promise<Map<string, OperationInfo>> {
  const ops = await rawJson<OperationInfo[]>('GET', '/api/v1/meta/operations');
  manifest = new Map(ops.map((o) => [o.name, o]));
  return manifest;
}

export function getManifest() {
  return manifest;
}

function buildRequest(op: string, input: Record<string, unknown> = {}) {
  const info = manifest?.get(op);
  if (!info) throw new Error(`Unknown operation ${op}`);
  const rest = { ...input };
  const path = info.path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const v = rest[name];
    delete rest[name];
    return encodeURIComponent(String(v ?? ''));
  });
  if (info.method === 'GET' || info.method === 'DELETE') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => qs.append(k, String(x)));
      else qs.set(k, String(v));
    }
    const q = qs.toString();
    return { method: info.method, url: q ? `${path}?${q}` : path, body: undefined };
  }
  return { method: info.method, url: path, body: rest };
}

export async function call<T = any>(op: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = buildRequest(op, input);
  const res = await request(r.method, r.url, r.body);
  return (await res.json()) as T;
}

/** Calls a file-producing operation and saves the result. */
export async function download(op: string, input: Record<string, unknown> = {}) {
  const r = buildRequest(op, input);
  const res = await request(r.method, r.url, r.body);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'download';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function fetchText(op: string, input: Record<string, unknown> = {}): Promise<string> {
  const r = buildRequest(op, input);
  const res = await request(r.method, r.url, r.body);
  return res.text();
}

export function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}
