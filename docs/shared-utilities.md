# Shared utilities

Small, dependency-backed modules that exist so the same problem is not solved
twice. Each one replaced a family of hand-rolled copies that had drifted apart;
if you find yourself about to write another Markdown renderer, toast, retry
loop, or LRU cache, import from here and extend it instead.

The rule from [CLAUDE.md](../CLAUDE.md) applies: never reinvent a solved
problem. Every module below is a thin layer over a well-maintained package,
adding only the project's conventions.

---

## Frontend

### `src/shared/markdown.js` — sanitized Markdown

Renders Markdown to HTML that is safe to assign via `innerHTML`. Built on
[`marked`](https://www.npmjs.com/package/marked) (CommonMark + GFM) followed by
a strict [`DOMPurify`](https://www.npmjs.com/package/dompurify) pass.

```js
import { renderMarkdown, stripMarkdown } from './shared/markdown.js';

el.innerHTML = renderMarkdown(modelOutput);

// Keep an existing stylesheet contract, and shift `#` down to `<h3>`:
el.innerHTML = renderMarkdown(text, {
  classes: { pre: 'md-code', 'code:not(pre code)': 'md-ic' },
  demoteHeadings: 2,
});

speak(stripMarkdown(text)); // plain text for voice/meta contexts
```

Only text-level tags survive sanitization: no `<img>`, `<iframe>`, `<style>`,
`<form>`, or event handlers. Link `href`s are restricted to `http(s):`,
`mailto:`, and same-site relative paths; every link gets
`target="_blank" rel="noopener noreferrer nofollow"`.

**Why it exists.** Eight separate renderers were parsing Markdown with regexes,
each with its own escaping, and none with a sanitizer. None supported tables or
nested lists. `@three-ws/concierge` has its own copy of this module
(`concierge-sdk/src/markdown.js`) because it ships as an independent bundle.

### `src/shared/toast.js` — notifications

```js
import { toast, toastSuccess, toastError } from './shared/toast.js';

toast('Copied to clipboard');
toastError('Could not save. Check your connection.');
const dismiss = toastSuccess('Agent created', { duration: 4000 });
```

One `role="status" aria-live="polite"` region, a real queue (up to three
visible; a second toast stacks instead of replacing the first), click-to-dismiss,
and error/success variants. Messages are set via `textContent`, never HTML.

**Why it exists.** 67 copies of a single-slot `function toast()`, most without
an ARIA live region, each re-declaring the same inline `cssText`.

### `src/shared/fuzzy.js` — fuzzy search

Backed by [`@leeoniya/ufuzzy`](https://www.npmjs.com/package/@leeoniya/ufuzzy)
(~7 kB).

```js
import { rank, matches, highlight } from './shared/fuzzy.js';

const results = rank(query, commands, (c) => `${c.label} ${c.group}`, { limit: 8 });
for (const { item, ranges } of results) {
  render(highlight(item.label, ranges)); // <mark> around the real match positions
}
```

Ranks by contiguity, word-boundary starts, and match position, and tolerates one
typo per term (insertion, substitution, transposition, or deletion). It does
**not** match arbitrarily sparse subsequences: that is deliberate, because the
scorer it replaced accepted any subsequence and then tied every such hit at one
score, so "close match" and "barely matches" sorted arbitrarily.

### `src/shared/coin-format.js` — `timeAgo` and `toEpochMs`

`timeAgo` accepts ISO strings, `Date` objects, epoch milliseconds, **and epoch
seconds**, normalizing through `toEpochMs`. Copies of this function across the
codebase disagreed about their input unit, which is a live source of
"53 years ago" bugs.

```js
import { timeAgo, toEpochMs } from './shared/coin-format.js';
timeAgo('2026-07-29T10:00:00Z'); // "3m ago"
timeAgo(1783670400);             // unix seconds, handled
```

### Browser-side fallbacks: never depend on one host

Four helpers exist so no page hinges on a single third-party host. Reach for
them instead of writing a CDN URL, a gateway URL, or a price feed inline.

```js
import { fetchFirst, fetchFirstOrNull } from './shared/failover-fetch.js';
import { getSolPriceUsd, getTokenPriceUsd, getBtcPriceUsd } from './shared/usd-price.js';
import { ensureModelViewer, ensureModelViewerOrFallback } from './shared/model-viewer-loader.js';
import { loadVision, visionWasmBase, modelUrl } from './shared/mediapipe-assets.js';
import { uriCandidates } from './ipfs.js';
import { readProvider } from './erc8004/chain-meta.js';
```

| Helper | Covers | Behaviour when a host is down |
|---|---|---|
| `fetchFirst(providers, opts)` | any ordered provider list | 4s per attempt, 60s cooldown on a failing provider, throws only when all miss |
| `getSolPriceUsd` / `getTokenPriceUsd(mint)` / `getBtcPriceUsd` | USD quotes | 4 feeds each; returns the last real price, or null. Never a hardcoded rate |
| `ensureModelViewerOrFallback(root)` | the `<model-viewer>` element | 3 CDNs, then every viewer in `root` becomes its poster image or a caption |
| `loadVision()` / `visionWasmBase()` / `modelUrl(path)` | MediaPipe | module is bundled; runtime prefers `public/vendor/mediapipe`, then 2 CDNs |
| `uriCandidates(uri)` | IPFS / Arweave content | one URL per gateway, including for a URL whose gateway was already chosen |
| `readProvider(chainId)` | browser EVM reads | ethers `FallbackProvider` over every keyless node in `CHAIN_META`, quorum 1 |

Two rules that are easy to get wrong:

- **Resolve asset paths against `import.meta.url`, not the site root.** Inside a
  third-party `<agent-3d>` embed a `/vendor/...` path resolves against the
  *embedding* page and 404s. `new URL('../../vendor/mediapipe', import.meta.url)`
  points at whichever origin served the module, which is what you want.
- **A file under `public/` that is not a Vite input cannot import from `src/`.**
  It ships as a raw copy, so the `/src/*` reference 404s in production
  (`public/forever.js` keeps its feed list inline for exactly this reason).
  Either register the page as a Rollup input in `vite.config.js` or stay
  self-contained.

---

## Backend

### `api/_lib/resilience.js` — retry, backoff, circuit breaking

Backed by [`cockatiel`](https://www.npmjs.com/package/cockatiel).

```js
import { withRetry, withBreaker, withRetryAndBreaker, parseRetryAfter, isRetryableError }
  from './_lib/resilience.js';

// Jittered exponential backoff; only transient failures are retried.
const data = await withRetry(() => fetchUpstream(url), {
  attempts: 3, initialDelayMs: 250, maxDelayMs: 10_000, label: 'birdeye',
});

// Retry, then degrade instead of throwing.
const quote = await withRetryAndBreaker('birdeye:quote', () => getQuote(mint), {
  fallback: null,
});
```

`isRetryableError` treats 408/425/429/5xx, network errno codes
(`ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, …), and aborts/timeouts as transient;
a 400 or a `TypeError` is not retried. Pass `shouldRetry` to override.

**Why it matters.** The backoff is *decorrelated-jittered*. Roughly three dozen
hand-rolled `sleep(base * 2 ** attempt)` loops had no jitter at all, so a shared
upstream blip re-synchronized every caller into the same retry wave.

### `api/_lib/upstream-fetch.js`: the one fetch for third-party calls

```js
import { fetchUpstream, fetchUpstreamJson, fetchAnyJson, lastGood } from './_lib/upstream-fetch.js';

// Deadline (8s default), transient-only retries, Retry-After honoured, breaker.
const body = await fetchUpstreamJson(url, {}, { timeoutMs: 6000, name: 'dexscreener' });

// Equivalent mirrors, first one that answers wins; a dead mirror is benched.
const { value } = await fetchAnyJson(['https://api.drand.sh/public/latest', 'https://api2.drand.sh/public/latest']);

// Keep the page alive through a blip: serve the previous value, flagged stale.
const { value: rows, stale } = await lastGood('llama:chains', () => fetchUpstreamJson(LLAMA));
```

A non-2xx response rejects with an `UpstreamError` carrying `status`, `url` and
a body excerpt, so `isRetryableError` and handlers can branch on it. Solana and
EVM RPC do not go through here: `api/_lib/solana/connection.js` and
`api/_lib/evm/rpc.js` have method-aware rotation. Ordered lists of *different*
providers (with per-provider parsers) use `fetchFirst` from
`src/shared/failover-fetch.js` instead.

Because every third-party call in `api/` passes through one of these three
(`fetchUpstream`, `fetchFirst`, or the Solana connection), they are also where
[Brownout](./brownout.md) hooks in. Each attempt is recorded against the
current request (`recordSource` from `api/_lib/brownout/`), and a `lastGood`
hit records itself as `tier: 'stale'` with its age, which is what lets the
response carry the `x-brownout` / `x-brownout-trace` headers saying which rung
answered and how fresh it was. The same seam honours a declared fault
(`faultFor(name)`): an `x-brownout-chaos` directive raises the fault in the
shape of the real failure, from inside the same `try` the genuine outage would
land in, so retries, `Retry-After` handling, cooldowns and the breaker all see
it exactly as they would see the outage. `failover-fetch.js` and
`connection.js` are isomorphic and load the brownout module lazily on the
server only (the specifier is parked on `globalThis` so Rollup cannot fold it
into the CDN bundle); in a browser both hooks are inert.

### `api/_lib/cache.js`: `cacheWrapLastGood`

```js
import { cacheWrapLastGood } from './_lib/cache.js';

// Fresh for 5 minutes; on a thrown refresh, the fleet-wide last-good copy (24h).
const board = await cacheWrapLastGood('pump:board', 300, () => fetchBoard());
const { value, stale } = await cacheWrapLastGood(key, 300, load, { withMeta: true });
```

Unlike `lastGood` above, the mirror lives in the shared store (Upstash), so a
freshly started instance can ride out an outage on a value another instance
fetched.

### `api/_lib/solana/read-guards.js`: chain reads that survive a dead RPC

```js
import {
	ataExists, blockhashKey, getRecentBlockhashInfo, mintDecimals, readBalanceOrNull,
} from './solana/read-guards.js';

const { blockhash } = await getRecentBlockhashInfo(conn, blockhashKey({ network: 'mainnet' }));
const decimals = await mintDecimals(conn, usdcMint);   // constant, no network read
if (!(await ataExists(conn, ata))) ixs.push(createAssociatedTokenAccountIdempotentInstruction(...));
const lamports = await readBalanceOrNull(conn, pubkey); // null means unknown, never zero
```

Every read here answers the question "what should this do when the chain cannot
be read at all?", and each answer is different:

- **Blockhash**: serve a cached one that is still inside its validity window.
  Pass `{ forceFresh: true }` on an expired-blockhash retry so the retry means
  something.
- **Mint decimals**: USDC, USDT, wSOL and `$THREE` have fixed decimals, so the
  common case never touches the network and cannot fail.
- **ATA probe**: fail OPEN to "missing". This is safe **only** with
  `createAssociatedTokenAccountIdempotentInstruction`; with the plain create, an
  unnecessary create fails the whole transaction. Always pair the two.
- **Balance**: `null` for unknown. Never let a caller read it as zero.

Anything that cannot degrade raises `rpcUnavailableError`, which
`respondRpcUnavailable` renders as a 503 with `Retry-After`, so a caller learns
"ask again shortly" instead of a sanitized 500.

### `api/_lib/lexical-rank.js`: the fallback for a search that cannot embed

```js
import { rankLexically } from './lexical-rank.js';

const rows = rankLexically(query, docs, { limit: 20 }); // [{ id, score: null, lexicalScore, match: 'lexical' }]
```

Semantic search is the one place where a provider ladder is **wrong**: a stored
vector space has one embedder, so another lane's vector is a different dimension
in a different geometry. When the embedder is down, degrade the *method* instead
of the provider. Every row is labelled `match: 'lexical'` with a null semantic
score, so no caller can mistake the ordering for a vector one. Used by
`/api/galaxy` and `/api/ibm/galaxy`.

`api/_lib/embeddings.js` covers the other half: `embedPassagesAny(preferredTag,
texts)` walks every configured embedder at **ingest** time (where no space is
fixed yet) and returns the tag that actually answered, so the caller records the
space it really got.

### `api/_lib/mem-cache.js` — bounded in-process cache

Backed by [`lru-cache`](https://www.npmjs.com/package/lru-cache).

```js
import { createCache, cached } from './_lib/mem-cache.js';

const cache = createCache({ max: 512, ttlMs: 60_000 });

// Read-through with single-flight: concurrent misses share one load().
// When load() throws, the last value it returned for this key (kept 30 min,
// `staleMs`) is served instead; pass `staleMs: 0` where the error must surface.
const price = await cached(cache, mint, () => fetchPrice(mint));

// Per-entry TTL when lifetimes vary by key:
cache.set(key, value, { ttl: 10 * 60_000 });
```

This is per-instance memory, the same model as the Maps it replaced. Shared
cross-instance state still belongs in Redis via `api/_lib/cache.js`.

**Why it matters.** The Maps it replaces were trimmed with
`map.delete(map.keys().next().value)`, which evicts the **oldest inserted** key,
not the least recently used one, so a continuously-hot key could be evicted
while colder keys inserted after it survived. Others called `.clear()` at the
cap, discarding everything periodically; most were unbounded.

`createCache` sets `ttlResolution: 0` so expiry is checked against a live clock
on every read rather than a memoized timestamp.

### `api/_lib/pool.js` — bounded concurrency

Backed by [`p-limit`](https://www.npmjs.com/package/p-limit).

```js
import { mapPool, mapPoolSettled } from './_lib/pool.js';

// At most 5 in flight; results in input order; rejects on first error.
const balances = await mapPool(wallets, 5, (w) => readBalance(w));

// One bad row must not abort a backfill:
const rows = await mapPoolSettled(items, 4, (i) => process(i));
for (const r of rows) if (!r.ok) log.warn(r.error);
```

Prefer this over chunking input into fixed batches and awaiting each batch: with
batching, one slow item holds its whole batch's slots idle until it drains.

### `api/_lib/csv.js` — CSV export

```js
import { csvCell, csvCellJson, toCsv } from './_lib/csv.js';

res.end(toCsv(['created_at', 'content'], rows.map((r) => [r.created_at, r.content])));
```

Every cell is RFC 4180 quoted **and** neutralized against spreadsheet formula
injection: Excel and Google Sheets execute a cell whose text starts with
`=`, `+`, `-`, `@`, or a leading tab/CR, which turns exported user content into
live formulas. Use `csvCellJson` for columns holding structured metadata.

**Never hand-roll a cell writer.** Two existed before this module and had
diverged, and the one lacking the formula guard was the one exporting
visitor-supplied chat transcripts.

---

## Operations

### `scripts/check-fetch-timeouts.mjs`: no unbounded third-party call

```bash
npm run check:fetch-timeouts          # wired into `npm run gate`
node scripts/check-fetch-timeouts.mjs --json
```

Fails the gate on a `fetch()` that carries no deadline. A fetch with no signal
has no deadline at all: undici's defaults run to minutes, so one upstream that
accepts a connection and then stalls holds the request until the platform kills
the invocation, and takes the request budget of every fallback behind it with
it. In production that does not read as "an upstream was slow", it reads as a
dead endpoint, a dead cron, or a page that spins forever.

A call counts as bounded when it passes a `signal` or goes through a wrapper
that supplies one (`fetchUpstream`, `fetchFirst`, `pumpFetchJson`, ...). An init
object assembled earlier in the function counts too: the checker resolves
`fetch(url, init)` back to where `init` was built. Only the deadline is
enforced, deliberately: retries, provider ladders and last-good tiers are the
right thing to add on top, but which one fits is a judgement call per call site,
while a deadline never is.

**Scope differs by directory.** In browser code (`src`, `public`, `workers`) the
rule covers literal external hosts only, since a page's fetch of our own API is
bounded by the page lifecycle and by `src/api.js`. Under `api/` it covers EVERY
call, whatever the URL is, because the two shapes that hang in practice are
invisible to a literal-host scan: a handler calling its own `/api/forge` (a real
socket between two serverless instances, not a free local call) and a download
of a provider result URL that only exists at runtime. Three exemptions there,
each for a call that cannot hang or is already bounded elsewhere: a `data:` URL
(no socket), a client snippet quoted as a string (it runs in a browser), and a
wrapper that spreads its caller's `init` (the deadline is the caller's, and a
second one would silently shorten it). Two shapes are never counted as calls at
all: a `fetch(` that sits inside a string literal (a usage example shipped as
data in an API response), and a member call such as `client.fetch(...)`, which
is somebody else's method rather than the global `fetch`.

The checker reads each call's real extent by balancing parentheses rather than
scanning a fixed window, because `signal` is conventionally the last key of an
options object and a windowed check reports a bounded call as unbounded exactly
when its options are longest. `tests/check-fetch-timeouts.test.js` covers that
case: a checker that silently stops catching things is worse than no checker,
since the gate keeps passing while the protection erodes.

### `scripts/check-cron-drift.mjs` — cron config vs. reality

Validates every cron expression in `vercel.json` with
[`cron-parser`](https://www.npmjs.com/package/cron-parser) and compares the
declared schedules against the live Cloud Scheduler jobs.

```bash
node scripts/check-cron-drift.mjs            # validate + compare against live jobs
node scripts/check-cron-drift.mjs --offline  # validate expressions only, no gcloud
node scripts/check-cron-drift.mjs --json     # machine-readable report
```

Reports invalid expressions, duplicate job ids, schedules that are declared but
missing from Cloud Scheduler, live schedules that disagree with the declared
one, jobs that are not `ENABLED`, and orphaned jobs no longer declared. Exits
non-zero on anything but orphans, so it can gate a deploy.

`vercel.json` is a live config file, but nothing previously verified that
Cloud Scheduler still matched it: a schedule edited without a re-sync, or a job
paused during an incident and never resumed, failed silently.
