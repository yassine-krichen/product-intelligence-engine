import { beforeEach, describe, expect, it, vi } from 'vitest';

const ledger = vi.hoisted(() => ({
  addCandidate: vi.fn(),
  addEvidence: vi.fn(),
  listCandidates: vi.fn(),
  recomputeScores: vi.fn(),
  showCandidate: vi.fn(),
}));
vi.mock('@/features/ledger/ledger.service', () => ledger);
vi.mock('@/features/discovery/hn-hunt.service', () => ({ dryRunHnHunt: vi.fn(), runHnHunt: vi.fn() }));
vi.mock('@/features/trends/trends.service', () => ({
  checkTrendsForCandidate: vi.fn(),
  dryRunTrends: vi.fn(),
}));

const { runCli } = await import('./run');

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) }, out, err };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('runCli', () => {
  it('prints usage and exits 0 with --help', async () => {
    const { io, out } = capture();

    expect(await runCli(['--help'], io)).toBe(0);
    expect(out.join('')).toMatch(/candidate add/);
  });

  it('exits 2 on an unknown command or unknown flag, writing nothing to the database', async () => {
    const a = capture();
    expect(await runCli(['candidate', 'delete'], a.io)).toBe(2);
    const b = capture();
    expect(await runCli(['candidate', 'add', '--name', 'x', '--niche', 'y', '--nope', '1'], b.io)).toBe(2);
    expect(ledger.addCandidate).not.toHaveBeenCalled();
  });

  it('rejects a javascript: URL with exit 2 and a JSON error that names the field, never reaching the service', async () => {
    const { io, err } = capture();

    const code = await runCli(
      ['evidence', 'add', '--candidate', 'x', '--source', 'REDDIT', '--claim', 'c', '--url', 'javascript:alert(1)'],
      io
    );

    expect(code).toBe(2);
    const parsed = JSON.parse(err.join('')) as { error: { code: string; details: Array<{ field: string }> } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
    expect(parsed.error.details[0]!.field).toBe('url');
    expect(ledger.addEvidence).not.toHaveBeenCalled();
  });

  it('passes validated, typed evidence to the service and prints compact JSON', async () => {
    ledger.addEvidence.mockResolvedValue({ id: 'e1', candidate: { id: 'p1' } });
    const { io, out } = capture();

    const code = await runCli(
      [
        'evidence', 'add', '--candidate', 'p1', '--source', 'AMAZON_MOVERS_SHAKERS',
        '--claim', 'Rank 4', '--url', 'https://www.amazon.com/x',
        '--metric', 'rank', '--value=4', '--unit', 'position', '--excerpt', '#4 LED Dog Collar',
      ],
      io
    );

    expect(code).toBe(0);
    expect(out.join('')).toBe('{"id":"e1","candidate":{"id":"p1"}}\n');
    expect(ledger.addEvidence).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        source: 'AMAZON_MOVERS_SHAKERS',
        method: 'AGENT_WEB_READ',
        numericValue: 4,
        metric: 'rank',
        unit: 'position',
        excerpt: '#4 LED Dog Collar',
        observedAt: expect.any(Date),
      })
    );
  });

  it('indents output with --pretty', async () => {
    ledger.listCandidates.mockResolvedValue([]);
    const { io, out } = capture();

    await runCli(['candidate', 'list', '--pretty'], io);

    expect(out.join('')).toContain('\n  "candidates"');
  });

  it('takes the candidate for `candidate show` as one positional argument', async () => {
    ledger.showCandidate.mockResolvedValue({ ok: true });
    const a = capture();
    expect(await runCli(['candidate', 'show', 'led dog collar'], a.io)).toBe(0);
    expect(ledger.showCandidate).toHaveBeenCalledWith('led dog collar');

    const b = capture();
    expect(await runCli(['candidate', 'show'], b.io)).toBe(2);
  });

  it('reports a runtime failure with exit 1 and scrubs connection URLs', async () => {
    ledger.listCandidates.mockRejectedValue(
      new Error("Can't reach database at postgresql://user:secret@host:5432/db\nstack line")
    );
    const { io, err } = capture();

    const code = await runCli(['candidate', 'list'], io);

    expect(code).toBe(1);
    const text = err.join('');
    expect(text).toContain('RUNTIME_ERROR');
    expect(text).not.toContain('secret');
  });
});
