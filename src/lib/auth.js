import crypto from 'crypto';
import { withClient } from './db.js';

/**
 * DB-only SaaS auth.
 * Header: x-api-key: <raw_api_key>
 * Stored: public.tenant_api_keys.key_hash = sha256:<hex>
 */
function sha256Key(raw) {
  const hex = crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

export function requireApiKey() {
  return async (req, res, next) => {
    try {
      // Accept API key from:
      // - header: x-api-key: <key>
      // - header: Authorization: Bearer <key>
      // - query:  ?api_key=<key>
      const hApiKey = req.headers['x-api-key'];
      const apiKeyFromHeader = Array.isArray(hApiKey) ? hApiKey[0] : hApiKey;

      const hAuth = req.headers['authorization'] || req.headers['Authorization'];
      const auth = Array.isArray(hAuth) ? hAuth[0] : hAuth;
      const apiKeyFromBearer = (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer '))
        ? auth.slice(7).trim()
        : null;

      const apiKeyFromQuery = req.query?.api_key ? String(req.query.api_key) : null;

      const apiKey = apiKeyFromHeader || apiKeyFromBearer || apiKeyFromQuery;
      if (!apiKey) {
        return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Missing API key' } });
      }

      const keyHash = sha256Key(apiKey);

      const row = await withClient(async (c) => {
        const r = await c.query(
          `SELECT id, tenant_id, is_enabled
           FROM public.tenant_api_keys
           WHERE key_hash=$1
           LIMIT 1`,
          [keyHash]
        );
        return r.rows[0] || null;
      });

      if (!row || !row.is_enabled) {
        return res.status(401).json({ ok: false, error: { code: 'unauthorized', message: 'Invalid API key' } });
      }

      // touch last_used_at (non-blocking)
      withClient(async (c) => {
        await c.query('UPDATE public.tenant_api_keys SET last_used_at=now() WHERE id=$1', [row.id]);
      }).catch(() => {});

      req.ctx = req.ctx || {};
      req.ctx.tenant_id = row.tenant_id;
      req.ctx.api_key_id = row.id;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
