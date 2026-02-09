import { Router } from 'express';
import { validateBody } from '../../lib/validate.js';
import { getSiteByUrl } from '../../services/siteService.js';
import { createScanJob, getScan } from '../../services/scanService.js';

const r = Router();

r.post('/scan/start',
  validateBody('https://innovia360.dev/schemas/v2/scan-start-request.schema.json'),
  async (req, res, next) => {
    try {
      const tenant_id = req.ctx?.tenant_id;
      const { site_url, type, scope, execution_ref, apply_ref } = req.body;

      const site = await getSiteByUrl(tenant_id, site_url);
      if (!site) return res.status(404).json({ ok: false, error: { code: 'site_not_found', message: 'Site not registered. Call /v2/inventory/sync first.' } });

      const job_id = await createScanJob(site.id, type, scope, { execution_ref, apply_ref });
      return res.json({ ok: true, job_id, status: 'queued' });
    } catch (e) {
      return next(e);
    }
  }
);

r.get('/scans/:job_id', async (req, res, next) => {
  try {
    const scan = await getScan(req.params.job_id);
    if (!scan) return res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Scan not found' } });
    return res.json({ ok: true, scan });
  } catch (e) {
    return next(e);
  }
});

export default r;
