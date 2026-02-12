-- 002_optimizations_applied.sql
-- Track apply confirmations from CMS clients (WordPress plugin) and per-item applied status.
-- Safe to run multiple times (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

-- Add applied_at to executions (global marker)
ALTER TABLE IF EXISTS public.optimization_executions
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

-- Add applied status fields to results (latest state)
ALTER TABLE IF EXISTS public.optimization_results
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS applied_status text,
  ADD COLUMN IF NOT EXISTS applied_fields jsonb,
  ADD COLUMN IF NOT EXISTS applied_error jsonb,
  ADD COLUMN IF NOT EXISTS apply_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

DO $$
BEGIN
  -- Add a check constraint only if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_optimization_results_applied_status'
  ) THEN
    ALTER TABLE public.optimization_results
      ADD CONSTRAINT chk_optimization_results_applied_status
      CHECK (applied_status IS NULL OR applied_status IN ('success','failed','skipped'));
  END IF;
END $$;

-- Apply batch table (idempotent)
CREATE TABLE IF NOT EXISTS public.optimization_apply_batches (
  apply_id          text PRIMARY KEY,
  site_id           uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  execution_id      text NOT NULL REFERENCES public.optimization_executions(execution_id) ON DELETE CASCADE,
  mode              text NOT NULL CHECK (mode IN ('manual','auto')),
  idempotency_key   text NOT NULL UNIQUE,
  plugin            text NOT NULL,
  plugin_version    text NOT NULL,
  connector_used    text NOT NULL CHECK (connector_used IN ('yoast','rankmath')),
  applied_at        timestamptz NOT NULL DEFAULT now(),
  raw_payload       jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.optimization_apply_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apply_id           text NOT NULL REFERENCES public.optimization_apply_batches(apply_id) ON DELETE CASCADE,
  wp_id              integer NOT NULL CHECK (wp_id > 0),
  entity_type        text NOT NULL CHECK (entity_type IN ('product','variation','post','page')),
  lang               text NOT NULL,
  status             text NOT NULL CHECK (status IN ('success','failed','skipped')),
  applied_fields     jsonb NOT NULL,
  wp_modified_gmt_after timestamptz,
  error              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_optimization_apply_items_apply_id ON public.optimization_apply_items(apply_id);
CREATE INDEX IF NOT EXISTS idx_optimization_results_exec_wp_lang ON public.optimization_results(execution_id, wp_id, lang);
