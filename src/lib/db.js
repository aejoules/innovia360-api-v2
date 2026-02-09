import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;
let pool;

export function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  pool = new Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });
  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  return pool;
}

export async function withClient(fn) {
  const p = getPool();
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function pingDb() {
  return withClient(async (c) => {
    const r = await c.query('SELECT 1 as ok');
    return r.rows?.[0]?.ok === 1;
  });
}
