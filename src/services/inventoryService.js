import { withClient } from '../lib/db.js';
import { entityContentHash } from '../lib/hash.js';

/**
 * InventoryService
 * - Upsert by (site_id, wp_id, lang)
 * - Hash = sha1:... if not provided
 */

export async function upsertInventoryBatch(site_id, entities) {
  if (!entities || entities.length === 0) return { upserted: 0 };

  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      for (const e of entities) {
        const content_hash = e.content_hash || entityContentHash(e);
        await c.query(
          `INSERT INTO public.wp_inventory_entities(
             site_id, wp_id, entity_type, post_type, status, lang,
             translation_group_id, source_wp_id,
             slug, permalink, canonical,
             title, excerpt, content_hash, modified_gmt,
             wc, public_hints
           )
           VALUES (
             $1,$2,$3,$4,$5,$6,
             $7,$8,
             $9,$10,$11,
             $12,$13,$14,$15,
             $16::jsonb,$17::jsonb
           )
           ON CONFLICT (site_id, wp_id, lang)
           DO UPDATE SET
             entity_type = EXCLUDED.entity_type,
             post_type   = EXCLUDED.post_type,
             status      = EXCLUDED.status,
             translation_group_id = EXCLUDED.translation_group_id,
             source_wp_id = EXCLUDED.source_wp_id,
             slug        = EXCLUDED.slug,
             permalink   = EXCLUDED.permalink,
             canonical   = EXCLUDED.canonical,
             title       = EXCLUDED.title,
             excerpt     = EXCLUDED.excerpt,
             content_hash= EXCLUDED.content_hash,
             modified_gmt= EXCLUDED.modified_gmt,
             wc          = EXCLUDED.wc,
             public_hints= EXCLUDED.public_hints,
             updated_at  = now()`,
          [
            site_id,
            e.wp_id,
            e.entity_type,
            e.post_type,
            e.status,
            e.lang,
            e.translation_group_id ?? null,
            e.source_wp_id ?? null,
            e.slug ?? null,
            e.permalink,
            e.canonical ?? null,
            e.title ?? null,
            e.excerpt ?? null,
            content_hash,
            e.modified_gmt,
            e.wc ? JSON.stringify(e.wc) : null,
            e.public ? JSON.stringify(e.public) : null
          ]
        );
      }
      await c.query('COMMIT');
      return { upserted: entities.length };
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  });
}

export async function loadInventorySlice(site_id, scope = {}, filters = {}) {
  const entityTypes = (scope.entity_types && scope.entity_types.length) ? scope.entity_types : null;
  const langs = (scope.langs && scope.langs.length) ? scope.langs : (scope.lang ? [scope.lang] : null);
  const statuses = (filters.statuses && filters.statuses.length) ? filters.statuses : null;
  const onlyWpIds = (filters.only_wp_ids && filters.only_wp_ids.length) ? filters.only_wp_ids : null;
  const cursorWpId = filters.cursor_wp_id ?? null;
  const limit = Math.min(Number(filters.limit || 50), 500);

  return withClient(async (c) => {
    const r = await c.query(
      `SELECT
         wp_id, entity_type, post_type, status, lang,
         translation_group_id, source_wp_id,
         slug, permalink, canonical,
         title, excerpt, content_hash, modified_gmt,
         wc, public_hints
       FROM public.wp_inventory_entities
       WHERE site_id = $1
         AND ($2::text[] IS NULL OR entity_type = ANY($2))
         AND ($3::text[] IS NULL OR lang = ANY($3))
         AND ($4::text[] IS NULL OR status = ANY($4))
         AND ($5::int[]  IS NULL OR wp_id = ANY($5))
         AND ($6::int IS NULL OR wp_id > $6)
       ORDER BY wp_id ASC
       LIMIT $7`,
      [site_id, entityTypes, langs, statuses, onlyWpIds, cursorWpId, limit]
    );
    return r.rows;
  });
}
