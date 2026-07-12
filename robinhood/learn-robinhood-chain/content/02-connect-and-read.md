Talk is cheap. In the next five minutes you'll connect to Robinhood Chain and pull real data off it — the current block height, the chain ID, and the gas price — with about fifteen lines of code. No wallet, no funds, no signup. Reads are free and public.

## Add the network to a wallet (optional, 60 seconds)

You don't need a wallet for reads, but if you want to poke around a block explorer with a browser wallet, add the network manually. In MetaMask: **Settings → Networks → Add network → Add manually**, then:

```text
Network name:     Robinhood Chain
RPC URL:          https://rpc.mainnet.chain.robinhood.com
Chain ID:         4663
Currency symbol:  ETH
Block explorer:   https://robinhoodchain.blockscout.com
```

For anything that spends, use **testnet** (chain ID `46630`, RPC `https://rpc.testnet.chain.robinhood.com`) and claim funds from the [faucet](https://faucet.testnet.chain.robinhood.com/) first.

:::warning The faucet needs a real browser
The testnet faucet is behind Cloudflare Turnstile and Google Sign-In — it can't be scripted. It drips 0.01 ETH plus five of each test Stock Token (TSLA, AMZN, PLTR, NFLX, AMD) per 24 hours. Claim once, up front, and reuse that wallet for every write tutorial. There's also a [Chainlink faucet](https://faucets.chain.link/robinhood-testnet) for testnet LINK/ETH.
:::

## Read the chain with raw JSON-RPC (zero dependencies)

Before any library, prove the RPC is real with nothing but `curl`. This asks the node for its chain ID:

```bash
curl -s https://rpc.mainnet.chain.robinhood.com \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

```json
{"jsonrpc":"2.0","id":1,"result":"0x1237"}
```

`0x1237` is `4663` in decimal — the mainnet chain ID. The chain is answering. That's the entire foundation of everything that follows.

:::tip You just saw the landing page's secret
The live stats strip on this site's [home page](../) is doing exactly this — plain `fetch` calls to that same RPC from your browser. Read-only chain access needs no backend, no key, and no SDK. That property is why so much of this course runs client-side.
:::

## Read the chain with viem

`curl` is fine for a sanity check; for real work you want typed results and helpers. Install viem:

```bash
npm init -y
npm install viem
npm pkg set type=module
```

Create `read.ts` (or `.mjs`) and paste:

```ts
import { createPublicClient, http, formatGwei } from 'viem'
import { robinhood } from 'viem/chains'

const client = createPublicClient({
  chain: robinhood,           // viem's official chain def — chain ID 4663
  transport: http(),          // uses the public RPC from the chain def
})

const [blockNumber, gasPrice, chainId] = await Promise.all([
  client.getBlockNumber(),
  client.getGasPrice(),
  client.getChainId(),
])

console.log(`chain id      ${chainId}`)
console.log(`block height  ${blockNumber}`)
console.log(`gas price     ${formatGwei(gasPrice)} gwei`)
```

Run it:

```bash
npx tsx read.ts
```

```text
chain id      4663
block height  7727411
gas price     0.01 gwei
```

That block number was live when this tutorial was written; yours will be higher, because Robinhood Chain produces a new block roughly every 100 milliseconds. Do the math: **that's on the order of half a million blocks a day.** Keep it in mind when you scan historical logs later — "the last hour" is tens of thousands of blocks.

## Use a faster RPC (when the public one isn't enough)

The public RPC is perfect for learning and light apps, but it rate-limits. The moment you're scanning large block ranges or serving users, move to a dedicated endpoint. Alchemy is the recommended provider:

```ts
const client = createPublicClient({
  chain: robinhood,
  transport: http(`https://robinhood-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`),
})
```

You'll feel the difference immediately in Tutorial 7 when scanning launchpad history — the public RPC will return `429 Too Many Requests` on a wide scan; a dedicated key won't.

## Skip the boilerplate: the hoodchain client

Everything above is standard viem. As your app grows you'll want the batteries-included client from the [hoodchain SDK](https://github.com/nirholas/robinhood-chain-sdk) — it wraps viem with multicall batching on by default, both networks pre-wired, and an optional wallet:

```bash
npm install hoodchain viem
```

```ts
import { createHoodClient } from 'hoodchain'

const hood = createHoodClient() // mainnet 4663, public RPC, multicall batching on
console.log('block', await hood.public.getBlockNumber())
```

`hood.public` is a normal viem `PublicClient`, so nothing you learned is wasted — the SDK just removes the setup. From the next tutorial on, we use `createHoodClient` because it also knows about Stock Tokens, feeds, and swaps, which raw viem does not. When you need to drop to the metal, `hood.public` and `hood.wallet` are right there.

## Troubleshooting

**`Cannot use import statement outside a module`** — add `"type": "module"` to your `package.json` (`npm pkg set type=module`), or use the `.mjs` extension.

**`fetch failed` / `ECONNREFUSED`** — check the RPC URL for a typo; it's `rpc.mainnet.chain.robinhood.com`, no port, HTTPS. Confirm you have network access with the `curl` command above.

**`npx tsx` is slow the first time** — `tsx` is being downloaded. Install it once (`npm i -D tsx`) to make subsequent runs instant.

**The block number looks *huge* / grows while you watch** — that's correct. ~100 ms blocks. It's a feature, not a bug.

## What you learned

You connected to Robinhood Chain three ways — raw `curl`, plain viem, and the hoodchain client — and read live data with each. You know reads are free and keyless, why block numbers are enormous, and when to upgrade off the public RPC. Next, the one concept that makes Stock Tokens different from every other ERC-20 you've touched.
