# Product Intelligence Engine

A self-hosted product-research platform for finding and validating promising ecommerce/dropshipping
product candidates from real, evidence-backed signals — not AI-invented metrics.

The system is evidence-first: every claim it shows is traceable to an actual observation with a
source URL and timestamp. When a metric isn't known yet, the UI says `UNKNOWN` with a reason. It
never fabricates sales, revenue, trend growth, or margin figures. See
`../PRODUCT_INTELLIGENCE_BUILD_SPEC.md` for the full governing spec and `REUSE.md` for the
repository audit this project's design is based on.

## Phase 1 scope

This is Phase 1 of a 4-phase build (spec section 21). What's real vs. stubbed:

| Area | Status |
|---|---|
| Data model (Product, observations, evidence, scores, research runs) | Live — full schema |
| Reddit adapter (`/r/{subreddit}/hot.json`) | Live |
| Hacker News adapter (Algolia search API) | Live |
| TikTok / Amazon / AliExpress adapters | Stub only — prove the interface is provider-agnostic, no real scraping |
| Discovery pipeline (discover → normalize → dedupe → enrich → calculate) | Live |
| Demand Momentum scoring | Live — computed per (source, tracked item, metric); see note below |
| Economics / Competition / Supplier Quality / Product Suitability scoring | Stub — always `INSUFFICIENT_DATA`, reason "not yet implemented (Phase 2/3)" |
| TrendObservation, SupplierObservation, CompetitorObservation | Schema only — no writer yet |
| Background jobs (BullMQ) | Live — niche-hunt jobs only |
| API routes (start a run, poll a run) | Live |
| Dashboard + product detail UI | Live |
| AI agent layer, watchlist, alerts, competitor intelligence | Not built — Phase 2/3 |

### A note on Demand Momentum and INSUFFICIENT_DATA (read before filing this as a bug)

Demand Momentum requires the *same* tracked item (a specific Reddit post, a specific HN story) to
have the *same* metric (e.g. `ups`, or `num_comments` — never compared against each other) observed
at 2+ genuinely different fetch times. A single research run fetches everything once, so every
metric it records has exactly one observation — that is a snapshot, not a trend, and cannot support
a momentum calculation without inventing one.

