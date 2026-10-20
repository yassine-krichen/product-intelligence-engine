# REUSE.md

Per the build spec's operating instructions (section 24), this documents what was inspected in
the candidate foundation repository and what — if anything — was reused from it.

---

## SOURCE

`alicelabs-llc/Scraper` ("ProdIntel") — https://github.com/alicelabs-llc/Scraper

## WHAT WAS REUSED

Nothing was reused as code. No files, functions, or literal logic from this repository appear
anywhere in this project. This project's architecture (Next.js App Router, Prisma/Postgres,
BullMQ worker, the `ProductSource` adapter interface, the scoring-dimension model) was designed
independently from the build spec, not derived from ProdIntel's structure.

Two ideas were used only as informal reference points for later phases, not copied:

- **`api/signals.ts`'s request-shape pattern for signal sources** — the general idea of giving
  each external signal source its own typed request/response shape, rather than one loosely
  typed blob. This project's own `ProductSource` interface
  (`src/features/discovery/source.types.ts`) was written independently, but the shape-per-source
  discipline was worth noting.
- **`services/ai/providers.ts`'s provider-table pattern for AI abstraction** — the idea of a
  lookup table mapping provider id to client config, as a reference point for Phase 3's
  multi-provider AI layer (spec section 7: Anthropic/OpenAI/Gemini/OpenRouter/Ollama support).
  Not needed and not implemented in Phase 1, since Phase 1 has no AI layer at all.

## WHY

The repository was audited per spec section 1 before any implementation began, specifically to
avoid rebuilding functionality that was already mature and reusable. The audit found the
opposite: reusable *ideas*, but an architecture and data-integrity approach that should not be
inherited (see MODIFICATIONS below for what was deliberately built differently, and why).

## LICENSE

MIT. Full permission to copy/modify/reuse is granted by the license; nothing in this project's
lack of code reuse is a licensing constraint — it's a quality/architecture judgment call. No
branding, naming, copy, or trademark from ProdIntel was carried over; this project's name,
structure, and all copy are original.

## MODIFICATIONS

Not applicable in the literal sense (no code was forked to modify) — but the audit's key finding
is recorded here because it directly shaped this project's core design principle:

**What must NOT be repeated:** ProdIntel's `geminiService.ts` and its scoring logic ask an LLM to
directly invent trend/margin/demand numbers with no real data backing it. Several of its "live"
signals are AI-invented rather than actually fetched from any source. This is exactly the
fabrication the build spec forbids (section 2: "Never fabricate ... trend growth ... demand").

This project's entire scoring design — a `ProductScoreDimension` row per dimension, each either
`COMPUTED` (from real stored observations) or `INSUFFICIENT_DATA` with an explicit reason, never
a single magic number, never an AI-invented metric — exists specifically because of what this
audit found should not be repeated.

**Verdict:** cherry-pick-components-only. ProdIntel was not used as a fork target; its
architecture was not inherited.

---

## RESEARCH REFERENCES (added 2026-10-04, Phase 1.5)

These were consulted while building the Google Trends client, the trend classifier and the discovery
approach. **No code was copied from any of them**; the Google Trends client in
`src/features/trends/google-trends.client.ts` is original, informed only by the public request pattern
(landing-page cookie, explore call for a widget token, widgetdata call for the series) that the MIT
projects below also document.

| Project | License | Used for | Status |
|---|---|---|---|
| `trendspyg` (Python) | MIT | Reference for Google Trends cookie/consent handling and request pacing | Reference only, no code reused |
| `trends-checker` (Python) | MIT | Reference for rate limiting and series fetching patterns | Reference only, no code reused |
| `Keepa` API client libraries | Keepa client libs are MIT; the Keepa service is paid | Considered for Amazon price/rank history | Not used: the owner will not pay for Keepa |
| `google-trends-api` (npm) | MIT | Live-tested on 2026-10-04 and it worked, but it was last published 2022-06 | Not adopted: an unmaintained dependency for ~150 lines of fetch code |
| `AdDownloader` | **GPL-3.0** | Ad-library scraping reference | **NOT used.** GPL-3.0 would force this project's license; nothing from it is read, copied or linked |

Licenses above are as recalled at the time of writing; re-verify before copying any code from them.
If code is ever reused from one of these, move it to the "WHAT WAS REUSED" section with attribution.
