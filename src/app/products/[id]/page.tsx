import { notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { assessCandidate } from '@/features/scoring/assess-candidate';
import { StatusPill } from '../../_components/status-pill';

export const dynamic = 'force-dynamic';

const DIMENSION_ORDER = [
  'DEMAND_MOMENTUM',
  'ECONOMICS',
  'COMPETITION',
  'SUPPLIER_QUALITY',
  'PRODUCT_SUITABILITY',
] as const;

const DIMENSION_LABELS: Record<(typeof DIMENSION_ORDER)[number], string> = {
  DEMAND_MOMENTUM: 'Demand momentum',
  ECONOMICS: 'Economics',
  COMPETITION: 'Competition',
  SUPPLIER_QUALITY: 'Supplier quality',
  PRODUCT_SUITABILITY: 'Product suitability',
};

interface ProductDetailPageProps {
  params: Promise<{ id: string }>;
}

export default async function ProductDetailPage({
  params,
}: ProductDetailPageProps): Promise<React.JSX.Element> {
  const { id } = await params;

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      sourceRecords: { orderBy: { observedAt: 'desc' } },
      demandObservations: { orderBy: { observedAt: 'asc' } },
      evidence: { orderBy: { observedAt: 'desc' } },
      scoreDimensions: true,
    },
  });

  if (!product) notFound();

  const assessment = assessCandidate(product.evidence);

  const scoreByDimension = new Map(
    product.scoreDimensions.map((dimension) => [dimension.dimension, dimension])
  );

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h1 className="text-lg font-semibold">{product.canonicalName}</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          {product.niche ? `Niche: ${product.niche}` : 'No niche recorded'}
          {product.category ? ` · Category: ${product.category}` : ''}
        </p>
        <p className="tabular mt-1 text-xs text-neutral-400 dark:text-neutral-500">
          First discovered {product.createdAt.toLocaleString()} · Last updated{' '}
          {product.updatedAt.toLocaleString()}
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Credibility
        </h2>
        {/*
          Verdict comes only from measured evidence (number + URL, from an API
          or an agent web read) across independent sources — see
          assessCandidate. Reasons and gaps are shown so "why not PROMISING?"
          always has an answer on the page.
        */}
        <div className="flex items-center gap-3 text-sm">
          <StatusPill status={assessment.verdict} />
          <span className="tabular text-neutral-600 dark:text-neutral-400">
            {assessment.independentSources} independent measured source(s)
          </span>
        </div>
        <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-5 text-sm text-neutral-700 dark:text-neutral-300">
          {assessment.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        {assessment.gaps.length > 0 && (
          <>
            <h3 className="mt-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">Gaps</h3>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-sm text-neutral-600 dark:text-neutral-400">
              {assessment.gaps.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Score Dimensions
        </h2>
        {/*
          Spec section 6: never a single opaque score. Each dimension is
          rendered on its own line, and a COMPUTED score always sits beside
          the evidence panel below it — the reason string on an
          INSUFFICIENT_DATA row is itself the traceability answer to
          "why is this UNKNOWN?".
        */}
        <dl className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
          {DIMENSION_ORDER.map((dimensionKey) => {
            const dimension = scoreByDimension.get(dimensionKey);
            return (
              <div key={dimensionKey} className="flex items-center justify-between py-2 text-sm">
                <dt className="font-medium">{DIMENSION_LABELS[dimensionKey]}</dt>
                <dd className="flex items-center gap-2 text-right">
                  {dimension?.status === 'COMPUTED' ? (
                    <span className="tabular text-base font-semibold">{dimension.score}</span>
                  ) : (
                    <>
                      <span className="tabular text-base font-semibold text-neutral-400 dark:text-neutral-600">
                        UNKNOWN
                      </span>
                      {dimension?.reason && (
                        <span className="text-xs text-neutral-500 dark:text-neutral-400">
                          {dimension.reason}
                        </span>
                      )}
                    </>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Demand Observation History
        </h2>
        {product.demandObservations.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No demand observations recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  <th className="py-1.5 pr-4 font-medium">Source</th>
                  <th className="py-1.5 pr-4 font-medium">Metric</th>
                  <th className="py-1.5 pr-4 font-medium">Value</th>
                  <th className="py-1.5 pr-4 font-medium">Fetched</th>
                  <th className="py-1.5 font-medium">Posted</th>
                </tr>
              </thead>
              <tbody>
                {product.demandObservations.map((observation) => (
                  <tr key={observation.id} className="border-b border-neutral-100 dark:border-neutral-900">
                    <td className="py-1.5 pr-4">{observation.source}</td>
                    <td className="py-1.5 pr-4">{observation.metric}</td>
                    <td className="tabular py-1.5 pr-4">{observation.value}</td>
                    {/* "Fetched" (observedAt) is the momentum clock; "Posted"
                        (sourceCreatedAt) is the underlying item's own
                        timestamp — evidence metadata only. Showing both
                        makes the B1 fix's distinction visible, not just
                        internal (spec section 6: every number must be
                        traceable). */}
                    <td className="tabular py-1.5 pr-4 text-neutral-500 dark:text-neutral-400">
                      {observation.observedAt.toLocaleString()}
                    </td>
                    <td className="tabular py-1.5 text-neutral-500 dark:text-neutral-400">
                      {observation.sourceCreatedAt.toLocaleString()}
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
          Evidence
        </h2>
        {product.evidence.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No evidence recorded yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {product.evidence.map((fact) => (
              <li key={fact.id} className="flex flex-col gap-0.5 py-2 text-sm">
                <span>
                  <span className="font-medium">{fact.claim}</span>
                  {fact.value ? `: ${fact.value}` : ''}
                </span>
                <span className="tabular text-xs text-neutral-500 dark:text-neutral-400">
                  {fact.source} · {fact.method} · {fact.observedAt.toLocaleString()}
                  {typeof fact.confidence === 'number' ? ` · confidence ${fact.confidence}` : ''}
                  {fact.url && (
                    <>
                      {' · '}
                      <a
                        href={fact.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        source
                      </a>
                    </>
                  )}
                </span>
                {fact.excerpt && (
                  <span className="text-xs italic text-neutral-500 dark:text-neutral-400">
                    “{fact.excerpt}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          Source Records
        </h2>
        {product.sourceRecords.length === 0 ? (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            No source records yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-100 dark:divide-neutral-900">
            {product.sourceRecords.map((record) => (
              <li key={record.id} className="flex items-center justify-between py-2 text-sm">
                <span className="flex items-center gap-2">
                  <StatusPill status={record.source} />
                  <a
                    href={record.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    {record.url}
                  </a>
                </span>
                <span className="tabular text-xs text-neutral-500 dark:text-neutral-400">
                  {record.observedAt.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
