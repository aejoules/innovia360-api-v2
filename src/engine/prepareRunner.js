import { crawlPublic } from './crawler.js';
import { quickBoost } from './quickBoost.js';
import { aiBoost } from './aiBoost.js';
import { computeDiff, scoreFromSignals, scoreFromSignalsWithOverrides } from './utils.js';


function isKeywordRelevant(keyword, text) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return false;
  const t = String(text || '').toLowerCase();
  // Basic relevance: keyword (or its main token) must appear in title/source.
  if (t.includes(kw)) return true;
  const main = kw.split(/\s+/).filter(Boolean)[0];
  if (main && main.length >= 4 && t.includes(main)) return true;
  return false;
}


/**
 * Prepare runner (used both sync and worker).
 * Takes inventory entities and produces ApplyPayload results[].
 */
export async function runPrepare({ site_url, ruleset, inventory, site_samples = [], focus_keyword = null, onProgress }) {
  const results = [];
  const total = inventory.length;

  const MIN_DELTA = Number(process.env.SAB_MIN_DELTA || 1);
  const FREEZE_SCORE = Number(process.env.SAB_FREEZE_SCORE || 20);

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
    const scanRes = scoreFromSignals(signals, { slug: e.slug || '' });
    const score = scanRes.score;
    const issues = scanRes.issues;
    const seo_fields_score = scanRes.seo_fields_score;
    const fields_issues = scanRes.fields_issues;

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
      scan: { score, issues, seo_fields_score, fields_issues, metrics: scanRes.metrics }
    };

    // --- Generator: deterministic quickBoost OR AI boost (with deterministic fallback) ---
    const wantsAi = ['safe_boost', 'deep_boost', 'ai_boost'].includes(String(ruleset || 'quick_boost'));

    // Base BEFORE fields for AI context
    const beforeFields = {
      post_title: before.core.post_title || '',
      post_excerpt: before.core.post_excerpt || '',
      meta_description: before.seo.meta_description || '',
      yoast_title: before.seo.title || '',
      yoast_metadesc: before.seo.meta_description || '',
      slug: e.slug || ''
    };

    // Site writing samples come from request payload in /v2/optimizations/prepare
    // We store them at execution.request_payload.site_samples (optional).
    const samples = Array.isArray(site_samples) ? site_samples : [];

    let generator = { kind: 'deterministic', timing_ms: 0 };
    let generated = null;

    if (wantsAi) {
      const ai = await aiBoost({
        mode: String(ruleset || 'safe_boost'),
        lang: e.lang || 'fr',
        focus_keyword: (() => {
        const kw = e.focus_keyword || focus_keyword || null;
        const src = (e.title || signals.title || '');
        return isKeywordRelevant(kw, src) ? kw : null;
      })(),
        site_samples: samples,
        beforeFields,
        source: {
          source_title: e.title || signals.title || '',
          source_excerpt: e.excerpt || '',
          key_facts: []
        }
      });
      if (ai.ok && ai.output?.fields) {
        generator = { kind: 'openai', ...ai.engine, timing_ms: ai.timing_ms };
        generated = ai.output;
      } else {
        generator = { kind: 'deterministic_fallback', reason: ai?.error?.code || 'unknown', timing_ms: ai.timing_ms || 0 };
      }
    }

    const boosted = generated?.fields
      ? {
          core: {
            post_title: generated.fields.post_title || before.core.post_title || '',
            post_excerpt: generated.fields.post_excerpt || before.core.post_excerpt || ''
          },
          seo: {
            // keep canonical/robots from crawl, only rewrite what we generate
            title: generated.fields.yoast_title || generated.fields.post_title || signals.title || '',
            meta_description: generated.fields.yoast_metadesc || generated.fields.meta_description || signals.meta_description || '',
            robots: signals.robots || null,
            canonical: signals.canonical || null,
            focus_keyword: (() => {
            const kw = e.focus_keyword || focus_keyword || null;
            const src = (e.title || signals.title || '');
            return isKeywordRelevant(kw, src) ? kw : null;
          })()
          },
          _ai: { generator, output: generated }
        }
      : {
          ...quickBoost({ entity: e, signals }),
          _ai: { generator }
        };

    const after = {
      core: boosted.core,
      seo: boosted.seo
    };

    const diff = {
      core: computeDiff(before.core, after.core),
      seo: computeDiff(before.seo, after.seo)
    };

    // --- SEO score before/after (estimated) ---
    const afterScore = scoreFromSignalsWithOverrides(signals, {
      title: after.seo?.title,
      meta_description: after.seo?.meta_description
    }, { slug: e.slug || '' });

    const score_before = seo_fields_score;
    const score_after = afterScore.seo_fields_score;
    const delta = score_after - score_before;

    // decision policy SAB v1 (non-breaking extension)
    let allowed = true;
    let reason = 'policy_pass';
    let risk = 'low';

    if (e.entity_type === 'variation') { allowed = false; reason = 'variation_policy'; risk = 'none'; }
    if (e.status !== 'publish') { allowed = false; reason = 'not_published'; risk = 'none'; }
    if (crawl.http_status !== 200) { allowed = false; reason = 'http_not_200'; risk = 'none'; }

    // Freeze good content
    if (allowed && score_before >= FREEZE_SCORE) {
      allowed = false;
      reason = 'frozen_score';
      risk = 'none';
    }

    // Only apply if improvement meets threshold
    if (allowed && delta < MIN_DELTA) {
      allowed = false;
      reason = 'delta_below_threshold';
      risk = 'none';
    }

    const decision = allowed
      ? { action: 'update', risk, reason }
      : { action: 'skip', risk, reason };

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
        seo_score: { source: 'yoast', before: score_before, after: score_after, delta, scan_before: score, scan_after: afterScore.score },
        engine: boosted?._ai?.generator || { kind: 'deterministic' },
        update: allowed ? {
          connector_target: 'auto',
          fields: {
            core: after.core,
            seo: after.seo,
            // Apply-ready flat fields for WP plugin (Yoast fields mapped on WP side)
            apply_fields: {
              post_title: after.core?.post_title || null,
              post_excerpt: after.core?.post_excerpt || null,
              meta_description: after.seo?.meta_description || null,
              yoast_title: after.seo?.title || null,
              yoast_metadesc: after.seo?.meta_description || null,
              slug: e.slug || null
            }
          }
        } : null
      }
    });

    if (onProgress) onProgress(i + 1, total);
  }

  return results;
}
