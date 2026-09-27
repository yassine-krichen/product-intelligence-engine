import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Server-only packages (Prisma, BullMQ/ioredis) must never be bundled for
  // the client. Route handlers already isolate them, but this keeps the
  // server component graph honest too.
  serverExternalPackages: ['@prisma/client', 'bullmq', 'ioredis'],
};

export default nextConfig;
