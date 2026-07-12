# hoodchain examples

Five runnable scripts. Build the package first so the `hoodchain` import resolves
(Node package self-reference):

```bash
npm install && npm run build
```

| Script | What it does | Needs |
| --- | --- | --- |
| `npx tsx examples/quote.ts [SYMBOLS…]` | Live Chainlink prices + multipliers for Stock Tokens | nothing |
| `npx tsx examples/portfolio.ts 0xADDR` | Multiplier-correct portfolio of any address | nothing |
| `npx tsx examples/watch-launches.ts` | Recent + real-time NOXA/Odyssey launches and graduations | nothing |
| `npx tsx examples/firehose.ts` | Stream every sequenced transaction pre-RPC | nothing |
| `npx tsx examples/swap-testnet.ts` | REAL swap on testnet 46630: wrap ETH → swap WETH→NFLX | funded `ROBINHOOD_CHAIN_PRIVATE_KEY` |

Fund a testnet key at [faucet.testnet.chain.robinhood.com](https://faucet.testnet.chain.robinhood.com/)
(0.01 ETH + five of each test Stock Token per claim, once per 24 h, browser-only).
