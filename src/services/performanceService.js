import { withClient } from '../lib/db.js';

/**
 * PerformanceService
 * Goal: turn scan scores + product meta into an actionable "business" list.
 *
 * IMPORTANT: this is intentionally heuristic and dependency-free
 * (no GSC/GA required). It works out-of-the-box.
 */

function toNumber(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function priceFromWc(wc) {
  if (!wc || typeof wc !== 'object') return 0;
  // Common WC fields
  return (
    toNumber(wc.price, 0) ||
    toNumber(wc.regular_price, 0) ||
    toNumber(wc.sale_price, 0) ||
    0
  );
}

function computeOpportunity({ score, price }) {
  // score: 0..100 (higher is better). Opportunity increases when score is low.
  const s = (typeof score === 'number' && Number.isFinite(score)) ? score : 50;
  const p = Math.max(0, price || 0);

  // Price weight: keep bounded (avoid huge outliers)
  const priceWeight = 1 + Math.log(1 + Math.min(p, 5000));

  const opp = Math.max(0, (100 - s) * priceWeight);
  // A conservative "value" proxy (NOT a promise):
  // assumes a small traffic uplift and a low conversion baseline.
  const estValue = (opp / 100) * Math.min(p, 1000) * 0.25;

  return {
    opportunity_score: Math.round(opp * 10) / 10,
    estimated_value_month: Math.round(estValue * 100) / 100
  };
}

export async function listOpportunities({ tenant_id, site_url, site_id = null, limit = 50, lang = null }) {
  const safeLimit = Math.max(1, Math.min(Number(limit || 50), 200));

  return withClient(async (c) => {
    // Resolve site_id from site_url (tenant-aware)
    let sid = site_id;
    if (!sid) {
      const s = await c.query(
        `SELECT id FROM public.sites WHERE tenant_id=$1 AND site_url=$2 LIMIT 1`,
        [tenant_id, site_url]
      );
      sid = s.rows?.[0]?.id || null;
    }
    if (!sid) return { site_id: null, items: [], meta: { total: 0 } };

    // Latest scan score per (wp_id, lang), preferring scan_2_before over scan_1
    const r = await c.query(
      `WITH latest_scan AS (
         SELECT DISTINCT ON (sr.wp_id, COALESCE(sr.lang,''))
           sr.wp_id,
           sr.lang,
           sr.score,
           sr.issues,
           sr.metrics,
           sj.type,
           sr.created_at
         FROM public.scan_results sr
         JOIN public.scan_jobs sj ON sj.job_id = sr.job_id
         WHERE sr.site_id = $1
           AND sr.wp_id IS NOT NULL
           AND sj.type IN ('scan_2_before','scan_1')
         ORDER BY sr.wp_id,
                  COALESCE(sr.lang,''),
                  CASE sj.type WHEN 'scan_2_before' THEN 0 ELSE 1 END,
                  sr.created_at DESC
       )
       SELECT
         inv.wp_id,
         inv.lang,
         inv.title,
         inv.permalink,
         inv.wc,
         ls.score,
         ls.issues,
         ls.metrics
       FROM public.wp_inventory_entities inv
       LEFT JOIN latest_scan ls
         ON ls.wp_id = inv.wp_id AND (ls.lang IS NULL OR ls.lang = inv.lang)
       WHERE inv.site_id = $1
         AND inv.entity_type = 'product'
         AND inv.status = 'publish'
         AND ($2::text IS NULL OR inv.lang = $2)
       ORDER BY inv.wp_id ASC
       LIMIT 2000`,
      [sid, lang]
    );

    const items = (r.rows || []).map((row) => {
      const wc = row.wc || null;
      const price = priceFromWc(wc);
      const score = (row.score === null || row.score === undefined) ? null : Number(row.score);

      const { opportunity_score, estimated_value_month } = computeOpportunity({ score, price });

      return {
        wp_id: row.wp_id,
        lang: row.lang,
        title: row.title,
        permalink: row.permalink,
        price,
        seo_score: score,
        opportunity_score,
        estimated_value_month,
        issues: row.issues || null,
        metrics: row.metrics || null
      };
    });

    // rank client-facing list by opportunity score
    items.sort((a, b) => (b.opportunity_score || 0) - (a.opportunity_score || 0));

    const top = items.slice(0, safeLimit);
    const estTotal = top.reduce((sum, it) => sum + (it.estimated_value_month || 0), 0);

    return {
      site_id: sid,
      items: top,
      meta: {
        total: items.length,
        returned: top.length,
        estimated_value_month_total: Math.round(estTotal * 100) / 100
      }
    };
  });
}
