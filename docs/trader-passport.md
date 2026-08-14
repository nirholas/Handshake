# Trader Passport: a track record other apps can verify

A three.ws trader's numbers are already provable one trade at a time: every closed position on [`/trader/<agent_id>`](https://three.ws/trader) links to the Solana transaction it came from. The **Trader Passport** is the second layer. Once a day the platform commits each ranked trader's rolled-up score to Solana as a signed SPL-Memo attestation, and this API hands that credential to anyone who asks, in a form they can re-check against the chain themselves.

That distinction is the whole point. A leaderboard you have to trust is marketing. A credential a competing terminal can fetch, pin, and independently verify is infrastructure.

## The credential

Kind: `threews.tradescore.v1`. Subject: the trader's Solana trading wallet. Issuer: the three.ws attester key, which signs the memo transaction.

The memo commits the headline numbers **and** the provenance behind them, so a consumer sees what was excluded, not only what was credited:

| Field | Meaning |
| --- | --- |
| `score` | The 0-100 Trader Score for the window |
| `closed`, `unique_coins` | Closed round-trips and distinct coins in the credited record |
| `win_rate`, `realized_pnl_sol`, `max_drawdown_pct` | The headline performance figures |
| `self_dealing_excluded` | Round-trips on coins the trader launched, stripped out of the credited score |
| `snipe_hit_rate`, `snipe_sample` | Entries that landed within 5 minutes of a coin's proven on-chain birth |
| `window`, `day`, `network` | Which window was committed, on which UTC day, on which cluster |

A credential is a **snapshot**, not a live feed. The passport always reports its age and how far the live record has drifted since it was signed.

## Read a passport

```bash
curl 'https://three.ws/api/trader-passport?wallet=<BASE58_WALLET>&network=mainnet&window=all'
```

Or by agent, which is what the profile page uses:

```bash
curl 'https://three.ws/api/trader-passport?agent_id=<AGENT_UUID>&network=mainnet&window=all'
```

Public, CORS-open, no auth, 60-second edge cache. Parameters: `wallet` **or** `agent_id` (required), `network` (`mainnet` default, or `devnet`), `window` (`24h` / `7d` / `30d` / `all`, default `all`), and `live=0` to skip re-deriving the current numbers.

The response:

```json
{
  "subject": {
    "wallet": "<BASE58_WALLET>",
    "wallet_url": "https://solscan.io/account/<BASE58_WALLET>",
    "agent": { "id": "<uuid>", "name": "…", "image": "…", "copiers": 4 },
    "profile_url": "https://three.ws/trader/<uuid>"
  },
  "network": "mainnet",
  "window": "all",
  "kind": "threews.tradescore.v1",
  "issuer": {
    "name": "three.ws",
    "kind": "threews.tradescore.v1",
    "attester": "<ISSUER_PUBKEY>",
    "attester_url": "https://solscan.io/account/<ISSUER_PUBKEY>",
    "memo_program": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    "cadence": "daily",
    "note": "Scores are re-derived from on-chain fills and committed …"
  },
  "status": "attested",
  "unattested_reason": null,
  "credential": {
    "kind": "threews.tradescore.v1",
    "signature": "<TX_SIGNATURE>",
    "slot": 300123456,
    "block_time": "2026-06-14T09:00:00.000Z",
    "day": "2026-06-14",
    "window": "all",
    "attester": "<ISSUER_PUBKEY>",
    "subject": "<BASE58_WALLET>",
    "agent_id": "<uuid>",
    "revoked": false,
    "well_formed": true,
    "schema_problems": [],
    "snapshot": { "score": 78, "closed": 41, "win_rate": 0.61, "realized_pnl_sol": 12.5, "self_dealing_excluded": 2, "…": "…" },
    "explorer_url": "https://solscan.io/tx/<TX_SIGNATURE>"
  },
  "credential_age_days": 1,
  "history": [{ "day": "2026-06-14", "score": 78, "signature": "<TX_SIGNATURE>" }],
  "live": { "score": 81, "closed": 44, "win_rate": 0.58, "realized_pnl_sol": 10.25 },
  "drift": { "moved": true, "fields": { "score": { "attested": 78, "live": 81, "delta": 3 } } },
  "verify": {
    "url": "https://three.ws/api/trader-passport/verify?signature=<TX_SIGNATURE>&network=mainnet",
    "how": "Fetch the attestation transaction from any Solana RPC, read the SPL-Memo payload, …"
  },
  "generated_at": "2026-06-15T09:02:11.418Z"
}
```

