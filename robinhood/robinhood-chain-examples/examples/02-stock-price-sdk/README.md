# 02 · Stock Token price with the SDK

Exactly what [example 01](../01-read-stock-price) does — one `import`, one
`createHoodClient()`, one `getQuote()`. The [`hoodchain`](https://github.com/nirholas/robinhood-chain-sdk)
SDK bundles the full **95-token registry**, the Chainlink decode, staleness
handling, and typed errors, so you never hand-maintain an address table.

**What it proves:** the SDK collapses example 01 to three meaningful lines and
covers all 95 Stock Tokens instead of a hard-coded handful.

## Prerequisites

- Node ≥ 20. Reads only — no wallet, no key, no funds.
- `hoodchain` is not on npm yet. Until it is, install the local sibling build:
  ```bash
  npm install                       # installs viem
  npm install ../../../robinhood-chain-sdk   # the hoodchain build (or: npm i hoodchain once published)
  ```
  When both repos are extracted as siblings, the path is `../robinhood-chain-sdk`.

## Run

```bash
npm start                     # AAPL TSLA NVDA
node index.js MSFT GOOGL AMD  # any registry symbols
```

## Expected output

```
AAPL   $   315.50   feed 0x6B22A786bAa607d76728168703a39Ea9C99f2cD0   age 39.3h
TSLA   $   407.82   feed 0x4A1166a659A55625345e9515b32adECea5547C38   age 38.5h
NVDA   $   210.19   feed 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15   age 42.0h
```

Unknown symbols surface a typed `UnknownSymbolError`:

```
FOOBAR —  UnknownSymbolError: Unknown Stock Token symbol "FOOBAR". Symbols are
case-insensitive tickers as listed on-chain (e.g. "AAPL", "TSLA"). ...
```

The SDK also throws `FeedNotFoundError` (token has no feed) and `StaleFeedError`
(answer older than the tolerance) — catch by class, not by string.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
