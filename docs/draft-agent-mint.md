# Draft agent mint

Every avatar that finishes reconstruction gets two things it did not have
before: a permanent copy in durable object storage, and a **draft on-chain
identity**. The identity is minted for you, in the background, with no wallet
prompt, no fee, and no step to remember. By the time the avatar appears in your
library it already exists as an asset on a public chain, owned by the agent's
own wallet.

"Draft" is the operative word. The identity is real and readable by anyone, but
it is marked inactive: it says *this agent exists and this is its avatar*, not
*this agent is live and taking work*. Activating it (going live, taking
payments, appearing in the marketplace) is a separate, deliberate step.

- **Orchestration:** [`api/_lib/draft-mint.js`](../api/_lib/draft-mint.js)
- **Caller:** [`api/_lib/reconstruct-finalize.js`](../api/_lib/reconstruct-finalize.js), the shared tail of the selfie and prompt to 3D pipeline
- **Solana mint machinery:** [`api/_lib/onchain-deploy.js`](../api/_lib/onchain-deploy.js) (shared with the batch deployer, so a draft mint is shaped exactly like any other platform mint)
- **Proof script:** [`scripts/draft-mint-devnet-e2e.mjs`](../scripts/draft-mint-devnet-e2e.mjs)

## Where it fires

`materializeReconstructAvatar()` is the one place a reconstruction becomes a
durable avatar, and every terminal path in the pipeline funnels through it
(rigged as-is, rigged after an auto-rig chain, and the unrigged fallback). In
order, it:

1. writes the GLB to the object store with `putObject()`;
2. creates the `avatars` row;
3. marks the regen job `done`;
4. dispatches the `avatar.created` webhook;
5. registers the result in the Forge store;
6. **mints the draft agent identity.**

Steps 4 through 6 are best-effort by contract. The avatar is already delivered
and visible at step 2, so a webhook, store, or chain hiccup logs a warning and
the job still succeeds. A draft mint failure never costs a user their avatar.

## The Solana leg (Metaplex Core)

Solana leads. The draft identity is a **Metaplex Core asset** minted into the
three.ws Agents collection, through the same `deployAgentOnce()` the batch
deployer uses. That means a draft mint carries everything a normal platform
mint carries: collection membership, the brand attribute set, the royalty
plugin, and enrolment in the Metaplex Agent Registry (an Agent Identity PDA).

Ownership resolves in this order:

1. the agent's existing Solana wallet, if it has one;
2. a freshly generated custodial wallet, when `JWT_SECRET` is configured so the
   secret can be encrypted at rest and recovered later;
3. the collection authority, holding the asset in custody until the user claims
   it.

The owner never signs the mint, so it needs no SOL of its own.

### Networks, and the one flag that arms mainnet

| `DRAFT_AGENT_MINT_NETWORK` | Behavior |
| --- | --- |
| unset or `devnet` (default) | Mints on Solana **devnet**. Free, automated, and the proof path. Results are written under `agent_identities.meta.devnet` so they can never be mistaken for, or block, a mainnet mint. |
| `mainnet` | Mints on Solana mainnet-beta. **This is the only switch that arms real spend.** |
| `off`, `disabled`, `0` | The Solana leg is skipped entirely. |

Mainnet is never implicit. It requires the operator to set
`DRAFT_AGENT_MINT_NETWORK=mainnet` **and** fund
`SOLANA_AGENT_COLLECTION_AUTHORITY_KEY` (or `LAUNCH_FUNDER_SECRET`) on mainnet.
With no authority secret configured, the leg reports `skipped` and does
nothing, so a deployment without mint credentials behaves exactly as it did
before this feature existed.

Budget roughly 0.004 SOL per mint (Core asset rent plus fee), 0.005 SOL once
for the collection account on a network's first run, and 0.003 SOL for the
Agent Registry enrolment.

### What lands in the database

| Location | Contents |
| --- | --- |
| `agent_identities.meta.devnet` | `sol_mint_address`, `collection`, and the full `onchain` block (CAIP-2 chain id, asset, metadata URI, owner, custody flag, tx signature) |
| `agent_identities.meta` (mainnet only) | the canonical `sol_mint_address` / `chain_type` / `network` fields every read path keys on, plus the same `onchain` block |
| `agent_actions` | a `solana.deploy` row for the audit trail |
| `avatars.source_meta.draft_mint` | the outcome stamp: job id, per-leg status, asset, signature, and timestamp |

