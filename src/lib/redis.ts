import 'server-only';
import IORedis from 'ioredis';

// Server-only. The `server-only` import above is a build-time guard against
// this ever landing in a client bundle by mistake. Shared by the BullMQ
// queue (API route side) and the worker process. `maxRetriesPerRequest: null`
// is required by BullMQ — it manages its own retry/backoff semantics and
// errors if ioredis retries underneath it. `lazyConnect: true` means
// constructing this client never blocks module load (e.g. during
// `next build`'s route analysis) on an actual network connection — the
// first real command triggers the connect.
const globalForRedis = globalThis as unknown as {
  redisConnection: IORedis | undefined;
};

function createConnection(): IORedis {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
}

export const redisConnection: IORedis =
  globalForRedis.redisConnection ?? createConnection();

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redisConnection = redisConnection;
}
