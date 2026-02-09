import { crawlPublic } from './crawler.js';
import { quickBoost } from './quickBoost.js';
import { computeDiff, scoreFromSignals } from './utils.js';

/**
 * Prepare runner (used both sync and worker).
 * Takes inventory entities and produces ApplyPayload results[].
 */
export async function runPrepare({ site_url, ruleset, inventory, onProgress }) {
  const results = [];
  const total = inventory.length;

  for (let i = 0; i < total; i++) {
    const e = inventory[i];
    const url = e.permalink;

    let crawl;
    try {
      crawl = await crawlPublic(url);
    } catch (err) {
      results.push({
        wp_id: e.wp_id,
        lang: e.lang,
        entity_type: e.entity_type,
        post_type: e.post_type,
        status: e.status,
        public_source: { url, http_status: 0, error: String(err?.message || err) },
        before: null,
        after: null,
        diff: null,
        decision: { action: 'skip', reason: 'crawl_failed' },
        apply: { allowed: false, reason: 'crawl_failed', update: null }
      });
      if (onProgress) onProgress(i + 1, total);
      continue;
    }

    const signals = crawl.signals;
    const { score, issues } = scoreFromSignals(signals);

    const before = {
      core: {
        post_title: e.title || signals.title || null,
        post_excerpt: e.excerpt || null
      },
      seo: {
        title: signals.title || null,
        meta_description: signals.meta_description || null,
        robots: signals.robots || null,
        canonical: signals.canonical || null
      },
      scan: { score, issues, metrics: { text_len: signals.text_len, h1_count: signals.h1_count, indexable: signals.indexable } }
    };

    const boosted = (ruleset === 'quick_boost')
      ? quickBoost({ entity: e, signals })
      : quickBoost({ entity: e, signals });

    const after = {
      core: boosted.core,
      seo: boosted.seo
    };

    const diff = {
      core: computeDiff(before.core, after.core),
      seo: computeDiff(before.seo, after.seo)
    };

    // decision policy V0
    let allowed = true;
    let reason = null;

    if (e.entity_type === 'variation') { allowed = false; reason = 'variation_policy'; }
    if (e.status !== 'publish') { allowed = false; reason = 'not_published'; }
    if (crawl.http_status !== 200) { allowed = false; reason = 'http_not_200'; }

    const decision = allowed ? { action: 'update' } : { action: 'skip', reason };

    results.push({
      wp_id: e.wp_id,
      lang: e.lang,
      entity_type: e.entity_type,
      post_type: e.post_type,
      status: e.status,
      public_source: { url: crawl.url, http_status: crawl.http_status, timing_ms: crawl.timing_ms, signals },
      before,
      after,
      diff,
      decision,
      apply: {
        allowed,
        reason,
        update: allowed ? {
          connector_target: 'auto',
          fields: {
            core: after.core,
            seo: after.seo
          }
        } : null
      }
    });

    if (onProgress) onProgress(i + 1, total);
  }

  return results;
}
