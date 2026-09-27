import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { checkAllSourcesHealth } from '@/features/discovery/pipeline';
import { NicheHuntForm } from './_components/niche-hunt-form';
import { StatusPill } from './_components/status-pill';

// Reads Prisma + calls source healthChecks on every request — never
// statically generated.
export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const [runs, candidates, sourceHealth] = await Promise.all([
    prisma.researchRun.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, canonicalName: true, niche: true, createdAt: true },
    }),
    checkAllSourcesHealth(),
  ]);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Start Niche Hunt
        </h1>
        <NicheHuntForm />
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent Research Runs
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No research runs yet — start one above.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="py-1.5 pr-4 font-medium">Niche</th>
                  <th className="py-1.5 pr-4 font-medium">Status</th>
                  <th className="py-1.5 pr-4 font-medium">Candidates</th>
                  <th className="py-1.5 pr-4 font-medium">Started</th>
                  <th className="py-1.5 font-medium">Finished</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="py-1.5 pr-4">{run.niche}</td>
                    <td className="py-1.5 pr-4">
                      <StatusPill status={run.status} />
                    </td>
                    <td className="tabular py-1.5 pr-4">{run.candidateCount}</td>
                    <td className="tabular py-1.5 pr-4 text-neutral-500 dark:text-neutral-400">
                      {run.startedAt.toLocaleString()}
                    </td>
                    <td className="tabular py-1.5 text-neutral-500 dark:text-neutral-400">
                      {run.finishedAt ? run.finishedAt.toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Recent Candidates
        </h2>
        {candidates.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No candidates discovered yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {candidates.map((product) => (
              <li key={product.id} className="flex items-center justify-between py-1.5 text-sm">
                <Link href={`/products/${product.id}`} className="hover:underline">
                  {product.canonicalName}
                </Link>
                <span className="text-xs text-neutral-500 dark:text-neutral-400">
                  {product.niche ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Source Health
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                <th className="py-1.5 pr-4 font-medium">Source</th>
                <th className="py-1.5 pr-4 font-medium">Status</th>
                <th className="py-1.5 font-medium">Checked</th>
              </tr>
            </thead>
            <tbody>
              {sourceHealth.map((health) => (
                <tr key={health.id} className="border-b border-neutral-100 dark:border-neutral-900">
                  <td className="py-1.5 pr-4">{health.id}</td>
                  <td className="py-1.5 pr-4">
                    <StatusPill status={health.status} />
                  </td>
                  <td className="tabular py-1.5 text-neutral-500 dark:text-neutral-400">
                    {health.checkedAt.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
