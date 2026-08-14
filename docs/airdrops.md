# Airdrop Checker

**Live surface: [three.ws/airdrops](https://three.ws/airdrops)**

Paste any Solana or Ethereum wallet and see which tracked airdrop programs it
qualifies for. The score comes from a real scan of the wallet's on-chain
history, the checklist says exactly what is missing and what to do next, and
every report is deep-linkable. Free, keyless for Solana, no account.

---

## How it works

One endpoint does everything:

```
GET /api/crypto/airdrops                      # the tracked-program directory
GET /api/crypto/airdrops?address=<wallet>     # scan + score that wallet
```

Three layers behind it:

1. **Activity scan**: [`api/_lib/wallet-activity.js`](../api/_lib/wallet-activity.js).
   Solana wallets are scanned keylessly: transaction signatures over the
   platform's rotating RPC chain (count, distinct active days, wallet age,
   recency) plus token diversity from the shared balance layer. EVM wallets are
   scanned across Ethereum, Optimism, Base and Arbitrum through Etherscan's V2
   unified API, where one `ETHERSCAN_API_KEY` covers every chain; native volume
   is converted to USD before any USD threshold sees it. Scans cache for an
   hour per wallet.
2. **Scoring**: [`api/_lib/airdrop-eligibility.js`](../api/_lib/airdrop-eligibility.js),
   a pure evaluator. Each registry criterion with a `check` string
   (`"tx_count >= 50"`) is compared against the measured activity; the score is
   the share of measurable criteria met. At or above 80 the wallet is
   *qualified*, at or above 30 *in progress*, below that *not eligible*.
3. **Registry**: [`data/airdrops.json`](../data/airdrops.json), the tracked
   programs with their criteria, status (confirmed / upcoming / speculation),
   estimated ranges, and source links. It is a plain JSON file, dated, and
   expected to be edited as programs confirm or close.

## The honesty contract

- **Fields a scan cannot measure are null, never zero.** A criterion over an
  unmeasured field is reported as *unknown* and counts as unmet; the wallet is
  told what could not be seen, not given credit for it.
- **Manual steps are not scored.** Protocol-specific actions (staking in a
  program, providing LP) cannot be seen by a generic wallet scan, so registry
  criteria without a `check` are surfaced as "do this yourself" to-dos and
  excluded from the score. The score only ever claims what was measured.
- **Capped scans say so.** Signature and transaction pagination is bounded; a
  wallet past the cap gets flagged totals that read as honest minimums.
- **Estimated ranges are labeled speculation.** The hero sum only adds ranges
  from programs the wallet actually qualifies for, and the page repeats that
  these are public speculation, not promises. Nothing on the surface is an
  endorsement of any program.

## Response shape (scan)

```json
{
	"address": "…",
	"family": "solana",
	"ts": "2026-08-06T20:00:00.000Z",
	"activity": {
		"family": "solana",
		"tx_count": 342, "days_active": 61, "account_age_days": 410,
		"last_active_days": 1, "unique_tokens": 12, "chains_active": 1,
		"contract_interactions": null, "volume_usd": null,
		"capped": false, "chains": ["solana"]
	},
	"opportunities": [
		{
			"id": "…", "name": "…", "chain": "solana", "status": "confirmed",
			"score": 75, "eligibility": "in_progress",
			"met": [{ "description": "50+ transactions on Solana" }],
			"missing": [{ "description": "…", "recommendation": "…" }],
			"manual": [{ "description": "…" }],
			"estimatedValue": "$100 - $2,000", "source": "https://…"
		}
	],
	"otherFamily": [],
	"summary": { "tracked": 6, "qualified": 2, "in_progress": 3, "not_eligible": 1, "estimatedValue": { "lo": 150, "hi": 3500, "entries": 2 } },
	"thresholds": { "qualified": 80, "inProgress": 30 },
	"registryUpdated": "2026-08-06"
}
```

Registry entries for the other chain family come back in `otherFamily`,
unevaluated, so the page can say "check these with your other wallet" instead
of rendering a fake zero.

## Related surfaces

- [`/portfolio`](portfolio.md): the live wallet portfolio; the two pages
  cross-link and share the recent-wallet list.
- [`/api/crypto/wallet`](crypto-api.md): the raw balance endpoint the token
  diversity measurement rides on.
