import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { normalizeTitle } from '@/features/discovery/normalize';
import type { EvidenceMethodValue, SourceId } from '@/features/discovery/source.types';
import {
  assessCandidate,
  type AssessableEvidence,
  type CandidateAssessment,
  type CandidateVerdict,
} from '@/features/scoring/assess-candidate';
import { computeScoresForProduct } from '@/features/scoring/score-dimensions';

/** Evidence columns the credibility verdict needs; selected explicitly so nothing else leaks into listings. */
const ASSESSABLE_EVIDENCE_SELECT = {
  source: true,
  method: true,
  url: true,
  claim: true,
  metric: true,
  numericValue: true,
  unit: true,
} satisfies Prisma.ResearchEvidenceSelect;

export class CandidateNotFoundError extends Error {
  constructor(reference: string) {
    super(`No candidate matches "${reference}" (looked up by id, then by normalized name).`);
    this.name = 'CandidateNotFoundError';
  }
}

export class InvalidCandidateNameError extends Error {
  constructor(name: string) {
    super(`Candidate name "${name}" has no letters or digits after normalization.`);
    this.name = 'InvalidCandidateNameError';
  }
}

export interface AddCandidateInput {
  name: string;
  niche: string;
  description?: string;
}

export interface CandidateSummary {
  id: string;
  name: string;
  niche: string | null;
  description: string | null;
}

/**
 * Idempotent on the normalized name (the same dedup key the discovery
 * pipeline uses), so re-adding "LED Dog Collar" and "led dog collar!" is one
 * candidate. The niche of an existing candidate is kept; only a newly
 * supplied description updates it.
 */
export async function addCandidate(
  input: AddCandidateInput
): Promise<{ created: boolean; candidate: CandidateSummary }> {
  const normalizedName = normalizeTitle(input.name);
  if (normalizedName.length === 0) throw new InvalidCandidateNameError(input.name);

  const existing = await prisma.product.findUnique({
    where: { normalizedName },
    select: { id: true },
  });

  const product = await prisma.product.upsert({
    where: { normalizedName },
    create: {
      canonicalName: input.name,
      normalizedName,
      niche: input.niche,
      description: input.description ?? null,
    },
    update: input.description !== undefined ? { description: input.description } : {},
    select: { id: true, canonicalName: true, niche: true, description: true },
  });

  return {
    created: existing === null,
    candidate: {
      id: product.id,
      name: product.canonicalName,
      niche: product.niche,
      description: product.description,
    },
  };
}

/** Accepts a product id or a name; the id is tried first because a cuid can never normalize to a real product name by accident. */
export async function resolveCandidate(reference: string): Promise<CandidateSummary> {
  const select = { id: true, canonicalName: true, niche: true, description: true } as const;

  const byId = await prisma.product.findUnique({ where: { id: reference }, select });
  const product =
    byId ??
    (await (async () => {
      const normalizedName = normalizeTitle(reference);
      if (normalizedName.length === 0) return null;
      return prisma.product.findUnique({ where: { normalizedName }, select });
    })());

  if (!product) throw new CandidateNotFoundError(reference);
  return {
    id: product.id,
    name: product.canonicalName,
    niche: product.niche,
    description: product.description,
  };
}

export interface RecordEvidenceInput {
  source: SourceId;
  claim: string;
  url: string;
  method: EvidenceMethodValue;
  observedAt: Date;
  metric?: string;
  numericValue?: number;
  unit?: string;
  excerpt?: string;
  /** Free-text value; defaults to the number plus unit when one is given. */
  valueText?: string;
  confidence?: number;
}

/**
 * Upserts on (product, source, claim, observedAt) so re-recording the same
 * observation updates it instead of duplicating it. Callers are responsible
 * for validating input; this layer only stores it.
 */
export async function recordEvidence(
  productId: string,
  input: RecordEvidenceInput
): Promise<{ id: string }> {
  const value =
    input.valueText ??
    (input.numericValue !== undefined
      ? `${input.numericValue}${input.unit ? ` ${input.unit}` : ''}`
      : null);

  const fields = {
    value,
    url: input.url,
    confidence: input.confidence ?? null,
    method: input.method,
    excerpt: input.excerpt ?? null,
    metric: input.metric ?? null,
    numericValue: input.numericValue ?? null,
    unit: input.unit ?? null,
  };

  return prisma.researchEvidence.upsert({
    where: {
      researchEvidence_naturalKey: {
        productId,
        source: input.source,
        claim: input.claim,
        observedAt: input.observedAt,
      },
    },
    update: fields,
    create: {
      productId,
      source: input.source,
      claim: input.claim,
      observedAt: input.observedAt,
      ...fields,
    },
    select: { id: true },
  });
}

