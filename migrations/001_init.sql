-- 001_init.sql (Innovia360 API v2 - WordPress) — DDL FINAL (tenant-aware)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Migrations tracking (with checksum for safety)
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Tenants
CREATE TABLE IF NOT EXISTS public.tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- API Keys (hashed)
CREATE TABLE IF NOT EXISTS public.tenant_api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  key_hash     text NOT NULL UNIQUE,
  label        text,
  is_enabled   boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tenant_api_keys_tenant ON public.tenant_api_keys(tenant_id);

-- Sites
CREATE TABLE IF NOT EXISTS public.sites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,

  site_url            text NOT NULL,
  cms                 text NOT NULL DEFAULT 'wordpress' CHECK (cms IN ('wordpress')),
  timezone            text NOT NULL DEFAULT 'UTC',

  plugin              text,
  plugin_version      text,

  connectors           text[] NOT NULL DEFAULT ARRAY[]::text[],
  wc_enabled           boolean NOT NULL DEFAULT false,
  wc_version           text,
  multilang_enabled    boolean NOT NULL DEFAULT false,
  multilang_provider   text NOT NULL DEFAULT 'none' CHECK (multilang_provider IN ('none','wpml','polylang')),

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_sites_tenant_siteurl UNIQUE (tenant_id, site_url)
);
CREATE INDEX IF NOT EXISTS idx_sites_tenant ON public.sites(tenant_id);

