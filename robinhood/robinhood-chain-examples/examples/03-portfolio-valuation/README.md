# 03 · Multiplier-correct portfolio valuation

**The correctness showpiece.** Robinhood Stock Tokens carry an ERC-8056
`uiMultiplier()` corporate-action factor, and generic trackers get the math
wrong in two ways:

1. **Double-counting the multiplier.** The Chainlink feed is *already*
   multiplier-adjusted, so USD value is `balance × feedPrice` — not
   `× uiMultiplier` on top. Applying it twice mis-states value after every
   split or reinvested dividend.
2. **Reporting raw balance as "shares."** The true share-equivalent is
   `balance × uiMultiplier ÷ 1e18`. After a corporate action it diverges from
   the raw ERC-20 balance.

`getPortfolio()` returns **both** numbers per position, values only priced
holdings, and sweeps all 95 tokens in a single multicall. Reads only.

## Prerequisites

- Node ≥ 20. No wallet or key. See [example 02](../02-stock-price-sdk) for the
  local `hoodchain` install note.

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
npm start                                    # a live default holder
node index.js 0xYourAddress                  # any address
```

## Expected output

```
Stock Token portfolio — 0xA953CA88ff430e9487c60cA34d757414f4efdA07

  SYMBOL        BALANCE       SHARE-EQUIV        VALUE
  ----------------------------------------------------------
  TSLA         0.027608         0.027608       $11.26
  ----------------------------------------------------------
  Total priced value: $11.26
```

A multi-position address prices each holding independently:

```
  AAPL         0.000854         0.000854        $0.27
  AMD          0.000455         0.000455        $0.25
  NVDA         0.001250         0.001250        $0.26
  SPCX         0.001755         0.001755        $0.26
  TSLA         0.000631         0.000631        $0.26
  Total priced value: $1.30
```

Right now every `uiMultiplier` is `1e18` (the chain is new — no corporate
actions have happened yet), so `SHARE-EQUIV` equals `BALANCE`. The code path is
already correct: when a token's multiplier moves, the two columns diverge and
the row is flagged `← corporate-action adjusted`. The SDK's live test cross-
checks `shareEquivalent` against the token's own on-chain `balanceOfUI()`.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
