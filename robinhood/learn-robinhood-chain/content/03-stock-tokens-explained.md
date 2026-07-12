If you remember one page from this course, make it this one. Stock Tokens look like ordinary ERC-20s, and 95% of the time they behave like ordinary ERC-20s. It's the other 5% — corporate actions like splits and dividends — that quietly breaks naive integrations and reports the wrong dollar value to a user. Here's exactly how they work, and the one worked example that makes the trap impossible to fall into.

## Anatomy of a Stock Token

A canonical Stock Token on Robinhood Chain is three things bolted together:

1. **A plain ERC-20**, 18 decimals. `balanceOf`, `transfer`, `approve` — all the usual methods, nothing surprising.
2. **A Chainlink price feed** — a separate contract, one per token, exposing `latestRoundData()` and answering with an **8-decimal** USD price.
3. **An [ERC-8056](https://eips.ethereum.org/) `uiMultiplier()`** — a single function returning a `1e18`-scaled ratio that encodes every corporate action the underlying stock has had.

Every canonical Stock Token proxies to one shared `Stock` beacon contract, which is how the [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) verifies that an address is a *real* Stock Token and not a lookalike: it checks the EIP-1967 beacon slot points at that one shared beacon.

## The multiplier, and why it exists

Stocks split. They pay dividends. A traditional token would handle a 2-for-1 split by *rebasing* — doubling everyone's balance overnight. Rebasing tokens are notoriously hostile to integrators: your cached balances silently go wrong, and every DeFi protocol that holds the token has to special-case it.

Robinhood Chain took the other path. **Balances never change from corporate actions.** Instead, `uiMultiplier()` moves. It's the shares-per-token ratio, scaled by `1e18`:

- `1000000000000000000` (i.e. `1e18`) → 1 token represents 1 share. This is the starting state for every token.
- After a reinvested dividend or a split adjustment, it rises above `1e18`. Your token balance is unchanged; each token now represents *more than one share* of economic exposure.

So a Stock Token has **two different quantities** you can ask about, and they answer different questions:

| Quantity | Formula | Answers |
| --- | --- | --- |
| Token balance | `balanceOf(you)` | "How many tokens do I hold?" |
| Share-equivalent | `balance × uiMultiplier ÷ 1e18` | "How many shares of the stock is that?" |

## The trap: which number do you multiply by the price?

Here's where integrations break. You have a token balance, a multiplier, and a Chainlink price. To get a USD value, which do you multiply?

The instinct — and it's wrong — is: *shares × price*. That is, `balance × multiplier × price`. It feels right ("value = number of shares times price per share"), and it produces a number that looks plausible. After a corporate action, it is **too high**, because you've counted the multiplier twice.

**The reason:** Robinhood's Chainlink feeds are **already multiplier-adjusted**. The feed for a Stock Token returns the total-return price of *one token*, not the price of one underlying share. The corporate action is baked into the feed answer. So:

:::danger The rule, memorize it
**USD value = token balance × feed price. Nothing else.**
The feed price already includes the multiplier. Applying `uiMultiplier` to the *value* double-counts every split and dividend. Use `uiMultiplier` only to report **share-equivalents** to a human — never in a valuation.
:::

## A worked example

Suppose a token has had a corporate action, so its multiplier is `1.5e18` (each token now represents 1.5 shares). You hold 10 tokens. The Chainlink feed answers `20000000000` — that's `$200.00` at 8 decimals, and remember, that's the price of one *token*.

**Wrong (double-counts the multiplier):**

```ts
const shares = balance * multiplier / 10n ** 18n   // 10 × 1.5 = 15 "shares"
const wrongUsd = shares * feedPriceUsd             // 15 × $200 = $3,000  ❌
```

**Right (feed price is per token, already adjusted):**

```ts
const rightUsd = balanceTokens * feedPriceUsd      // 10 × $200 = $2,000  ✅
```

The wrong version overstates the position by exactly the multiplier — a 50% error here. On a real portfolio dashboard that's the difference between a user trusting your app and closing it forever. And the share count itself is still useful — you'd show "10 tokens ≈ 15 shares" as context — you just don't put it in the dollar math.

:::tip The feed answer isn't stale on weekends — it's closed
Stock feeds update 24/5, following market hours. Read one on a Saturday and its `updatedAt` will be Friday's close. That is **not** a stale feed; it's a closed market. A staleness check with a one-hour window will reject every weekend read. Use a window that tolerates the weekend gap (~72 hours), and tighten it only during market hours if you need to. The hoodchain SDK defaults to a 72-hour window for exactly this reason.
:::

## Doing it correctly, with the SDK

The [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) encodes all of the above so you don't have to. Here's the whole thing, correct by construction:

```ts
import { createHoodClient, getQuote, getMultiplier } from 'hoodchain'

const hood = createHoodClient()

// getQuote returns the multiplier-adjusted price of ONE TOKEN
const quote = await getQuote(hood, 'AAPL', { maxAgeSeconds: 7 * 24 * 60 * 60 })
console.log(`AAPL token price: $${quote.priceUsd}`)   // e.g. $315.50

// getMultiplier is the shares-per-token ratio — for display, not valuation
const m = await getMultiplier(hood, 'AAPL')
console.log(`1 AAPL token = ${Number(m) / 1e18} shares`)  // e.g. 1.0
```

`getQuote` also runs the staleness guard, validates the answer is positive and the round is complete, and throws a typed `StaleFeedError` / `InvalidFeedAnswerError` / `FeedNotFoundError` you can catch precisely. `getPortfolio` (Tutorial 5) applies the valuation rule across every holding and even cross-checks its share math against the token's own on-chain `balanceOfUI()`.

## Not every token has a feed

There are 95 Stock Tokens on-chain but Chainlink's public directory currently lists feeds for a **subset** — 34 at the time of writing. A token without a feed can still have its balance read; it just can't be priced on-chain. The SDK models this honestly: `listPricedStockTokens()` returns only the priceable ones, and `getQuote` on an unpriced token throws `FeedNotFoundError` rather than inventing a number. When you build the portfolio tracker, you'll see unpriced holdings reported as such — never as `$0`, which would be a lie.

## Troubleshooting

**My USD total is way too high after a split** — you're multiplying by `uiMultiplier` somewhere in the value path. Remove it. Value is `balance × feed price`, full stop.

**`StaleFeedError` on a weekend** — expected. Widen `maxAgeSeconds` to cover the weekend (e.g. `7 * 24 * 60 * 60`). The market is closed, not the feed broken.

**`FeedNotFoundError`** — that token has no Chainlink feed. Read its balance, but don't try to price it. Use `listPricedStockTokens()` to see what *can* be priced.

**My "share count" and "token count" differ and I expected them equal** — that token has had a corporate action, so its multiplier is above `1e18`. That divergence is the whole point of the design; both numbers are correct, they just answer different questions.

## What you learned

You now understand the one thing that makes Robinhood Chain integrations subtly hard: the multiplier, the two quantities it produces, and the ironclad rule that valuation uses the feed price alone. You also know feeds are 24/5 and that not every token is priceable. With this, you're ready to build — starting with a live price ticker.
