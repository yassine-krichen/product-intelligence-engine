import { describe, expect, it } from 'vitest';
import { assessCandidate, isMeasured, type AssessableEvidence } from './assess-candidate';

function evidence(overrides: Partial<AssessableEvidence> = {}): AssessableEvidence {
  return {
    source: 'GOOGLE_TRENDS',
    method: 'API',
    url: 'https://trends.google.com/trends/explore?q=x',
    claim: 'Some claim',
    metric: 'interest_last_90d_mean',
    numericValue: 42,
    unit: 'index',
    ...overrides,
  };
}

const claimOnly = (source: AssessableEvidence['source']): AssessableEvidence =>
  evidence({ source, method: 'AGENT_WEB_READ', metric: null, numericValue: null, unit: null });

describe('assessCandidate', () => {
  it('is UNVERIFIED with no evidence at all', () => {
    const result = assessCandidate([]);

    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.independentSources).toBe(0);
    expect(result.reasons.join(' ')).toMatch(/No evidence recorded/);
  });

  it('is UNVERIFIED when every claim lacks a number, however many sources agree', () => {
    const result = assessCandidate([
      claimOnly('REDDIT'),
      claimOnly('TIKTOK_CREATIVE_CENTER'),
      claimOnly('WEB'),
    ]);

    expect(result.verdict).toBe('UNVERIFIED');
    expect(result.independentSources).toBe(0);
    expect(result.gaps.join(' ')).toMatch(/3 claim\(s\) have no numeric metric/);
  });

  it('is WEAK with one measured source and says it is one signal only', () => {
    const result = assessCandidate([evidence()]);

    expect(result.verdict).toBe('WEAK');
    expect(result.independentSources).toBe(1);
    expect(result.reasons.join(' ')).toMatch(/One signal only/);
    expect(result.gaps.join(' ')).toMatch(/second independent source/);
  });

  it('does not count two measured rows from the same source twice', () => {
    const result = assessCandidate([
      evidence({ metric: 'a', numericValue: 10 }),
      evidence({ metric: 'b', numericValue: 20 }),
    ]);

    expect(result.verdict).toBe('WEAK');
    expect(result.independentSources).toBe(1);
  });

  it('is PROMISING with two different sources that each carry a measured metric', () => {
    const result = assessCandidate([
      evidence({ source: 'GOOGLE_TRENDS' }),
      evidence({
        source: 'AMAZON_MOVERS_SHAKERS',
        method: 'AGENT_WEB_READ',
        url: 'https://www.amazon.com/gp/movers-and-shakers/pet-supplies',
        metric: 'rank_change_pct',
        numericValue: 350,
        unit: '%',
      }),
    ]);

    expect(result.verdict).toBe('PROMISING');
    expect(result.independentSources).toBe(2);
  });

  it('does not let a claim-only source count as the second independent source', () => {
    const result = assessCandidate([evidence(), claimOnly('REDDIT')]);

    expect(result.verdict).toBe('WEAK');
  });

  it('ignores a number with no URL or entered manually', () => {
    const noUrl = evidence({ source: 'WEB', method: 'AGENT_WEB_READ', url: null });
    const manual = evidence({ source: 'REDDIT', method: 'MANUAL' });

    expect(isMeasured(noUrl)).toBe(false);
    expect(isMeasured(manual)).toBe(false);
    const result = assessCandidate([evidence(), noUrl, manual]);
    expect(result.verdict).toBe('WEAK');
    expect(result.gaps.join(' ')).toMatch(/2 number\(s\) lack a URL, were entered manually/);
  });

  it('ignores a non-finite number', () => {
    expect(isMeasured(evidence({ numericValue: Number.NaN }))).toBe(false);
  });

  it('does not count a declining source as demand, and still flags the contradiction', () => {
    const result = assessCandidate([
      evidence({
        source: 'GOOGLE_TRENDS',
        metric: 'interest_yoy_change_pct',
        numericValue: 80,
        unit: '%',
      }),
      evidence({
        source: 'AMAZON_MOVERS_SHAKERS',
        method: 'AGENT_WEB_READ',
        url: 'https://www.amazon.com/gp/movers-and-shakers/pet-supplies',
        metric: 'sales_rank_change_pct',
        numericValue: -40,
        unit: '%',
      }),
    ]);

    expect(result.verdict).toBe('WEAK');
    expect(result.independentSources).toBe(1);
    expect(result.reasons.join(' ')).toMatch(
      /CONTRADICTION: rising in GOOGLE_TRENDS but declining in AMAZON_MOVERS_SHAKERS/
    );
  });

  it('downgrades PROMISING to WEAK when a third source contradicts the two that agree', () => {
    const result = assessCandidate([
      evidence({ source: 'GOOGLE_TRENDS', metric: 'interest_yoy_change_pct', numericValue: 80, unit: '%' }),
      evidence({
        source: 'HACKER_NEWS',
        url: 'https://example.com/hn-article',
        metric: 'points',
        numericValue: 300,
        unit: null,
      }),
      evidence({
        source: 'AMAZON_MOVERS_SHAKERS',
        method: 'AGENT_WEB_READ',
        url: 'https://www.amazon.com/gp/movers-and-shakers/pet-supplies',
        metric: 'sales_rank_change_pct',
        numericValue: -40,
        unit: '%',
      }),
    ]);

    expect(result.independentSources).toBe(2);
    expect(result.verdict).toBe('WEAK');
    expect(result.reasons.join(' ')).toMatch(/Downgraded from PROMISING to WEAK/);
  });

  it('does not flag a contradiction for small moves or agreeing sources', () => {
    const result = assessCandidate([
      evidence({
        source: 'GOOGLE_TRENDS',
        metric: 'interest_yoy_change_pct',
        numericValue: 80,
        unit: '%',
      }),
      evidence({
        source: 'AMAZON_MOVERS_SHAKERS',
        method: 'AGENT_WEB_READ',
        metric: 'sales_rank_change_pct',
        numericValue: -4,
        unit: '%',
      }),
    ]);

    expect(result.reasons.join(' ')).not.toMatch(/CONTRADICTION/);
  });

  it('lists the core sources that have not been tried yet as gaps', () => {
    const result = assessCandidate([evidence()]);

    expect(result.gaps.join(' ')).toMatch(/No evidence yet from: .*TIKTOK_CREATIVE_CENTER/);
    expect(result.gaps.join(' ')).not.toMatch(/No evidence yet from: GOOGLE_TRENDS/);
  });
});
