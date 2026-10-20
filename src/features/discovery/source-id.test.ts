import { EvidenceMethod, SourceId } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_METHODS, SOURCE_IDS } from './source.types';

describe('TypeScript enums mirror the Prisma schema', () => {
  it('SOURCE_IDS matches the Prisma SourceId enum exactly', () => {
    expect([...SOURCE_IDS].sort()).toEqual(Object.values(SourceId).sort());
  });

  it('EVIDENCE_METHODS matches the Prisma EvidenceMethod enum exactly', () => {
    expect([...EVIDENCE_METHODS].sort()).toEqual(Object.values(EvidenceMethod).sort());
  });
});
