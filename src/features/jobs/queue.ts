import 'server-only';
import { Queue } from 'bullmq';
import { redisConnection } from '@/lib/redis';
import type { NicheHuntParams } from '@/features/discovery/pipeline';

/**
 * Server-only — the `server-only` import above is a build-time guard against
 * this ever landing in a client bundle by mistake. The API route enqueues
 * here; the worker process (started via
 * `task product-intelligence-engine:worker`, see src/features/jobs/worker.ts)
 * is what actually calls the pipeline. Nothing in src/app/api ever imports
 * pipeline.ts directly — long research work must never run inline inside an
 * HTTP request (spec section 16).
 */
export const RESEARCH_RUN_QUEUE_NAME = 'researchRunQueue';

export const NICHE_HUNT_JOB_NAME = 'niche-hunt';

export type NicheHuntJobData = NicheHuntParams;

const globalForQueue = globalThis as unknown as {
  researchRunQueue: Queue<NicheHuntJobData> | undefined;
};

/**
 * Lazily constructs the Queue on first use rather than at module load.
 * BullMQ opens a real Redis connection (and checks the server version) as
 * soon as a Queue is constructed. Doing that at module scope would mean
 * `next build`'s page-data collection — which loads every route module to
 * inspect its exports — touches a live Redis connection. Deferring
 * construction until a request actually enqueues a job keeps the build
 * independent of whether Redis is reachable (or new enough) at build time.
 */
function getResearchRunQueue(): Queue<NicheHuntJobData> {
  if (!globalForQueue.researchRunQueue) {
    globalForQueue.researchRunQueue = new Queue<NicheHuntJobData>(RESEARCH_RUN_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });
  }
  return globalForQueue.researchRunQueue;
}

export async function enqueueNicheHunt(data: NicheHuntJobData): Promise<void> {
  await getResearchRunQueue().add(NICHE_HUNT_JOB_NAME, data, {
    jobId: data.runId,
  });
}
