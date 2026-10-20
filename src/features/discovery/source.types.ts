/**
 * Provider-agnostic discovery source interface (spec section 3).
 *
 * Every adapter — real or stub — implements this shape identically, so the
 * pipeline never special-cases a specific source. Stub sources (TikTok,
 * Amazon, AliExpress) exist purely to prove that claim; see
 * adapters/stub.adapter.ts.
 */

/**
 * Mirrors the Prisma `SourceId` enum (source-id.test.ts fails if they drift).
 * REDDIT, TIKTOK_CREATIVE_CENTER, AMAZON_MOVERS_SHAKERS and WEB have no
 * automated adapter — they label evidence the Claude Code agent recorded from
 * public web pages via the `pie` CLI (see AGENT_PLAYBOOK.md).
 */
export const SOURCE_IDS = [
  'REDDIT',
  'HACKER_NEWS',
  'TIKTOK',
  'AMAZON',
  'ALIEXPRESS',
  'TIKTOK_CREATIVE_CENTER',
  'AMAZON_MOVERS_SHAKERS',
  'GOOGLE_TRENDS',
  'WEB',
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

/** Mirrors the Prisma `EvidenceMethod` enum. */
export const EVIDENCE_METHODS = ['API', 'AGENT_WEB_READ', 'MANUAL'] as const;
export type EvidenceMethodValue = (typeof EVIDENCE_METHODS)[number];

export type SourceHealthStatus =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'DOWN'
  | 'NOT_IMPLEMENTED';

export interface DiscoveryInput {
  /** Free-text niche keyword the user is hunting in, e.g. "pet accessories". */
  niche: string;
  /** Max candidates a single adapter call should return. */
  limit?: number;
}

/** A single raw signal about a candidate product, before normalization. */
export interface RawProduct {
  source: SourceId;
  externalId: string;
  title: string;
  url: string;
  observedAt: Date;
  /** Real, source-reported metrics only — never invented (spec section 2). */
  metrics: Record<string, number>;
  raw: unknown;
}

/** A single traceable fact about a product, destined for ResearchEvidence. */
export interface ProductEvidence {
  claim: string;
  value: string;
  url: string;
  observedAt: Date;
  /** 0–1. How much weight this single observation should carry. */
  confidence: number;
  /** Defaults to API for adapter-produced evidence. */
  method?: EvidenceMethodValue;
  /** Structured measurement; omit all three for a qualitative claim. */
  metric?: string;
  numericValue?: number;
  unit?: string;
}

export interface SourceHealth {
  id: SourceId;
  status: SourceHealthStatus;
  message?: string;
  checkedAt: Date;
}

/**
 * S6 fix: a source's `discover()` can succeed overall while still losing
 * part of its own input (e.g. one subreddit out of several failing to
 * fetch). That's a data gap, not nothing — spec section 14 ("store source
 * errors") and section 2 (data gaps must be explicit) both require it to be
 * recorded somewhere the user can see it, not just `console.warn`'d. Mirrors
 * the existing `{ groups, dropped }` / `{ rawProducts, errors }` shape
 * already used elsewhere in this pipeline (successes + explicit gaps, never
 * one silently masking the other).
 */
export interface SourceWarning {
  message: string;
}

export interface DiscoverResult {
  items: RawProduct[];
  /** Partial, non-fatal failures within this single discover() call. Empty when nothing went wrong. */
  warnings: SourceWarning[];
}

export interface ProductSource {
  id: SourceId;
  discover(input: DiscoveryInput): Promise<DiscoverResult>;
  enrich(product: RawProduct): Promise<ProductEvidence[]>;
  healthCheck(): Promise<SourceHealth>;
}

/** Thrown by stub adapters — proves the interface without faking data. */
export class NotImplementedError extends Error {
  constructor(sourceId: SourceId) {
    super(`Source "${sourceId}" is not implemented in Phase 1.`);
    this.name = 'NotImplementedError';
  }
}
