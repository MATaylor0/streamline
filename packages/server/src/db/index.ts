import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { Database } from './schema.js';
import * as m001 from './migrations/001_initial.js';
import * as m002 from './migrations/002_ai_agents.js';

export type Dialect = 'postgres' | 'sqlite';

export interface DatabaseHandle {
  db: Kysely<Database>;
  dialect: Dialect;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  url: string;
  ssl?: 'disable' | 'require' | 'verify-full';
  sslCa?: string;
  poolMax?: number;
}

/** Migrations are bundled in code (not discovered on disk) so builds stay self-contained. */
const migrations: Record<string, Migration> = {
  '001_initial': m001,
  '002_ai_agents': m002,
};

class StaticMigrationProvider implements MigrationProvider {
  async getMigrations() {
    return migrations;
  }
}

export async function createDatabase(opts: DatabaseOptions): Promise<DatabaseHandle> {
  const url = opts.url;
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pg = await import('pg');
    // Return BIGINT/NUMERIC aggregates (e.g. COUNT) as JS numbers.
    pg.default.types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));
    pg.default.types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
    let ssl: false | { rejectUnauthorized: boolean; ca?: string } = false;
    if (opts.ssl === 'require') ssl = { rejectUnauthorized: false };
    if (opts.ssl === 'verify-full') {
      ssl = { rejectUnauthorized: true, ca: opts.sslCa ? readFileSync(opts.sslCa, 'utf8') : undefined };
    }
    const pool = new pg.default.Pool({ connectionString: url, max: opts.poolMax ?? 10, ssl });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { db, dialect: 'postgres', close: () => db.destroy() };
  }

  if (url.startsWith('sqlite:')) {
    const BetterSqlite = (await import('better-sqlite3')).default;
    const file = url.slice('sqlite:'.length) || ':memory:';
    if (file !== ':memory:') mkdirSync(dirname(resolve(file)), { recursive: true });
    const sqlite = new BetterSqlite(file);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    return { db, dialect: 'sqlite', close: () => db.destroy() };
  }

  throw new Error('DATABASE_URL must start with postgres://, postgresql:// or sqlite:');
}

export async function migrateToLatest(db: Kysely<Database>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
