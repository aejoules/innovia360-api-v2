import { Queue } from 'bullmq';
import { getRedis } from './redis.js';

export const SCAN_QUEUE_NAME = 'c360_scan_v2';

export function getScanQueue() {
  const connection = getRedis();
  return new Queue(SCAN_QUEUE_NAME, { connection });
}
