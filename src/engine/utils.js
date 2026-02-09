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

export function scoreFromSignals(sig) {
  let score = 100;
  const issues = [];

  const title = (sig?.title || '').trim();
  const meta = (sig?.meta_description || '').trim();
  const h1c = Number(sig?.h1_count || 0);

  if (!title) { score -= 20; issues.push({ code: 'title_missing', field: 'title' }); }
  if (title.length > 65) { score -= 8; issues.push({ code: 'title_too_long', field: 'title' }); }
  if (title.length < 20) { score -= 6; issues.push({ code: 'title_too_short', field: 'title' }); }

  if (!meta) { score -= 15; issues.push({ code: 'meta_missing', field: 'meta_description' }); }
  if (meta && meta.length < 80) { score -= 6; issues.push({ code: 'meta_too_short', field: 'meta_description' }); }
  if (meta && meta.length > 165) { score -= 6; issues.push({ code: 'meta_too_long', field: 'meta_description' }); }

  if (h1c === 0) { score -= 8; issues.push({ code: 'h1_missing', field: 'h1' }); }
  if (h1c > 1) { score -= 5; issues.push({ code: 'h1_multiple', field: 'h1' }); }

  if (sig?.robots === 'noindex,nofollow') { score -= 30; issues.push({ code: 'noindex', field: 'robots' }); }

  score = Math.max(0, Math.min(100, score));
  return { score, issues };
}
