import { prisma } from '@/lib/prisma';
import { hnAdapter } from './adapters/hn.adapter';
import { DISCOVERY_LIMIT, groupByNormalizedName, runNicheHunt } from './pipeline';

export interface DryRunCandidate {
  name: string;
  normalizedName: string;
  signals: Array<{
    externalId: string;
    url: string;
    observedAt: string;
    metrics: Record<string, number>;
  }>;
}

/** Live HN fetch + normalization with no database access: proves the source path works without a DATABASE_URL. */
export async function dryRunHnHunt(
  niche: string
): Promise<{ niche: string; candidateCount: number; dropped: number; candidates: DryRunCandidate[] }> {
  const { items } = await hnAdapter.discover({ niche, limit: DISCOVERY_LIMIT });
  const { groups, dropped } = groupByNormalizedName(items);

  return {
    niche,
    candidateCount: groups.length,
    dropped: dropped.length,
    candidates: groups.map((group) => ({
      name: group.canonicalName,
      normalizedName: group.normalizedName,
      signals: group.items.map((item) => ({
        externalId: item.externalId,
        url: item.url,
        observedAt: item.observedAt.toISOString(),
        metrics: item.metrics,
      })),
    })),
  };
}

export interface HnHuntResult {
  runId: string;
  status: string;
  candidateCount: number;
  errors: unknown;
}

/** Runs the existing HN pipeline in-process (no queue/Redis): create a PENDING run, execute it, read the outcome back. */
export async function runHnHunt(niche: string): Promise<HnHuntResult> {
  const run = await prisma.researchRun.create({
    data: { niche, sources: ['HACKER_NEWS'], status: 'PENDING' },
    select: { id: true },
  });

  await runNicheHunt({ runId: run.id, niche });

  const finished = await prisma.researchRun.findUniqueOrThrow({
    where: { id: run.id },
    select: { status: true, candidateCount: true, errors: true },
  });
  return {
    runId: run.id,
    status: finished.status,
    candidateCount: finished.candidateCount,
    errors: finished.errors,
  };
}
