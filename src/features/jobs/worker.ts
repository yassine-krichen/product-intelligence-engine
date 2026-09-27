import { Worker, type Job } from 'bullmq';
import { redisConnection } from '@/lib/redis';
import { prisma } from '@/lib/prisma';
import { runNicheHunt } from '@/features/discovery/pipeline';
import {
  RESEARCH_RUN_QUEUE_NAME,
  NICHE_HUNT_JOB_NAME,
  type NicheHuntJobData,
} from './queue';

/**
 * Standalone worker process entrypoint — started via
 * `task product-intelligence-engine:worker` (runs `tsx watch` against this
 * file, foreground). Not started by `next dev`/`next start`: background
 * research work must run in its own process, never inline in an HTTP
 * request (spec section 16).
 */
const worker = new Worker<NicheHuntJobData>(
  RESEARCH_RUN_QUEUE_NAME,
  async (job: Job<NicheHuntJobData>) => {
    if (job.name !== NICHE_HUNT_JOB_NAME) {
      throw new Error(`Unknown job name: ${job.name}`);
    }
    await runNicheHunt(job.data);
  },
  { connection: redisConnection, concurrency: 2 }
);

worker.on('completed', (job) => {
  console.info(`[worker] research run completed`, { runId: job.data.runId });
});

worker.on('failed', async (job, error) => {
  // S5 fix: BullMQ fires 'failed' after EVERY failed attempt, not just the
  // last one — this job has `attempts: 2` (see queue.ts) with a backoff, so
  // marking the ResearchRun FAILED on the first attempt raced with (and
  // could permanently overwrite) the retry that was about to succeed. Only
  // the final attempt gets to write a terminal FAILED status.
  const attemptsMade = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts.attempts ?? 1;
  const isFinalAttempt = attemptsMade >= maxAttempts;

  console.error(`[worker] research run attempt failed`, {
    runId: job?.data.runId,
    attemptsMade,
    maxAttempts,
    isFinalAttempt,
    message: error.message,
  });

  // Best-effort: mark the run FAILED even if the pipeline crashed before it
  // could update its own status (e.g. a bug outside runNicheHunt's own
  // try/catch boundaries) — but only once retries are exhausted.
  if (job?.data.runId && isFinalAttempt) {
    await prisma.researchRun
      .update({
        where: { id: job.data.runId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errors: [{ source: 'worker', message: error.message, occurredAt: new Date().toISOString() }],
        },
      })
      .catch((updateError) => {
        console.error('[worker] failed to record FAILED status', updateError);
      });
  }
});

console.info(`[worker] listening on queue "${RESEARCH_RUN_QUEUE_NAME}"`);

async function shutdown(): Promise<void> {
  console.info('[worker] shutting down');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
