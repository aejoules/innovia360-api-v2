# Innovia360 API v2 (Enterprise • DB-only)

API v2 (WordPress) supporting the flow: **Scan → Execute (Prepare) → Apply → Scan After**.

## Architecture
- **Web Service** (Express): validates requests, persists inventory, launches executions (sync ≤ `SYNC_LIMIT`, async otherwise)
- **Worker Service** (BullMQ): runs long jobs (scan + execution_prepare)
- **Postgres** (Render): tenant-aware data model
- **Redis** (Render): queues

## DB-only authentication (required)
All `/v2/*` endpoints require header:

- `x-api-key: <raw_api_key>`

In DB we store **only a hash**:

- `public.tenant_api_keys.key_hash = sha256:<hex>`

### Provision a tenant + API key
1) Generate a raw API key (store it safely on the plugin side).
2) Compute the hash (`sha256:<hex>`):

```bash
node -e "const crypto=require('crypto'); const k=process.argv[1]; const h=crypto.createHash('sha256').update(k,'utf8').digest('hex'); console.log('sha256:'+h)" "YOUR_RAW_API_KEY"
```

3) Insert into Postgres (psql):

```sql
INSERT INTO public.tenants(name) VALUES ('Client A') RETURNING id;

-- use the returned tenant id below
INSERT INTO public.tenant_api_keys(tenant_id, key_hash, label, is_enabled)
VALUES ('<TENANT_UUID>', 'sha256:<HEX>', 'wp-plugin', true);
```

## Render
This repo includes `render.yaml` with:
- `innovia360-api-v2` (web)
- `innovia360-api-v2-worker` (worker)
- `innovia360-v2-redis`
- `innovia360-v2-db`

Environment variables:
- `DATABASE_URL`, `REDIS_URL` (injected by Render)
- `SYNC_LIMIT` (default 50)
- `MIGRATE_ON_BOOT=true` (web + worker)

## Key endpoints
- `POST /v2/inventory/sync` — upsert site + inventory (wp_id, lang, types…)
- `POST /v2/scan/start` — queue a scan (scan_1 / scan_2_before / scan_2_after)
- `GET  /v2/scans/:job_id` — scan status + KPIs
- `POST /v2/optimizations/prepare` — sync (≤50) or async (>50)
- `GET  /v2/executions/:execution_id` — poll execution status/result
- `POST /v2/optimizations/applied` — plugin confirmation (idempotent)

## Local dev
```bash
npm ci
export DATABASE_URL=postgres://...
export REDIS_URL=redis://...
npm run dev
npm run dev:worker
```