`status` is `"attested"` or `"unattested"`. An unattested wallet still returns the same document shape with `credential: null` and an `unattested_reason` explaining why (no agent yet, no closed trades yet, or not yet in the daily attested set) so an integration never has to branch on two response shapes.

## Verify it yourself

```bash
curl 'https://three.ws/api/trader-passport/verify?signature=<TX_SIGNATURE>&network=mainnet&wallet=<BASE58_WALLET>&attester=<ISSUER_PUBKEY>'
```

This endpoint reads **no three.ws database**. It fetches the transaction from a Solana RPC node, re-parses the SPL-Memo payload, and re-checks that:

1. the transaction exists at confirmed commitment and did not fail,
2. it invoked the SPL Memo program,
3. the memo parses and satisfies the `threews.tradescore.v1` schema,
4. the committed subject wallet is an account of that transaction,
5. the signer matches the `attester` you pinned, and the subject matches the `wallet` you passed.

```json
{ "valid": true, "found": true, "network": "mainnet", "signature": "<TX_SIGNATURE>",
  "attester": "<ISSUER_PUBKEY>", "subject": "<BASE58_WALLET>",
  "slot": 300123456, "block_time": "2026-06-14T09:00:00.000Z",
  "payload": { "score": 78, "…": "…" }, "reasons": [],
  "explorer_url": "https://solscan.io/tx/<TX_SIGNATURE>",
  "kind": "threews.tradescore.v1",
  "memo_program": "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "checked_at": "2026-06-15T09:02:11.418Z" }
```

Every failed check appears in `reasons[]`, so `valid: false` always says why. `wallet` and `attester` are optional; omit them and you get the on-chain facts without the equality checks. An RPC that is unreachable returns a `502 rpc_failed` error rather than a false `valid: false`: an unanswered question is not a negative verdict.

You do not need this endpoint at all. The same five checks run against any RPC with `getTransaction` plus a JSON parse, which is the property that makes the credential portable.

## Using it in your own app

Render a "verified trader" badge from someone else's terminal in three calls:

```js
const p = await fetch(
  `https://three.ws/api/trader-passport?wallet=${wallet}&network=mainnet`,
).then((r) => r.json());

if (p.status === 'attested') {
  const v = await fetch(p.verify.url).then((r) => r.json());
  if (v.valid && v.attester === KNOWN_THREEWS_ATTESTER) {
    show({
      score: p.credential.snapshot.score,
      asOf: p.credential.day,
      staleDays: p.credential_age_days,
      drifted: p.drift?.moved,
      proof: p.credential.explorer_url,
    });
  }
}
```

Pin `KNOWN_THREEWS_ATTESTER` from `issuer.attester` on first fetch and treat a change as a reason to re-check, exactly as you would pin a certificate.

Two rules worth honoring if you display the score:

- **Show the age.** A month-old credential is not a current claim. `credential_age_days` is there for that.
- **Show the drift, or show the live number.** `drift.moved` tells you the record has changed since signing; presenting the anchored score alone as "current" is the failure mode this API exists to prevent.

## On the profile page

The Proof tab of [`/trader/<agent_id>`](https://three.ws/trader) renders the passport directly: the signed credential, a committed-versus-live table for every headline metric, the daily attestation history, and a **Verify against the chain** button that calls the verify endpoint live and renders the verdict, including a red one when a check fails.

## Where credentials come from

`api/cron/trader-score-attest.js` runs daily. It walks the top of the all-time leaderboard per network, re-derives each trader's canonical metrics with the same code the profile page uses, and commits one memo per (wallet, network, window, UTC day). Re-running it the same day returns the existing signature instead of broadcasting a duplicate. With no attester key configured the cron reports which wallets it *would* attest rather than failing, so a missing key is visible instead of silent.

## Related

- [Claim your wallet](trader-card.md): the read-only track record that comes before any credential
- [Trading arenas](trading-arenas.md): what a verified record unlocks
- [Copy trading](copy-trading.md): leaderboard weighting and performance fees
- [API reference](api-reference.md): every public endpoint
