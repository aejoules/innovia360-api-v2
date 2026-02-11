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

const r = Router();

const SYNC_LIMIT = Number(process.env.SYNC_LIMIT || 50);
// /v2/optimizations/prepare can involve crawling + AI calls and can exceed typical
// reverse-proxy/PHP timeouts (especially when called from WordPress). To avoid
// request timeouts, support an async-first mode.
const FORCE_ASYNC_PREPARE = String(process.env.FORCE_ASYNC_PREPARE || '').toLowerCase() === 'true';

/**
 * GET /v2/executions/:execution_id
 * Poll the execution status (queued/running/done/failed).
 */
const getExecutionHandler = async (req, res, next) => {
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

    const base = {
      ok: true,
      execution_id: row.execution_id,
      status: row.status,
      progress: row.progress ?? 0
    };
    // Auto-timeout: if an execution is stuck in 'queued' too long, fail it so clients stop polling forever.
    const STUCK_QUEUED_SECONDS = Number(process.env.EXECUTION_STUCK_QUEUED_SECONDS || 180);
    if (row.status === 'queued' && row.started_at) {
      const ageMs = Date.now() - new Date(row.started_at).getTime();
      if (ageMs > STUCK_QUEUED_SECONDS * 1000) {
        try {
          await markExecutionFailed(execution_id, {
            code: 'worker_not_running',
            message: `Execution stuck in queued for ${Math.floor(ageMs/1000)}s. Worker/Redis may be down.`
          });
          // Reload and return failed state
          const row2 = await getExecutionForTenant(execution_id, tenant_id);
          return res.json({
            ok: true,
            execution_id: row2.execution_id,
            status: row2.status,
            progress: row2.progress ?? 0,
            error: row2.error_payload || { code: 'worker_not_running' }
          });
        } catch (_) {
          // if failing update fails, fall through
        }
      }
    }


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
};

r.get('/executions/:execution_id', getExecutionHandler);
r.get('/optimizations/executions/:execution_id', getExecutionHandler);

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

      // Async-first: anything non-quick (AI / richer processing) should run in worker
      // to avoid request timeouts from WordPress/PHP/reverse proxies.
      const rulesetName = String(ruleset || '').toLowerCase();
      const shouldAsync = FORCE_ASYNC_PREPARE || (inventory.length > SYNC_LIMIT) || (rulesetName !== 'quick_boost');

      // Create execution record
      await createExecution({
        execution_id,
        site_id: site.id,
        ruleset,
        connector_target: 'auto',
        request_payload: req.body,
        status: shouldAsync ? 'queued' : 'running',
        progress: shouldAsync ? 0 : 1
      });

      if (shouldAsync) {
        const q = getExecutionQueue();

        // Fire-and-forget enqueue to avoid hanging the HTTP request when Redis/queue
        // is slow or temporarily unavailable (WordPress will otherwise timeout).
        // We still return execution_id immediately; the execution will move to
        // 'running' once the worker picks it up. If enqueue fails, we mark it failed.
        Promise.resolve()
          .then(() => q.add('execution_prepare', { execution_id }, { attempts: 2 }))
          .catch(async (err) => {
            try {
              await setExecutionStatus(execution_id, 'failed', 0, String(err?.message || err || 'enqueue_failed'));
            } catch (_) {}
          });

        return res.status(202).json({
          ok: true,
          execution_id,
          status: 'queued',
          progress: 0,
          links: {
            poll: `/v2/optimizations/executions/${execution_id}`
          }
        });
      }

      // Sync path (deterministic only)
      await setExecutionStatus(execution_id, 'running', 1);

      const results = await runPrepare({
        site_url,
        ruleset,
        inventory,
        site_samples,
        focus_keyword,
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

// (removed duplicate /executions/:execution_id route; using getExecutionHandler above)

export default r;