Phase 1 has no re-observation scheduler yet (that's Phase 2+ work), so **Demand Momentum will show
`INSUFFICIENT_DATA` for essentially every product until the same product has been re-discovered
across two or more separate research runs.** This is intentional and correct, not a bug to fix by
lowering the observation threshold — see spec section 2 ("never fabricate a metric") and section 6
("`INSUFFICIENT_DATA` ... is preferable to fake precision"). An earlier version of this pipeline
computed momentum from a single run's `ups` vs. `num_comments` values (or from one post's creation
timestamp vs. another's), which produced confident-looking but meaningless scores; that bug is what
this note exists to prevent from being "fixed" again.

## Stack

- Next.js 15 (App Router), TypeScript strict, Tailwind CSS
- Prisma + PostgreSQL (Neon-managed in production)
- Redis (`ioredis`) + BullMQ for the background research-run queue
- One Next.js app + one standalone worker process — no microservices

## Setup

1. Copy `.env.example` to `.env` and fill in real values:
   - `DATABASE_URL` — a Postgres connection string. In production this points at a
     [Neon](https://neon.tech) database. No local Postgres is required or assumed for
     development in this environment — `npx prisma migrate dev` is intentionally not run here;
     point `DATABASE_URL` at a real Neon database (or any reachable Postgres) before migrating.
   - `REDIS_URL` — defaults to `redis://127.0.0.1:6379` for a local Redis Windows service.
     [Upstash](https://upstash.com)'s `REDIS_URL` (a `rediss://...` TLS URL) works identically in
     production — `ioredis` speaks both.
   - `REDDIT_USER_AGENT` — a descriptive User-Agent string for Reddit's public JSON endpoints
     (Reddit asks API consumers to identify themselves).
2. Install dependencies and generate the Prisma client:
   ```
   task product-intelligence-engine:install
   npx prisma generate
   ```
3. Once `DATABASE_URL` points at a real, reachable database, create the schema:
   ```
   npx prisma migrate dev --name init
   ```

## Running

Via the root Taskfile (see `../ORCHESTRATION.md` for the full multi-project setup):

```
task product-intelligence-engine:dev      # Next.js app on port 3005
task product-intelligence-engine:worker   # BullMQ worker (foreground, separate terminal)
```

The Next.js app alone can boot and serve the dashboard without Redis/a live database reachable —
it just can't complete a research run without both. The worker is required for a submitted niche
hunt to actually run; the API route only enqueues the job (spec section 16: long research work
must never block an HTTP request).

`task product-intelligence-engine:dev` is also wired into the root `process-compose.yaml`, so
`process-compose up` from the repo root starts it alongside the other local apps. The worker is
intentionally **not** part of `process-compose.yaml` — like `epub-to-audio-book`, it's an
on-demand process you start manually with `task product-intelligence-engine:worker`.

## Using it

1. Open `http://localhost:3005`.
2. Under "Start Niche Hunt", enter a niche keyword (e.g. `pet accessories`) and, optionally, a
   comma-separated subreddit list (e.g. `dropship, Entrepreneur`) to search on Reddit. Hacker News
   is always searched by the niche keyword directly.
3. The dashboard polls the run until it finishes, then lists it under "Recent Research Runs" and
   any discovered products under "Recent Candidates".
4. Open a candidate to see its 5 score dimensions, demand observation history, evidence, and raw
   source records — every claim on the page links back to where it came from.

## Deviations from the literal spec (and why)

- **`Product.discoveredInRunId`** — not in the spec's literal entity list, but added so
  `GET /api/research-runs/[id]` can return a run's candidates directly (a spec-required
  behavior) without a separate join table. Only set at creation time, so re-running a hunt later
  updates a product's signals without rewriting which run first discovered it.
- **`Product.sourceUrls` can contain duplicate URLs across runs.** It's an atomic `push` on every
  re-discovery of the same product (see the `upsertProduct` doc comment in
  `src/features/discovery/pipeline.ts`), by design, so two research runs never race and lose one
  another's URL — but that means the same URL can be appended more than once if the same product
  surfaces again in a later run. This is a display convenience only; the authoritative,
  already-deduplicated per-source record is `ProductSourceRecord` (unique on `(source, externalId)`).
- **Prisma model name `ProductSourceRecord`** instead of the spec's `ProductSource` — the spec's
  own `ProductSource` name is already used for the TypeScript adapter interface
  (`src/features/discovery/source.types.ts`); the build task itself flagged this and asked for
  the DB model to be renamed to avoid the clash.
- **Prisma 7.10.0 pinned instead of the `latest` npm dist-tag** — at build time, `npm view prisma
  dist-tags.latest` resolved to an `8.0.0-rc.*` release candidate. Pinned to the last stable 7.x
  release instead (boring/stable over bleeding-edge, per this project's engineering standards).
- **Tailwind CSS v4** — the spec just says "Tailwind"; v4 is the current stable major and uses a
  CSS-first config (`@import "tailwindcss"` in `globals.css`, no `tailwind.config.ts` needed for
  this project's scope) rather than v3's JS config file.
- **In-memory rate limiter** (`src/lib/rate-limit.ts`) is explicitly a Phase 1 placeholder, as the
  spec allows ("documented as a placeholder for a real limiter later") — it does not share state
  across instances or survive a restart.

## Known environment caveat: local Redis version

This machine's local Redis Windows service reports version 3.0.504. BullMQ requires Redis >= 5.0
and will throw `Redis version needs to be greater or equal than 5.0.0` as soon as a Queue/Worker
actually connects. The Next.js app itself is unaffected at boot or build time (see
`src/features/jobs/queue.ts` — the BullMQ `Queue` is constructed lazily on first API call, not at
module load, specifically so `next build` and `next dev` never touch Redis just by starting up),
but `task product-intelligence-engine:worker` will fail against this local Redis until it's
upgraded to >= 5.0 or `REDIS_URL` is pointed at Upstash (which is already >= 5.0-compatible).

## Known dependency advisories (accepted for Phase 1)

`npm audit` reports 7 advisories, all in transitive dev/build tooling — none in code that runs in
the deployed app:

- `mysql2` / `deepmerge-ts` (high) — pulled in transitively by the `prisma` CLI's `@prisma/config`,
  regardless of the fact this project only uses Postgres. Not present in `@prisma/client`, which is
  the package that actually runs at request time.
- `postcss` (high) — bundled inside `next`'s own internal `node_modules/next/node_modules/postcss`
  (Next's internal build-time CSS handling), not the top-level `postcss`/`@tailwindcss/postcss`
  this project declares.
- `@vitest/mocker` (moderate) — test-only tooling, never shipped.

All three fixes require a breaking major bump (`prisma@6.19.3`'s own `npm audit fix --force`
suggestion, or `next@16.x`) that would contradict this spec's pinned "Next.js 15" / the
"boring/stable over bleeding-edge" reasoning above. Re-check `npm audit` next time dependencies
are touched.

## Security notes (spec section 18)

- Subreddit names are validated against a strict allowlist (`^[A-Za-z0-9_]{2,21}$`) in **two**
  places — the API route and the adapter itself — before ever being interpolated into a fetch URL.
- Every external API response (Reddit, HN) is parsed with Zod before anything is trusted or
  stored, including URL fields (must be `http`/`https`, never `javascript:`/`data:`/etc.) and the
  Reddit `permalink` (must start with `/r/` before it's used to build a link).
- Prisma, BullMQ, and all adapters are server-only; nothing DB- or queue-related is imported into
  a client component. `src/lib/prisma.ts`, `src/lib/redis.ts`, and `src/features/jobs/queue.ts`
  each `import 'server-only'` as a build-time guard against this, not just a code comment.
- No `dangerouslySetInnerHTML` is used anywhere — scraped titles/text render as plain React
  children.
- The research-run POST route has a basic in-memory rate limit (see Deviations above). It
  deliberately does **not** key on `x-forwarded-for` — with no trusted reverse proxy in front of
  this Phase 1 deployment, that header is fully client-spoofable, so trusting it as an identity key
  would make the limit trivially bypassable. Until real per-user auth exists, the limiter keys on a
  single shared bucket instead (see `src/lib/rate-limit.ts`'s doc comment) — replace with
  authenticated-user-based limiting before any multi-user deployment.
- A failed/timed-out job enqueue (e.g. Redis unreachable) marks the just-created `ResearchRun`
  `FAILED` and returns `503`, rather than leaving an orphaned `PENDING` run or an unhandled `500`.
- `GET /api/research-runs/[id]` uses an explicit Prisma `select` (never the full row) and sanitizes
  every stored error entry before it reaches the client: whitespace is collapsed and the message is
  truncated to a short single line, and any message matching a known internal-error shape (a raw
  Prisma client invocation message, or one containing an absolute Windows/POSIX file path) is
  replaced wholesale with a fixed generic string instead of being partially redacted — see
  `sanitizeMessage` in that route file.
