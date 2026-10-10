#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.js';
import { createApp, createLogger, type App } from './app.js';
import { buildServer } from './http/server.js';
import { migrateToLatest } from './db/index.js';
import { SYSTEM_ACTOR, type Actor } from './core/operation.js';
import { AppError } from './core/errors.js';
import { resolveApiToken } from './auth/identity.js';
import { buildMcpServer } from './mcp/server.js';
import { seedDemoData } from './seed/demo.js';
import { toolName } from './ops/index.js';
import { VERSION } from './version.js';

const HELP = `Streamline ${VERSION} — enterprise process mapping

Usage: streamline <command> [options]

Commands:
  serve                     Start the web UI, REST API and MCP endpoint (default)
  migrate                   Apply database migrations and exit
  create-admin              Create an administrator account
                              --email <email> --name <name> [--password <pw>]
  create-service-account    Create a service account (e.g. for an AI agent) and print an API token
                              --name <name> --email <email> [--role editor] [--scope write|read]
  seed-demo                 Load demonstration data (only into an empty repository)
  ops                       List every operation (the same catalogue as the API and MCP tools)
  op <name>                 Run an operation directly against the database (the "system path")
                              --input '<json>'   operation input (or pipe JSON on stdin)
                              --token <slt_…>    act as the token's user (default: system, all permissions)
  mcp                       Run an MCP server over stdio, acting as STREAMLINE_TOKEN's user
  help                      Show this help

All configuration comes from environment variables (see .env.example).`;

async function withApp<T>(fn: (app: App) => Promise<T>, opts: { quiet?: boolean } = {}): Promise<T> {
  const config = loadConfig();
  const log = createLogger({ ...config, LOG_LEVEL: opts.quiet ? 'error' : config.LOG_LEVEL }, { stderr: true });
  const app = await createApp(config, { log });
  try {
    return await fn(app);
  } finally {
    await app.close();
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  const [command = 'serve', ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      name: { type: 'string' },
      password: { type: 'string' },
      role: { type: 'string' },
      scope: { type: 'string' },
      input: { type: 'string' },
      token: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  switch (command) {
    case 'serve': {
      const config = loadConfig();
      const app = await createApp(config);
      const server = await buildServer(app);
      const shutdown = async (signal: string) => {
        app.log.info({ signal }, 'shutting down');
        await server.close();
        await app.close();
        process.exit(0);
      };
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      process.on('SIGINT', () => void shutdown('SIGINT'));
      await server.listen({ host: config.HOST, port: config.PORT });
      return;
    }

    case 'migrate': {
      const config = loadConfig();
      const app = await createApp({ ...config, MIGRATE_ON_START: false }, { migrate: false, bootstrap: false });
      const applied = await migrateToLatest(app.database.db);
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
      await app.close();
      return;
    }

    case 'create-admin': {
      const email = values.email ?? (await prompt('Email: '));
      const name = values.name ?? (await prompt('Name: '));
      const password = values.password ?? (await prompt('Password (leave blank to generate): '));
      await withApp(async (app) => {
        const user = await app.executor.execute<{ email: string; initialPassword?: string }>(
          'user.create',
          { email, name, role: 'admin', kind: 'human', password: password || undefined },
          SYSTEM_ACTOR,
          { channel: 'cli' },
        );
        console.log(`Administrator ${user.email} created.`);
        if (user.initialPassword) console.log(`Generated password: ${user.initialPassword}`);
      }, { quiet: true });
      return;
    }

    case 'create-service-account': {
      if (!values.name || !values.email) throw new Error('--name and --email are required');
      await withApp(async (app) => {
        const meta = { channel: 'cli' as const };
        const user = await app.executor.execute<{ id: string }>(
          'user.create',
          { email: values.email, name: values.name, role: values.role ?? 'editor', kind: 'service' },
          SYSTEM_ACTOR,
          meta,
        );
        const token = await app.executor.execute<{ token: string }>(
          'token.create',
          { name: `${values.name} token`, scope: values.scope ?? 'write', userId: user.id },
          SYSTEM_ACTOR,
          meta,
        );
        console.log(`Service account created. API / MCP token (shown once):\n${token.token}`);
      }, { quiet: true });
      return;
    }

    case 'seed-demo': {
      await withApp(async (app) => {
        await seedDemoData(app.executor, SYSTEM_ACTOR);
        console.log('Demo data loaded.');
      }, { quiet: true });
      return;
    }

    case 'ops': {
      await withApp(async (app) => {
        const ops = app.executor.list();
        if (values.json) {
          console.log(JSON.stringify(ops.map((o) => ({ name: o.name, method: o.http.method, path: `/api/v1${o.http.path}`, permission: o.permission, mcpTool: o.mcp === false ? null : toolName(o.name), summary: o.summary })), null, 2));
          return;
        }
        let group = '';
        for (const o of ops.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))) {
          if (o.group !== group) console.log(`\n${(group = o.group)}`);
          console.log(`  ${o.name.padEnd(30)} ${o.http.method.padEnd(6)} /api/v1${o.http.path.padEnd(40)} ${o.summary}`);
        }
      }, { quiet: true });
      return;
    }

    case 'op': {
      const name = positionals[0];
      if (!name) throw new Error('Usage: streamline op <operation> --input <json>');
      const raw = values.input ?? (await readStdin());
      const input = raw.trim() ? JSON.parse(raw) : {};
      await withApp(async (app) => {
        let actor: Actor = SYSTEM_ACTOR;
        if (values.token) {
          const resolved = await resolveApiToken(app.database.db, values.token);
          if (!resolved) throw new Error('Invalid token');
          actor = resolved;
        }
        const result = await app.executor.execute<unknown>(name, input, actor, { channel: 'cli' });
        const op = app.executor.get(name)!;
        console.log(op.file ? (result as { content: string }).content : JSON.stringify(result, null, 2));
      }, { quiet: true });
      return;
    }

    case 'mcp': {
      const token = values.token ?? process.env.STREAMLINE_TOKEN;
      if (!token) throw new Error('Set STREAMLINE_TOKEN (an API token) to run the stdio MCP server');
      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      const config = loadConfig();
      // stdout is the protocol channel: logs must go to stderr.
      const log = createLogger({ ...config, LOG_LEVEL: 'warn' }, { stderr: true });
      const app = await createApp(config, { log });
      const actor = await resolveApiToken(app.database.db, token);
      if (!actor) throw new Error('Invalid, expired or revoked token');
      const server = buildMcpServer(app.executor, actor, {});
      await server.connect(new StdioServerTransport());
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    case 'version':
    case '--version':
      console.log(VERSION);
      return;

    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  if (err instanceof AppError) {
    console.error(`${err.code}: ${err.message}${err.details ? `\n${JSON.stringify(err.details, null, 2)}` : ''}`);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
