# hood-js examples

Four runnable scripts against the built package. Build first so the `hood-js` import
resolves (Node package self-reference):

```bash
npm install && npm run build
```

| Script | What it does | Needs |
| --- | --- | --- |
| `node examples/price.mjs [SYMBOLS…]` | Live Stock Token prices, one or batched | nothing |
| `node examples/coins.mjs` | Top trending Robinhood Chain memecoins | nothing |
| `node examples/portfolio.mjs 0xADDR` | Multiplier-correct portfolio for any address | nothing |
| `node examples/swap-testnet.mjs` | REAL swap on testnet 46630: WETH → NFLX | funded `ROBINHOOD_CHAIN_PRIVATE_KEY` |

Fund a testnet key at [faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com/)
(0.01 ETH + five of each test Stock Token per claim, once per 24 h, browser-only).
