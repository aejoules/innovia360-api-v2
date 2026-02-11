import { withClient } from '../lib/db.js';
import { getScanQueue } from '../queues/scanQueue.js';

export function makeScanJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '');
  const rnd = Math.random().toString(16).slice(2, 10);
  return `scan_${ts}_${rnd}`;
}

export async function createScanJob(site_id, type, scope, refs = {}) {
  const job_id = makeScanJobId();
  const { execution_ref = null, apply_ref = null } = refs;

  await withClient(async (c) => {
    await c.query(
      `INSERT INTO public.scan_jobs(job_id, site_id, type, scope, execution_ref, apply_ref, status, progress, created_at)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,'queued',0,now())`,
      [job_id, site_id, type, JSON.stringify(scope || {}), execution_ref, apply_ref]
    );
  });

  const q = getScanQueue();
  await q.add('scan_job', { job_id }, { attempts: 2 });

  return job_id;
}

export async function getScan(job_id) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT job_id, site_id, type, scope, execution_ref, apply_ref, status, progress, error_payload, created_at, started_at, ended_at
       FROM public.scan_jobs WHERE job_id=$1 LIMIT 1`,
      [job_id]
    );
    const scan = r.rows[0] || null;
    if (!scan) return null;

    const k = await c.query(
      `SELECT summary FROM public.scan_kpis WHERE job_id=$1 LIMIT 1`,
      [job_id]
    );

    return {
      ...scan,
      kpis: k.rows[0]?.summary || null
    };
  });
}

export async function markScanStarted(job_id) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.scan_jobs
       SET status='running', progress=5, started_at=COALESCE(started_at, now())
       WHERE job_id=$1`,
      [job_id]
    );
  });
}

export async function markScanProgress(job_id, progress) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.scan_jobs SET progress=$2 WHERE job_id=$1`,
      [job_id, progress]
    );
  });
}

export async function markScanFailed(job_id, error_payload) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.scan_jobs
       SET status='failed', error_payload=$2::jsonb, ended_at=now()
       WHERE job_id=$1`,
      [job_id, JSON.stringify(error_payload)]
    );
  });
}

export async function markScanDone(job_id) {
  return withClient(async (c) => {
    await c.query(
      `UPDATE public.scan_jobs
       SET status='done', progress=100, ended_at=now()
       WHERE job_id=$1`,
      [job_id]
    );
  });
}

export async function insertScanResult(job_id, site_id, row) {
  return withClient(async (c) => {
    await c.query(
      `INSERT INTO public.scan_results(
         job_id, site_id, wp_id, lang, entity_type, url,
         http_status, indexable, metrics, issues, score
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [
        job_id,
        site_id,
        row.wp_id ?? null,
        row.lang ?? null,
        row.entity_type ?? null,
        row.url,
        row.http_status ?? null,
        row.indexable ?? null,
        row.metrics ? JSON.stringify(row.metrics) : null,
        row.issues ? JSON.stringify(row.issues) : null,
        row.score ?? null
      ]
    );
  });
}

export async function upsertScanKpis(job_id, site_id, summary) {
  return withClient(async (c) => {
    await c.query(
      `INSERT INTO public.scan_kpis(job_id, site_id, summary)
       VALUES($1,$2,$3::jsonb)
       ON CONFLICT (job_id)
       DO UPDATE SET summary=EXCLUDED.summary, created_at=now()`,
      [job_id, site_id, JSON.stringify(summary)]
    );
  });
}
