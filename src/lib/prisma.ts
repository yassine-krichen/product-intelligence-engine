import 'server-only';
import { PrismaClient } from '@prisma/client';

// Server-only. Never import this from a client component. The `server-only`
// import above is a build-time guard (not just a comment): it throws if this
// module is ever pulled into a client bundle by mistake.
//
// Next.js dev mode reloads route modules on every change, which would create
// a fresh PrismaClient (and a fresh connection pool) per reload without this
// guard. Caching the instance on `globalThis` survives hot reloads in dev;
// in production each server process still gets exactly one instance.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
