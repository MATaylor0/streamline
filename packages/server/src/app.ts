import pino, { type Logger } from 'pino';
import type { Config } from './config.js';
import { createDatabase, migrateToLatest, type DatabaseHandle } from './db/index.js';
import { Executor } from './core/executor.js';
import { SYSTEM_ACTOR, type Services } from './core/operation.js';
import { allOperations } from './ops/index.js';
import { createWebhookDispatcher } from './webhooks.js';
import { hashPassword, checkPasswordPolicy } from './auth/passwords.js';
import { newId, nowIso } from './lib/util.js';
import { seedDemoData } from './seed/demo.js';

export interface App {
  config: Config;
  log: Logger;
  database: DatabaseHandle;
  services: Services;
  executor: Executor;
  close(): Promise<void>;
}

export function createLogger(config: Config, opts: { stderr?: boolean } = {}): Logger {
  const options = {
    level: config.LOG_LEVEL,
    redact: { paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'], censor: '[redacted]' },
    base: { service: 'streamline' },
  };
  return opts.stderr ? pino(options, pino.destination(2)) : pino(options);
}

/**
 * Builds the transport-independent core: database, migrations, executor and
 * event dispatch. The HTTP server, MCP stdio server and CLI all start here.
 */
export async function createApp(config: Config, opts: { log?: Logger; migrate?: boolean; bootstrap?: boolean } = {}): Promise<App> {
  const log = opts.log ?? createLogger(config);
  const database = await createDatabase({
    url: config.DATABASE_URL,
    ssl: config.DATABASE_SSL,
    sslCa: config.DATABASE_SSL_CA,
    poolMax: config.DATABASE_POOL_MAX,
  });

  if (opts.migrate ?? config.MIGRATE_ON_START) {
    const applied = await migrateToLatest(database.db);
    if (applied.length) log.info({ applied }, 'database migrations applied');
  }

  const services: Services = { db: database.db, dialect: database.dialect, config };
  const dispatcher = createWebhookDispatcher(services, log);
  services.onEvent = dispatcher;
  const executor = new Executor(services, allOperations);

  if (opts.bootstrap ?? true) await bootstrap(executor, config, log);

  return {
    config,
    log,
    database,
    services,
    executor,
    close: async () => {
      await dispatcher.flush();
      await database.close();
    },
  };
}

/** First-run setup: create the initial administrator and optional demo content. */
async function bootstrap(executor: Executor, config: Config, log: Logger) {
  const db = executor.services.db;
  const count = Number((await db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
  if (count === 0 && config.BOOTSTRAP_ADMIN_EMAIL) {
    const password = config.BOOTSTRAP_ADMIN_PASSWORD;
    if (!password && !config.oidcEnabled) {
      log.warn('BOOTSTRAP_ADMIN_EMAIL set without BOOTSTRAP_ADMIN_PASSWORD and SSO is disabled; skipping admin creation');
    } else {
      if (password) {
        const problem = checkPasswordPolicy(password, config.PASSWORD_MIN_LENGTH);
        if (problem) throw new Error(`BOOTSTRAP_ADMIN_PASSWORD: ${problem}`);
      }
      const now = nowIso();
      await db
        .insertInto('users')
        .values({
          id: newId(),
          email: config.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
          name: config.BOOTSTRAP_ADMIN_NAME,
          password_hash: password ? await hashPassword(password) : null,
          role: 'admin',
          kind: 'human',
          status: 'active',
          auth_provider: password ? 'local' : 'oidc',
          external_id: null,
          locked_until: null,
          last_login_at: null,
          created_at: now,
          updated_at: now,
        })
        .execute();
      log.info({ email: config.BOOTSTRAP_ADMIN_EMAIL }, 'bootstrap administrator created');
    }
  } else if (count === 0) {
    log.warn('No users exist. Set BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD or run `streamline create-admin`.');
  }

  if (config.SEED_DEMO_DATA) {
    const processes = Number((await db.selectFrom('processes').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    if (processes === 0) {
      await seedDemoData(executor, SYSTEM_ACTOR);
      log.info('demo data seeded');
    }
  }
}
