import { z } from 'zod';

/**
 * Mirrors the Prisma ScoreDimension/ScoreStatus enums. Kept as an
 * independent Zod schema (rather than importing the Prisma enum directly)
 * so scoring logic can be unit-tested without a Prisma client instance.
 */
export const ScoreDimensionSchema = z.enum([
  'DEMAND_MOMENTUM',
  'ECONOMICS',
  'COMPETITION',
  'SUPPLIER_QUALITY',
  'PRODUCT_SUITABILITY',
]);
export type ScoreDimensionValue = z.infer<typeof ScoreDimensionSchema>;

/**
 * A dimension's computed result. The two branches are mutually exclusive by
 * construction: a COMPUTED result always carries a 0-100 integer score, an
 * INSUFFICIENT_DATA result always carries a reason and never a score. This
 * makes "fabricate a number anyway" a type error, not just a convention.
 */
export const ScoreResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('COMPUTED'),
    score: z.number().int().min(0).max(100),
    reason: z.string().nullable().optional(),
  }),
  z.object({
    status: z.literal('INSUFFICIENT_DATA'),
    score: z.null(),
    reason: z.string(),
  }),
]);
export type ScoreResult = z.infer<typeof ScoreResultSchema>;
