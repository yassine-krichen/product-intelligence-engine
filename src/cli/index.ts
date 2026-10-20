import { prisma } from '@/lib/prisma';
import { runCli } from './run';

/**
 * Entry point for `npm run pie -- <args>` / `task product-intelligence-engine:pie -- <args>`.
 * Talks to Prisma directly: no queue, no Redis, no running Next.js server.
 */
async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  await prisma.$disconnect();
  process.exitCode = exitCode;
}

void main();
