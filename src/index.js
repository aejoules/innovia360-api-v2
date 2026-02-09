import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpLogger, logger } from './lib/logger.js';
import { loadSchemas } from './lib/validate.js';
import { migrate } from './lib/migrate.js';
import { requireApiKey } from './lib/auth.js';
import { apiRateLimit } from './lib/rateLimit.js';
import { pingDb } from './lib/db.js';

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
app.use(express.json({ limit: '10mb' }));
app.use(httpLogger);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// IMPORTANT (ESM): routes import-time validation requires schemas to be loaded
// BEFORE routers are imported. We therefore load schemas first, then dynamically
// import routers after.
loadSchemas(path.resolve(__dirname, './schemas/v2'));

if ((process.env.MIGRATE_ON_BOOT || 'true') === 'true') {
  migrate().catch((e) => {
    logger.error({ err: e }, 'migration failed on boot');
    process.exit(1);
  });
}

app.get('/health', async (_req, res) => {
  const db_ok = await pingDb().catch(() => false);
  res.json({ ok: true, service: 'innovia360-api-v2', db_ok, ts: new Date().toISOString() });
});

// Auth + rate limit for v2
app.use('/v2', apiRateLimit(), requireApiKey());

// Routers are imported after schemas are loaded (ESM import order)
const { default: inventoryRouter } = await import('./routes/v2/inventory.js');
const { default: optimizationsRouter } = await import('./routes/v2/optimizations.js');
const { default: scanRouter } = await import('./routes/v2/scan.js');

app.use('/v2', inventoryRouter);
app.use('/v2', optimizationsRouter);
app.use('/v2', scanRouter);

app.use((err, _req, res, _next) => {
  logger.error({ err }, 'unhandled');
  res.status(500).json({ ok: false, error: { code: 'internal_error', message: 'Unexpected error' } });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => logger.info({ port }, 'web server started'));
