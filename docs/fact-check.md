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
2. Search across a source chain (Brave, Tavily, Exa, Serper, then keyless Wikipedia full-text and DuckDuckGo Instant Answer as always-available fallbacks) and take the top 5 unique results.
3. Run LLM stance extraction on each of the 5: an excerpt plus a stance of `supports`, `contradicts`, or `neutral`.
4. Weight each source by an authority score, adjusted by strictness (`high` halves low-authority weights, `low` floors them, `medium` is the default).
5. Compute the verdict: fewer than 2 sources is `insufficient`; a weighted support ratio above 0.65 is `supported`; a weighted contradiction ratio above 0.65 is `contradicted`; otherwise `mixed`. Confidence is the winning ratio.
6. Build a cost breakdown and the attestation.

The LLM routes through the platform's shared free-first policy (Groq and OpenRouter as funded defaults). Results are cached in Redis for 7 days keyed by a hash of the claim, strictness, and any image URL, so an identical claim (on either lane) never re-runs the live chain.

**The attestation** is a tamper-evident content digest: `sha256:` followed by the SHA-256 of a JSON object of `{ verdict, confidence, claim, source URLs }`. It is returned as a string field you can recompute to confirm the verdict was not altered. Note that this is a content hash, not an on-chain record; it is distinct from the platform's [SAS credentialed attestations](./sas-attestations.md) and [3D provenance anchoring](./provenance.md), which do write to Solana.

**The benchmark** (`GET /api/fact-check-benchmark`) reads two committed files: a 40-claim fixture (10 per verdict class, deliberately time-stable and non-partisan) and a generated report from `scripts/fact-check-benchmark.mjs`, which runs those claims in-process against the real chain. The API never fabricates a score: if the runner has not executed in an environment, `ran` is false and `report` is null, and the page renders a designed "not yet run" empty state. Both the claim set and the scoring runner are linked from the page for inspection.

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
  "costBreakdown": { "searchCalls": 2, "llmTokens": 1400, "totalUsdc": "0.100350" },
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
