# 06 · Sequencer firehose

Decode Robinhood Chain's Arbitrum Nitro **sequencer feed** into a live
transaction stream. `subscribeFeed` connects to
`wss://feed.mainnet.chain.robinhood.com`, unpacks each Nitro L2 message (signed
tx and batch kinds), and hands you viem-parsed transactions **~100–300ms before
they are queryable over RPC** — the earliest possible view of chain activity.
Reads only; auto-reconnects with backoff.

**What it proves:** the firehose is real, unauthenticated, and high-throughput,
and the SDK turns raw Nitro frames into typed transactions with an optional
address filter.

## Prerequisites

- Node ≥ 20 (uses the built-in `WebSocket`; on older Node the SDK falls back to
  the `ws` peer dependency, which this example installs).

## Run

```bash
npm install && npm install ../../../robinhood-chain-sdk
npm start                                  # 15s of everything
node index.js 30 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168   # 30s, USDG txs only
node index.js 0                            # stream forever (Ctrl-C)
```

## Expected output

```
Connecting to the sequencer firehose…
Connected. Decoding L2 messages as they stream…

  seq   7732546  0x3ea23f6c10d1c645…  to 0x0000000071727de22e5e9d8baf0edac6f37da032
  seq   7732547  0xc3b210eb2dabac05…  to 0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc  0.000010 ETH
  seq   7732548  0x338a90b4a1305e7f…  to 0x48190f1560e60cac0107f2fe9625daf85b058c4c  0.018535 ETH
  ...
1168 frames, 6712 transactions decoded.
```

That's **6,712 transactions in 12 seconds** off one socket. The first line's
recipient `0x0000…da032` is the ERC-4337 EntryPoint v0.7 — account-abstraction
traffic shows up here just like everything else.

---

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
