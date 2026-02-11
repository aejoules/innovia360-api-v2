import { request } from 'undici';
import * as cheerio from 'cheerio';

const DEFAULT_TIMEOUT_MS = Number(process.env.CRAWLER_TIMEOUT_MS || 15000);
const MAX_REDIRECTS = Number(process.env.CRAWLER_MAX_REDIRECTS || 5);
const UA = process.env.CRAWLER_UA || 'Innovia360Bot/1.0';

function normalizeRobots(value) {
  const v = (value || '').toLowerCase().replace(/\s+/g, '');
  if (!v) return 'index,follow';
  if (v.includes('noindex')) return 'noindex,nofollow';
  return 'index,follow';
}

function extractTextLen($) {
  const txt = $('body').text() || '';
  return txt.replace(/\s+/g, ' ').trim().length;
}

export async function crawlPublic(url) {
  const startedAt = Date.now();
  let current = url;
  let redirects = 0;

  while (true) {
    const res = await request(current, {
      method: 'GET',
      maxRedirections: 0,
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml'
      },
      bodyTimeout: DEFAULT_TIMEOUT_MS,
      headersTimeout: DEFAULT_TIMEOUT_MS
    });

    const status = res.statusCode;
    const loc = res.headers.location;

    if ([301, 302, 303, 307, 308].includes(status) && loc && redirects < MAX_REDIRECTS) {
      redirects += 1;
      current = new URL(loc, current).toString();
      continue;
    }

    const html = await res.body.text();
    const $ = cheerio.load(html);

    const title = ($('title').first().text() || '').trim();
    const metaDesc = ($('meta[name="description"]').attr('content') || '').trim();
    const canonical = ($('link[rel="canonical"]').attr('href') || '').trim() || null;
    const robotsRaw = ($('meta[name="robots"]').attr('content') || '').trim();
    const robots = normalizeRobots(robotsRaw);

    const h1 = $('h1').map((_, el) => $(el).text().trim()).get().filter(Boolean);
    const h1_count = h1.length;

    const text_len = extractTextLen($);
    const indexable = status === 200 && robots !== 'noindex,nofollow';

    return {
      url: current,
      http_status: status,
      timing_ms: Date.now() - startedAt,
      signals: {
        title,
        meta_description: metaDesc,
        canonical,
        robots,
        h1,
        h1_count,
        text_len,
        indexable
      }
    };
  }
}