-- Inventory
CREATE TABLE IF NOT EXISTS public.wp_inventory_entities (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  wp_id              integer NOT NULL CHECK (wp_id > 0),
  entity_type        text NOT NULL CHECK (entity_type IN ('product','variation','post','page')),
  post_type          text NOT NULL CHECK (post_type IN ('product','product_variation','post','page')),
  status             text NOT NULL CHECK (status IN ('publish','draft','private','pending','future','trash')),
  lang               text NOT NULL,

  translation_group_id text,
  source_wp_id       integer CHECK (source_wp_id IS NULL OR source_wp_id > 0),

  slug               text,
  permalink          text NOT NULL,
  canonical          text,

  title              text,
  excerpt            text,
  content_hash       text,
  modified_gmt       timestamptz NOT NULL,

  wc                 jsonb,
  public_hints        jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_wp_inventory_site_wp_lang UNIQUE (site_id, wp_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_wp_inventory_site_type ON public.wp_inventory_entities(site_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_wp_inventory_site_status ON public.wp_inventory_entities(site_id, status);
CREATE INDEX IF NOT EXISTS idx_wp_inventory_site_lang ON public.wp_inventory_entities(site_id, lang);
CREATE INDEX IF NOT EXISTS idx_wp_inventory_site_permalink ON public.wp_inventory_entities(site_id, permalink);
CREATE INDEX IF NOT EXISTS gin_wp_inventory_wc ON public.wp_inventory_entities USING gin (wc);
CREATE INDEX IF NOT EXISTS gin_wp_inventory_public_hints ON public.wp_inventory_entities USING gin (public_hints);

-- Executions (Prepare)
CREATE TABLE IF NOT EXISTS public.optimization_executions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id       text NOT NULL UNIQUE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  ruleset            text NOT NULL,
  connector_target   text NOT NULL DEFAULT 'auto' CHECK (connector_target IN ('auto','yoast','rankmath')),
  mode               text NOT NULL DEFAULT 'prepare_only' CHECK (mode IN ('prepare_only')),

  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  progress           integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  result_payload     jsonb,
  error_payload      jsonb,

  request_payload    jsonb NOT NULL,
  response_summary   jsonb,

  started_at         timestamptz NOT NULL DEFAULT now(),
  ended_at           timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exec_site_started ON public.optimization_executions(site_id, started_at DESC);

-- Per-entity results
CREATE TABLE IF NOT EXISTS public.optimization_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id       text NOT NULL REFERENCES public.optimization_executions(execution_id) ON DELETE CASCADE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  wp_id              integer NOT NULL CHECK (wp_id > 0),
  entity_type        text NOT NULL CHECK (entity_type IN ('product','variation','post','page')),
  post_type          text NOT NULL CHECK (post_type IN ('product','product_variation','post','page')),
  status             text NOT NULL CHECK (status IN ('publish','draft','private','pending','future','trash')),
  lang               text NOT NULL,

  decision           jsonb NOT NULL,
  public_source      jsonb,
  before_payload     jsonb,
  after_payload      jsonb,
  diff_payload       jsonb,
  apply_payload      jsonb NOT NULL,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_exec_result UNIQUE (execution_id, wp_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_optres_site_wp_lang ON public.optimization_results(site_id, wp_id, lang);
CREATE INDEX IF NOT EXISTS idx_optres_exec_site ON public.optimization_results(execution_id, site_id);

-- Apply confirmations
CREATE TABLE IF NOT EXISTS public.apply_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apply_id           text NOT NULL UNIQUE,
  execution_id       text NOT NULL REFERENCES public.optimization_executions(execution_id) ON DELETE CASCADE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  connector_used     text NOT NULL CHECK (connector_used IN ('yoast','rankmath')),
  mode               text NOT NULL CHECK (mode IN ('manual','auto')),

  idempotency_key    text NOT NULL UNIQUE,
  applied_at         timestamptz NOT NULL,

  items_total        integer NOT NULL DEFAULT 0,
  items_success      integer NOT NULL DEFAULT 0,
  items_failed       integer NOT NULL DEFAULT 0,
  items_skipped      integer NOT NULL DEFAULT 0,

  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apply_batches_site_applied ON public.apply_batches(site_id, applied_at DESC);

CREATE TABLE IF NOT EXISTS public.apply_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apply_id           text NOT NULL REFERENCES public.apply_batches(apply_id) ON DELETE CASCADE,
  execution_id       text NOT NULL REFERENCES public.optimization_executions(execution_id) ON DELETE CASCADE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  wp_id              integer NOT NULL CHECK (wp_id > 0),
  entity_type        text NOT NULL CHECK (entity_type IN ('product','variation','post','page')),
  lang               text NOT NULL,

  status             text NOT NULL CHECK (status IN ('success','failed','skipped')),
  applied_fields     jsonb NOT NULL,

  wp_modified_gmt_after timestamptz,
  error_payload      jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_apply_item UNIQUE (apply_id, wp_id, lang)
);
CREATE INDEX IF NOT EXISTS idx_apply_items_site_wp_lang ON public.apply_items(site_id, wp_id, lang);
CREATE INDEX IF NOT EXISTS idx_apply_items_exec ON public.apply_items(execution_id);

-- Scan jobs
CREATE TABLE IF NOT EXISTS public.scan_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             text NOT NULL UNIQUE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  type               text NOT NULL CHECK (type IN ('scan_1','scan_2_before','scan_2_after')),
  scope              jsonb NOT NULL,
  execution_ref      text,
  apply_ref          text,

  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  progress           integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  error_payload      jsonb,

  created_at         timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  ended_at           timestamptz
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_site_created ON public.scan_jobs(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_exec_ref ON public.scan_jobs(execution_ref);

-- Scan results
CREATE TABLE IF NOT EXISTS public.scan_results (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             text NOT NULL REFERENCES public.scan_jobs(job_id) ON DELETE CASCADE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,

  wp_id              integer CHECK (wp_id > 0),
  lang               text,
  entity_type        text CHECK (entity_type IN ('product','variation','post','page')),
  url                text NOT NULL,

  http_status        integer CHECK (http_status BETWEEN 100 AND 599),
  indexable          boolean,

  metrics            jsonb,
  issues             jsonb,
  score              integer CHECK (score BETWEEN 0 AND 100),

  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_results_job ON public.scan_results(job_id);
CREATE INDEX IF NOT EXISTS idx_scan_results_site_wp_lang ON public.scan_results(site_id, wp_id, lang);

-- Scan KPI snapshot
CREATE TABLE IF NOT EXISTS public.scan_kpis (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             text NOT NULL UNIQUE REFERENCES public.scan_jobs(job_id) ON DELETE CASCADE,
  site_id            uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  summary            jsonb NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- updated_at triggers (optional)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sites_updated_at') THEN
    CREATE TRIGGER trg_sites_updated_at
    BEFORE UPDATE ON public.sites
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_wp_inventory_updated_at') THEN
    CREATE TRIGGER trg_wp_inventory_updated_at
    BEFORE UPDATE ON public.wp_inventory_entities
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END$$;

COMMIT;
