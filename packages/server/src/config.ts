import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Twelve-factor configuration. Every setting comes from the environment so the
 * same image runs unchanged on a laptop, Docker Compose, Kubernetes, ECS,
 * Azure Container Apps or Cloud Run.
 *
 * Any variable may instead be supplied as `<NAME>_FILE`, pointing at a file
 * that holds the value (Docker / Kubernetes secrets convention).
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const list = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(8080),
  PUBLIC_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool(false),

  /** `postgres://user:pass@host:5432/db` or `sqlite:/path/to/file.db` (or `sqlite::memory:`). */
  DATABASE_URL: z.string().default('sqlite:./data/streamline.db'),
  DATABASE_SSL: z.enum(['disable', 'require', 'verify-full']).default('disable'),
  DATABASE_SSL_CA: z.string().optional(),
  DATABASE_POOL_MAX: int(10),
  MIGRATE_ON_START: bool(true),

  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: int(12),
  SESSION_IDLE_MINUTES: int(120),
  CORS_ORIGINS: list(),

  LOCAL_AUTH_ENABLED: bool(true),
  PASSWORD_MIN_LENGTH: int(12),
  LOGIN_MAX_FAILURES: int(5),
  LOGIN_LOCKOUT_MINUTES: int(15),

  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  BOOTSTRAP_ADMIN_NAME: z.string().default('Administrator'),
  SEED_DEMO_DATA: bool(false),

  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPES: z.string().default('openid email profile'),
  OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
  /** Claim that carries group / role membership, e.g. `groups` or `roles`. */
  OIDC_ROLE_CLAIM: z.string().default('groups'),
  /** `admin=Streamline-Admins;editor=Process-Owners,Analysts;approver=Risk` */
  OIDC_ROLE_MAPPING: z.string().default(''),
  OIDC_DEFAULT_ROLE: z.enum(['viewer', 'editor', 'approver', 'admin']).default('viewer'),
  OIDC_AUTO_PROVISION: bool(true),

  MCP_ENABLED: bool(true),
  API_DOCS_ENABLED: bool(true),
  RATE_LIMIT_MAX: int(600),
  RATE_LIMIT_LOGIN_MAX: int(10),
  BODY_LIMIT_BYTES: int(5 * 1024 * 1024),
  AUDIT_READS: bool(false),
  WEBHOOK_ALLOW_PRIVATE_NETWORKS: bool(false),
  WEB_DIST_DIR: z.string().optional(),
});

export type RawConfig = z.infer<typeof schema>;

export interface Config extends RawConfig {
  sessionSecret: string;
  isProduction: boolean;
  oidcEnabled: boolean;
  oidcRoleMapping: Array<{ role: string; groups: string[] }>;
}

function resolveFileVars(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  // Only Streamline's own settings honour the *_FILE convention.
  for (const base of Object.keys(schema.shape)) {
    const file = env[`${base}_FILE`];
    if (file && out[base] === undefined) out[base] = readFileSync(file, 'utf8').trim();
  }
  return out;
}

export function parseRoleMapping(input: string): Array<{ role: string; groups: string[] }> {
  return input
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [role, groups = ''] = part.split('=');
      return {
        role: role.trim(),
        groups: groups
          .split(',')
          .map((g) => g.trim())
          .filter(Boolean),
      };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(resolveFileVars(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';

  let sessionSecret = raw.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProduction) throw new Error('SESSION_SECRET (or SESSION_SECRET_FILE) must be set in production.');
    sessionSecret = randomBytes(32).toString('hex');
  }
  if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');

  const oidcEnabled = Boolean(raw.OIDC_ISSUER && raw.OIDC_CLIENT_ID);
  if (oidcEnabled && !raw.PUBLIC_URL) throw new Error('PUBLIC_URL is required when OIDC is enabled.');
  if (!raw.LOCAL_AUTH_ENABLED && !oidcEnabled) {
    throw new Error('At least one sign-in method must be enabled (LOCAL_AUTH_ENABLED or OIDC_*).');
  }

  return {
    ...raw,
    sessionSecret,
    isProduction,
    oidcEnabled,
    oidcRoleMapping: parseRoleMapping(raw.OIDC_ROLE_MAPPING),
  };
}
