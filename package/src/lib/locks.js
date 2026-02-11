// Postgres advisory lock to avoid concurrent migrations on multi-instance deployments.
export async function withAdvisoryLock(pgClient, lockKeyBigint, fn) {
  await pgClient.query('SELECT pg_advisory_lock($1)', [lockKeyBigint]);
  try {
    return await fn();
  } finally {
    await pgClient.query('SELECT pg_advisory_unlock($1)', [lockKeyBigint]);
  }
}
