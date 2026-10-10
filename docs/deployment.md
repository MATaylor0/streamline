# Deployment

Streamline ships as **one OCI image** that serves the UI, REST API and MCP endpoint on port 8080. It is configured entirely through environment variables (see [`.env.example`](../.env.example)), and any variable can be supplied as `NAME_FILE`. It needs:

- **Database:** PostgreSQL 13+ (recommended for production and multiple replicas), or SQLite on a persistent volume for a single node
- **Secrets:** `SESSION_SECRET` (32+ characters), the database URL, and optionally the bootstrap admin and OIDC client secret
- **Ingress:** HTTPS termination with `PUBLIC_URL` set to the external URL and `TRUST_PROXY=true`

Health endpoints: `/healthz` (liveness) and `/readyz` (readiness, which checks the database). Migrations run on start and are lock-protected, so they are safe with several replicas; to run them as a separate step instead, set `MIGRATE_ON_START=false` and run `streamline migrate`.

## Build the image

```bash
docker build -t registry.example.com/streamline:0.1.0 .
docker push registry.example.com/streamline:0.1.0
```

The build is multi-stage. The runtime image is `node:22-bookworm-slim`, runs as non-root, and includes a container `HEALTHCHECK`.

## Single host

**SQLite (evaluation, small teams)**

```bash
docker run -d --name streamline -p 8080:8080 --restart unless-stopped \
  -e PUBLIC_URL=https://streamline.example.com -e TRUST_PROXY=true \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com -e BOOTSTRAP_ADMIN_PASSWORD='…' \
  -v streamline-data:/data registry.example.com/streamline:0.1.0
```

**Docker Compose with PostgreSQL**

```bash
cp .env.example .env    # set SESSION_SECRET, BOOTSTRAP_ADMIN_PASSWORD, POSTGRES_PASSWORD, PUBLIC_URL
docker compose up -d
```

The compose service runs read-only, with all capabilities dropped and `no-new-privileges`.

## Kubernetes (any distribution: EKS, AKS, GKE, OpenShift, on-prem)

```bash
kubectl create secret generic streamline \
  --from-literal=DATABASE_URL='postgres://user:pass@db:5432/streamline' \
  --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  --from-literal=BOOTSTRAP_ADMIN_PASSWORD='…'

helm upgrade --install streamline deploy/helm/streamline \
  --set image.repository=registry.example.com/streamline --set image.tag=0.1.0 \
  --set existingSecret=streamline \
  --set publicUrl=https://streamline.example.com \
  --set ingress.enabled=true --set ingress.className=nginx --set ingress.host=streamline.example.com \
  --set autoscaling.enabled=true
```

The chart provides a Deployment (hardened pod and container security contexts, probes, rolling updates), a Service, an Ingress, an HPA, a PDB, a ServiceAccount (for cloud workload-identity annotations) and an optional NetworkPolicy. Use `existingSecret` with External Secrets Operator, Sealed Secrets or the Secrets Store CSI driver.

## AWS

**ECS Fargate + RDS PostgreSQL** (recommended)
1. RDS for PostgreSQL (Multi-AZ, encryption on). Store `DATABASE_URL` and `SESSION_SECRET` in **Secrets Manager**.
2. Push the image to **ECR**.
3. Task definition: container port 8080, `secrets` → `DATABASE_URL` and `SESSION_SECRET` from Secrets Manager, environment `PUBLIC_URL`, `TRUST_PROXY=true`, `DATABASE_SSL=require`, `readonlyRootFilesystem: true` plus a `/tmp` volume, and health check `/healthz`.
4. Service behind an **ALB** (HTTPS with an ACM certificate). Target group health check: `/readyz`.
5. SSO with Entra ID, Okta or **IAM Identity Center** (OIDC app): set `OIDC_*`.

**App Runner** also works for a quick start: set the port to 8080, configure the same secrets, and attach a VPC connector to reach RDS.

**EKS:** use the Helm chart. Annotate the service account for IRSA if you need it, and use the AWS Load Balancer Controller for ingress.

## Microsoft Azure

**Azure Container Apps + Azure Database for PostgreSQL – Flexible Server**

```bash
az containerapp create -n streamline -g rg-streamline --environment cae-streamline \
  --image registry.example.com/streamline:0.1.0 --target-port 8080 --ingress external \
  --min-replicas 1 --max-replicas 5 \
  --secrets db-url='postgres://…@server.postgres.database.azure.com:5432/streamline?sslmode=require' session=$(openssl rand -hex 32) \
  --env-vars DATABASE_URL=secretref:db-url SESSION_SECRET=secretref:session \
             PUBLIC_URL=https://streamline.example.com TRUST_PROXY=true DATABASE_SSL=require
```

- Store secrets in **Key Vault** and reference them from Container Apps with a managed identity.
- For **Entra ID SSO**, register an app with redirect URI `https://<host>/api/v1/auth/oidc/callback` and set:
  - `OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0`
  - `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`
  - `OIDC_ROLE_CLAIM=groups` (enable the groups claim) or `roles` (app roles)
  - `OIDC_ROLE_MAPPING=admin=<group-id>;approver=<group-id>;editor=<group-id>`
- **AKS:** use the Helm chart, with Workload Identity via `serviceAccount.annotations`.

## Google Cloud

**Cloud Run + Cloud SQL for PostgreSQL**

```bash
gcloud run deploy streamline --image REGION-docker.pkg.dev/PROJECT/repo/streamline:0.1.0 \
  --port 8080 --allow-unauthenticated --min-instances 1 \
  --add-cloudsql-instances PROJECT:REGION:streamline-db \
  --set-secrets DATABASE_URL=streamline-db-url:latest,SESSION_SECRET=streamline-session:latest \
  --set-env-vars PUBLIC_URL=https://streamline.example.com,TRUST_PROXY=true
```

- With the Cloud SQL connector, use a socket URL: `postgres://user:pass@/streamline?host=/cloudsql/PROJECT:REGION:streamline-db`.
- Streamline does its own authentication, so `--allow-unauthenticated` only exposes the login page. You can put IAP in front as well.
- For Google Workspace SSO: `OIDC_ISSUER=https://accounts.google.com`.
- **GKE:** use the Helm chart.

## On-premises and air-gapped

- Mirror the image into your internal registry. At runtime it needs no outbound internet access; webhooks and SSO need only the endpoints you configure.
- Use the Helm chart on OpenShift or Rancher, or Compose on a VM.
- SQLite mode suits small isolated installs. Back up `/data/streamline.db`; `sqlite3 .backup` is safe while the app is running.

## Backup, restore and migration

- **PostgreSQL:** use your platform's automated backups or point-in-time recovery, or `pg_dump`.
- **Logical export:** `GET /api/v1/export` (or **Settings → Download full export**) produces a portable JSON of everything except credentials.
- **Moving processes between environments:** export a process as JSON and import it on the target with `process.import`. Teams, systems, risks and controls are matched by name.

## Upgrades

Roll out a new image tag. Migrations apply automatically on start, inside the Kysely migration lock, and the rolling update (`maxUnavailable: 0`) keeps the service available.
