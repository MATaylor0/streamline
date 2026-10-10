# Security

## Identity and access

| Control | Implementation |
| --- | --- |
| SSO | OpenID Connect authorization-code flow with PKCE, `state` and `nonce`. ID token validated by `openid-client`. Unverified emails rejected. Group/role claim mapped to roles on every login (`OIDC_ROLE_MAPPING`). Optional auto-provisioning |
| Local passwords | scrypt (N=2¹⁵, r=8, p=1, 64-byte key, per-user salt). Policy: length ≥ 12 and 3 of 4 character classes. Lockout after 5 failures for 15 minutes. Constant-time responses for unknown accounts. Can be disabled (`LOCAL_AUTH_ENABLED=false`) once SSO is in place |
| Sessions | 256-bit random token, stored hashed, signed HttpOnly cookie, SameSite=Lax, Secure under https. Absolute TTL (12 h) and idle timeout (2 h). Revoked on disable, role change or password reset |
| CSRF | Per-session token required in `X-CSRF-Token` for every cookie-authenticated write (double submit). Bearer requests are exempt because browsers can't send them cross-site |
| API tokens | `slt_` + 256-bit random, SHA-256 hashed at rest, shown once, read/write scope, optional expiry, revocable, last-used tracking |
| Authorization | RBAC (viewer / editor / approver / admin → 13 permissions) enforced in the executor for every channel. Resource rules (team ownership, segregation of duties, last-admin protection) live in the operation handlers |
| AI agents | Use service accounts with least-privilege roles and read-only tokens where possible. Credential operations are not exposed over MCP. Every MCP action is audited with channel `mcp` |

## Auditing

- Every write, every permission denial and every sign-in (successful or failed) is written to `audit_log`. Each row records the actor, channel, operation, target, sanitized input (fields named like passwords, secrets or tokens are redacted), outcome, IP and request id.
- Successful writes are audited inside the same database transaction as the change, so a committed change always has an audit row.
- Bulk exports are always audited. Set `AUDIT_READS=true` to audit every read as well.
- The audit log has no update or delete operation. For tamper-evidence, stream it to your SIEM: subscribe a webhook to `*`, or ship container logs, which are structured JSON with request ids.

## Application hardening

- Input validation on every operation (zod), with length limits on all strings and arrays. Request body limit is 5 MB.
- Parameterized SQL everywhere (Kysely). LIKE wildcards are escaped.
- Security headers via Helmet: strict CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), HSTS under https, `nosniff`, referrer policy.
- No CORS unless `CORS_ORIGINS` is configured.
- Rate limiting: global per user/IP, and a stricter limit on login.
- Webhook SSRF protection: https only, and private, loopback, link-local and CGNAT addresses are rejected after DNS resolution and again on every delivery. Redirects are not followed. Override with `WEBHOOK_ALLOW_PRIVATE_NETWORKS` for internal targets.
- Errors never leak stack traces. Every error carries a request id for correlation.
- Secrets can be supplied as files (`SESSION_SECRET_FILE`, `DATABASE_URL_FILE`, …). Logs redact `Authorization` and `Cookie` headers.

## Runtime

- The container runs as non-root uid 1000 and works with a read-only root filesystem (writable `/tmp`, plus `/data` only when using SQLite). It needs no Linux capabilities.
- The Helm chart sets `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, drops all capabilities, uses the RuntimeDefault seccomp profile, disables service-account token automount, and offers an optional NetworkPolicy.
- Database TLS: `DATABASE_SSL=require` or `verify-full`, with `DATABASE_SSL_CA`.

## Operational checklist

1. Set `PUBLIC_URL` to the https URL and `TRUST_PROXY=true` behind a load balancer.
2. Generate `SESSION_SECRET` (`openssl rand -hex 32`) and keep it in a secret manager.
3. Use PostgreSQL with TLS and automated backups. Store the app's database credentials as a secret.
4. Configure SSO, map IdP groups to roles, then consider `LOCAL_AUTH_ENABLED=false`. Keep a break-glass local admin only if your policy allows it.
5. Rotate the bootstrap admin password after first login, or remove `BOOTSTRAP_ADMIN_PASSWORD` from the environment.
6. Create one service account per AI agent or integration. Use read-only tokens with expiry wherever possible.
7. Forward logs and audit events to your SIEM.
