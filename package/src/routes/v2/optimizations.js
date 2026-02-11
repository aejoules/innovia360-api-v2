import { Router } from 'express';
import { validateBody, validateResponse } from '../../lib/validate.js';
import { getSiteByUrl } from '../../services/siteService.js';
import { loadInventorySlice } from '../../services/inventoryService.js';
import {
  makeExecutionId,
  createExecution,
  getExecution,
  getExecutionForTenant,
  setExecutionStatus,
  setExecutionProgress,
  markExecutionDone,
  markExecutionFailed,
  upsertOptimizationResult,
  buildApplyPayload
} from '../../services/executionService.js';
import { getExecutionQueue } from '../../queues/executionQueue.js';
import { runPrepare } from '../../engine/prepareRunner.js';
import { withClient } from '../../lib/db.js';

// If the queue/worker is misconfigured, executions can stay "queued" forever.
// To avoid infinite polling loops in WordPress, we can (optionally) kick off
// the execution inline from the web service after a short delay.
const INLINE_KICK_ENABLED = (process.env.INLINE_KICK_ON_STUCK || 'true') === 'true';
const INLINE_KICK_AFTER_MS = Number(process.env.INLINE_KICK_AFTER_MS || 15000);
const _inlineKicks = new Set();

async function fetchSiteById(site_id) {
  return withClient(async (c) => {
    const r = await c.query('SELECT id, site_url FROM public.sites WHERE id=$1 LIMIT 1', [site_id]);
    return r.rows[0] || null;
  });
}

async function kickExecutionInline(execution_id) {
  if (_inlineKicks.has(execution_id)) return;
  _inlineKicks.add(execution_id);

  // Fire-and-forget background execution.
  setImmediate(async () => {
    try {
      const ex = await getExecution(execution_id);
      if (!ex) return;
      if (ex.status !== 'queued') return;

      const site = await fetchSiteById(ex.site_id);
      if (!site) {
        await markExecutionFailed(execution_id, { code: 'site_not_found', message: 'Site not found' });
        return;
      }

      const reqPayload = ex.request_payload || {};
      const scope = reqPayload.scope || {};
      const filters = reqPayload.filters || {};
      const rawInventory = await loadInventorySlice(ex.site_id, scope, filters);
      const inventory = (reqPayload.focus_keyword && typeof reqPayload.focus_keyword === 'string')
        ? rawInventory.map((it) => ({ ...it, focus_keyword: reqPayload.focus_keyword }))
        : rawInventory;

      await setExecutionStatus(execution_id, 'running', 1);

      const results = await runPrepare({
        site_url: reqPayload.site_url || site.site_url,
        ruleset: ex.ruleset,
        inventory,
        site_samples: reqPayload.site_samples || [],
        onProgress: async (done, total) => {
          const p = Math.max(1, Math.min(99, Math.floor((done / (total || 1)) * 95)));
          await setExecutionProgress(execution_id, p);
        }
      });

      for (const row of results) {
        await upsertOptimizationResult(execution_id, ex.site_id, {
          wp_id: row.wp_id,
          entity_type: row.entity_type,
          post_type: row.post_type,
          status: row.status,
          lang: row.lang,
          decision: row.decision,
          public_source: row.public_source,
          before: row.before,
          after: row.after,
          diff: row.diff,
          apply: row.apply
        });
      }

      const applyPayload = buildApplyPayload({ site_url: reqPayload.site_url || site.site_url, ruleset: ex.ruleset, execution_id, results });
      validateResponse('https://innovia360.dev/schemas/v2/apply-payload-response.schema.json', applyPayload);

      await markExecutionDone(execution_id, applyPayload, {
        items_total: applyPayload.summary.items_total,
        items_allowed: applyPayload.summary.items_allowed
      });
    } catch (err) {
      await markExecutionFailed(execution_id, { code: 'inline_kick_failed', message: String(err?.message || err) });
    } finally {
      _inlineKicks.delete(execution_id);
    }
  });
}

const r = Router();

const SYNC_LIMIT = Number(process.env.SYNC_LIMIT || 50);
const FORCE_ASYNC_PREPARE = (process.env.FORCE_ASYNC_PREPARE || 'true') === 'true';

/**
 * GET /v2/executions/:execution_id
 * Poll the execution status (queued/running/done/failed).
 */
