import type { EvidenceMethodValue, SourceId } from '@/features/discovery/source.types';
import {
  hostMatchesSource,
  hostOf,
  hostsRelated,
  normalizeUrl,
} from '@/features/discovery/source-url';

export type CandidateVerdict = 'UNVERIFIED' | 'WEAK' | 'PROMISING';

/** The subset of a ResearchEvidence row the credibility rule needs. */
export interface AssessableEvidence {
  source: SourceId;
  method: EvidenceMethodValue;
  url: string | null;
  claim: string;
  metric: string | null;
  numericValue: number | null;
  unit: string | null;
}

export interface CandidateAssessment {
  verdict: CandidateVerdict;
  /** Independent source families that each contributed a measured, positive demand signal. */
  independentSources: number;
  reasons: string[];
  gaps: string[];
}

/** Two independent measured sources before demand is believed: one source can be a fluke, an echo chamber, or a bot-driven spike. */
const MIN_INDEPENDENT_SOURCES_FOR_PROMISING = 2;

/** Below this absolute percent change a source is "flat", not rising/declining: avoids flagging noise as a contradiction. */
const DIRECTION_THRESHOLD_PERCENT = 10;

/** Metrics that express a change over time; only these can carry a direction. */
const CHANGE_METRIC_PATTERN = /change|growth|yoy/i;

/**
 * Engagement floors. A story with 1 point or a thread with 2 comments is
 * noise (anyone can post one), so raw engagement counts only above a bar that
 * takes real attention: 50 points/upvotes, or 20 comments.
 */
const ENGAGEMENT_MIN_POINTS = 50;
const ENGAGEMENT_MIN_COMMENTS = 20;
const ENGAGEMENT_POINT_METRICS = new Set(['points', 'ups', 'upvotes', 'score']);
const ENGAGEMENT_COMMENT_METRICS = new Set(['num_comments', 'comments']);

/**
 * Sources that are the same site and therefore one independent voice:
 * Amazon's generic and Movers & Shakers pages, TikTok's generic and Creative
 * Center pages.
 */
const SOURCE_FAMILY: Partial<Record<SourceId, string>> = {
  AMAZON: 'AMAZON',
  AMAZON_MOVERS_SHAKERS: 'AMAZON',
  TIKTOK: 'TIKTOK',
  TIKTOK_CREATIVE_CENTER: 'TIKTOK',
};

const familyOf = (source: SourceId): string => SOURCE_FAMILY[source] ?? source;

/** Sources worth trying next, listed in gaps so the agent knows where to look. */
const CORE_EVIDENCE_SOURCES: SourceId[] = [
  'GOOGLE_TRENDS',
  'TIKTOK_CREATIVE_CENTER',
  'AMAZON_MOVERS_SHAKERS',
  'REDDIT',
  'HACKER_NEWS',
];

/**
 * A number only counts as a measurement when it is traceable: a finite value,
 * a URL a human can open, and a method that actually read the source (an API
 * call or the agent reading the page). MANUAL numbers have no provenance. A
 * hand-entered row must also cite a URL that belongs to its declared source;
 * adapter (API) rows are trusted as written (an HN row cites the linked
 * article, not news.ycombinator.com).
 */
export function isMeasured(evidence: AssessableEvidence): boolean {
  if (
    evidence.numericValue === null ||
    !Number.isFinite(evidence.numericValue) ||
    evidence.url === null ||
    evidence.url.length === 0 ||
    (evidence.method !== 'API' && evidence.method !== 'AGENT_WEB_READ')
  ) {
    return false;
  }
  return evidence.method === 'API' || hostMatchesSource(evidence.source, evidence.url);
}

type Direction = 'rising' | 'declining';

function isChangeMetric(evidence: AssessableEvidence): boolean {
  return (
    evidence.metric !== null &&
    CHANGE_METRIC_PATTERN.test(evidence.metric) &&
    evidence.unit?.trim() === '%'
  );
}

function directionOf(evidence: AssessableEvidence): Direction | null {
  if (evidence.numericValue === null || !isChangeMetric(evidence)) return null;
  if (evidence.numericValue >= DIRECTION_THRESHOLD_PERCENT) return 'rising';
  if (evidence.numericValue <= -DIRECTION_THRESHOLD_PERCENT) return 'declining';
  return null;
}

/**
 * Why a measured row does NOT count as positive demand, or null when it does.
 * A measurement that shows zero, decline, or trivial engagement is still a
 * fact worth keeping, but it must never be the thing that makes a candidate
 * look promising.
 */
function noDemandReason(evidence: AssessableEvidence): string | null {
  const value = evidence.numericValue;
  if (value === null) return 'no number';
  if (value <= 0) return 'zero or negative value';
  if (directionOf(evidence) === 'declining') return 'declining';
  if (evidence.metric !== null) {
    if (ENGAGEMENT_POINT_METRICS.has(evidence.metric) && value < ENGAGEMENT_MIN_POINTS) {
      return `below the ${ENGAGEMENT_MIN_POINTS}-point engagement floor`;
    }
    if (ENGAGEMENT_COMMENT_METRICS.has(evidence.metric) && value < ENGAGEMENT_MIN_COMMENTS) {
      return `below the ${ENGAGEMENT_MIN_COMMENTS}-comment engagement floor`;
    }
  }
  return null;
}

