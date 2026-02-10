import { Worker } from 'bullmq';
import { getRedis } from './queues/redis.js';
import { SCAN_QUEUE_NAME } from './queues/scanQueue.js';
import { EXECUTION_QUEUE_NAME } from './queues/executionQueue.js';
import { logger } from './lib/logger.js';
import { migrate } from './lib/migrate.js';
import { withClient } from './lib/db.js';
import { loadInventorySlice } from './services/inventoryService.js';
import {
  setExecutionStatus,
  setExecutionProgress,
  markExecutionDone,
  markExecutionFailed,
  upsertOptimizationResult,
  buildApplyPayload
} from './services/executionService.js';
import { markScanStarted, markScanProgress, markScanDone, markScanFailed, insertScanResult, upsertScanKpis } from './services/scanService.js';
import { runPrepare } from './engine/prepareRunner.js';
import { crawlPublic } from './engine/crawler.js';
import { scoreFromSignals } from './engine/utils.js';

if ((process.env.MIGRATE_ON_BOOT || 'true') === 'true') {
  await migrate();
}

const connection = getRedis();

async function fetchExecutionRequest(execution_id) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT execution_id, site_id, ruleset, request_payload
       FROM public.optimization_executions
       WHERE execution_id=$1
       LIMIT 1`,
      [execution_id]
    );
    return r.rows[0] || null;
  });
}

async function fetchSite(site_id) {
  return withClient(async (c) => {
    const r = await c.query('SELECT id, site_url FROM public.sites WHERE id=$1 LIMIT 1', [site_id]);
    return r.rows[0] || null;
  });
}

async function fetchScanJob(job_id) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT job_id, site_id, type, scope
       FROM public.scan_jobs
       WHERE job_id=$1
       LIMIT 1`,
      [job_id]
    );
    return r.rows[0] || null;
  });
}

async function doExecutionPrepare(execution_id) {
  const ex = await fetchExecutionRequest(execution_id);
  if (!ex) throw new Error('execution_not_found');

  const site = await fetchSite(ex.site_id);
  if (!site) throw new Error('site_not_found');

  const req = ex.request_payload || {};
  const scope = req.scope || {};
  const filters = req.filters || {};
  const rawInventory = await loadInventorySlice(ex.site_id, scope, filters);
  const inventory = (req.focus_keyword && typeof req.focus_keyword === 'string')
    ? rawInventory.map((it) => ({ ...it, focus_keyword: req.focus_keyword }))
    : rawInventory;

  await setExecutionStatus(execution_id, 'running', 1);

  const results = await runPrepare({
    site_url: req.site_url || site.site_url,
    ruleset: ex.ruleset,
    inventory,
    site_samples: req.site_samples || [],
    focus_keyword: req.focus_keyword || null,
    onProgress: async (done, total) => {
      const p = Math.max(1, Math.min(99, Math.floor((done / total) * 95)));
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

  const applyPayload = buildApplyPayload({ site_url: req.site_url || site.site_url, ruleset: ex.ruleset, execution_id, results });
  await markExecutionDone(execution_id, applyPayload, {
    items_total: applyPayload.summary.items_total,
    items_allowed: applyPayload.summary.items_allowed
  });
}

async function doScan(job_id) {
  const scan = await fetchScanJob(job_id);
  if (!scan) throw new Error('scan_not_found');

  await markScanStarted(job_id);

  const scope = scan.scope || {};
  const inventory = await loadInventorySlice(scan.site_id, scope, { limit: scope.limit || 500 });

  const total = inventory.length || 1;
  let sumScore = 0;
  let indexableCount = 0;
  let seen = 0;

  for (let i = 0; i < inventory.length; i++) {
    const e = inventory[i];
    let crawl;
    try {
      crawl = await crawlPublic(e.permalink);
    } catch (err) {
      await insertScanResult(job_id, scan.site_id, {
        wp_id: e.wp_id,
        lang: e.lang,
        entity_type: e.entity_type,
        url: e.permalink,
        http_status: 0,
        indexable: false,
        metrics: { error: String(err?.message || err) },
        issues: [{ code: 'crawl_failed' }],
        score: 0
      });
      seen += 1;
      await markScanProgress(job_id, Math.min(99, Math.floor((seen / total) * 95)));
      continue;
    }

    const { score, issues } = scoreFromSignals(crawl.signals);
    sumScore += score;
    if (crawl.signals.indexable) indexableCount += 1;
    seen += 1;

    await insertScanResult(job_id, scan.site_id, {
      wp_id: e.wp_id,
      lang: e.lang,
      entity_type: e.entity_type,
      url: crawl.url,
      http_status: crawl.http_status,
      indexable: crawl.signals.indexable,
      metrics: { ...crawl.signals, timing_ms: crawl.timing_ms },
      issues,
      score
    });

    await markScanProgress(job_id, Math.min(99, Math.floor((seen / total) * 95)));
  }

  const avgScore = inventory.length ? Math.round(sumScore / inventory.length) : 0;
  const indexableRate = inventory.length ? Math.round((indexableCount / inventory.length) * 100) : 0;

  await upsertScanKpis(job_id, scan.site_id, {
    entities_seen: inventory.length,
    avg_score: avgScore,
    indexable_rate: indexableRate
  });

  await markScanDone(job_id);
}

// Workers
new Worker(SCAN_QUEUE_NAME, async (job) => {
  const { job_id } = job.data || {};
  try {
    await doScan(job_id);
    return { ok: true };
  } catch (err) {
    logger.error({ err, job_id }, 'scan failed');
    await markScanFailed(job_id, { code: 'scan_failed', message: String(err?.message || err) });
    throw err;
  }
}, { connection, concurrency: Number(process.env.SCAN_CONCURRENCY || 2) });

new Worker(EXECUTION_QUEUE_NAME, async (job) => {
  const { execution_id } = job.data || {};
  try {
    await doExecutionPrepare(execution_id);
    return { ok: true };
  } catch (err) {
    logger.error({ err, execution_id }, 'execution failed');
    await markExecutionFailed(execution_id, { code: 'execution_failed', message: String(err?.message || err) });
    throw err;
  }
}, { connection, concurrency: Number(process.env.EXECUTION_CONCURRENCY || 2) });

logger.info('worker started');