r.get('/executions/:execution_id', async (req, res, next) => {
  try {
    const tenant_id = req.ctx?.tenant_id;
    const { execution_id } = req.params;

    const row = await getExecutionForTenant(execution_id, tenant_id);
    if (!row) {
      return res.status(404).json({
        ok: false,
        error: { code: 'not_found', message: 'Execution not found' }
      });
    }

    // Optional inline kick if stuck in queued for too long (prevents infinite polling loops).
    if (INLINE_KICK_ENABLED && row.status === 'queued') {
      const createdAt = row.created_at ? new Date(row.created_at).getTime() : 0;
      if (createdAt && (Date.now() - createdAt) > INLINE_KICK_AFTER_MS) {
        kickExecutionInline(execution_id);
      }
    }

    const base = {
      ok: true,
      execution_id: row.execution_id,
      status: row.status,
      progress: row.progress ?? 0
    };

    if (row.status === 'done') {
      return res.json({ ...base, result: row.result_payload });
    }
    if (row.status === 'failed') {
      return res.json({ ...base, error: row.error_payload || { code: 'failed' } });
    }
    return res.json(base);
  } catch (e) {
    return next(e);
  }
});

r.post('/optimizations/prepare',
  validateBody('https://innovia360.dev/schemas/v2/optimizations-prepare-request.schema.json'),
  async (req, res, next) => {
    try {
      const tenant_id = req.ctx?.tenant_id;
      const { site_url, ruleset, scope, filters = {}, site_samples = [], focus_keyword = null } = req.body;

      const site = await getSiteByUrl(tenant_id, site_url);
      if (!site) {
        return res.status(404).json({
          ok: false,
          error: { code: 'site_not_found', message: 'Site not registered. Call /v2/inventory/sync first.' }
        });
      }

      const rawInventory = await loadInventorySlice(site.id, scope, filters);
      const inventory = (focus_keyword && typeof focus_keyword === 'string')
        ? rawInventory.map((it) => ({ ...it, focus_keyword }))
        : rawInventory;
      const execution_id = makeExecutionId();

      // Create execution record
      const willAsync = FORCE_ASYNC_PREPARE || (inventory.length > SYNC_LIMIT);

      await createExecution({
        execution_id,
        site_id: site.id,
        ruleset,
        connector_target: 'auto',
        request_payload: req.body,
        status: willAsync ? 'queued' : 'running',
        progress: willAsync ? 0 : 1
      });

      if (willAsync) {
        const q = getExecutionQueue();
        // Enqueue job for the worker. If the worker/redis is down, the inline kick
        // mechanism in the polling endpoint will prevent infinite queued loops.
        await q.add('execution_prepare', { execution_id }, { attempts: 2 });

        return res.status(202).json({
          ok: true,
          execution_id,
          status: 'queued',
          progress: 0,
          links: {
            poll: `/v2/executions/${execution_id}`
          }
        });
      }

      // Sync path
      await setExecutionStatus(execution_id, 'running', 1);

      const results = await runPrepare({
        site_url,
        ruleset,
        inventory,
        site_samples,
        onProgress: async (done, total) => {
          const p = Math.max(1, Math.min(99, Math.floor((done / total) * 95)));
          await setExecutionProgress(execution_id, p);
        }
      });

      // Persist per-entity optimization results
      for (const row of results) {
        await upsertOptimizationResult(execution_id, site.id, {
          wp_id: row.wp_id,
          entity_type: row.entity_type,
          post_type: row.post_type,
          status: row.status,
          lang: row.lang,
          decision: row.decision,
          public_source: row.public_source,
          before: row.before,
          after: row.after,
          diff: row.diff,
          apply: row.apply
        });
      }

      const applyPayload = buildApplyPayload({ site_url, ruleset, execution_id, results });
      validateResponse('https://innovia360.dev/schemas/v2/apply-payload-response.schema.json', applyPayload);

      await markExecutionDone(execution_id, applyPayload, {
        items_total: applyPayload.summary.items_total,
        items_allowed: applyPayload.summary.items_allowed
      });

      return res.json(applyPayload);
    } catch (e) {
      return next(e);
    }
  }
);



r.post('/optimizations/applied',
  validateBody('https://innovia360.dev/schemas/v2/optimizations-applied-request.schema.json'),
  async (req, res, next) => {
    try {
      const tenant_id = req.ctx?.tenant_id;
      const { recordApply } = await import('../../services/applyService.js');
      const rcv = await recordApply(tenant_id, req.body);

      const items = req.body.items || [];
      const success = items.filter(i => i.status === 'success').length;
      const failed = items.filter(i => i.status === 'failed').length;
      const skipped = items.filter(i => i.status === 'skipped').length;

      return res.json({
        ok: true,
        apply_id: rcv.apply_id,
        execution_id: req.body.execution.execution_id,
        idempotent: rcv.idempotent,
        received: { items_total: items.length, items_success: success, items_failed: failed, items_skipped: skipped },
        actions: { scan_after_suggested: true }
      });
    } catch (e) {
      return next(e);
    }
  }
);

export default r;
