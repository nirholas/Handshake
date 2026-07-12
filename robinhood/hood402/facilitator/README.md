# hood402-facilitator

A self-hostable x402 facilitator for USDG on Robinhood Chain. Verifies and settles
`exact`/EIP-3009 payments per the [x402 spec](https://github.com/coinbase/x402), backed by an
idempotent SQLite ledger. This is what `hood402/server`'s `paywall({ facilitator })` option
talks to — and any other x402-speaking resource server can use it too, since it implements
the standard `/verify` and `/settle` HTTP contract.

Built on the [`hood402`](..) protocol package. Part of the [hood402](..) repo.

## Why run your own facilitator

- **No vendor lock-in.** Point `paywall({ facilitator })` at your own instance instead of a
  third party's — you control uptime, key custody, and settlement policy.
- **Idempotent by construction.** A `(network, payer, nonce)` unique key in the SQLite
  ledger means a retried `/settle` call for the same signed payment returns the original
  transaction instead of broadcasting (and paying gas) twice.
- **Zero native dependencies.** The ledger uses Node's built-in `node:sqlite` — no
  `better-sqlite3`, no native compilation step, trivial Docker builds.

## Install & run

```bash
git clone https://github.com/nirholas/hood402.git
cd hood402 && npm install && npm run build   # build the core `hood402` package first
cd facilitator && npm install && npm run build

cp ../.env.example .env   # fill in FACILITATOR_PRIVATE_KEY at minimum
npm start
```

```
hood402-facilitator listening on :4021 — signer 0x... — networks: robinhood, robinhood-testnet
```

### Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `FACILITATOR_PRIVATE_KEY` | yes | — | The gas wallet that broadcasts settlement transactions. Needs ETH on every network it settles. Never holds user funds — it only relays signed EIP-3009 authorizations. |
| `FACILITATOR_NETWORKS` | no | `robinhood,robinhood-testnet` | Comma-separated networks to settle on. |
| `ROBINHOOD_RPC_URL` | no | public mainnet RPC | Override the mainnet RPC (e.g. an Alchemy endpoint for higher rate limits). |
| `ROBINHOOD_TESTNET_RPC_URL` | no | public testnet RPC | Override the testnet RPC. |
| `PORT` | no | `4021` | HTTP port. |
| `LEDGER_PATH` | no | `./data/hood402-ledger.sqlite` | SQLite ledger file path. |

## API

### `GET /healthz`
```json
{ "ok": true, "signer": "0x...", "networks": ["robinhood", "robinhood-testnet"] }
```

### `GET /supported`
The `(x402Version, scheme, network)` triples this facilitator settles — per spec, so any
x402 client can discover compatibility before paying.
```json
{ "kinds": [{ "x402Version": 1, "scheme": "exact", "network": "robinhood" }, ...] }
```

### `POST /verify`
```json
{ "paymentPayload": { "...": "the decoded X-PAYMENT payload" }, "paymentRequirements": { "...": "the 402 challenge's requirement" } }
```
Runs the full state machine: structure → EIP-3009 signature recovery → on-chain replay check
(`authorizationState`) → on-chain balance check (`balanceOf`). Returns
`{ "isValid": true, "payer": "0x..." }` or `{ "isValid": false, "invalidReason": "..." }`.

### `POST /settle`
Same request shape as `/verify`. Re-verifies, then broadcasts
`transferWithAuthorization` and awaits the receipt.
```json
{ "success": true, "transaction": "0x...", "network": "robinhood", "payer": "0x..." }
```
Idempotent: calling `/settle` again with the *same* `(payer, nonce)` returns the original
result instead of re-broadcasting. A concurrent duplicate mid-flight gets `409` with
`errorReason: "authorization_already_used"`.

### `GET /metrics`
Prometheus text format — settlement counts by status and total USDG settled (atomic units).

## Deploying to Google Cloud Run

```bash
# from robinhood/hood402/ (the repo root — the facilitator depends on the sibling package)
docker build -f facilitator/Dockerfile -t hood402-facilitator .

gcloud run deploy hood402-facilitator \
  --image hood402-facilitator \
  --region us-central1 \
  --port 4021 \
  --set-env-vars FACILITATOR_NETWORKS=robinhood,robinhood-testnet \
  --set-secrets FACILITATOR_PRIVATE_KEY=hood402-facilitator-key:latest \
  --min-instances 1
```

The SQLite ledger lives at `/app/data` inside the container. Cloud Run's filesystem is
ephemeral per-instance — for production durability, either mount a Cloud Storage FUSE
volume at `/app/data`, or point `LEDGER_PATH` at a persistent disk. A lost ledger only
risks re-broadcasting an already-settled nonce, which the on-chain
`authorizationState` check catches before any gas is spent — the ledger is an
optimization for skipping a wasted RPC round trip, not the sole source of truth for
double-spend prevention.

## Docker build locally

```bash
docker build -f facilitator/Dockerfile -t hood402-facilitator .
docker run --rm -p 4021:4021 \
  -e FACILITATOR_PRIVATE_KEY=0x... \
  -e FACILITATOR_NETWORKS=robinhood-testnet \
  hood402-facilitator
```

## Publishing

This package's `hood402` dependency is `file:..` for local development inside the monorepo.
Before `npm publish`, change it to a real semver range (e.g. `"hood402": "^0.1.0"`) matching
the version actually published to the registry — `npm pack` succeeds either way, but a
`file:` dependency does not resolve for an external installer.

## License

Apache-2.0 © 2026 nirholas

Built by [nirholas](https://x.com/nichxbt) · [three.ws](https://three.ws)
