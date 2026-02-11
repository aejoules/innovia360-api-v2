import { withClient } from '../lib/db.js';
import { getSiteByUrl } from './siteService.js';

export function makeApplyId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const rnd = Math.random().toString(16).slice(2, 10);
  return `apply_${ts}_${rnd}`;
}

/**
 * Record plugin confirmation (DB-only).
 * - Enforces idempotency on apply_batch.idempotency_key
 * - Writes apply_batches + apply_items
 */
export async function recordApply(tenant_id, payload) {
  const site_url = payload?.site?.site_url;
  if (!site_url) throw new Error('missing site.site_url');

  const site = await getSiteByUrl(tenant_id, site_url);
  if (!site) {
    throw new Error('site_not_found');
  }

  const apply_id = makeApplyId();
  const execution_id = payload?.execution?.execution_id;
  const connector_used = payload?.site?.connector_used;
  const mode = payload?.apply_batch?.mode || 'manual';
  const idempotency_key = payload?.apply_batch?.idempotency_key;
  const applied_at = payload?.apply_batch?.applied_at || new Date().toISOString();

  if (!execution_id) throw new Error('missing execution.execution_id');
  if (!idempotency_key) throw new Error('missing apply_batch.idempotency_key');

  const items = Array.isArray(payload.items) ? payload.items : [];
  const counts = {
    total: items.length,
    success: items.filter(i => i.status === 'success').length,
    failed: items.filter(i => i.status === 'failed').length,
    skipped: items.filter(i => i.status === 'skipped').length
  };

  return withClient(async (c) => {
    // idempotency
    const existing = await c.query(
      'SELECT apply_id FROM public.apply_batches WHERE idempotency_key=$1 LIMIT 1',
      [idempotency_key]
    );
    if (existing.rowCount > 0) {
      return { apply_id: existing.rows[0].apply_id, idempotent: true };
    }

    await c.query('BEGIN');
    try {
      await c.query(
        `INSERT INTO public.apply_batches(
           apply_id, execution_id, site_id,
           connector_used, mode,
           idempotency_key, applied_at,
           items_total, items_success, items_failed, items_skipped
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          apply_id,
          execution_id,
          site.id,
          connector_used,
          mode,
          idempotency_key,
          applied_at,
          counts.total,
          counts.success,
          counts.failed,
          counts.skipped
        ]
      );

      for (const it of items) {
        await c.query(
          `INSERT INTO public.apply_items(
             apply_id, execution_id, site_id,
             wp_id, entity_type, lang,
             status, applied_fields, wp_modified_gmt_after, error_payload
           )
           VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
           ON CONFLICT (apply_id, wp_id, lang)
           DO UPDATE SET
             status=EXCLUDED.status,
             applied_fields=EXCLUDED.applied_fields,
             wp_modified_gmt_after=EXCLUDED.wp_modified_gmt_after,
             error_payload=EXCLUDED.error_payload`,
          [
            apply_id,
            execution_id,
            site.id,
            it.wp_id,
            it.entity_type,
            it.lang,
            it.status,
            JSON.stringify(it.applied_fields || {}),
            it.wp_modified_gmt_after || null,
            it.error_payload ? JSON.stringify(it.error_payload) : null
          ]
        );
      }

      await c.query('COMMIT');
      return { apply_id, idempotent: false };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}
