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
