import type { ProductEvidence } from '@/features/discovery/source.types';
import type { TrendAnalysis } from '@/features/scoring/trend-series';

interface TrendEvidenceInput {
  keyword: string;
  url: string;
  observedAt: Date;
  analysis: TrendAnalysis;
}

const INTEREST_UNIT = 'index 0-100';

/**
 * Turns a trend analysis into evidence rows. The classification row is always
 * emitted (so UNKNOWN-with-a-reason is visible in the ledger); numeric rows
 * are emitted only when the number is meaningful, so thin or tiny-base data
 * can never be mistaken for a measured demand signal.
 */
export function buildTrendEvidence({
  keyword,
  url,
  observedAt,
  analysis,
}: TrendEvidenceInput): ProductEvidence[] {
  const flags = analysis.flags.length > 0 ? ` [${analysis.flags.join(', ')}]` : '';
  const evidence: ProductEvidence[] = [
    {
      claim: `Google Trends trend classification (keyword "${keyword}")`,
      value: `${analysis.classification}: ${analysis.reason}${flags}`,
      url,
      observedAt,
      confidence: 0.5,
      method: 'API',
    },
  ];

  if (analysis.recentMean !== null) {
    evidence.push({
      claim: `Google Trends interest, last 90 days (keyword "${keyword}")`,
      value: `${analysis.recentMean} ${INTEREST_UNIT}`,
      url,
      observedAt,
      confidence: 0.7,
      method: 'API',
      metric: 'interest_last_90d_mean',
      numericValue: analysis.recentMean,
      unit: INTEREST_UNIT,
    });
  }

  if (analysis.yoyChangePercent !== null) {
    evidence.push({
      claim: `Google Trends interest, last 90 days vs same window last year (keyword "${keyword}")`,
      value: `${analysis.yoyChangePercent}%`,
      url,
      observedAt,
      confidence: 0.7,
      method: 'API',
      metric: 'interest_yoy_change_pct',
      numericValue: analysis.yoyChangePercent,
      unit: '%',
    });
  }

  return evidence;
}
