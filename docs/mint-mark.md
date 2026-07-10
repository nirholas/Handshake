# The three.ws mint mark

Every coin launched through three.ws has a mint address that starts with `3ws` — the three.ws brand mark. This is automatic and verifiable directly from the address without any external lookup.

---

## For users

### What is the mint mark?

When you launch a coin on three.ws (via Studio or the agent wallet path), the platform grinds a Solana keypair until it finds one whose public key starts with `3ws`. That resulting address is your coin's mint.

**Example:** a three.ws-launched mint looks like `3wsXrT4Gy…`

### Why does it matter?

- **Provenance at a glance.** Anyone looking at a mint address on Solscan, pump.fun, or any Solana explorer can immediately tell whether a coin came from three.ws — no metadata lookup required.
- **Tamper-evident.** The mark is baked into the Ed25519 keypair itself. It cannot be retroactively attached to an unbranded mint.
- **Automatic.** You don't configure anything. Every branded launch comes out stamped.

### How does it work?

The server runs a fast WASM-based keypair grinder (single-threaded, sub-second for a 3-character prefix) until it finds a match, then uses that keypair as the coin mint. The expected work is ~49 000 keypairs at ~25 000/s, taking well under a second on the Cloud Run server's CPU.

### Is it on every coin?

Yes — all coins launched via **Studio** or **launch-agent** carry the mark. The only exception is the generic x402 pay-per-call launcher, which accepts arbitrary mints supplied by the caller at runtime and intentionally has no brand constraint.

---

## For developers

### Single source of truth

[src/solana/vanity/brand.js](../src/solana/vanity/brand.js) owns everything:

```js
export const THREE_WS_MARK = '3ws';

export const THREE_WS_VANITY = Object.freeze({
  prefix: THREE_WS_MARK,
  suffix: '',
  ignoreCase: true,
});

export function hasThreeWsMark(address) { /* case-insensitive prefix check */ }
export function assertThreeWsMark(address) { /* throws UnbrandedMintError */ }
export class UnbrandedMintError extends Error { /* code: 'unbranded_mint' */ }
```

No other file hardcodes `'3ws'` or re-implements the check. Import from here.

### Server enforcement

`api/pump/[action].js` reads `env.THREE_WS_MARK_ENFORCE` at the start of both `launch-prep` and `launch-agent`:

```js
const enforceMark = env.THREE_WS_MARK_ENFORCE !== '0' && env.THREE_WS_MARK_ENFORCE !== 'false';
```

When enforcement is **on** (default):
- A client-supplied `mint_address` is validated with `hasThreeWsMark`; unbranded mints return `400 unbranded_mint`.
- When no mint is supplied, the server grinds one with `grindVanityNode({ ...THREE_WS_VANITY })`.
- Grind cost is logged at info level: `{ publicKey, attempts, durationMs }` — expect ~49 000 attempts, < 1 000 ms on the Cloud Run server's CPU.

When enforcement is **off**: a random `Keypair.generate()` is used (pure-legacy fallback). No brand constraint.

### The kill-switch

**`THREE_WS_MARK_ENFORCE`** — registered in `api/_lib/env.js`, documented in `.env.example`.

| Value | Behaviour |
|-------|-----------|
| `1` (default) | Enforcement ON — launches fail-closed if mark cannot be stamped |
| `0` or `false` | Enforcement OFF — unbranded mints are accepted |

Flip to `'0'` **only during an incident** where `grindVanityNode` is broken and launches must continue unblocked. Re-enable immediately when the incident is resolved. Never leave it off in production.

### Feed events

Confirmed launches emit a `coin-buy` feed event on the `feed:events` Redis bus (see `api/_lib/feed.js`). The event carries `branded: hasThreeWsMark(mint)` so the FOMO ticker and any downstream consumer can distinguish branded from unbranded launches:

```js
{
  type: 'coin-buy',
  ts: Date.now(),
  actor: '<short-wallet>',
  mint: '3wsXrT4Gy…',
  sol: 0,
  network: 'mainnet',
  branded: true,
}
```

### Observability

Every server-side grind emits a structured log line via `logger('pump.launch')`:

```json
{ "lvl": "info", "name": "pump.launch", "msg": "mint_mark_stamped",
  "publicKey": "3wsXrT4Gy...", "attempts": 49213, "durationMs": 892 }
```

Watch this in the Cloud Run logs (Cloud Logging) to confirm the ~49 000-attempt / sub-second expectation holds. A sharp increase in `attempts` or `durationMs` signals WASM performance degradation.

### The generic x402 launcher exemption

`api/x402/pump-launch.js` is a pay-per-call endpoint that accepts an arbitrary `mint` keypair supplied by the buyer at runtime. It does **not** enforce the brand mark and must never have `assertThreeWsMark` added to it. The mint is the buyer's choice; the brand constraint belongs only to three.ws-initiated launches.

### Token example

All code examples and fixtures in this codebase use `$THREE`:

- Symbol: `$THREE`
- Mint: `FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

No other mint should appear in tests, fixtures, or documentation.

---

## Related

- [Solana agents](solana) — agent wallet management and on-chain interactions
- [Solana pump.fun signals](solana-pumpfun) — pump.fun live feed integration
- [ERC-8004](erc8004) — on-chain agent registry (uses the same brand metadata builder)
