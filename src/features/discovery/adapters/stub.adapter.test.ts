import { describe, expect, it } from 'vitest';
import { amazonAdapter, aliexpressAdapter, tiktokAdapter } from './stub.adapter';
import { NotImplementedError } from '../source.types';
import type { DiscoveryInput, RawProduct } from '../source.types';

const fakeInput: DiscoveryInput = { niche: 'pet accessories' };
const fakeRawProduct: RawProduct = {
  source: 'TIKTOK',
  externalId: 'stub-1',
  title: 'Stub product',
  url: 'https://example.com',
  observedAt: new Date(),
  metrics: {},
  raw: {},
};

describe.each([
  ['tiktokAdapter', tiktokAdapter, 'TIKTOK'],
  ['amazonAdapter', amazonAdapter, 'AMAZON'],
  ['aliexpressAdapter', aliexpressAdapter, 'ALIEXPRESS'],
] as const)('%s (Phase 1 stub)', (_name, adapter, id) => {
  it('reports NOT_IMPLEMENTED health rather than a fake HEALTHY status', async () => {
    const health = await adapter.healthCheck();

    expect(health.status).toBe('NOT_IMPLEMENTED');
    expect(health.id).toBe(id);
    expect(health.checkedAt).toBeInstanceOf(Date);
  });

  it('discover() throws NotImplementedError instead of silently returning fabricated products', async () => {
    await expect(adapter.discover(fakeInput)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('enrich() throws NotImplementedError instead of silently returning fabricated evidence', async () => {
    await expect(adapter.enrich(fakeRawProduct)).rejects.toBeInstanceOf(NotImplementedError);
  });
});
