import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Database, UserRow } from '../db/schema.js';
import { ForbiddenError } from '../core/errors.js';
import { ROLES, isRole, type Role } from '../core/permissions.js';
import { newId, nowIso } from '../lib/util.js';

type OidcClient = typeof import('openid-client');
type OidcConfiguration = Awaited<ReturnType<OidcClient['discovery']>>;

/**
 * OpenID Connect single sign-on (Entra ID / Azure AD, Okta, Auth0, Google
 * Workspace, Keycloak, Ping…). Authorization code flow with PKCE, state and nonce.
 */
export class OidcProvider {
  private configuration?: Promise<OidcConfiguration>;
  private client?: OidcClient;

  constructor(private readonly config: Config) {}

  get redirectUri(): string {
    return new URL('/api/v1/auth/oidc/callback', this.config.PUBLIC_URL).toString();
  }

  private async lib(): Promise<OidcClient> {
    this.client ??= await import('openid-client');
    return this.client;
  }

  private async discover(): Promise<OidcConfiguration> {
    const lib = await this.lib();
    this.configuration ??= lib
      .discovery(new URL(this.config.OIDC_ISSUER!), this.config.OIDC_CLIENT_ID!, this.config.OIDC_CLIENT_SECRET)
      .catch((err) => {
        this.configuration = undefined;
        throw err;
      });
    return this.configuration;
  }

  async start(): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
    const lib = await this.lib();
    const cfg = await this.discover();
    const verifier = lib.randomPKCECodeVerifier();
    const state = lib.randomState();
    const nonce = lib.randomNonce();
    const url = lib.buildAuthorizationUrl(cfg, {
      redirect_uri: this.redirectUri,
      scope: this.config.OIDC_SCOPES,
      code_challenge: await lib.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    });
    return { url: url.toString(), state, nonce, verifier };
  }

  async callback(currentUrl: URL, expected: { state: string; nonce: string; verifier: string }) {
    const lib = await this.lib();
    const cfg = await this.discover();
    const tokens = await lib.authorizationCodeGrant(cfg, currentUrl, {
      pkceCodeVerifier: expected.verifier,
      expectedState: expected.state,
      expectedNonce: expected.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new ForbiddenError('Identity provider did not return an ID token');
    let profile: Record<string, unknown> = { ...claims };
    if (!profile.email && tokens.access_token) {
      try {
        profile = { ...profile, ...(await lib.fetchUserInfo(cfg, tokens.access_token, claims.sub)) };
      } catch {
        /* userinfo is optional */
      }
    }
    return profile;
  }

  /** Map IdP groups/roles to a Streamline role. The highest matching role wins. */
  roleFromClaims(profile: Record<string, unknown>): Role | null {
    const raw = profile[this.config.OIDC_ROLE_CLAIM];
    const groups = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[ ,]+/) : [];
    let best: Role | null = null;
    for (const { role, groups: wanted } of this.config.oidcRoleMapping) {
      if (!isRole(role)) continue;
      if (wanted.some((g) => groups.includes(g)) && (!best || ROLES.indexOf(role) > ROLES.indexOf(best))) best = role;
    }
    return best;
  }

  /** Find or provision the local account for an SSO identity. */
  async upsertUser(db: Kysely<Database>, profile: Record<string, unknown>): Promise<UserRow> {
    const sub = String(profile.sub);
    const email = String(profile.email ?? '').toLowerCase();
    if (!email) throw new ForbiddenError('Your identity provider did not supply an email address');
    if (profile.email_verified === false) throw new ForbiddenError('Your email address is not verified with the identity provider');
    const name = String(profile.name ?? ([profile.given_name, profile.family_name].filter(Boolean).join(' ') || email));
    const mapped = this.roleFromClaims(profile);
    const now = nowIso();

    let user = await db.selectFrom('users').selectAll().where('external_id', '=', sub).where('auth_provider', '=', 'oidc').executeTakeFirst();
    user ??= await db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();

    if (!user) {
      if (!this.config.OIDC_AUTO_PROVISION) throw new ForbiddenError('No Streamline account exists for this identity. Ask an administrator to invite you.');
      const id = newId();
      await db
        .insertInto('users')
        .values({
          id,
          email,
          name,
          password_hash: null,
          role: mapped ?? this.config.OIDC_DEFAULT_ROLE,
          kind: 'human',
          status: 'active',
          auth_provider: 'oidc',
          external_id: sub,
          locked_until: null,
          last_login_at: now,
          created_at: now,
          updated_at: now,
        })
        .execute();
      return db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    }

    if (user.kind !== 'human') throw new ForbiddenError('Service accounts cannot sign in interactively');
    // Linking an SSO identity to an existing local account by email: from now on it signs in via SSO.
    await db
      .updateTable('users')
      .set({
        external_id: sub,
        auth_provider: 'oidc',
        name,
        last_login_at: now,
        updated_at: now,
        // Role mapping (when configured) is authoritative so IdP group changes take effect at next login.
        ...(this.config.oidcRoleMapping.length && mapped ? { role: mapped } : {}),
      })
      .where('id', '=', user.id)
      .execute();
    return db.selectFrom('users').selectAll().where('id', '=', user.id).executeTakeFirstOrThrow();
  }
}
