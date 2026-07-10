# Agent wallets

Every three.ws agent owns a **custodial Solana wallet**. It is what lets an agent act on its own — pay for an API call, buy a coin, tip another agent, receive its earnings — without a human approving each transaction in a browser extension.

This is the reference for the wallet itself: how it's created, how its key is held, what may spend from it, and where the controls live. For the owner-facing safety story (limits, freeze, proof, recovery) read [Custody you can verify](custody.md). For the complete tour of everything the wallet can do, read [What agents can do → The Agent Wallet](agent-abilities/chapters/10-the-agent-wallet.md).

## What you get

The wallet is created automatically when an agent is created — there is no separate "enable wallet" step and no seed phrase for the owner to write down. Each agent gets:

- a **Solana keypair** (mainnet and devnet share one address)
- an **EVM keypair** for the chains where the agent registers its ERC-8004 identity
- a spot on the platform's custody ledger, which records every outbound movement

Nothing is shared between agents. Two agents owned by the same person hold two independent wallets.

## Key custody

The private key is generated on the server, never leaves it, and is **encrypted at rest with AES-256-GCM**.

The encryption key derives, via HKDF, from a dedicated secret (`WALLET_ENCRYPTION_KEY`) that exists only to protect wallets — deliberately *not* the platform's `JWT_SECRET`. Each ciphertext embeds its own random salt, so no two records share a derived key, and rotating session secrets never bricks a wallet. Ciphertexts written under the older scheme still decrypt (dual-read) and re-encrypt opportunistically on their next write.

This is the same secret box used for coin treasuries and the launcher, so every custodial secret on the platform is held the same way.

**What this means honestly:** the platform can sign for the agent. That is the point — an autonomous agent that needs you to approve each transaction is not autonomous. What the platform gives you in exchange is that everything it *can* do is capped by policy you set, halted by a freeze you control, recorded in an audit trail, and provable on-chain. See [custody.md](custody.md).

## Who can spend

Four paths move funds out of an agent wallet, and **all four pass through one policy module** before anything is signed:

| Path | Trigger |
|------|---------|
| Withdraw | The owner sweeps funds out |
| x402 pay | The agent pays for a paid API call |
| Trade | A discretionary buy/sell from the wallet hub |
| Snipe | The autonomous sniper worker executes a strategy |

Because enforcement lives at the signing boundary rather than in each feature, a new feature cannot accidentally introduce an unguarded spend path.

### The policy

Limits are stored per agent and are **opt-in** — an unset ceiling means "no global cap," so existing automated flows keep their own per-feature caps until an owner tightens the policy. Once set, they are hard limits applied uniformly:

- `daily_usd` — rolling 24-hour USD-equivalent outflow ceiling, summed from the custody ledger
- `per_tx_usd` — maximum USD-equivalent for a single outbound transaction
- `withdraw_allowlist` — if non-empty, withdrawals may only target these addresses
- `frozen` — the kill switch: every **autonomous** path is refused
- `require_capabilities` — when on, every autonomous spend must present a valid [scoped session key](agent-abilities/wallet/21-access.md)

Two asymmetries are deliberate:

- **A freeze never blocks the owner's withdrawal.** Locking down a misbehaving agent must not trap your money; the safe direction stays open.
- **An SPL token that can't be priced in USD** is governed by the allowlist and rate limit rather than the USD cap — a price-feed outage can never strand your own withdrawal.

Coin-launch and bonding-curve activity carries an additional SOL-denominated policy (`max_sol_per_tx`, `daily_sol_cap`, an optional `allowed_mints` allowlist). A freshly provisioned agent that has never been configured defaults to **1 SOL per transaction and 5 SOL per rolling day**, so a stolen session token cannot drain it.

On top of the numeric caps sit two additive layers, each of which can only ever *narrow* a spend, never widen it: [natural-language spend rules](financial-controls.md) that an LLM authors and deterministic code enforces, and a behavioral anomaly guard that freezes the wallet when a spend doesn't look like the agent's normal behavior.

### The audit trail

Every spend writes a row to the custody event ledger — amount, USD value, destination, path, timestamp. The rolling daily ceiling is enforced by summing that ledger, which means the cap and the audit trail can never disagree. The ledger is also what the [proof-of-custody](agent-abilities/wallet/20-proof-of-custody.md) Merkle attestation commits to.

## Where owners manage it

The **Agent Wallet Hub** lives at `/agent/:id/wallet`. Owners see all 23 sections; a visitor to a public agent page sees a read-only view (balance and deposit address only). A network selector switches every read and write between mainnet and devnet.

Key endpoints:

- `GET /api/agents/:id/solana` — address, live balance (public)
- `GET /api/agents/:id/solana/activity` — parsed transaction feed (owner only)
- `GET`/`PUT /api/agents/:id/solana/limits` — read and set the spend policy
- `POST /api/agents/:id/solana/withdraw` — sweep an asset out
- `GET /api/agents/:id/solana/guard` — anomaly guard state and flagged activity

Full request/response shapes are in the [REST API reference](api-reference.md).

## Paying by name

An agent can pay a human-readable name instead of a base58 address. `/api/x402/pay-by-name` resolves a recipient across three namespaces, in order: a `@username` (which resolves to that user's default agent's Solana address), a `.sol` SNS name resolved on-chain via Bonfida (subdomains included), or a raw base58 address, which passes straight through. `GET` resolves only, so you can show the user the address before spending; `POST` resolves and settles from the agent's wallet under the same spend policy as any other outbound path.

## Related

- [Custody you can verify](custody.md) — limits, freeze, Merkle proof-of-custody, social recovery and inheritance
- [Financial controls](financial-controls.md) — plain-English spend rules, compiled and enforced deterministically
- [What agents can do](agent-abilities.md) — the complete dossier, including a page per wallet ability
- [x402 protocol](x402.md) — how agents pay for services
- [Coin launches](coin-launches.md) — how the wallet signs a pump.fun launch
