-- 002_optimizations_applied.sql (v3.1 compat)
-- Compatible with existing DB that already has: apply_batches, apply_items.
-- Adds: applied_* fields on optimization_* tables + extra columns + constraints on apply_* tables.
-- Safe re-run (IF NOT EXISTS).

-- Marker on execution
ALTER TABLE IF EXISTS public.optimization_executions
  ADD COLUMN IF NOT EXISTS applied_at timestamptz;

-- Latest applied state stored on results (optional but useful for UI/analytics)
ALTER TABLE IF EXISTS public.optimization_results
  ADD COLUMN IF NOT EXISTS applied_at timestamptz,
  ADD COLUMN IF NOT EXISTS applied_status text,
  ADD COLUMN IF NOT EXISTS applied_fields jsonb,
  ADD COLUMN IF NOT EXISTS applied_error jsonb,
  ADD COLUMN IF NOT EXISTS apply_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_optimization_results_applied_status'
  ) THEN
    ALTER TABLE public.optimization_results
      ADD CONSTRAINT chk_optimization_results_applied_status
      CHECK (applied_status IS NULL OR applied_status IN ('success','failed','skipped'));
  END IF;
END $$;

-- Extend existing apply_batches with trace info (non-breaking)
ALTER TABLE IF EXISTS public.apply_batches
  ADD COLUMN IF NOT EXISTS plugin text,
  ADD COLUMN IF NOT EXISTS plugin_version text,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb;

-- Ensure idempotency (unique key)
CREATE UNIQUE INDEX IF NOT EXISTS ux_apply_batches_idempotency_key
  ON public.apply_batches(idempotency_key);

-- Ensure upsert works for items (apply_id, wp_id, lang unique)
CREATE UNIQUE INDEX IF NOT EXISTS ux_apply_items_apply_wp_lang
  ON public.apply_items(apply_id, wp_id, lang);

-- Helpful indexes for lookups
CREATE INDEX IF NOT EXISTS idx_optimization_results_exec_wp_lang
  ON public.optimization_results(execution_id, wp_id, lang);

CREATE INDEX IF NOT EXISTS idx_apply_batches_execution_id
  ON public.apply_batches(execution_id);

CREATE INDEX IF NOT EXISTS idx_apply_items_execution_id
  ON public.apply_items(execution_id);
