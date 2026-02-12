import rateLimit from 'express-rate-limit';

export function apiRateLimit() {
  const rpm = Number(process.env.RATE_LIMIT_RPM || 120);
  return rateLimit({
    windowMs: 60_000,
    limit: rpm,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const k = req.headers['x-api-key'];
      const hKey = (Array.isArray(k) ? k[0] : k);

      const auth = req.headers['authorization'];
      const hAuth = (Array.isArray(auth) ? auth[0] : auth);
      const bearer = (hAuth && String(hAuth).toLowerCase().startsWith('bearer '))
        ? String(hAuth).slice(7).trim()
        : null;

      const qKey = req.query?.api_key ? String(req.query.api_key) : null;

      return hKey || bearer || qKey || req.ip;
    },
    handler: (req, res) => res.status(429).json({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } }),
  });
}
