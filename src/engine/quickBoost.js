import { clamp } from './utils.js';

function pickKeyword(entity, signals) {
  // V0 heuristic: first strong token from title
  const t = (entity?.title || signals?.title || '').toLowerCase();
  const words = t.replace(/[^a-z0-9\s\-]/g, ' ').split(/\s+/).filter(w => w.length >= 4);
  return words[0] || null;
}

export function quickBoost({ entity, signals }) {
  const baseTitle = (signals?.title || entity?.title || '').trim();
  const baseMeta = (signals?.meta_description || '').trim();

  const focus_keyword = pickKeyword(entity, signals);

  const afterSeoTitle = clamp(baseTitle, 60) || clamp(entity?.title || '', 60);
  const afterMeta = clamp(baseMeta || entity?.excerpt || baseTitle, 155);

  // robots: do not override noindex
  const robots = signals?.robots || 'index,follow';

  return {
    seo: {
      title: afterSeoTitle,
      meta_description: afterMeta,
      focus_keyword,
      robots,
      canonical: signals?.canonical || entity?.canonical || entity?.permalink || null
    },
    core: {
      post_title: clamp(entity?.title || afterSeoTitle, 70),
      post_excerpt: clamp(entity?.excerpt || afterMeta, 160)
    }
  };
}
