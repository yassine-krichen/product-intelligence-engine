import { describe, expect, it } from 'vitest';
import { normalizeTitle } from './normalize';

describe('normalizeTitle', () => {
  it('lowercases and collapses casing differences to the same key', () => {
    expect(normalizeTitle('LED Dog Collar')).toBe(normalizeTitle('led dog collar'));
  });

  it('strips punctuation', () => {
    expect(normalizeTitle('Dog Collar - LED! (2024 model)')).toBe(
      normalizeTitle('Dog Collar LED 2024 model')
    );
  });

  it('collapses extra/irregular whitespace', () => {
    expect(normalizeTitle('Dog   Collar\tLED\n\ncollar')).toBe(
      normalizeTitle('Dog Collar LED collar')
    );
  });

  it('returns an empty string for an empty input', () => {
    expect(normalizeTitle('')).toBe('');
  });

  it('returns an empty string when input is only punctuation/whitespace', () => {
    expect(normalizeTitle('   ---!!!   ')).toBe('');
  });

  it('returns an empty string when input is only stopwords', () => {
    expect(normalizeTitle('The Show For You')).toBe('');
  });

  it('removes stopwords but keeps meaningful terms', () => {
    expect(normalizeTitle('Show HN: My New LED Dog Collar')).toBe('led dog collar');
  });

  it('produces the same normalized key for near-duplicate titles (dedup use case)', () => {
    const a = normalizeTitle('Show HN: LED Dog Collar for Night Walks');
    const b = normalizeTitle('LED Dog Collar for night walks!');
    expect(a).toBe(b);
  });

  it('is deterministic across repeated calls', () => {
    const input = 'Portable Blender - USB Rechargeable (2024)';
    expect(normalizeTitle(input)).toBe(normalizeTitle(input));
  });

  it('does not collapse genuinely different titles to the same key', () => {
    expect(normalizeTitle('LED Dog Collar')).not.toBe(normalizeTitle('LED Cat Collar'));
  });
});
