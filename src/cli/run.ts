import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  addCandidate,
  addEvidence,
  listCandidates,
  recomputeScores,
  showCandidate,
} from '@/features/ledger/ledger.service';
import { dryRunHnHunt, runHnHunt } from '@/features/discovery/hn-hunt.service';
import { checkTrendsForCandidate, dryRunTrends } from '@/features/trends/trends.service';
import {
  CandidateAddSchema,
  CandidateListSchema,
  CandidateShowSchema,
  EvidenceAddSchema,
  HuntHnSchema,
  ScoreRecomputeSchema,
  TrendsCheckSchema,
} from './schemas';

export const USAGE = `pie - Product Intelligence Engine CLI (prints compact JSON; add --pretty for indented)

Usage: pie <group> <command> [flags]

  candidate add --name <text> --niche <text> [--description <text>]
  candidate list [--niche <text>] [--verdict UNVERIFIED|WEAK|PROMISING] [--limit <1-200>]
  candidate show <id|name>
  evidence add --candidate <id|name> --source <SOURCE> --claim <text> --url <http(s) url>
               [--metric <snake_case> --value <number> [--unit <text>]]
               [--excerpt <verbatim snippet, max 300 chars>] [--observed-at <ISO date>]
               [--method AGENT_WEB_READ|MANUAL]   (default AGENT_WEB_READ)
  score recompute [--candidate <id|name>]
  hunt hn --niche <keyword> [--dry-run]
  trends check --candidate <id|name> [--keyword <text>] [--geo <US>]
  trends check --dry-run --keyword <text> [--geo <US>]

Sources: REDDIT, HACKER_NEWS, TIKTOK, AMAZON, ALIEXPRESS, TIKTOK_CREATIVE_CENTER,
         AMAZON_MOVERS_SHAKERS, GOOGLE_TRENDS, WEB

Notes:
  - Pass negative numbers as --value=-5 (a bare -5 reads as a flag).
  - A number only counts as evidence with --metric, --value and a --url; claims without
    a number are stored but never count as demand.
  - Every argument is validated; invalid input is rejected, never coerced.
`;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

type OptionSpec = Record<string, { type: 'string' | 'boolean' }>;

interface CommandDefinition {
  options: OptionSpec;
  /** Name the single positional argument is stored under, if the command takes one. */
  positional?: string;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

const toCamelCase = (flag: string): string => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/**
 * Parses and Zod-validates arguments, then runs the service call. Each
 * schema is the single gate: nothing reaches Prisma without passing it.
 */
class CliValidationError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super('Invalid arguments.');
    this.name = 'CliValidationError';
  }
}

function command<S extends z.ZodType>(
  options: OptionSpec,
  schema: S,
  run: (args: z.output<S>) => Promise<unknown>,
  positional?: string
): CommandDefinition {
  return {
    options,
    positional,
    run: async (raw) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new CliValidationError(parsed.error);
      return run(parsed.data);
    },
  };
}

const COMMANDS: Record<string, CommandDefinition> = {
  'candidate add': command(
    { name: { type: 'string' }, niche: { type: 'string' }, description: { type: 'string' } },
    CandidateAddSchema,
    (args) => addCandidate(args)
  ),
  'candidate list': command(
    { niche: { type: 'string' }, verdict: { type: 'string' }, limit: { type: 'string' } },
    CandidateListSchema,
    async (args) => ({ candidates: await listCandidates(args) })
  ),
  'candidate show': command({}, CandidateShowSchema, (args) => showCandidate(args.candidate), 'candidate'),
  'evidence add': command(
    {
      candidate: { type: 'string' },
      source: { type: 'string' },
      claim: { type: 'string' },
      url: { type: 'string' },
      metric: { type: 'string' },
      value: { type: 'string' },
      unit: { type: 'string' },
      excerpt: { type: 'string' },
      'observed-at': { type: 'string' },
      method: { type: 'string' },
    },
    EvidenceAddSchema,
    async (args) => {
      const { candidate, ...rest } = args;
      return addEvidence(candidate, {
        source: rest.source,
        claim: rest.claim,
        url: rest.url,
        method: rest.method,
        observedAt: rest.observedAt ?? new Date(),
        metric: rest.metric,
        numericValue: rest.value,
        unit: rest.unit,
        excerpt: rest.excerpt,
      });
    }
  ),
  'score recompute': command(
    { candidate: { type: 'string' } },
    ScoreRecomputeSchema,
    async (args) => ({ results: await recomputeScores(args.candidate) })
  ),
  'hunt hn': command(
    { niche: { type: 'string' }, 'dry-run': { type: 'boolean' } },
    HuntHnSchema,
    (args) => (args.dryRun ? dryRunHnHunt(args.niche) : runHnHunt(args.niche))
  ),
  'trends check': command(
    {
      candidate: { type: 'string' },
      keyword: { type: 'string' },
      geo: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    TrendsCheckSchema,
    (args) =>
      args.dryRun
        ? dryRunTrends(args.keyword!, args.geo)
        : checkTrendsForCandidate({ candidate: args.candidate!, keyword: args.keyword, geo: args.geo })
  ),
};

/**
 * Database errors can embed connection strings, so surface only one short,
 * scrubbed line. Prisma puts the cause on the last line (the first is a code
 * frame header); everything else leads with it.
 */
function describeRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error';
  const lines = message.split('\n').filter((line) => line.trim().length > 0);
  const line = (message.includes('prisma.') ? lines[lines.length - 1] : lines[0]) ?? 'Unknown error';
  return line.replace(/[a-z]+:\/\/\S+/gi, '[redacted-url]').slice(0, 300);
}

function fail(io: CliIo, code: string, message: string, details?: unknown): number {
  io.stderr(`${JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } })}\n`);
  return code === 'VALIDATION_ERROR' || code === 'USAGE' ? 2 : 1;
}

/** Returns the process exit code: 0 ok, 2 bad usage/validation, 1 runtime failure. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const pretty = argv.includes('--pretty');
  const args = argv.filter((arg) => arg !== '--pretty');

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    io.stdout(USAGE);
    return 0;
  }

  const key = `${args[0]} ${args[1] ?? ''}`.trim();
  const definition = COMMANDS[key];
  if (!definition) return fail(io, 'USAGE', `Unknown command "${key}". Run with --help.`);

  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: args.slice(2),
      options: definition.options,
      allowPositionals: definition.positional !== undefined,
      strict: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return fail(io, 'USAGE', error instanceof Error ? error.message : 'Invalid arguments.');
  }

  if (definition.positional !== undefined && positionals.length !== 1) {
    return fail(io, 'USAGE', `Expected exactly one <${definition.positional}> argument.`);
  }

  const raw: Record<string, unknown> = {};
  for (const [flag, value] of Object.entries(values)) {
    if (value !== undefined) raw[toCamelCase(flag)] = value;
  }
  if (definition.positional !== undefined) raw[definition.positional] = positionals[0];

  try {
    const result = await definition.run(raw);
    io.stdout(`${JSON.stringify(result, null, pretty ? 2 : undefined)}\n`);
    return 0;
  } catch (error) {
    // Only argument parsing is a validation error; a ZodError thrown later by
    // an adapter parsing a third-party response is a runtime failure.
    if (error instanceof CliValidationError) {
      return fail(
        io,
        'VALIDATION_ERROR',
        'Invalid arguments.',
        error.zodError.issues.map((issue) => ({ field: issue.path.join('.') || '(root)', message: issue.message }))
      );
    }
    return fail(io, 'RUNTIME_ERROR', describeRuntimeError(error));
  }
}
