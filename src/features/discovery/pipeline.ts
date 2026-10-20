import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { computeScoresForProduct } from '@/features/scoring/score-dimensions';
import { hnAdapter } from './adapters/hn.adapter';
import { googleTrendsAdapter } from '@/features/trends/google-trends.adapter';
import { tiktokAdapter, amazonAdapter, aliexpressAdapter } from './adapters/stub.adapter';
import { normalizeTitle } from './normalize';
import type { DiscoveryInput, ProductSource, RawProduct, SourceHealth } from './source.types';

/**
 * DISCOVER -> NORMALIZE -> DEDUPLICATE -> ENRICH -> CALCULATE
 *
 * Only Hacker News is wired for automated discovery. Reddit's public .json
 * endpoints return 403 to unauthenticated clients (live-verified 2026-10-04,
 * see README), so Reddit/TikTok/Amazon evidence is recorded by the Claude Code
 * agent through the `pie` CLI instead. Google Trends measures a known keyword
 * rather than discovering candidates, so it is health-checked but not a
 * discovery source. The stub sources still appear in ALL_SOURCES so the
 * dashboard's source-health panel shows them as NOT_IMPLEMENTED rather than
 * silently pretending they don't exist.
 */
const DISCOVERY_SOURCES: ProductSource[] = [hnAdapter];
/** Max candidates one adapter call returns per hunt. */
export const DISCOVERY_LIMIT = 25;
export const ALL_SOURCES: ProductSource[] = [
  hnAdapter,
  googleTrendsAdapter,
  tiktokAdapter,
  amazonAdapter,
  aliexpressAdapter,
];

export interface NicheHuntParams {
  runId: string;
  niche: string;
}

interface RunErrorEntry {
  source: string;
  message: string;
  occurredAt: string;
}

interface CandidateGroup {
  normalizedName: string;
  canonicalName: string;
  items: RawProduct[];
}

export async function checkAllSourcesHealth(): Promise<SourceHealth[]> {
  return Promise.all(ALL_SOURCES.map((source) => source.healthCheck()));
}

/**
 * DISCOVER: run every source adapter independently. One adapter throwing
 * must never abort the run (spec section 14) — failures are collected as
 * data, not raised.
 */
export async function discoverFromSources(
  sources: ProductSource[],
  input: DiscoveryInput
): Promise<{ rawProducts: RawProduct[]; errors: RunErrorEntry[] }> {
  const rawProducts: RawProduct[] = [];
  const errors: RunErrorEntry[] = [];

  const results = await Promise.allSettled(
    sources.map((source) => source.discover(input))
  );

  results.forEach((result, index) => {
    const source = sources[index]!;
    if (result.status === 'fulfilled') {
      rawProducts.push(...result.value.items);
      // S6 fix: a source can succeed overall while still losing part of its
      // own input (e.g. one of several sub-requests failing).
      // Those partial failures are data gaps too (spec section 2/14) — fold
      // them into the same `errors` trail as a full adapter failure instead
      // of leaving them to only reach a `console.warn` no one downstream
      // ever sees.
      for (const warning of result.value.warnings) {
        errors.push({
          source: source.id,
          message: warning.message,
          occurredAt: new Date().toISOString(),
        });
      }
    } else {
      errors.push({
        source: source.id,
        message:
          result.reason instanceof Error ? result.reason.message : 'Unknown discovery error',
        occurredAt: new Date().toISOString(),
      });
    }
  });

  return { rawProducts, errors };
}

interface GroupingResult {
  groups: CandidateGroup[];
  /** Raw items whose title normalized to nothing (pure stopwords/punctuation) and were dropped. */
  dropped: RawProduct[];
}

/**
 * NORMALIZE + DEDUPLICATE: group raw signals by their normalized title.
 *
 * A title that normalizes to an empty string (pure stopwords/punctuation, or
 * non-Latin/accented text stripped by normalizeTitle's ASCII-only filter) is
 * dropped rather than grouped — but the drop is returned as data so the
 * caller can record it, instead of silently discarding a discovered item
 * with no trace (spec section 2: data gaps must be explicit, never silent).
 */
export function groupByNormalizedName(rawProducts: RawProduct[]): GroupingResult {
  const groups = new Map<string, CandidateGroup>();
  const dropped: RawProduct[] = [];

  for (const item of rawProducts) {
    const normalizedName = normalizeTitle(item.title);
    if (normalizedName.length === 0) {
      dropped.push(item);
      continue;
    }

    const existing = groups.get(normalizedName);
    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(normalizedName, {
        normalizedName,
        canonicalName: item.title.trim(),
        items: [item],
      });
    }
  }

  return { groups: [...groups.values()], dropped };
}