The mint is idempotent. An agent that already carries an identity on the target
network short-circuits to `already` without touching the chain.

## The EVM leg (ERC-8004)

The EVM leg registers the agent's card URI in the canonical ERC-8004 Identity
Registry. It is off unless explicitly enabled, and it never blocks or delays
the Solana leg.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DRAFT_AGENT_MINT_EVM_ENABLED` | off | `1` / `true` / `yes` / `on` arms the leg |
| `DRAFT_AGENT_MINT_EVM_CHAIN_ID` | `84532` (Base Sepolia) | any chain in [`api/_lib/erc8004-chains.js`](../api/_lib/erc8004-chains.js) |
| `EVM_TREASURY_PRIVATE_KEY` | unset | gas source; without it the leg stops at a dry run |

The agent registers itself: the call is signed by the agent's own custodial EVM
wallet, and the treasury only tops that wallet up to a small gas floor
(0.00025 native) when it is short. The card the registry URI points at is the
three.ws Agent Card v1 shape with `active: false`, pinned to IPFS when a
provider is configured and to the object store otherwise.

**Without a treasury key the leg is a full dry run**, not a stub: it builds the
real `register(string)` calldata and asks the live chain for a gas estimate,
then returns `status: 'dry_run'` with the calldata, the registry address, the
card URI, and the estimate. Nothing is broadcast. That makes the wiring
provable on a deployment that has no funded EVM wallet at all.

## Proving it end to end

[`scripts/draft-mint-devnet-e2e.mjs`](../scripts/draft-mint-devnet-e2e.mjs)
runs the real orchestration against real infrastructure: it writes real GLB
bytes to the object store, creates the avatar row, calls
`mintDraftAgentIdentity()` with its real dependency set, reads the minted asset
back **from the chain** with `fetchAsset()`, checks collection membership and
that the metadata URI resolves, re-reads the database for the durable stamps,
and exercises the ERC-8004 leg against the live testnet RPC.

It is devnet-only by construction: it refuses to start if
`DRAFT_AGENT_MINT_NETWORK=mainnet`, and it pins the network to devnet for its
own process. Nothing it does spends real funds.

```bash
DATABASE_URL=postgres://…                              \
S3_ENDPOINT=…  S3_ACCESS_KEY_ID=…  S3_SECRET_ACCESS_KEY=… \
S3_BUCKET=…    S3_PUBLIC_DOMAIN=…                      \
SOLANA_AGENT_COLLECTION_AUTHORITY_KEY=<devnet-funded base58 keypair> \
node scripts/draft-mint-devnet-e2e.mjs
```

The authority needs about 0.02 devnet SOL to cover the collection account, the
mint, and the registry enrolment on a first run. Fund it at
<https://faucet.solana.com>. The script writes an evidence JSON (asset,
signature, explorer link, storage checksum, chain read-back, EVM calldata) to
`DRAFT_MINT_E2E_OUT`, defaulting to your temp directory. At the end it deletes
the user, avatar, and agent rows it created (the chain artifacts are permanent
by nature); set `DRAFT_MINT_E2E_KEEP=1` to keep them.

### Running it without cloud credentials

A local Postgres and any S3-compatible store are enough. The app's database
driver speaks Neon's HTTP protocol, so a local Postgres needs a proxy in front
of it; point the driver at that proxy with
`DRAFT_MINT_E2E_NEON_HTTP_ENDPOINT`.

```bash
docker network create draftmint-net
docker run -d --name draftmint-pg --network draftmint-net \
  -e POSTGRES_PASSWORD=proof -e POSTGRES_DB=threews postgres:16-alpine
docker run -d --name draftmint-neon --network draftmint-net -p 4455:4444 \
  -e PG_CONNECTION_STRING=postgres://postgres:proof@draftmint-pg:5432/threews \
  ghcr.io/timowilhelm/local-neon-http-proxy:main
