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
      `SELECT execution_id, site_id, ruleset, connector_target, mode, status, progress, result_payload, response_summary, error_payload, request_payload, created_at, started_at, ended_at
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
      `SELECT e.execution_id, e.site_id, e.ruleset, e.connector_target, e.mode, e.status, e.progress,
              e.result_payload, e.response_summary, e.error_payload, e.request_payload, e.created_at, e.started_at, e.ended_at
       FROM public.optimization_executions e
       JOIN public.sites s ON s.id = e.site_id
       WHERE e.execution_id=$1 AND s.tenant_id=$2
       LIMIT 1`,
      [execution_id, tenant_id]
    );
    return r.rows[0] || null;
  });
}


export async function listOptimizationResultsForTenant(execution_id, tenant_id, limit = 5000, offset = 0) {
  if (!tenant_id) return [];
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT r.id, r.execution_id, r.site_id, r.wp_id, r.entity_type, r.post_type, r.status, r.lang,
              r.decision, r.public_source, r.before_payload, r.after_payload, r.diff_payload, r.apply_payload, r.created_at
       FROM public.optimization_results r
       JOIN public.sites s ON s.id = r.site_id
       WHERE r.execution_id=$1 AND s.tenant_id=$2
       ORDER BY r.created_at ASC
       LIMIT $3 OFFSET $4`,
      [execution_id, tenant_id, limit, offset]
    );
    return r.rows || [];
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


/**
 * Record an "applied" confirmation coming from a CMS client (WordPress plugin).
 * - Idempotent on apply_batch.idempotency_key
 * - Writes batch + items
 * - Updates optimization_results with latest applied_* fields
 * - Marks optimization_executions.applied_at
 */
export async function recordOptimizationsApplied(tenant_id, body) {
  if (!tenant_id) throw new Error('missing tenant_id');
  const site_url = body?.site?.site_url;
  const execution_id = body?.execution?.execution_id;
  const applied_at = body?.execution?.applied_at;
  const apply_id = body?.apply_batch?.apply_id;
  const mode = body?.apply_batch?.mode;
  const idempotency_key = body?.apply_batch?.idempotency_key;

  return withClient(async (c) => {
    // Resolve site under tenant
    const siteRes = await c.query(
      `SELECT s.id
       FROM public.sites s
       WHERE s.tenant_id=$1 AND s.site_url=$2
       LIMIT 1`,
      [tenant_id, site_url]
    );
    const site = siteRes.rows[0];
    if (!site) {
      const e = new Error('site_not_found');
      e.code = 'site_not_found';
      throw e;
    }

    // Ensure execution belongs to this site + tenant
    const execRes = await c.query(
      `SELECT e.execution_id
       FROM public.optimization_executions e
       WHERE e.execution_id=$1 AND e.site_id=$2
       LIMIT 1`,
      [execution_id, site.id]
    );
    if (execRes.rowCount === 0) {
      const e = new Error('execution_not_found');
      e.code = 'execution_not_found';
      throw e;
    }

    // Idempotency: if batch already exists, return previous summary
    const existing = await c.query(
      `SELECT apply_id, applied_at
       FROM public.optimization_apply_batches
       WHERE idempotency_key=$1
       LIMIT 1`,
      [idempotency_key]
    );
    if (existing.rowCount > 0) {
      const items = await c.query(
        `SELECT status FROM public.optimization_apply_items WHERE apply_id=$1`,
        [existing.rows[0].apply_id]
      );
      const statuses = items.rows.map(x => x.status);
      return {
        ok: true,
        execution_id,
        apply_id: existing.rows[0].apply_id,
        idempotency_key,
        already_recorded: true,
        summary: {
          items_total: statuses.length,
          items_success: statuses.filter(s => s === 'success').length,
          items_failed: statuses.filter(s => s === 'failed').length,
          items_skipped: statuses.filter(s => s === 'skipped').length
        }
      };
    }

    await c.query('BEGIN');
    try {
      await c.query(
        `INSERT INTO public.optimization_apply_batches(
           apply_id, site_id, execution_id, mode, idempotency_key,
           plugin, plugin_version, connector_used, applied_at, raw_payload
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::jsonb)`,
        [
          apply_id,
          site.id,
          execution_id,
          mode,
          idempotency_key,
          body.site.plugin,
          body.site.plugin_version,
          body.site.connector_used,
          applied_at,
          JSON.stringify(body)
        ]
      );

      const items = Array.isArray(body.items) ? body.items : [];
      for (const it of items) {
        await c.query(
          `INSERT INTO public.optimization_apply_items(
             apply_id, wp_id, entity_type, lang, status, applied_fields, wp_modified_gmt_after, error
           ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::jsonb)`,
          [
            apply_id,
            it.wp_id,
            it.entity_type,
            it.lang,
            it.status,
            JSON.stringify(it.applied_fields),
            it.wp_modified_gmt_after || null,
            it.error ? JSON.stringify(it.error) : null
          ]
        );

        // Update latest applied state on optimization_results (best-effort)
        await c.query(
          `UPDATE public.optimization_results
           SET applied_at = $5::timestamptz,
               applied_status = $4,
               applied_fields = $6::jsonb,
               applied_error = $7::jsonb,
               apply_id = $2,
               idempotency_key = $3
           WHERE execution_id=$1 AND wp_id=$8 AND lang=$9`,
          [
            execution_id,
            apply_id,
            idempotency_key,
            it.status,
            applied_at,
            JSON.stringify(it.applied_fields),
            it.error ? JSON.stringify(it.error) : null,
            it.wp_id,
            it.lang
          ]
        );
      }

      // Mark execution applied_at (single timestamp)
      await c.query(
        `UPDATE public.optimization_executions
         SET applied_at = COALESCE(applied_at, $2::timestamptz)
         WHERE execution_id=$1`,
        [execution_id, applied_at]
      );

      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }

    const statuses = items.map(x => x.status);
    return {
      ok: true,
      execution_id,
      apply_id,
      idempotency_key,
      already_recorded: false,
      summary: {
        items_total: statuses.length,
        items_success: statuses.filter(s => s === 'success').length,
        items_failed: statuses.filter(s => s === 'failed').length,
        items_skipped: statuses.filter(s => s === 'skipped').length
      }
    };
  });
}
