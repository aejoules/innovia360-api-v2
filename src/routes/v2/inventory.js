import { Router } from 'express';
import { validateBody } from '../../lib/validate.js';
import { upsertSite } from '../../services/siteService.js';
import { upsertInventoryBatch } from '../../services/inventoryService.js';

const r = Router();

r.post('/inventory/sync',
  validateBody('https://innovia360.dev/schemas/v2/inventory-sync-request.schema.json'),
  async (req, res, next) => {
    try {
      const tenant_id = req.ctx?.tenant_id;
      const s = req.body.site;

      const site = await upsertSite(tenant_id, s.site_url, {
        cms: s.cms,
        timezone: s.timezone,
        plugin: s.plugin,
        plugin_version: s.plugin_version,
        connectors: s.connectors || [],
        wc_enabled: Boolean(s.wc?.enabled),
        wc_version: s.wc?.version || null,
        multilang_enabled: Boolean(s.multilang?.enabled),
        multilang_provider: s.multilang?.provider || 'none'
      });

      const out = await upsertInventoryBatch(site.id, req.body.entities);

      return res.json({
        ok: true,
        site_id: site.id,
        received: { entities: req.body.entities.length },
        upserted: out.upserted,
        batch: req.body.batch
      });
    } catch (e) {
      return next(e);
    }
  }
);

export default r;
