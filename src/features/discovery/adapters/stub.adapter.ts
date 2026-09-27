import { NotImplementedError } from '../source.types';
import type { ProductSource, SourceHealth, SourceId } from '../source.types';

/**
 * Stub adapters for sources named in the spec (TikTok, Amazon, AliExpress)
 * that are out of scope for Phase 1. They exist ONLY to prove the
 * ProductSource interface is genuinely provider-agnostic — the pipeline can
 * iterate over a source list that includes these without special-casing
 * "real" vs "stub". No scraping is attempted; `discover`/`enrich` throw and
 * `healthCheck` reports NOT_IMPLEMENTED so the source-health panel is honest
 * about what isn't wired up yet, rather than silently omitting it.
 */
function makeStubAdapter(id: SourceId): ProductSource {
  return {
    id,
    async discover() {
      throw new NotImplementedError(id);
    },
    async enrich() {
      throw new NotImplementedError(id);
    },
    async healthCheck(): Promise<SourceHealth> {
      return {
        id,
        status: 'NOT_IMPLEMENTED',
        message: 'Not implemented in Phase 1.',
        checkedAt: new Date(),
      };
    },
  };
}

export const tiktokAdapter = makeStubAdapter('TIKTOK');
export const amazonAdapter = makeStubAdapter('AMAZON');
export const aliexpressAdapter = makeStubAdapter('ALIEXPRESS');
