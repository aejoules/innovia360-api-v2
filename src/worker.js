import { Worker, QueueEvents, Queue } from 'bullmq'
import IORedis from 'ioredis'
import pg from 'pg'

const {
  REDIS_URL,
  DATABASE_URL,
  BULLMQ_PREFIX = 'bull',
  SCAN_QUEUE = 'c360_scan_v2',
  EXECUTION_QUEUE = 'innovia360_execution_v2'
} = process.env

const connection = new IORedis(REDIS_URL)

const { Pool } = pg
const pool = new Pool({ connectionString: DATABASE_URL })

console.log({
  redis: 'connected',
  scan_queue: SCAN_QUEUE,
  execution_queue: EXECUTION_QUEUE,
  msg: 'bullmq config'
})

/* ===============================
   HEARTBEAT (toutes les 30s)
================================= */
async function heartbeat(queue) {
  try {
    const counts = await queue.getJobCounts()

    const { rows } = await pool.query(
      `select count(*) as queued
       from optimization_executions
       where status='queued'`
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

/* ===============================
   JOB PROCESSOR
================================= */

const executionQueue = new Queue(EXECUTION_QUEUE, {
  connection,
  prefix: BULLMQ_PREFIX
})

const worker = new Worker(
  EXECUTION_QUEUE,
  async job => {
    const start = Date.now()
    console.log({ msg: 'job received', execution_id: job.data.execution_id })

    try {
      const executionId = job.data.execution_id

      await pool.query(
        `update optimization_executions
         set status='running'
         where execution_id=$1`,
        [executionId]
      )

      // >>> ICI ton traitement IA réel <<<
      // simulate work
      await new Promise(resolve => setTimeout(resolve, 3000))

      await pool.query(
        `update optimization_executions
         set status='done', progress=100, ended_at=now()
         where execution_id=$1`,
        [executionId]
      )

      console.log({
        msg: 'job completed',
        execution_id: executionId,
        duration_ms: Date.now() - start
      })

    } catch (err) {
      console.error({
        msg: 'job failed',
        execution_id: job.data.execution_id,
        error: err.message
      })

      await pool.query(
        `update optimization_executions
         set status='failed'
         where execution_id=$1`,
        [job.data.execution_id]
      )
    }
  },
  {
    connection,
    prefix: BULLMQ_PREFIX
  }
)

worker.on('error', err => {
  console.error('Worker error:', err)
})

console.log({ msg: 'worker started' })

/* ===============================
   HEARTBEAT LOOP
================================= */

setInterval(() => {
  heartbeat(executionQueue)
}, 30000)
