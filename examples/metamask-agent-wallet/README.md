# MetaMask Agent Wallet demo

A single-page demo that gives a three.ws agent a real server-side wallet through the
MetaMask Agentic CLI (`mm`). A tiny localhost bridge ([server.mjs](./server.mjs))
shells out to the authenticated `mm` CLI and exposes three JSON endpoints; the page
([index.html](./index.html)) renders the live wallet state, signs messages, and
verifies the signatures client-side with `viem`.

Nothing here is mocked: the address, balance, ETH price, and signatures all come from
the real CLI session on your machine.

## Prerequisites

- Node 18+ (the repo root `npm install` provides `viem`).
- The MetaMask Agentic CLI installed and authenticated (`mm auth status` must report
  an authenticated session). The bridge invokes `mm ... --json` via `execFile`, so
  `mm` has to be on your `PATH`.

## Run it

```bash
node examples/metamask-agent-wallet/server.mjs
# MetaMask agent wallet demo -> http://localhost:4280
```

Then open http://localhost:4280. Set `PORT` to change the port (default `4280`).

The server binds to `127.0.0.1` on purpose: the CLI session lives on this machine,
so the bridge must never be exposed publicly.

## HTTP surface

| Method | Path | What it does |
|---|---|---|
| `GET` | `/` | Serves the demo page. |
| `GET` | `/api/agent-wallet` | Auth status, address, chain, and total balance via `mm auth status`, `mm wallet address`, `mm wallet balance`. |
| `GET` | `/api/price` | Spot ETH price on Base via `mm price spot`. |
| `POST` | `/api/agent-wallet/sign` | Body `{ "message": "..." }` (max 500 chars). Signs with `mm wallet sign-message` (EIP-191 personal_sign, chain id 8453) and verifies the signature with viem's `verifyMessage` before returning it. |

## Example

With the server running:

```bash
curl -s -X POST http://localhost:4280/api/agent-wallet/sign \
  -H 'content-type: application/json' \
  -d '{"message":"hello from three.ws"}'
# -> { "address": "0x...", "status": "...", "signature": "0x...",
#      "standard": "EIP-191 (personal_sign)", "verified": true }
```

`verified: true` means the round trip is real: the CLI produced the signature and
viem recovered the same address from it.

## Files

- [server.mjs](./server.mjs): the localhost bridge (Node stdlib http + `execFile('mm', ...)` + viem verification).
- [index.html](./index.html): the self-contained UI (no build step, no framework).

## Related

- The `metamask-agent-wallet` skill in `data/skills/metamask-agent-wallet` documents the full `mm` CLI surface.
- Other embed demos live in this directory's parent, [examples/](../README.md).
