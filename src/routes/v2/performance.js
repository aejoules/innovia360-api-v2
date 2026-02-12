import { Router } from 'express';
import { listOpportunities } from '../../services/performanceService.js';

const r = Router();

/**
 * GET /v2/performance/opportunities
 * Query:
 *  - site_url (required)
 *  - limit (optional, default 50)
 *  - lang (optional)
 *
 * Works out-of-the-box (no external connectors required).
 */
r.get('/performance/opportunities', async (req, res, next) => {
  try {
    const tenant_id = req.ctx?.tenant_id;
    const site_url = req.query?.site_url ? String(req.query.site_url) : '';
    const limit = req.query?.limit ? Number(req.query.limit) : 50;
    const lang = req.query?.lang ? String(req.query.lang) : null;

    if (!site_url) {
      return res.status(400).json({ ok: false, error: { code: 'bad_request', message: 'site_url is required' } });
    }

    const out = await listOpportunities({ tenant_id, site_url, limit, lang });
    if (!out.site_id) {
      return res.status(404).json({ ok: false, error: { code: 'site_not_found', message: 'Site not registered. Call /v2/inventory/sync first.' } });
    }

    return res.json({ ok: true, site_id: out.site_id, items: out.items, meta: out.meta });
  } catch (e) {
    return next(e);
  }
});

export default r;
