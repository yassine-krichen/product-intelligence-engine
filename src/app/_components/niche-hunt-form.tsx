'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

interface RunStatusSnapshot {
  id: string;
  status: string;
  candidateCount: number;
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'PARTIAL']);
const POLL_INTERVAL_MS = 2_000;

/**
 * Posts to POST /api/research-runs, then polls
 * GET /api/research-runs/[id] until the run reaches a terminal status. The
 * API route only enqueues the job — it never runs the pipeline inline — so
 * this poll is the only way the UI learns when a run actually finishes.
 */
export function NicheHuntForm(): React.JSX.Element {
  const [niche, setNiche] = useState('');
  const [subreddits, setSubreddits] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunStatusSnapshot | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function stopPolling(): void {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function pollRun(id: string): Promise<void> {
    try {
      const response = await fetch(`/api/research-runs/${id}`);
      if (!response.ok) return;
      const data: { run: { status: string; candidateCount: number } } = await response.json();
      setActiveRun({ id, status: data.run.status, candidateCount: data.run.candidateCount });
      if (TERMINAL_STATUSES.has(data.run.status)) stopPolling();
    } catch {
      // Transient poll failure — the next tick will retry.
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const subredditList = subreddits
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    try {
      const response = await fetch('/api/research-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          niche,
          subreddits: subredditList.length > 0 ? subredditList : undefined,
        }),
      });

      const data: { id?: string; error?: string } = await response.json();

      if (!response.ok || !data.id) {
        setError(data.error ?? 'Failed to start research run.');
        return;
      }

      setActiveRun({ id: data.id, status: 'PENDING', candidateCount: 0 });
      stopPolling();
      pollRef.current = setInterval(() => {
        void pollRun(data.id!);
      }, POLL_INTERVAL_MS);
    } catch {
      setError('Network error — could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="flex max-w-md flex-col gap-3 rounded border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="niche" className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Niche keyword
        </label>
        <input
          id="niche"
          required
          minLength={2}
          maxLength={100}
          value={niche}
          onChange={(event) => setNiche(event.target.value)}
          placeholder="pet accessories"
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="subreddits" className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Subreddits (comma-separated, optional)
        </label>
        <input
          id="subreddits"
          value={subreddits}
          onChange={(event) => setSubreddits(event.target.value)}
          placeholder="dropship, Entrepreneur"
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>

      <button
        type="submit"
        disabled={submitting}
        className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {submitting ? 'Starting…' : 'Start Niche Hunt'}
      </button>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {activeRun && (
        <p className="tabular text-sm text-neutral-600 dark:text-neutral-400">
          Run {activeRun.id.slice(0, 8)} — {activeRun.status}
          {activeRun.candidateCount > 0 ? ` — ${activeRun.candidateCount} candidate(s)` : ''}
        </p>
      )}
    </form>
  );
}
