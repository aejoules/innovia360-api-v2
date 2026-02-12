import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { withClient } from './db.js';
import { withAdvisoryLock } from './locks.js';
import { sha256 } from './hash.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Enterprise migrations runner.
 * - Applies ./migrations/*.sql in lexical order.
 * - Tracks applied migrations in public.schema_migrations (version, checksum).
 * - Uses advisory lock to avoid concurrent migration runs.
 */
export async function migrate() {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  if (files.length === 0) {
    logger.warn('no migrations found');
    return;
  }

  await withClient(async (client) => {
    await withAdvisoryLock(client, 8812367123n, async () => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations(
          version text PRIMARY KEY,
          checksum text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )
      `);

      for (const file of files) {
        const version = file;
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        const checksum = sha256(sql);

        const existing = await client.query(
          'SELECT version, checksum FROM public.schema_migrations WHERE version=$1',
          [version]
        );

        if (existing.rowCount > 0) {
          if (existing.rows[0].checksum !== checksum) {
            throw new Error(`migration checksum mismatch: ${version}`);
          }
          continue;
        }

        logger.info({ version }, 'applying migration');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO public.schema_migrations(version, checksum) VALUES($1,$2)', [version, checksum]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        }
      }
    });
  });
}
