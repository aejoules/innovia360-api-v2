import IORedis from 'ioredis';

let redis;
export function getRedis() {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is required');
  redis = new IORedis(url, { maxRetriesPerRequest: null });
  return redis;
}
