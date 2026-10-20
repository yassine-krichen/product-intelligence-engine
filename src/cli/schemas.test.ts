import { describe, expect, it } from 'vitest';
import {
  CandidateAddSchema,
  CandidateListSchema,
  EvidenceAddSchema,
  HuntHnSchema,
  TrendsCheckSchema,
} from './schemas';

const validEvidence = {
  candidate: 'led dog collar',
  source: 'AMAZON_MOVERS_SHAKERS',
  claim: 'Ranked #4 in Pet Supplies movers and shakers',
  url: 'https://www.amazon.com/gp/movers-and-shakers/pet-supplies',
};

function issuesFor(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }): string {
  return result.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ') ?? '';
}

describe('EvidenceAddSchema', () => {
  it('accepts a minimal qualitative claim and defaults the method to AGENT_WEB_READ', () => {
    const result = EvidenceAddSchema.parse(validEvidence);

    expect(result.method).toBe('AGENT_WEB_READ');
    expect(result.value).toBeUndefined();
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<script>', 'ftp://example.com/x', 'not a url', '//example.com'])(
    'rejects the non-http(s) URL %s',
    (url) => {
      expect(EvidenceAddSchema.safeParse({ ...validEvidence, url }).success).toBe(false);
    }
  );

  it('rejects a URL with embedded credentials or control characters', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, url: 'https://user:pw@example.com/' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, url: 'https://exa\nmple.com/' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, url: 'https://example.com/a b' }).success).toBe(false);
  });

  it('rejects an oversize claim instead of truncating it', () => {
    const result = EvidenceAddSchema.safeParse({ ...validEvidence, claim: 'x'.repeat(501) });

    expect(result.success).toBe(false);
    expect(issuesFor(result)).toMatch(/claim: must be at most 500/);
  });

  it('rejects an excerpt over 300 characters', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, excerpt: 'y'.repeat(301) }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, excerpt: 'y'.repeat(300) }).success).toBe(true);
  });

  it('strips control and invisible characters from text but keeps the words', () => {
    const result = EvidenceAddSchema.parse({
      ...validEvidence,
      claim: 'Ranked\u0000 #4‮ in\nPet\tSupplies​',
    });

    expect(result.claim).toBe('Ranked #4 in Pet Supplies');
  });

  it('rejects text that is empty once control characters are stripped', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, claim: '\u0000​  ' }).success).toBe(false);
  });

  it.each(['NaN', 'Infinity', '-Infinity', '', '0x10', '1,000', '12abc', '1e999'])(
    'rejects the non-finite or non-numeric --value %j',
    (value) => {
      expect(EvidenceAddSchema.safeParse({ ...validEvidence, metric: 'rank', value }).success).toBe(false);
    }
  );

  it('parses a finite --value into a number', () => {
    const result = EvidenceAddSchema.parse({ ...validEvidence, metric: 'rank', value: '-12.5', unit: 'position' });

    expect(result.value).toBe(-12.5);
  });

  it('requires --metric and --value together', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, metric: 'rank' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, value: '4' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, unit: '%' }).success).toBe(false);
  });

  it('rejects a metric name that is not snake_case', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, metric: 'Rank Change', value: '1' }).success).toBe(false);
  });

  it('rejects an unknown source id', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, source: 'TWITTER' }).success).toBe(false);
  });

  it('rejects method API: only an in-repo adapter may claim it', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, method: 'API' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, method: 'MANUAL' }).success).toBe(true);
  });

  it('accepts ISO dates and datetimes, rejects other formats and the future', () => {
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, observedAt: '2026-10-01' }).success).toBe(true);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, observedAt: '2026-10-01T12:00:00Z' }).success).toBe(true);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, observedAt: '10/01/2026' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, observedAt: '2026-13-45' }).success).toBe(false);
    expect(EvidenceAddSchema.safeParse({ ...validEvidence, observedAt: '2999-01-01' }).success).toBe(false);
  });
});

describe('CandidateAddSchema', () => {
  it('requires name and niche and caps their length', () => {
    expect(CandidateAddSchema.safeParse({ niche: 'pets' }).success).toBe(false);
    expect(CandidateAddSchema.safeParse({ name: 'LED collar' }).success).toBe(false);
    expect(CandidateAddSchema.safeParse({ name: 'n'.repeat(121), niche: 'pets' }).success).toBe(false);
    expect(CandidateAddSchema.safeParse({ name: 'LED collar', niche: 'pets', description: 'd'.repeat(1001) }).success).toBe(false);
  });
});

describe('CandidateListSchema', () => {
  it('defaults the limit and rejects a bad verdict or limit', () => {
    expect(CandidateListSchema.parse({}).limit).toBe(50);
    expect(CandidateListSchema.safeParse({ verdict: 'GREAT' }).success).toBe(false);
    expect(CandidateListSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(CandidateListSchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(CandidateListSchema.safeParse({ limit: '-3' }).success).toBe(false);
  });
});

describe('HuntHnSchema and TrendsCheckSchema', () => {
  it('requires a niche of at least 2 characters', () => {
    expect(HuntHnSchema.safeParse({ niche: 'a' }).success).toBe(false);
    expect(HuntHnSchema.parse({ niche: 'standing desk' }).dryRun).toBe(false);
  });

  it('requires a candidate unless --dry-run, and a keyword with --dry-run', () => {
    expect(TrendsCheckSchema.safeParse({}).success).toBe(false);
    expect(TrendsCheckSchema.safeParse({ dryRun: true }).success).toBe(false);
    expect(TrendsCheckSchema.safeParse({ dryRun: true, keyword: 'pickleball paddle' }).success).toBe(true);
    expect(TrendsCheckSchema.safeParse({ candidate: 'x' }).success).toBe(true);
  });

  it('only accepts an uppercase two-letter geo', () => {
    expect(TrendsCheckSchema.safeParse({ candidate: 'x', geo: 'us' }).success).toBe(false);
    expect(TrendsCheckSchema.safeParse({ candidate: 'x', geo: 'USA' }).success).toBe(false);
    expect(TrendsCheckSchema.parse({ candidate: 'x', geo: 'US' }).geo).toBe('US');
  });
});
