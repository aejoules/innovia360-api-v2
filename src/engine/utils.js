export function clamp(str, maxLen) {
  const s = (str || '').trim();
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1).trimEnd() + '…';
}

export function computeDiff(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const out = {};
  for (const k of keys) {
    const b = before?.[k];
    const a = after?.[k];
    if (b === undefined && a !== undefined) out[k] = 'added';
    else if (b !== undefined && a === undefined) out[k] = 'removed';
    else if (JSON.stringify(b) === JSON.stringify(a)) out[k] = 'unchanged';
    else out[k] = 'changed';
  }
  return out;
}

function norm(s) {
  return String(s || '').trim();
}

function normRobots(r) {
  return norm(r).toLowerCase().replace(/\s+/g, '');
}

function isPlaceholderText(s) {
  const t = norm(s).toLowerCase();
  if (!t) return false;
  const patterns = [
    /great things are on the horizon/,
    /just another wordpress site/,
    /site en construction/,
    /coming soon/,
    /lorem ipsum/,
    /hello world/,
    /^home$/,
    /^accueil$/,
    /^untitled$/,
    /^sample page$/
  ];
  return patterns.some((re) => re.test(t));
}

function inRange(n, min, max) {
  return typeof n === 'number' && n >= min && n <= max;
}

/**
 * Business SEO scoring (deterministic).
 *
 * Returns:
 * - score: 0..100   (public scan score)
 * - seo_fields_score: 0..20 (used for freeze / decision)
 * - issues: array of issue objects (for score 0..100)
 * - fields_issues: array of issues for seo_fields_score
 * - metrics: basic metrics used for debugging
 */
export function scoreFromSignals(sig, opts = {}) {
  const title = norm(sig?.title);
  const meta = norm(sig?.meta_description);
  const canonical = norm(sig?.canonical);
  const robots = normRobots(sig?.robots);
  const h1c = Number(sig?.h1_count || 0);
  const h1s = Array.isArray(sig?.h1) ? sig.h1.map(norm).filter(Boolean) : [];
  const h1 = h1s[0] || '';
  const indexable = sig?.indexable !== false && !robots.includes('noindex');
  const text_len = Number(sig?.text_len || 0);
  const slug = norm(opts?.slug);

  // ---------- Public scan score 0..100 ----------
  let score = 100;
  const issues = [];

  // Indexation
  if (!indexable) {
    score -= 60;
    issues.push({ code: 'noindex', field: 'robots' });
  }

  // Title
  if (!title) {
    score -= 40;
    issues.push({ code: 'title_missing', field: 'title' });
  } else {
    if (title.length > 60) {
      score -= 15;
      issues.push({ code: 'title_too_long', field: 'title', len: title.length });
    }
    if (title.length < 20) {
      score -= 10;
      issues.push({ code: 'title_too_short', field: 'title', len: title.length });
    }
    if (isPlaceholderText(title)) {
      score -= 30;
      issues.push({ code: 'title_placeholder', field: 'title' });
    }
  }

  // Meta description
  if (!meta) {
    score -= 30;
    issues.push({ code: 'meta_missing', field: 'meta_description' });
  } else {
    if (meta.length < 70) {
      score -= 10;
      issues.push({ code: 'meta_too_short', field: 'meta_description', len: meta.length });
    }
    if (meta.length > 170) {
      score -= 10;
      issues.push({ code: 'meta_too_long', field: 'meta_description', len: meta.length });
    }
    if (isPlaceholderText(meta)) {
      score -= 20;
      issues.push({ code: 'meta_placeholder', field: 'meta_description' });
    }
  }

  // H1
  if (h1c === 0) {
    score -= 20;
    issues.push({ code: 'h1_missing', field: 'h1' });
  } else if (h1c > 1) {
    score -= 10;
    issues.push({ code: 'h1_multiple', field: 'h1', count: h1c });
  }
  if (h1 && isPlaceholderText(h1)) {
    score -= 20;
    issues.push({ code: 'h1_placeholder', field: 'h1' });
  }

  // Canonical
  if (!canonical) {
    score -= 5;
    issues.push({ code: 'canonical_missing', field: 'canonical' });
  }

  score = Math.max(0, Math.min(100, score));

  // ---------- SEO fields score 0..20 (freeze/decision) ----------
  let fieldsScore = 20;
  const fieldsIssues = [];

  // title 20..60 preferred (tolerance 40..65 not used here, keep strict)
  if (!title) { fieldsScore -= 4; fieldsIssues.push({ code: 'title_missing' }); }
  else {
    if (!inRange(title.length, 20, 60)) { fieldsScore -= 2; fieldsIssues.push({ code: 'title_len_out' }); }
    if (isPlaceholderText(title)) { fieldsScore -= 4; fieldsIssues.push({ code: 'title_placeholder' }); }
  }

  // meta 70..170
  if (!meta) { fieldsScore -= 4; fieldsIssues.push({ code: 'meta_missing' }); }
  else {
    if (!inRange(meta.length, 70, 170)) { fieldsScore -= 2; fieldsIssues.push({ code: 'meta_len_out' }); }
    if (isPlaceholderText(meta)) { fieldsScore -= 3; fieldsIssues.push({ code: 'meta_placeholder' }); }
  }

  // indexable
  if (!indexable) { fieldsScore -= 6; fieldsIssues.push({ code: 'noindex' }); }

  // h1
  if (h1c !== 1) { fieldsScore -= 2; fieldsIssues.push({ code: 'h1_not_single' }); }
  if (h1 && isPlaceholderText(h1)) { fieldsScore -= 3; fieldsIssues.push({ code: 'h1_placeholder' }); }

  // canonical present
  if (!canonical) { fieldsScore -= 1; fieldsIssues.push({ code: 'canonical_missing' }); }

  // title != meta (avoid duplicates)
  if (title && meta && title.toLowerCase() === meta.toLowerCase()) { fieldsScore -= 1; fieldsIssues.push({ code: 'title_meta_duplicate' }); }

  // slug not empty (if provided)
  if (opts && 'slug' in opts) {
    if (!slug) { fieldsScore -= 1; fieldsIssues.push({ code: 'slug_missing' }); }
  }

  fieldsScore = Math.max(0, Math.min(20, fieldsScore));

  return {
    score,
    issues,
    seo_fields_score: fieldsScore,
    fields_issues: fieldsIssues,
    metrics: {
      title_len: title.length,
      meta_len: meta.length,
      h1_count: h1c,
      indexable,
      text_len,
      has_canonical: Boolean(canonical),
      robots
    }
  };
}

/**
 * Convenience helper: score with partial field overrides.
 * Useful to estimate "after" score without re-crawling the page.
 */
export function scoreFromSignalsWithOverrides(sig, overrides = {}, opts = {}) {
  const merged = {
    ...(sig || {}),
    ...(overrides || {})
  };
  return scoreFromSignals(merged, opts);
}