function findContradictions(measured: AssessableEvidence[]): string[] {
  const directionsBySource = new Map<SourceId, Set<Direction>>();
  for (const evidence of measured) {
    const direction = directionOf(evidence);
    if (direction === null) continue;
    const set = directionsBySource.get(evidence.source) ?? new Set<Direction>();
    set.add(direction);
    directionsBySource.set(evidence.source, set);
  }

  const rising: SourceId[] = [];
  const declining: SourceId[] = [];
  for (const [source, directions] of directionsBySource) {
    if (directions.has('rising')) rising.push(source);
    if (directions.has('declining')) declining.push(source);
  }

  if (rising.length === 0 || declining.length === 0) return [];
  return [
    `CONTRADICTION: rising in ${rising.join(', ')} but declining in ${declining.join(', ')}. Resolve before trusting either.`,
  ];
}

interface CountedSources {
  families: Set<string>;
  sources: Set<SourceId>;
}

/**
 * Which sources genuinely add an independent voice. Rows are processed in a
 * fixed order so the result never depends on database ordering. A URL can
 * count for only one source (the first claims it), and a WEB row counts only
 * when its host is unrelated to every host already counted, so a Reddit page
 * labelled both REDDIT and WEB is one voice, not two.
 */
function countIndependentSources(positive: AssessableEvidence[]): CountedSources {
  const ordered = [...positive].sort(
    (a, b) =>
      a.source.localeCompare(b.source) || (a.url ?? '').localeCompare(b.url ?? '')
  );
  const claimedUrls = new Map<string, string>();
  const countedHosts: string[] = [];
  const result: CountedSources = { families: new Set(), sources: new Set() };

  const consider = (row: AssessableEvidence): boolean => {
    const normalized = normalizeUrl(row.url ?? '');
    const host = hostOf(row.url ?? '');
    if (normalized === null || host === null) return false;

    const family = familyOf(row.source);
    const owner = claimedUrls.get(normalized);
    if (owner !== undefined && owner !== family) return false;

    claimedUrls.set(normalized, family);
    countedHosts.push(host);
    result.families.add(family);
    result.sources.add(row.source);
    return true;
  };

  for (const row of ordered.filter((r) => r.source !== 'WEB')) consider(row);

  const otherHosts = [...countedHosts];
  for (const row of ordered.filter((r) => r.source === 'WEB')) {
    const host = hostOf(row.url ?? '');
    if (host === null || otherHosts.some((counted) => hostsRelated(host, counted))) continue;
    consider(row);
  }

  return result;
}

/**
 * Credibility verdict for one candidate, from its evidence ledger only.
 *
 * PROMISING needs >= 2 independent sources (different source families and
 * different pages) that each contributed a measured, positive demand signal:
 * a number with a URL that is above zero, not declining, and above the
 * engagement floor. One such source is WEAK. Claims without a measured number
 * never create demand: a candidate with only prose is UNVERIFIED. Any
 * contradiction between sources caps the verdict at WEAK.
 */
export function assessCandidate(evidence: AssessableEvidence[]): CandidateAssessment {
  const measured = evidence.filter(isMeasured);
  const positive = measured.filter((row) => noDemandReason(row) === null);
  const noDemand = measured.filter((row) => noDemandReason(row) !== null);
  const counted = countIndependentSources(positive);
  const independentSources = counted.families.size;

  const reasons: string[] = [];
  const gaps: string[] = [];

  const unmeasuredNumbers = evidence.filter((row) => row.numericValue !== null && !isMeasured(row));
  const claimsWithoutNumbers = evidence.filter((row) => row.numericValue === null);

  if (claimsWithoutNumbers.length > 0) {
    gaps.push(
      `${claimsWithoutNumbers.length} claim(s) have no numeric metric and are not counted as demand.`
    );
  }
  if (unmeasuredNumbers.length > 0) {
    gaps.push(
      `${unmeasuredNumbers.length} number(s) lack a URL, were entered manually, or cite a URL that does not belong to the declared source, and are not counted.`
    );
  }
  if (noDemand.length > 0) {
    gaps.push(
      `${noDemand.length} measured number(s) show no demand (zero, declining, or below the engagement floor) and are not counted.`
    );
  }

  let verdict: CandidateVerdict;
  if (independentSources >= MIN_INDEPENDENT_SOURCES_FOR_PROMISING) {
    verdict = 'PROMISING';
    reasons.push(
      `${independentSources} independent sources each report a measured positive signal: ${[...counted.sources].join(', ')}.`
    );
  } else if (independentSources === 1) {
    verdict = 'WEAK';
    reasons.push(
      `One signal only (${[...counted.sources].join(', ')}); a single source cannot confirm demand.`
    );
    gaps.push('Needs a second independent source with a measured positive signal.');
  } else {
    verdict = 'UNVERIFIED';
    reasons.push(
      evidence.length === 0
        ? 'No evidence recorded.'
        : noDemand.length > 0
          ? 'Measured numbers exist but none shows demand; claims alone do not establish it either.'
          : 'No measured metric recorded; claims alone do not establish demand.'
    );
    gaps.push('Needs a measured positive metric (numeric value + URL) from a real source.');
  }

  const contradictions = findContradictions(measured);
  reasons.push(...contradictions);
  if (contradictions.length > 0 && verdict === 'PROMISING') {
    verdict = 'WEAK';
    reasons.push('Downgraded from PROMISING to WEAK because sources contradict each other.');
  }

  const untried = CORE_EVIDENCE_SOURCES.filter(
    (source) => !evidence.some((row) => row.source === source)
  );
  if (verdict !== 'PROMISING' && untried.length > 0) {
    gaps.push(`No evidence yet from: ${untried.join(', ')}.`);
  }

  return { verdict, independentSources, reasons, gaps };
}
