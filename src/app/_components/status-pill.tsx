const STATUS_STYLES: Record<string, string> = {
  HEALTHY: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  COMPLETED: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  COMPUTED: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  PROMISING: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  WEAK: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  UNVERIFIED: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
  DEGRADED: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  RUNNING: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  PARTIAL: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  PENDING: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
  DOWN: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  FAILED: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  NOT_IMPLEMENTED: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
  INSUFFICIENT_DATA: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-500',
};

/** Small status indicator used for source health, run status, and score status. */
export function StatusPill({ status }: { status: string }): React.JSX.Element {
  const className =
    STATUS_STYLES[status] ??
    'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300';

  return (
    <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${className}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