/**
 * Finds or creates the Product for a candidate group. `discoveredInRunId` is
 * only set at creation time, so re-running a hunt later updates a product's
 * signals without rewriting which run first surfaced it (spec definition of
 * done #12: "run the research again later and see what changed").
 *
 * Uses a single atomic `upsert` (S4 fix) rather than find-then-create: two
 * concurrent runs discovering the same product previously raced on the
 * `normalizedName` unique constraint (crashing whichever create lost) and
 * could lose one run's `sourceUrls` addition to the other's read-modify-write.
 * `sourceUrls: { push: ... }` compiles to `sourceUrls = sourceUrls || $1` in
 * the UPDATE statement — an atomic append, never a JS read-then-write — so
 * concurrent writers can't stomp each other. The tradeoff: this convenience
 * rollup field can accumulate duplicate URLs across many runs; that's
 * acceptable since it is explicitly documented (README) as a display
 * convenience, not the authoritative record — ProductSourceRecord (already
 * deduped via its own `(source, externalId)` unique constraint) is that.
 */
async function upsertProduct(group: CandidateGroup, runId: string, niche: string) {
  const newUrls = Array.from(new Set(group.items.map((item) => item.url)));

  return prisma.product.upsert({
    where: { normalizedName: group.normalizedName },
    create: {
      canonicalName: group.canonicalName,
      normalizedName: group.normalizedName,
      niche,
      sourceUrls: newUrls,
      discoveredInRunId: runId,
    },
    update: {
      sourceUrls: { push: newUrls },
    },
  });
}

/**
 * ENRICH: persists the ProductSourceRecord + DemandObservation for each raw
 * signal, then calls the owning adapter's enrich() to collect
 * ResearchEvidence. Each raw item is isolated in its own try/catch so one
 * bad enrich() call doesn't lose the rest of the group's data.
 *
 * `fetchedAt` is the owning ResearchRun's own `startedAt` — a single,
 * stable timestamp for every observation this run records (B1 fix: momentum
 * must be measured against when a value was FETCHED, never a post's own
 * creation time, and never a fresh `new Date()` per item, which would let
 * two metrics read off the very same fetch look like two points in a time
 * series). Being derived from the run row rather than computed here also
 * makes it stable across BullMQ retries of the same job, which is what lets
 * the upserts below use it as part of an idempotency key (S5).
 */
async function persistGroupObservations(
  productId: string,
  group: CandidateGroup,
  sourceById: Map<string, ProductSource>,
  fetchedAt: Date
): Promise<RunErrorEntry[]> {
  const errors: RunErrorEntry[] = [];

  for (const item of group.items) {
    try {
      await prisma.productSourceRecord.upsert({
        where: { source_externalId: { source: item.source, externalId: item.externalId } },
        update: {
          url: item.url,
          observedAt: item.observedAt,
          rawMetadata: item.raw as Prisma.InputJsonValue,
        },
        create: {
          productId,
          source: item.source,
          externalId: item.externalId,
          url: item.url,
          observedAt: item.observedAt,
          rawMetadata: item.raw as Prisma.InputJsonValue,
        },
      });

      for (const [metric, value] of Object.entries(item.metrics)) {
        await prisma.demandObservation.upsert({
          where: {
            demandObservation_naturalKey: {
              productId,
              source: item.source,
              sourceItemId: item.externalId,
              metric,
              observedAt: fetchedAt,
            },
          },
          update: {
            value,
            sourceCreatedAt: item.observedAt,
          },
          create: {
            productId,
            source: item.source,
            sourceItemId: item.externalId,
            metric,
            value,
            observedAt: fetchedAt,
            sourceCreatedAt: item.observedAt,
          },
        });
      }

      const adapter = sourceById.get(item.source);
      if (adapter) {
        const evidence = await adapter.enrich(item);
        for (const fact of evidence) {
          await prisma.researchEvidence.upsert({
            where: {
              researchEvidence_naturalKey: {
                productId,
                source: item.source,
                claim: fact.claim,
                observedAt: fact.observedAt,
              },
            },
            update: {
              value: fact.value,
              url: fact.url,
              confidence: fact.confidence,
              method: fact.method ?? 'API',
              metric: fact.metric ?? null,
              numericValue: fact.numericValue ?? null,
              unit: fact.unit ?? null,
            },
            create: {
              productId,
              source: item.source,
              claim: fact.claim,
              value: fact.value,
              url: fact.url,
              observedAt: fact.observedAt,
              confidence: fact.confidence,
              method: fact.method ?? 'API',
              metric: fact.metric ?? null,
              numericValue: fact.numericValue ?? null,
              unit: fact.unit ?? null,
            },
          });
        }
      }
    } catch (error) {
      errors.push({
        source: item.source,
        message: error instanceof Error ? error.message : 'Unknown enrichment error',
        occurredAt: new Date().toISOString(),
      });
    }
  }

  return errors;
}

