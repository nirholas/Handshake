# Skill bundles

A **skill bundle** sells several of one agent's skills as a single purchase. One
payment, one confirmation, and every skill in the bundle unlocks at once.

The hard part of a bundle was never grouping the skills. It was the price. The
usual answer is "take 20% off the sum of the parts", which is a guess dressed as
advice. three.ws answers it from the seller's own ledger instead: some buyers have
already bought two or more of these skills separately, and what they actually paid
is real evidence of what the combination is worth.

Build one at **[three.ws/bundles](https://three.ws/bundles)**. The page is
owner-only: it lists the agents you own, the skills on each that carry an active
price, and a price panel that backtests any price you type against those buyers.

> Source: [`pages/bundles.html`](../pages/bundles.html) (the builder),
> [`api/agents/[id]/bundles.js`](../api/agents/[id]/bundles.js) (management and
> pricing), [`api/_lib/bundle-pricing.js`](../api/_lib/bundle-pricing.js) (the
> arithmetic), [`api/marketplace/purchase-bundle.js`](../api/marketplace/purchase-bundle.js)
> (checkout and unlock).

---

## How the price is derived

Two bases, and the API always says which one it used, so a default is never
mistaken for a finding.

| `history.basis` | When | What the suggested price is |
|---|---|---|
| `median_basket` | At least one buyer bought 2+ of the selected skills | The **median** of what those buyers really spent across them, capped at the sum of the parts |
| `discount_off_list` | Nobody has bought 2+ of them yet | A flat **20% off** the sum of the parts, labelled as a starting point |

Only confirmed, paid purchases count. Trials and access rows granted by an earlier
bundle are excluded (`kind` is filtered to the paid kinds
[`api/_lib/marketplace-kinds.js`](../api/_lib/marketplace-kinds.js) publishes), so
nothing inflates the evidence a seller is shown.

Every amount in and out of these endpoints is an **atomic integer as a string**
(the currency's smallest unit). A 9-decimal mint puts real balances past
`Number.MAX_SAFE_INTEGER`, so the server carries every amount as a BigInt and the
browser scales through `BigInt` too. `mint_decimals` in the pricing response is
how a client turns an atomic amount into a human one.

---

## Endpoints

All four live under the agent. `:id` is the agent's UUID.

| Method | Path | Auth | Does |
|---|---|---|---|
| `GET` | `/api/agents/:id/bundles` | public | List the agent's active bundles |
| `GET` | `/api/agents/:id/bundles?include_inactive=1` | owner | The same list with paused bundles included |
| `GET` | `/api/agents/:id/bundles?action=pricing&skills=a,b` | public | Price a candidate bundle against real sales |
| `POST` | `/api/agents/:id/bundles` | owner | Publish a bundle |
| `PATCH` | `/api/agents/:id/bundles/:bundleId` | owner | Rename, reprice, or change its skills |
| `DELETE` | `/api/agents/:id/bundles/:bundleId` | owner | Deactivate it (nothing is deleted) |

Owner calls need a session cookie (plus the `x-csrf-token` header that
[`src/api.js`](../src/api.js) attaches automatically in the browser) or a bearer
token. The two `GET`s are public on purpose: they read only aggregate counts and
the agent's own list prices, both of which the marketplace already publishes per
skill. No buyer identity and no row-level history ever leaves the handler.

### Price a candidate bundle

```bash
curl -s "https://three.ws/api/agents/$AGENT_ID/bundles?action=pricing&skills=research,summarize"
```

```json
{
  "data": {
    "agent_id": "00000000-0000-4000-8000-00000000a9e7",
    "currency_mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "chain": "solana",
    "mint_decimals": 6,
    "skills": [
      { "skill": "research",   "list_amount": "2000000", "units_sold": 0, "gross_atomic": "0", "buyers": 0 },
      { "skill": "summarize",  "list_amount": "1000000", "units_sold": 0, "gross_atomic": "0", "buyers": 0 }
    ],
    "unpriced_skills": [],
    "sum_of_parts_atomic": "3000000",
    "history": {
      "multi_skill_buyers": 0,
      "revenue_atomic": "0",
      "median_basket_atomic": null,
      "basis": "discount_off_list"
    },
    "suggested": {
      "price": "2400000",
      "discount_atomic": "600000",
      "discount_percent": 20,
      "backtest_revenue_atomic": "0",
      "revenue_delta_atomic": "0",
      "buyers_better_off": 0
    },
    "asked": null
  }
}
```

Add `&price=<atomic>` to backtest a specific price. The response's `asked` block
then carries the same shape as `suggested` for that price: what the bundle would
have collected from the same buyers (`backtest_revenue_atomic`), how that compares
to what they really paid (`revenue_delta_atomic`, negative means the price left
money on the table), and how many of them would have come out ahead
(`buyers_better_off`). The builder page calls exactly this as you drag the price.

A skill you named that has no active price is not silently dropped: it comes back
in `unpriced_skills` and is left out of the sum. Skills priced in **different
mints** are refused with `409 mixed_currency`, because adding two currencies
produces a number that means nothing.

### Publish

```bash
curl -s -X POST "https://three.ws/api/agents/$AGENT_ID/bundles" \
  -H "authorization: Bearer $THREE_WS_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "name": "Research starter pack",
    "description": "Research plus summarize, one payment.",
    "price_amount": "2400000",
    "currency_mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
    "chain": "solana",
    "skills": ["research", "summarize"]
  }'
```

`price_amount` takes an atomic integer as a string or a number; a string is the
safe form on a 9-decimal mint. `skills` needs at least two names and takes at most
fifty. The response is `201` with the created bundle and its skills.

`DELETE` sets `is_active = false`. Buyers who already paid keep their access,
because access lives on their `skill_purchases` rows, not on the bundle.

Pausing is reversible. `PATCH` with `{"is_active": true}` puts the bundle back on
sale, and `include_inactive=1` is how you find it again: the plain `GET` is the
buyer-facing list and stays active-only, so a paused bundle is returned only to a
session that owns the agent. Anyone else passing the flag gets the public list
unchanged. The builder page uses exactly this, which is why a paused bundle stays
on screen, dimmed, with a **Reactivate** button.

---

## Checkout

A bundle is bought through the marketplace, not through the bundle endpoints:

```
POST /api/marketplace/purchase-bundle              { "bundle_id": "..." }
POST /api/marketplace/purchase-bundle/:id/confirm  { }        # Solana
POST /api/marketplace/purchase-bundle/:id/confirm  { "tx_signature": "0x..." }   # EVM
```

`create` writes a `pending` row in `bundle_purchases` and returns Solana Pay
parameters: recipient (the creator's payout wallet), `price_amount`,
`currency_mint`, `chain`, a freshly minted `reference`, and the platform fee split.
`confirm` proves the payment on-chain **before** anything unlocks: Solana is
located by the reference the server minted (no client-supplied signature is
trusted), EVM by the submitted tx hash. On a confirmed verdict the handler writes
one `skill_purchases` row per skill with `kind = 'bundle'` and `amount = 0`, which
is what [`hasSkillAccess()`](../api/_lib/skill-access.js) reads, and records a
single bundle-level revenue event so one bundle sale is never counted as N skill
sales in GMV.

**Reach today:** the builder, the two public `GET`s, and this checkout are live.
The buyer-facing *browser* surface is not: no marketplace or agent-profile view
renders a published bundle yet, so a human buyer reaches one through the API
above, while the seller-side builder is fully wired. Rendering bundles on the
agent's marketplace listing is the next step.

---

## Storage

| Table | Holds |
|---|---|
| `skill_bundles` | One row per bundle: name, description, `price_amount`, `currency_mint`, `chain`, `is_active` |
| `bundle_items` | The skill names in a bundle, one row each |
| `bundle_purchases` | One row per checkout: status, reference, tx signature, platform fee |
| `skill_purchases` | The unlock itself, one row per skill, `kind = 'bundle'` |

## Related

- [Marketplace](marketplace.md): how skills and assets are listed, bought, and settled
- [Agent skills](agent-skills.md): what a skill is in the first place
- [Agent wallets](agent-wallets.md): where a bundle's payment lands
