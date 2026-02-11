import IORedis from 'ioredis';

let redis;
export function getRedis() {
  if (redis) return redis;
  const url = process.env.REDIS_URL
    || process.env.REDIS_TLS_URL
    || process.env.REDIS_INTERNAL_URL
    || process.env.REDIS_CONNECTION_STRING;

  if (!url) {
    throw new Error('Redis URL is required (set REDIS_URL or REDIS_INTERNAL_URL or REDIS_TLS_URL)');
  }

  // Render may provide either redis:// or rediss:// URLs.
  // maxRetriesPerRequest=null recommended for BullMQ.
  redis = new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
  return redis;
}
