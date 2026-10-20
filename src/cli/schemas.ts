import { z } from 'zod';
import { SOURCE_IDS } from '@/features/discovery/source.types';

/**
 * Every CLI argument is untrusted: the agent passes text it copied off public
 * web pages. Validation rejects bad input outright; the only transformation
 * is stripping control/invisible characters from free text, applied AFTER the
 * length cap so an oversized value is rejected, never truncated.
 */

const WHITESPACE_CONTROLS = /[\t\n\r]/g;
// C0/C1 controls plus zero-width and bidi-override characters (used to disguise text).
const INVISIBLE_CHARS = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
const URL_FORBIDDEN_CHARS = /[\s\u0000-\u001F\u007F-\u009F]/;

const MAX_URL_LENGTH = 2048;

function cleanText(maxLength: number): z.ZodType<string> {
  return z
    .string()
    .max(maxLength, `must be at most ${maxLength} characters`)
    .transform((value) => value.replace(WHITESPACE_CONTROLS, ' ').replace(INVISIBLE_CHARS, '').trim())
    .pipe(z.string().min(1, 'must not be empty'));
}

const HttpUrlSchema = z
  .string()
  .max(MAX_URL_LENGTH, `must be at most ${MAX_URL_LENGTH} characters`)
  .refine((value) => !URL_FORBIDDEN_CHARS.test(value), 'must not contain whitespace or control characters')
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      );
    } catch {
      return false;
    }
  }, 'must be an absolute http(s) URL without embedded credentials');

const FiniteNumberSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/, 'must be a plain decimal number')
  .transform(Number)
  .pipe(z.number().finite('must be finite'));

const MetricNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be snake_case, 1-64 characters');

/** One day of slack for clock skew; an observation from the future is a typo or a fabrication. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

const ObservedAtSchema = z
  .string()
  .refine((value) => z.iso.datetime({ offset: true }).safeParse(value).success || z.iso.date().safeParse(value).success, 'must be an ISO 8601 date or datetime')
  .transform((value) => new Date(value))
  .refine((date) => !Number.isNaN(date.getTime()), 'must be a valid date')
  .refine((date) => date.getTime() <= Date.now() + FUTURE_SLACK_MS, 'must not be in the future');

const CandidateReferenceSchema = cleanText(200);

/**
 * Only AGENT_WEB_READ and MANUAL can be entered by hand. API means "fetched by
 * an adapter in this codebase"; letting the CLI claim it would let anyone
 * mint a measured-looking signal.
 */
const CliMethodSchema = z.enum(['AGENT_WEB_READ', 'MANUAL']);

export const CandidateAddSchema = z.object({
  name: cleanText(120),
  niche: cleanText(100),
  description: cleanText(1000).optional(),
});

const EvidenceAddBaseSchema = z.object({
  candidate: CandidateReferenceSchema,
  source: z.enum(SOURCE_IDS),
  claim: cleanText(500),
  url: HttpUrlSchema,
  metric: MetricNameSchema.optional(),
  value: FiniteNumberSchema.optional(),
  unit: cleanText(32).optional(),
  excerpt: cleanText(300).optional(),
  observedAt: ObservedAtSchema.optional(),
  method: CliMethodSchema.default('AGENT_WEB_READ'),
});

export const EvidenceAddSchema = EvidenceAddBaseSchema.superRefine((input, ctx) => {
  if ((input.metric === undefined) !== (input.value === undefined)) {
    ctx.addIssue({
      code: 'custom',
      path: [input.metric === undefined ? 'metric' : 'value'],
      message: '--metric and --value must be given together (a number needs a name, a name needs a number)',
    });
  }
  if (input.unit !== undefined && input.value === undefined) {
    ctx.addIssue({ code: 'custom', path: ['unit'], message: '--unit requires --value' });
  }
});

export const CandidateListSchema = z.object({
  niche: cleanText(100).optional(),
  verdict: z.enum(['UNVERIFIED', 'WEAK', 'PROMISING']).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'must be a positive integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .default(50),
});

export const CandidateShowSchema = z.object({ candidate: CandidateReferenceSchema });

export const ScoreRecomputeSchema = z.object({ candidate: CandidateReferenceSchema.optional() });

export const HuntHnSchema = z.object({
  niche: cleanText(100).pipe(z.string().min(2, 'must be at least 2 characters')),
  dryRun: z.boolean().default(false),
});

export const TrendsCheckSchema = z
  .object({
    candidate: CandidateReferenceSchema.optional(),
    keyword: cleanText(100).optional(),
    geo: z
      .string()
      .regex(/^[A-Z]{2}$/, 'must be a two-letter uppercase country code, e.g. US')
      .default(''),
    dryRun: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    if (input.dryRun && input.keyword === undefined) {
      ctx.addIssue({ code: 'custom', path: ['keyword'], message: '--dry-run requires --keyword (no database lookup happens)' });
    }
    if (!input.dryRun && input.candidate === undefined) {
      ctx.addIssue({ code: 'custom', path: ['candidate'], message: '--candidate is required unless --dry-run is set' });
    }
  });
