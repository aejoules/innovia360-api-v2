import { withClient } from '../lib/db.js';

export function makeExecutionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const rnd = Math.random().toString(16).slice(2, 10);
  return `exec_${ts}_${rnd}`;
}

export async function createExecution({ execution_id, site_id, ruleset, connector_target = 'auto', request_payload, status = 'queued', progress = 0 }) {
  return withClient(async (c) => {
    await c.query(
      `INSERT INTO public.optimization_executions(
         execution_id, site_id, ruleset, connector_target, mode,
         status, progress, request_payload, started_at
       )
       VALUES($1,$2,$3,$4,'prepare_only',$5,$6,$7::jsonb,now())`,
      [execution_id, site_id, ruleset, connector_target, status, progress, JSON.stringify(request_payload)]
    );
    return execution_id;
  });
}

export async function setExecutionStatus(execution_id, status, progress = null) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.optimization_executions
       SET status=$2,
           progress=COALESCE($3, progress),
           ended_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE ended_at END
       WHERE execution_id=$1`,
      [execution_id, status, progress]
    );
  });
}

export async function setExecutionProgress(execution_id, progress) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.optimization_executions SET progress=$2 WHERE execution_id=$1`,
      [execution_id, progress]
    );
  });
}

export async function markExecutionDone(execution_id, result_payload, response_summary = null) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.optimization_executions
       SET status='done',
           progress=100,
           result_payload=$2::jsonb,
           response_summary=$3::jsonb,
           ended_at=now()
       WHERE execution_id=$1`,
      [execution_id, JSON.stringify(result_payload), response_summary ? JSON.stringify(response_summary) : null]
    );
  });
}

export async function markExecutionFailed(execution_id, error_payload) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.optimization_executions
       SET status='failed',
           error_payload=$2::jsonb,
           ended_at=now()
       WHERE execution_id=$1`,
      [execution_id, JSON.stringify(error_payload)]
    );
  });
}

export async function getExecution(execution_id) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT execution_id, site_id, ruleset, connector_target, status, progress, result_payload, error_payload, request_payload, started_at, ended_at
       FROM public.optimization_executions
       WHERE execution_id=$1
       LIMIT 1`,
      [execution_id]
    );
    return r.rows[0] || null;
  });
}

/**
 * Tenant-safe execution lookup.
 * Ensures the execution belongs to a site owned by the tenant.
 */
export async function getExecutionForTenant(execution_id, tenant_id) {
  if (!tenant_id) return null;
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT e.execution_id, e.site_id, e.ruleset, e.connector_target, e.status, e.progress,
              e.result_payload, e.error_payload, e.request_payload, e.started_at, e.ended_at
       FROM public.optimization_executions e
       JOIN public.sites s ON s.id = e.site_id
       WHERE e.execution_id=$1 AND s.tenant_id=$2
       LIMIT 1`,
      [execution_id, tenant_id]
    );
    return r.rows[0] || null;
  });
}

export async function upsertOptimizationResult(execution_id, site_id, row) {
  return withClient(async (c) => {
    await c.query(
      `INSERT INTO public.optimization_results(
         execution_id, site_id, wp_id, entity_type, post_type, status, lang,
         decision, public_source, before_payload, after_payload, diff_payload, apply_payload
       )
       VALUES(
         $1,$2,$3,$4,$5,$6,$7,
         $8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb
       )
       ON CONFLICT (execution_id, wp_id, lang)
       DO UPDATE SET
         decision = EXCLUDED.decision,
         public_source = EXCLUDED.public_source,
         before_payload = EXCLUDED.before_payload,
         after_payload = EXCLUDED.after_payload,
         diff_payload = EXCLUDED.diff_payload,
         apply_payload = EXCLUDED.apply_payload`,
      [
        execution_id,
        site_id,
        row.wp_id,
        row.entity_type,
        row.post_type,
        row.status,
        row.lang,
        JSON.stringify(row.decision),
        row.public_source ? JSON.stringify(row.public_source) : null,
        row.before ? JSON.stringify(row.before) : null,
        row.after ? JSON.stringify(row.after) : null,
        row.diff ? JSON.stringify(row.diff) : null,
        JSON.stringify(row.apply)
      ]
    );
  });
}

/**
 * Build ApplyPayload (API response) from computed results.
 * Note: format matches existing schema files (apply-payload-response.schema.json).
 */
export function buildApplyPayload({ site_url, ruleset, execution_id, results }) {
  const now = new Date().toISOString();
  return {
    ok: true,
    execution: {
      execution_id,
      site_url,
      ruleset,
      created_at: now
    },
    summary: {
      items_total: results.length,
      items_allowed: results.filter(r => r.apply?.allowed).length,
      items_skipped: results.filter(r => !r.apply?.allowed).length
    },
    results
  };
}
