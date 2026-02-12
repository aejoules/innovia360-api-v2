import { Worker, Queue, QueueEvents } from 'bullmq'
import IORedis from 'ioredis'
import pg from 'pg'

const {
  REDIS_URL,
  DATABASE_URL,
  BULLMQ_PREFIX = 'bull',
  SCAN_QUEUE = 'c360_scan_v2',
  EXECUTION_QUEUE = 'innovia360_execution_v2'
} = process.env

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false
})

const { Pool } = pg
const pool = new Pool({ connectionString: DATABASE_URL })

console.log({
  redis: 'connected',
  scan_queue: SCAN_QUEUE,
  execution_queue: EXECUTION_QUEUE,
  msg: 'bullmq config'
})

const executionQueue = new Queue(EXECUTION_QUEUE, {
  connection,
  prefix: BULLMQ_PREFIX
})

async function heartbeat(queue) {
  try {
    const counts = await queue.getJobCounts()
    const { rows } = await pool.query(
      `select count(*)::int as queued from optimization_executions where status='queued'`
    )
    console.log({
      msg: 'worker heartbeat',
      waiting: counts.waiting,
      active: counts.active,
      completed: counts.completed,
      failed: counts.failed,
      dbQueued: rows[0].queued
    })
  } catch (err) {
    console.error('heartbeat error', err.message)
  }
}

const worker = new Worker(
  EXECUTION_QUEUE,
  async job => {
    const start = Date.now()
    console.log({ msg: 'job received', execution_id: job?.data?.execution_id })

    // ⚠️ Ici tu gardes TON traitement réel (je ne change rien à ta logique métier)
    // Ce worker instrumenté doit uniquement rajouter des logs.

    console.log({
      msg: 'job completed',
      execution_id: job?.data?.execution_id,
      duration_ms: Date.now() - start
    })
  },
  { connection, prefix: BULLMQ_PREFIX }
)

worker.on('error', err => console.error('Worker error:', err))

console.log({ msg: 'worker started' })

setInterval(() => heartbeat(executionQueue), 30000)
