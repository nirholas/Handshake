# Fact Check: sourced verdicts with cryptographic attestations

Fact Check submits a claim and returns a verdict, `supported`, `contradicted`, `mixed`, or `insufficient`, backed by live web search and LLM stance analysis, cited sources, a confidence score, and a SHA-256 attestation over the result you can recompute. It ships with a published, checkable accuracy benchmark instead of an asserted quality number, and a live free-check box on the page. The first 3 checks a day per IP run the exact same real chain for free; after that it is $0.10 USDC per check via x402 on Base or Solana. No account, no API key.

Page: [/fact-check](https://three.ws/fact-check)

API: `POST /api/x402/fact-check` (the check), `GET /api/fact-check-benchmark` (the published accuracy benchmark).

## Why it exists

An agent that makes claims needs a way to check claims, and a fact-checker only earns trust if you can audit both its answers and its overall accuracy. Most tools give you neither: no sources, no confidence, no track record. Fact Check is built to be auditable end to end. Every verdict carries the sources it was built from, the stance it read from each, a confidence score, and a content hash you can reproduce. And the whole service publishes a fixed benchmark, 40 curated claims scored against the real chain, so the accuracy number on the page is a measurement, not a marketing claim. It is a paid x402 service that any agent can discover and pay, with a free daily lane so a human can try it with zero setup.

## How it works

The page (`src/fact-check.js`) hydrates three cards: the accuracy benchmark, a "try one free check" box, and pricing. The check itself is `POST /api/x402/fact-check`, a free-daily-lane endpoint that meters overage onto x402.

The request routing:

- A `POST` with a valid `claim` and free quota remaining runs the real chain and returns `200` with `lane: "free"` and `free_remaining_today`.
- Once the free quota is exhausted, or if a payment header is present, the request falls through to the x402 rail: a `402` challenge for $0.10 USDC (100,000 atomics), payable on Base or Solana, and a paid run returns `lane: "paid"`.
- Malformed JSON or a present-but-invalid claim returns a hard `400`; a body with no `claim` at all falls through to a valid 402 so discovery probes get a proper challenge.

The fact-check pipeline (`runFactCheck`):

1. Generate exactly 3 search queries with an LLM.
2. Search across a source chain (Vertex-grounded Google Search, then Brave, Tavily, Exa, Serper, then keyless Wikipedia full-text and DuckDuckGo Instant Answer as always-available fallbacks) and take the top 5 unique results. Each keyed rung is skipped when its key is absent, so the chain runs whatever is configured and always reaches the keyless rungs.
3. Run LLM stance extraction on each of the 5: an excerpt plus a stance of `supports`, `contradicts`, `partial`, or `neutral`. `partial` is a source that engages the claim and finds it true in one respect while wrong, overstated, or only conditionally true in another (right about the fact, wrong about its scale, cause, exclusivity or universality). It is deliberately narrow: hedged prose, thin coverage, or an extractor that is merely unsure is `neutral`, not `partial`.
4. Weight each source by an authority score, adjusted by strictness (`high` halves low-authority weights, `low` floors them, `medium` is the default).
5. Compute the verdict over the stance-bearing evidence only, so tangential results cannot drown a clear answer. Fewer than 2 sources, zero weight, or no source that took a stance at all is `insufficient`, and so is a lone stance-bearing source lost in otherwise-silent evidence (under 30 percent coverage): evidence that never engages the claim is absence of evidence, not disagreement. Otherwise direction is judged over stance-bearing weight alone, 70 percent or more one way is `supported` or `contradicted`, and anything else is `mixed`. `partial` weight is stance-bearing but takes neither side, so it dilutes dominance: a claim every source calls half-true reaches `mixed` on its own, without needing the sources to disagree with each other. Confidence blends dominance with coverage, so a unanimous verdict read off thin engagement scores lower than one read off broad engagement; for `mixed` the dominance term is how strongly the evidence establishes mixedness (partial weight, plus opposed stances counted as the joint evidence of a split that they are), not how lopsided the split was.
6. Build a cost breakdown and the attestation.

The LLM routes through the platform's shared free-first policy (Groq and OpenRouter as funded defaults). Results are cached in Redis for 7 days keyed by a hash of the claim, strictness, and any image URL, so an identical claim (on either lane) never re-runs the live chain.

**The attestation** is a tamper-evident content digest: `sha256:` followed by the SHA-256 of a JSON object of `{ verdict, confidence, claim, source URLs }`. It is returned as a string field you can recompute to confirm the verdict was not altered. Note that this is a content hash, not an on-chain record; it is distinct from the platform's [SAS credentialed attestations](./sas-attestations.md) and [3D provenance anchoring](./provenance.md), which do write to Solana.

**The benchmark** (`GET /api/fact-check-benchmark`) scores a 40-claim fixture (10 per verdict class, deliberately time-stable and non-partisan) against the real chain. The API never fabricates a score: with no run available, `ran` is false and `report` is null, and the page renders a designed "not yet run" empty state. Both the claim set and the scoring runner are linked from the page for inspection. See [Running the benchmark](#running-the-benchmark) for how a run is produced and published.

## Walkthrough

1. Open [/fact-check](https://three.ws/fact-check). The Accuracy benchmark card loads the current published score, per-class breakdown, and last-run time, with links to the 40 benchmark claims and the scoring runner.
2. In the "Try one free check" box, type a claim (5 to 1000 characters) and click Run free check.
3. Read the verdict pill with its confidence, the cited sources with their stances, and the SHA-256 attestation string.
4. After your 3 free checks for the day, the box tells you the paid x402 lane ($0.10 USDC) picks up from there, and to come back tomorrow for more free checks.

## Examples

Free lane (no payment, subject to the 3-per-day-per-IP quota):

```bash
curl -X POST 'https://three.ws/api/x402/fact-check' \
  -H 'content-type: application/json' \
  -d '{"claim":"Solana uses a proof-of-history mechanism to order transactions."}'
```

A free-lane response looks like:

```json
{
  "verdict": "supported",
  "confidence": 0.86,
  "claim": "Solana uses a proof-of-history mechanism to order transactions.",
  "strictness": "medium",
  "sources": [
    { "url": "https://...", "title": "...", "excerpt": "...", "stance": "supports", "weight": 0.9 }
  ],
  "costBreakdown": { "searchCalls": 3, "llmTokens": 1400, "totalUsdc": "0.100350" },
  "attestation": "sha256:...",
  "lane": "free",
  "free_remaining_today": 2
}
```

Read the published benchmark:

```bash
curl 'https://three.ws/api/fact-check-benchmark'
```

Once the free quota is spent, the same POST returns `402` with an x402 challenge; pay it with any x402 client (for example `@three-ws/x402-fetch`) and retry. See [x402](./x402.md).

## Running the benchmark

A published accuracy figure is only worth what its run date is worth, so the benchmark is designed to be re-run by anyone with the service key, not only by whoever first set it up.

### Where a run is stored

Two places, read in this order by `GET /api/fact-check-benchmark`:

1. **The database** (`app_settings`, key `fact_check_benchmark:latest_run`). Written by a `--publish` run or by the weekly cron. This wins, so a new run reaches the public page immediately with no deploy.
2. **`data/_generated/fact-check-benchmark.json`**, committed and baked into the image. The fallback when nothing is published or the DB is unreachable, so an outage degrades to the last shipped run instead of an empty page.

The response's `source` field says which one answered (`database` or `image`).

### Scheduled re-run

`/api/cron/fact-check-benchmark` runs the suite weekly (Mondays 04:41 UTC, see `vercel.json`) in-process on Cloud Run, against the real chain with the Redis verdict cache disabled, and publishes to the DB. No credential is needed for this path: it calls the chain directly, below the x402 payment layer. Tune with `FACT_CHECK_BENCHMARK_CONCURRENCY` (default 6) and `FACT_CHECK_BENCHMARK_DEADLINE_MS` (default 240000, kept under Cloud Scheduler's 320s attempt deadline).

### Running it by hand

```bash
# Scores the deployed endpoint and publishes the result to the live page.
node --env-file=.env scripts/fact-check-benchmark.mjs --publish
```

Drop `--publish` to write only the local file (takes effect on the next deploy). `FACT_CHECK_ENDPOINT` targets a different deployment; `--in-process` runs the chain in-process instead of over HTTP, which needs the search and LLM credentials locally.

One caveat specific to the HTTP path: it goes through the deployed endpoint, so it shares production's 7-day verdict cache. A second run inside that window re-reads the first run's verdicts for any claim that was cached, which measures the cache rather than the chain. The in-process paths (`--in-process` and the cron) disable the cache for the duration of the run and do not have this problem, which is why the scheduled run is the authoritative producer. The `endpoint` field on every report records which path produced it.

### The payment bypass

The runner's HTTP path calls the paid endpoint 40 times, which the 3-per-day free lane cannot cover, so it needs one of the two bypasses in `api/_lib/x402/access-control.js`:

- **`INTERNAL_API_KEY`** (what the published runs use). The internal service key, sent as the `X-API-Key` header. It lives as a plain env var on the `three-ws-api` Cloud Run service and mirrored in `.env`. Rotate it by generating a new value, updating the service, and updating `.env`:
  ```bash
  KEY="three_ws_internal_$(openssl rand -hex 24)"
  gcloud run services update three-ws-api --region us-central1 \
    --project aerial-vehicle-466722-p5 --update-env-vars "INTERNAL_API_KEY=$KEY"
  ```
  Use `--update-env-vars` (merges), never `--set-env-vars` (replaces the whole set). Every bypassed call is logged to `x402_access_log` with caller `internal`.
- **`FACT_CHECK_BYPASS_TOKEN`**, an OAuth bearer carrying the `x402:bypass` scope, sent as `Authorization: Bearer`. Use this when you want a scoped, per-user credential rather than the service key.

With neither, the runner exits before spending a run and writes nothing.

### Why a run can be refused

Two guards keep a bad run from becoming a published number:

- **Errored-claim ceiling.** Above 10% unreachable claims the run measured provider availability, not verdict accuracy. Nothing is written and the previous run stays up.
- **Degraded checks count as errors.** The chain does not throw when its LLM providers are exhausted: stance extraction falls back to all-neutral and every claim resolves to `insufficient`. That would publish roughly 25% as the product's accuracy with zero apparent errors. Both runners read the `degraded` field on the response and count such a check as unreachable, which is what makes the ceiling above fire during an outage.

## States and limits

- **Free quota.** 3 checks per day per IP, running the identical real chain (`lane: "free"`). The limiter is critical: a cache or limiter outage fails closed to the paid rail rather than opening unlimited free checks.
- **Paid lane.** $0.10 USDC (100,000 atomics) per check, on Base or Solana, discoverable in the x402 bazaar. Quota exhaustion or a payment header routes here.
- **Input validation.** Claim 5 to 1000 characters (else `400`), strictness one of `high`, `medium`, `low` (default `medium`), and an optional image URL that must be http(s) and under 2048 characters.
- **Errors.** No search results returns `422 no_results`; a search failure `502 search_failed`; a provider failure `502 provider_error`; malformed JSON `400`; an oversized body `413`.
- **Honest benchmark.** The score shown is whatever the runner last measured against the real chain, or a "not yet run" empty state. Because production currently runs on keyless search fallbacks, decisive verdicts are harder to reach, which the published benchmark reflects rather than hides.
- **Idempotency.** A 7-day Redis cache is shared across both lanes, so repeated identical claims are cheap and consistent.

## Related

- [x402: paid agent skills](./x402.md): the payment rail the $0.10 lane rides
- [API reference: Fact Check API](./api-reference.md): the endpoint's full request and response reference
- [SAS credentialed attestations](./sas-attestations.md) and [3D provenance](./provenance.md): the platform's on-chain attestation primitives (distinct from this content-hash attestation)
- Pages: [/fact-check](https://three.ws/fact-check) · [/x402](https://three.ws/x402)
