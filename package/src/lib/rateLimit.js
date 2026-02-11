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
      return (Array.isArray(k) ? k[0] : k) || req.ip;
    },
    handler: (req, res) => res.status(429).json({ ok: false, error: { code: 'rate_limited', message: 'Too many requests' } }),
  });
}