export async function addEvidence(
  candidateReference: string,
  input: RecordEvidenceInput
): Promise<{ id: string; candidate: CandidateSummary }> {
  const candidate = await resolveCandidate(candidateReference);
  const { id } = await recordEvidence(candidate.id, input);
  return { id, candidate };
}

export interface CandidateListItem {
  id: string;
  name: string;
  niche: string | null;
  verdict: CandidateVerdict;
  independentSources: number;
  evidenceCount: number;
}

const LIST_FETCH_CAP = 1000;

export async function listCandidates(filter: {
  niche?: string;
  verdict?: CandidateVerdict;
  limit: number;
}): Promise<CandidateListItem[]> {
  const products = await prisma.product.findMany({
    where: filter.niche ? { niche: { equals: filter.niche, mode: 'insensitive' } } : {},
    orderBy: { createdAt: 'desc' },
    take: LIST_FETCH_CAP,
    select: {
      id: true,
      canonicalName: true,
      niche: true,
      evidence: { select: ASSESSABLE_EVIDENCE_SELECT },
    },
  });

  return products
    .map((product): CandidateListItem => {
      const assessment = assessCandidate(product.evidence);
      return {
        id: product.id,
        name: product.canonicalName,
        niche: product.niche,
        verdict: assessment.verdict,
        independentSources: assessment.independentSources,
        evidenceCount: product.evidence.length,
      };
    })
    .filter((item) => filter.verdict === undefined || item.verdict === filter.verdict)
    .slice(0, filter.limit);
}

export interface CandidateDetail {
  candidate: CandidateSummary;
  assessment: CandidateAssessment;
  evidence: Array<{
    id: string;
    source: string;
    method: string;
    claim: string;
    metric: string | null;
    numericValue: number | null;
    unit: string | null;
    value: string | null;
    url: string | null;
    excerpt: string | null;
    observedAt: string;
  }>;
  scoreDimensions: Array<{
    dimension: string;
    status: string;
    score: number | null;
    reason: string | null;
  }>;
}

export async function showCandidate(reference: string): Promise<CandidateDetail> {
  const candidate = await resolveCandidate(reference);

  const [evidence, dimensions] = await Promise.all([
    prisma.researchEvidence.findMany({
      where: { productId: candidate.id },
      orderBy: { observedAt: 'desc' },
      select: {
        id: true,
        value: true,
        excerpt: true,
        observedAt: true,
        ...ASSESSABLE_EVIDENCE_SELECT,
      },
    }),
    prisma.productScoreDimension.findMany({
      where: { productId: candidate.id },
      select: { dimension: true, status: true, score: true, reason: true },
    }),
  ]);

  return {
    candidate,
    assessment: assessCandidate(evidence satisfies AssessableEvidence[]),
    evidence: evidence.map((row) => ({
      id: row.id,
      source: row.source,
      method: row.method,
      claim: row.claim,
      metric: row.metric,
      numericValue: row.numericValue,
      unit: row.unit,
      value: row.value,
      url: row.url,
      excerpt: row.excerpt,
      observedAt: row.observedAt.toISOString(),
    })),
    scoreDimensions: dimensions,
  };
}

export interface RecomputeResult {
  id: string;
  name: string;
  verdict: CandidateVerdict;
  dimensions: Array<{ dimension: string; status: string; score: number | null }>;
}

/** Recomputes score dimensions for one candidate, or every candidate when no reference is given. */
export async function recomputeScores(candidateReference?: string): Promise<RecomputeResult[]> {
  const targets = candidateReference
    ? [await resolveCandidate(candidateReference)]
    : (await prisma.product.findMany({ select: { id: true, canonicalName: true } })).map(
        (product) => ({ id: product.id, name: product.canonicalName })
      );

  const results: RecomputeResult[] = [];
  for (const target of targets) {
    await computeScoresForProduct(target.id);
    const [dimensions, evidence] = await Promise.all([
      prisma.productScoreDimension.findMany({
        where: { productId: target.id },
        select: { dimension: true, status: true, score: true },
      }),
      prisma.researchEvidence.findMany({
        where: { productId: target.id },
        select: ASSESSABLE_EVIDENCE_SELECT,
      }),
    ]);
    results.push({
      id: target.id,
      name: target.name,
      verdict: assessCandidate(evidence).verdict,
      dimensions,
    });
  }
  return results;
}
