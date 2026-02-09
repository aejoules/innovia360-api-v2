import { Queue } from 'bullmq';
import { getRedis } from './redis.js';

export const EXECUTION_QUEUE_NAME = 'innovia360_execution_v2';

export function getExecutionQueue() {
  const connection = getRedis();
  return new Queue(EXECUTION_QUEUE_NAME, { connection });
}
