import { setTimeout as delay } from 'timers/promises';

/**
 * SEO Agent Boost - OpenAI generator (with deterministic fallback handled by caller).
 *
 * This module is intentionally dependency-free (uses global fetch available in Node >= 18).
 */

function envInt(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
}

function stripCodeFences(s) {
  if (!s) return s;
  const t = String(s).trim();
  // Remove ```json ... ``` wrappers if any
  if (t.startsWith('```')) {
    return t.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '').trim();
  }
  return t;
}

function safeJsonParse(text) {
  const cleaned = stripCodeFences(text);
  try {
    return { ok: true, json: JSON.parse(cleaned) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function buildPrompt({ mode, lang, focus_keyword, site_samples, beforeFields, source }) {
  const sampleLines = (site_samples || []).slice(0, 3).map((s, i) => `- sample_${i + 1}: ${String(s).slice(0, 800)}`).join('\n');

  const kw = focus_keyword ? String(focus_keyword).trim() : '';

  return {
    system: [
      'You are SEO Agent Boost, an expert SEO editor for WordPress content.',
      '',
      'Goal: propose improved SEO fields (title, meta description, excerpt, Yoast title/metadesc, optional slug) that increase SEO quality without altering facts.',
      '',
      'Hard rules:',
      '- Output MUST be valid JSON. No markdown, no explanations outside JSON.',
      '- Do NOT invent facts (specs, prices, guarantees, certifications, medical claims).',
      '- Respect language and infer the site brand voice from provided site writing samples; keep the same voice.',
      '- Follow length constraints: title 40-65 chars, meta 120-170 chars (target 45-60 / 140-160).',
      '- If focus keyword is provided, include it naturally (no keyword stuffing).',
      '',
      'Brand voice rule:',
      '- Infer a brand_voice label from the site samples among: ecom-direct, institutionnel-premium, tech-saas, medical-scientifique, artisan-heritage, minimal-neutral.',
      '- Provide 2-4 evidence points brand_voice_evidence.',
      '',
      'Return JSON only.'
    ].join('\n'),
    user: [
      'Generate SEO improvements for the following WordPress entity.',
      '',
      'CONTEXT',
      `- language: ${lang}`,
      `- mode: ${mode}`,
      `- seo_source: yoast`,
      `- focus_keyword: ${kw || '(none)'}`,
      '',
      'SITE WRITING SAMPLES (for brand voice inference)',
      sampleLines || '- sample_1: (none)\n- sample_2: (none)\n- sample_3: (none)',
      '',
      'CURRENT FIELDS (BEFORE)',
      `- post_title: ${beforeFields.post_title || ''}`,
      `- post_excerpt: ${beforeFields.post_excerpt || ''}`,
      `- meta_description: ${beforeFields.meta_description || ''}`,
      `- yoast_title: ${beforeFields.yoast_title || ''}`,
      `- yoast_metadesc: ${beforeFields.yoast_metadesc || ''}`,
      `- slug: ${beforeFields.slug || ''}`,
      '',
      'SOURCE CONTENT (TRUTH)',
      `- source_title: ${source.source_title || ''}`,
      `- source_excerpt: ${source.source_excerpt || ''}`,
      `- key_facts: ${Array.isArray(source.key_facts) ? source.key_facts.join(' | ') : ''}`,
      '',
      'TASK',
      '1) Infer site brand voice from SITE WRITING SAMPLES and set quality.brand_voice + quality.brand_voice_evidence.',
      '2) Propose AFTER fields optimized for CTR + SEO while keeping the same brand voice.',
      '3) Keep same meaning; do not add new facts.',
      '4) Return a JSON object with these top-level keys only:',
      '   - fields: { post_title, post_excerpt, meta_description, yoast_title, yoast_metadesc, slug? }',
      '   - content_blocks: { h1?, h2?, faq? } (optional)',
      '   - quality: { language, brand_voice, brand_voice_evidence, brand_voice_ok, no_forbidden_claims }',
      '   - notes: [..] (max 3)',
      '',
      'OUTPUT: JSON only.'
    ].join('\n')
  };
}

export async function aiBoost({ mode, lang, focus_keyword, site_samples, beforeFields, source }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: { code: 'openai_missing_key', message: 'OPENAI_API_KEY not set' } };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const timeoutMs = envInt('OPENAI_TIMEOUT_MS', 30000);
  const prompt = buildPrompt({ mode, lang, focus_keyword, site_samples, beforeFields, source });

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error('openai_timeout')), timeoutMs);

  const startedAt = Date.now();
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: mode === 'deep_boost' ? 0.6 : 0.3,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ]
      })
    });

    const txt = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        error: { code: 'openai_http_error', status: resp.status, message: txt.slice(0, 500) },
        timing_ms: Date.now() - startedAt
      };
    }

    const data = JSON.parse(txt);
    const content = data?.choices?.[0]?.message?.content || '';
    const parsed = safeJsonParse(content);
    if (!parsed.ok) {
      return {
        ok: false,
        error: { code: 'openai_bad_json', message: String(parsed.error?.message || parsed.error) },
        raw: content.slice(0, 2000),
        timing_ms: Date.now() - startedAt
      };
    }

    return {
      ok: true,
      engine: { name: 'openai', model, version: 'sab-ia-v1' },
      output: parsed.json,
      timing_ms: Date.now() - startedAt
    };
  } catch (e) {
    return {
      ok: false,
      error: { code: 'openai_call_failed', message: String(e?.message || e) },
      timing_ms: Date.now() - startedAt
    };
  } finally {
    clearTimeout(t);
    // small jitter to reduce burst rate in batch
    await delay(20);
  }
}
