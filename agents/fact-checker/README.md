# Fact Checker

The verification pipeline behind the three.ws Real-Time Fact Checker. Given a claim, it generates search queries with an LLM, runs them across a multi-provider web search chain, scores each source's authority, extracts each source's stance toward the claim, and optionally folds in evidence from an attached image. The weighted verdict, confidence score, and SHA-256 attestation are computed by the consuming endpoint. It serves end users on the `/fact-check` page (3 free checks per day per IP), paying agents over x402, and the Sheriff Boone NPC in `/play`.

## How it works

For each check, [../../api/x402/fact-check.js](../../api/x402/fact-check.js) drives this sequence:

1. **Query generation**: `generateSearchQueries()` asks the LLM for 3 distinct search queries approaching the claim from different angles ([src/llm-verdict.js](src/llm-verdict.js)).
2. **Search**: `searchAll()` runs the queries through a fallback chain: Brave, Tavily, Exa, Serper (each only if its key is configured, up to 2 in parallel), then two free keyless fallbacks, Wikipedia full-text search and the DuckDuckGo Instant Answer API, until at least 3 deduplicated results exist ([src/search-sources.js](src/search-sources.js)).
3. **Authority weighting**: `authorityScore()` maps each result URL to a trust weight in [0, 1]: curated domain scores (Reuters 0.85, Wikipedia 0.7, Reddit 0.4, and so on), 0.95 for `.gov`, 0.9 for `.edu`, 0.55 default ([src/source-authority.js](src/source-authority.js)).
4. **Stance extraction**: `analyzeResults()` makes one LLM call over the top results, returning a 200-character excerpt and a stance (`supports`, `contradicts`, `partial`, `neutral`) per source. `partial` marks a source that finds the claim true in one respect and wrong or overstated in another; the consuming endpoint counts it as stance-bearing evidence that takes neither side, which is how a half-true claim reaches a `mixed` verdict without the sources having to disagree with each other.
5. **Image evidence** (optional): `imageEvidence()` sends an attached image to the shared vision helper ([../../api/_lib/vision.js](../../api/_lib/vision.js)), getting a description, transcribed text, and a stance. The result folds into the verdict as one more source with weight 0.6. Fail-open: any vision failure returns `null` and the check proceeds on web sources alone ([src/image-evidence.js](src/image-evidence.js)).

## Key files

| File | Role |
|---|---|
| [src/search-sources.js](src/search-sources.js) | `searchWeb()` and `searchAll()`: the multi-provider search chain with keyless fallbacks |
| [src/llm-verdict.js](src/llm-verdict.js) | `generateSearchQueries()` and `analyzeResults()`: LLM query generation and stance extraction |
| [src/source-authority.js](src/source-authority.js) | `authorityScore()`: per-domain trust weights |
| [src/image-evidence.js](src/image-evidence.js) | `imageEvidence()`: vision analysis of a claim's attached image |
| [../../api/x402/fact-check.js](../../api/x402/fact-check.js) | The endpoint: free lane, x402 paid lane, weighted verdict, caching, attestation |
| [../../pages/fact-check.html](../../pages/fact-check.html) | The `/fact-check` page |
| [../../scripts/fact-check-benchmark.mjs](../../scripts/fact-check-benchmark.mjs) | Real-chain accuracy benchmark over 40 fixture claims |
| [../../tests/api/fact-check-v2.test.js](../../tests/api/fact-check-v2.test.js) | Endpoint tests |

## How to run

The keyless search chain works with no configuration at all, from the repo root (Node 20+):

```bash
node -e "import('./agents/fact-checker/src/search-sources.js').then(m => m.searchWeb('Does cracking your knuckles cause arthritis')).then(r => console.log(r.slice(0, 3)))"
```

A full check through the deployed endpoint (the free lane allows 3 checks per day per IP):

```bash
curl -s -X POST https://three.ws/api/x402/fact-check -H 'content-type: application/json' -d '{"claim":"The Eiffel Tower is 330 meters tall"}'
```

Above the free quota the same request returns a 402 quote for $0.10 in USDC on Base or Solana. The accuracy benchmark: `node scripts/fact-check-benchmark.mjs`.

## Environment variables

- `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, `SERPER_API_KEY`: optional paid search providers, used in that priority order. All are optional; without any of them the chain runs on Wikipedia plus DuckDuckGo.
- LLM providers come from the shared chain in [../../api/_lib/llm.js](../../api/_lib/llm.js) (`GROQ_API_KEY`, `OPENROUTER_API_KEY`, and the rest). `callLlm` deliberately passes no BYOK key so the free providers stay first.
- Vision lane configuration is owned by `api/_lib/vision.js`; if unconfigured, image evidence is skipped.
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (or the `three_KV_REST_API_*` / `KV_REST_API_*` equivalents): used by the endpoint for the 7-day verdict cache and the free-lane quota counter.

## Platform connections

- **x402**: `POST /api/x402/fact-check` is a paid, Bazaar-listed endpoint ($0.10, USDC on Base or Solana) with a free daily lane; responses carry `lane` and `free_remaining_today`.
- **Consumers**: the `/fact-check` page, paying agents via the Bazaar, and the Sheriff Boone NPC in `/play`.
- **Attestation**: every verdict ships with a SHA-256 attestation over the claim, verdict, and sources, computed in the endpoint.