/**
 * Orchestrates the full DISCOVER -> NORMALIZE -> DEDUPLICATE -> ENRICH ->
 * CALCULATE pipeline for a single niche-hunt job. Called only from the
 * BullMQ worker (src/features/jobs/worker.ts) — never from an HTTP request
 * handler directly, so a slow source never blocks a response (spec section
 * 16).
 */
export async function runNicheHunt(params: NicheHuntParams): Promise<void> {
  const { runId, niche } = params;

  // S2 fix: ioredis's offline queue (`maxRetriesPerRequest: null`, see
  // src/lib/redis.ts) can buffer a `queue.add` call and deliver it once Redis
  // reconnects, even after the API route already gave up waiting and marked
  // this run FAILED + returned 503 to the client. Without a guard here, that
  // late delivery would let the worker pick the job up and run it to
  // completion anyway — silently un-failing a run the client was already
  // told failed. The PENDING -> RUNNING transition is therefore conditional:
  // it only applies if the run is *still* PENDING. If another writer already
  // moved it elsewhere (FAILED by the route's timeout handler, or a
  // duplicate delivery already claimed it), zero rows match and this run is
  // skipped entirely rather than silently reviving a run that was already
  // resolved.
  const { count } = await prisma.researchRun.updateMany({
    where: { id: runId, status: 'PENDING' },
    data: { status: 'RUNNING' },
  });

  if (count === 0) {
    console.warn(
      `[pipeline] skipping run ${runId}: not PENDING (already FAILED/cancelled, or already claimed)`
    );
    return;
  }

  // `startedAt` is set once, at ResearchRun creation (the API route), and
  // never changes across BullMQ retries of this same job — that stability is
  // exactly what B1's fix needs: every observation this run records shares
  // one fetch-time clock (see persistGroupObservations's doc comment).
  const run = await prisma.researchRun.findUniqueOrThrow({
    where: { id: runId },
    select: { startedAt: true },
  });
  const fetchedAt = run.startedAt;

  const { rawProducts, errors: discoveryErrors } = await discoverFromSources(
    DISCOVERY_SOURCES,
    { niche, limit: DISCOVERY_LIMIT }
  );

  const { groups, dropped } = groupByNormalizedName(rawProducts);
  const sourceById = new Map(DISCOVERY_SOURCES.map((source) => [source.id, source] as const));

  // A title that normalizes to nothing is a data gap, not a silent no-op
  // (spec section 2) — record it in the run's error trail rather than just
  // dropping the raw item with no trace.
  const droppedTitleErrors: RunErrorEntry[] = dropped.map((item) => ({
    source: 'normalize',
    message: `Title normalized to empty and was dropped (source=${item.source}, externalId=${item.externalId}): "${item.title}"`,
    occurredAt: new Date().toISOString(),
  }));

  const persistErrors: RunErrorEntry[] = [];
  const productIds = new Set<string>();

  for (const group of groups) {
    try {
      const product = await upsertProduct(group, runId, niche);
      productIds.add(product.id);

      const groupErrors = await persistGroupObservations(
        product.id,
        group,
        sourceById,
        fetchedAt
      );
      persistErrors.push(...groupErrors);

      await computeScoresForProduct(product.id);
    } catch (error) {
      persistErrors.push({
        source: 'pipeline',
        message:
          error instanceof Error ? error.message : 'Unknown error persisting candidate',
        occurredAt: new Date().toISOString(),
      });
    }
  }

  const allErrors = [...discoveryErrors, ...droppedTitleErrors, ...persistErrors];
  const status =
    productIds.size === 0 && allErrors.length > 0
      ? 'FAILED'
      : allErrors.length > 0
        ? 'PARTIAL'
        : 'COMPLETED';

  await prisma.researchRun.update({
    where: { id: runId },
    data: {
      status,
      finishedAt: new Date(),
      candidateCount: productIds.size,
      errors: allErrors as unknown as Prisma.InputJsonValue,
    },
  });
}