docker run -d --name draftmint-minio --network draftmint-net -p 9100:9000 \
  -e MINIO_ROOT_USER=draftmint -e MINIO_ROOT_PASSWORD=draftmintsecret \
  -e MINIO_DOMAIN=localhost quay.io/minio/minio:latest server /data

# Apply the repo schema, then every incremental migration, in that order.
docker cp api/_lib/schema.sql draftmint-pg:/schema.sql
docker cp api/_lib/migrations draftmint-pg:/migrations
docker exec draftmint-pg psql -U postgres -d threews -q -f /schema.sql
docker exec draftmint-pg sh -c \
  'cd /migrations && for f in $(ls *.sql | sort); do psql -U postgres -d threews -q -f "$f"; done'
```

The store is addressed virtual-host style (`<bucket>.localhost`), which is why
MinIO is started with `MINIO_DOMAIN=localhost`; add
`127.0.0.1 <bucket>.localhost` to `/etc/hosts` and give the bucket a
public-read policy so the script's read-back check can fetch the object.

### When the faucet says no

The public devnet faucet rate-limits per source IP, so a shared machine (a
Codespace, a CI runner, an office network) can find it already exhausted by
someone else, and every airdrop in the endpoint chain comes back 429. The proof
does not have to stop there: point the whole devnet chain at your own validator
with the real Metaplex programs cloned off devnet, and it airdrops without
limit.

```bash
solana-test-validator --reset --ledger /tmp/dm-ledger \
  --url https://api.devnet.solana.com \
  --clone-upgradeable-program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d \
  --clone-upgradeable-program 1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p &

solana-keygen new --no-bip39-passphrase --silent --outfile /tmp/dm-authority.json
solana airdrop 20 "$(solana-keygen pubkey /tmp/dm-authority.json)" --url http://127.0.0.1:8899
```

The two programs are Metaplex Core (the asset) and the Metaplex Agent Registry
(the identity PDA). Clone both, or the registry enrolment fails and the proof
covers only half the mint.

One wrinkle: the platform derives a connection's websocket endpoint by swapping
the scheme on its HTTP URL, same host and same port, which is what every hosted
RPC provider serves. A test validator instead puts its websocket on
`rpcPort + 1`, so the derived `ws://127.0.0.1:8899` never connects, transaction
confirmation falls back to block-height polling, and the mint reports an expired
blockhash for a transaction that in fact landed. Front the validator with
anything that serves HTTP and the websocket upgrade on one port, and point
`SOLANA_RPC_URL_DEVNET` at that port instead.

`SOLANA_RPC_URL_DEVNET` takes priority over every other devnet lane, so the run
uses your node. The signature it produces is a real signature from a real
Solana runtime executing the real programs, but it lives on your ledger, not on
public devnet: it will not resolve on Solscan. The script reports which node
served the run and, off the public cluster, prints the endpoint instead of an
explorer link, so the evidence file never overstates what was proven.

## Failure semantics

| Situation | Result |
| --- | --- |
| No authority secret | Solana leg returns `skipped` / `authority_unconfigured`; nothing else changes |
| Authority underfunded | The mint throws, the caller logs and moves on, the avatar is unaffected |
| Agent already minted on this network | `already`, with the existing asset address, no chain write |
| Agent Registry enrolment fails | The mint still stands; the back-fill retries the enrolment later |
| No EVM treasury key | EVM leg returns `dry_run` with real calldata and a real gas estimate |
| `DRAFT_AGENT_MINT_EVM_CHAIN_ID` is not a chain in the table | EVM leg returns `skipped` / `unsupported_chain` |
| Treasury cannot cover the agent wallet's gas top-up | EVM leg returns `skipped` / `treasury_low:<balance>`; nothing is broadcast |
| Agent has no custodial EVM key to sign with | EVM leg returns `skipped` / `no_evm_key` |
| Database write fails after a mint | The avatar stamp is skipped with a warning; the on-chain asset and the agent meta are already written |

## Related

- [Selfie to Avatar](./selfie-to-avatar.md): the pipeline whose tail calls this
- [Agent identities](./agent-identities.md): what an agent identity is and how it is generated
- [Agent tokens](./agent-tokens.md): what happens after a draft identity goes live
- [The agent index](./agent-index.md): the cross-chain index that surfaces these registrations
