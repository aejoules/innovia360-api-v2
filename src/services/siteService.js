import { withClient } from '../lib/db.js';

/**
 * SiteService (tenant-aware)
 */

export async function getSiteByUrl(tenant_id, site_url) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM public.sites WHERE tenant_id=$1 AND site_url=$2 LIMIT 1`,
      [tenant_id, site_url]
    );
    return r.rows[0] || null;
  });
}

export async function getSiteById(tenant_id, site_id) {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT * FROM public.sites WHERE tenant_id=$1 AND id=$2 LIMIT 1`,
      [tenant_id, site_id]
    );
    return r.rows[0] || null;
  });
}

export async function upsertSite(tenant_id, site_url, meta = {}) {
  const {
    cms = 'wordpress',
    timezone = 'UTC',
    plugin,
    plugin_version,
    connectors = [],
    wc_enabled = false,
    wc_version = null,
    multilang_enabled = false,
    multilang_provider = 'none'
  } = meta;

  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO public.sites(
         tenant_id, site_url, cms, timezone,
         plugin, plugin_version, connectors,
         wc_enabled, wc_version,
         multilang_enabled, multilang_provider
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7::text[],$8,$9,$10,$11)
       ON CONFLICT (tenant_id, site_url)
       DO UPDATE SET
         cms=EXCLUDED.cms,
         timezone=EXCLUDED.timezone,
         plugin=EXCLUDED.plugin,
         plugin_version=EXCLUDED.plugin_version,
         connectors=EXCLUDED.connectors,
         wc_enabled=EXCLUDED.wc_enabled,
         wc_version=EXCLUDED.wc_version,
         multilang_enabled=EXCLUDED.multilang_enabled,
         multilang_provider=EXCLUDED.multilang_provider,
         updated_at=now()
       RETURNING *`,
      [tenant_id, site_url, cms, timezone, plugin || null, plugin_version || null, connectors, wc_enabled, wc_version, multilang_enabled, multilang_provider]
    );
    return r.rows[0];
  });
}
