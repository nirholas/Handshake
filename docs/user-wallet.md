# Your master wallet: the per-user custodial hub

Every three.ws **agent** owns a wallet ([agent-wallets.md](agent-wallets.md)). Separately, every **user account** can own one custodial wallet of its own: the **master wallet**. It is the financial hub for the person rather than the bot. You fund it once, then push money out to wherever it needs to be: into an agent's wallet so the agent can trade or pay for API calls, or straight out to any Solana address.

Solana is the operative chain here. The master wallet also holds an EVM keypair (used for reading a Base USDC balance and for the chains where agents register an on-chain identity), but the send paths documented below are Solana only.

Everything on this page moves real money. Read [Safety: this is a spend surface](#safety-this-is-a-spend-surface) before calling any `POST`.

Code: `api/user/wallet/index.js`, `send.js`, `fund-agent.js`, `history.js`.

## The page: [three.ws/wallet](https://three.ws/wallet)

If you just want to use your wallet rather than script it, **[/wallet](https://three.ws/wallet)** is the whole feature in a browser. Sign in and it shows your balances across Solana and Base, your two addresses with copy buttons and explorer links, and four actions: add funds (deposit), send, fund an agent, and history. If you have never provisioned a wallet, the page offers to create one and explains exactly what gets generated first.

Three things about that page are worth knowing before you use it:

- **Depositing is scan-to-fund.** The **Add funds** sheet (`src/wallet-deposit.js`) renders a payment-request QR, not a bare address: a Solana Pay URI (`solana:<addr>?amount=&spl-token=`) or, for Base USDC, an EIP-681 transfer link, so a scanning wallet opens with the recipient, token, and amount pre-filled. While the sheet is open, a watcher re-reads the wallet's real balances against a baseline and announces the exact on-chain delta the moment the deposit lands; it backs off over time, suspends while the tab is hidden, and gives up rather than polling forever.
- **Moving money out is two-step by design.** When you submit the send form or the fund-agent form, the page does not sign anything. It calls the route with `simulate: true`, which runs the real balance, rent, and fee checks on the server and returns what the transfer would actually cost. Only after you read back the amount, recipient, asset, and network, and press **Confirm and send**, does anything get signed and broadcast. A transfer cannot be reversed, so nothing leaves your wallet without you seeing the final numbers.
- **It is the same API documented below.** The page has no privileged path: it is a session-authenticated client over these four endpoints, so anything it can do, the `curl` examples on this page can do too.

Page code: `pages/wallet.html`, `src/master-wallet.js` (controller), `src/wallet-api.js` (the client), `src/wallet-deposit.js` (the deposit sheet), `public/master-wallet.css`. Not to be confused with `src/wallet.js`, which connects an **external** wallet such as Phantom and has nothing to do with the custodial master wallet.

## Master wallet vs agent wallet

They are different wallets with different jobs, and mixing them up is the single most common mistake here.

| | Master wallet | Agent wallet |
| --- | --- | --- |
| Belongs to | your **user account**, one per user | one **agent**, one per agent |
| Address record | `master_wallets` row keyed by `user_id` | the agent's own record |
| Who can spend | **you**, with a signed-in browser session | the agent itself, autonomously, plus you |
| Spend policy | none: no per-transaction cap, no daily USD cap, no allowlist, no freeze switch | full policy module: daily and per-transaction caps, withdraw allowlist, kill switch, capability gating |
| Auth accepted | **session cookie only** (no API key, no bearer token) | session or scoped credential, depending on the path |
| Typical use | hold funds, top up agents, sweep out | pay x402 endpoints, trade, buy skills, receive earnings |

The practical consequence: **an API key cannot spend your master wallet, and neither can an agent.** Only a browser session belonging to you can. That is deliberate. The agent-side limits, freeze switch, and audit rails described in [custody.md](custody.md) govern agent wallets; the master wallet's protection is that nothing autonomous can reach it at all, plus a hard ceiling of **5 outbound transactions per user per day** shared across `send` and `fund-agent`.

Funds flow one way through the platform's plumbing: master wallet to agent wallet, via `fund-agent`. To go the other direction, use the agent's own owner withdrawal (see [agent-wallets.md](agent-wallets.md)), which a freeze never blocks.

## Auth model: session plus CSRF

- Every route requires a signed-in **session cookie**. Without one: `401 unauthorized`. There is no bearer or API-key path on these four routes, unlike most of the API.
- Every write (`POST`) additionally requires a one-time CSRF token in `X-CSRF-Token`, obtained from `GET /api/csrf-token`. The token is bound to your user id, single-use, and expires after an hour. Missing: `403 csrf_missing`. Stale or wrong: `403 csrf_invalid`. Fetch a fresh token per write.
- Reads are rate limited at 60 per minute per user. Writes that move funds are limited to **5 per day per user**, and that limiter is critical: if its backend is unreachable in production the write is refused rather than uncapped. A `simulate: true` preview does **not** draw on that daily budget; previews have their own ceiling of 30 per minute per user, so pricing a transfer a few times can never lock you out of sending. Both money-moving routes are additionally limited per IP, as is wallet creation.

See [authentication.md](authentication.md) for how sessions and CSRF tokens work in general.

The examples below assume a browser-style cookie jar in `cookies.txt` and a token in `$CSRF`:

```bash
CSRF=$(curl -s -b cookies.txt https://three.ws/api/csrf-token | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
```

## Provisioning: lazy, and idempotent

No wallet exists until you ask for one. `GET /api/user/wallet` on an account that has never provisioned returns `{"wallet": null}`, which is the signal for a UI to offer a "create wallet" action rather than an error state. That is exactly what [/wallet](https://three.ws/wallet) renders for a new account.

`POST /api/user/wallet` creates the pair: a Solana keypair and an EVM keypair, both generated server-side, both encrypted at rest with AES-256-GCM under the dedicated `WALLET_ENCRYPTION_KEY` (the same secret box that protects agent wallets, deliberately not the session signing secret). There is no seed phrase for you to write down.

The call is idempotent. If a wallet already exists it returns `200` with `"created": false` and the existing addresses; a genuine creation returns `201` with `"created": true`.

```bash
curl -sX POST https://three.ws/api/user/wallet \
  -b cookies.txt -H "X-CSRF-Token: $CSRF"
```

```json
{
  "wallet": {
    "solana_address": "7Gk…",
    "evm_address": "0x9f…",
    "created_at": "2026-07-30T10:22:04.113Z",
    "created": true
  }
}
```

## Reading balances

`GET /api/user/wallet` returns the addresses plus live balances. Nothing is cached, and nothing blocks: the Solana read and the Base USDC read run in parallel and a failure of either yields `null` for that field rather than a failed request, so the page still renders.

```bash
curl -s -b cookies.txt https://three.ws/api/user/wallet
```

```json
{
  "wallet": {
    "solana_address": "7Gk…",
    "evm_address": "0x9f…",
    "created_at": "2026-07-30T10:22:04.113Z",
    "balances": {
      "sol": 0.4213,
      "sol_usdc": 120.5,
      "evm_usdc": 0,
      "total_usd": 197.84
    }
  }
}
```

- `sol` is the native balance, `sol_usdc` the USDC balance on Solana, `evm_usdc` the USDC balance on Base (read with a direct `balanceOf` call through the EVM RPC failover chain).
- `total_usd` is the priced Solana total plus the Base USDC figure, and is `null` when the price feed is unavailable. Treat a `null` as "unknown", never as zero.

## Sending SOL or an SPL token (this spends real funds)

`POST /api/user/wallet/send` signs and broadcasts a transfer from your master wallet to any Solana address.

| Field | Values | Meaning |
| --- | --- | --- |
| `destination` | base58 Solana address, required | Validated as a real, on-curve address. Program or off-curve addresses are refused, as is your own wallet address. |
| `amount` | positive number, or `"max"` | `"max"` sweeps the spendable balance. |
| `asset` | `"SOL"` (default) or an SPL mint address | Any SPL mint works, including Token-2022 mints. For USDC, pass the Solana USDC mint. |
| `simulate` | `true` to preview | Returns the resolved asset, destination, amount and USD value **without signing anything**. |

Reserves and guards, all applied before signing:

- A `"max"` SOL sweep holds back rent exemption plus a fee reserve, so the account never becomes unusable. A fixed SOL amount that would eat into that reserve is refused with `insufficient_balance`.
- For a token send, the source token account must exist and hold at least the requested amount, otherwise `insufficient_balance`. `"max"` sends the entire token balance.
- If the recipient has no token account for that mint, the transaction opens one (idempotently) and your wallet pays the rent. If your SOL cannot cover fee plus that rent, the call is refused with `insufficient_sol_for_fees` rather than half-executing.
- Amounts that round to zero at the mint's decimals are refused with `invalid_amount`.

Preview first. This costs nothing and signs nothing:

```bash
curl -sX POST https://three.ws/api/user/wallet/send \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -d '{
        "destination": "7Gk1vQ9c3sN4wH2xY8mJ6pR5tB1aD7fE0uK4nC9zL3sV",
        "amount": 5,
        "asset": "SOL",
        "simulate": true
      }'
```

```json
{
  "simulation": {
    "asset": "SOL",
    "destination": "7Gk1vQ9c3sN4wH2xY8mJ6pR5tB1aD7fE0uK4nC9zL3sV",
    "human_amount": 5,
    "usd_value": 742.15,
    "network": "mainnet"
  }
}
```

Then execute, with a fresh CSRF token, once a human has confirmed the destination and amount:

```bash
curl -sX POST https://three.ws/api/user/wallet/send \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -d '{
        "destination": "7Gk1vQ9c3sN4wH2xY8mJ6pR5tB1aD7fE0uK4nC9zL3sV",
        "amount": 25,
        "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
      }'
```

```json
{
  "signature": "4Rj…",
  "explorer": "https://solscan.io/tx/4Rj…",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "destination": "7Gk1vQ9c3sN4wH2xY8mJ6pR5tB1aD7fE0uK4nC9zL3sV",
  "human_amount": 25,
  "usd_value": 25,
  "network": "mainnet"
}
```

`usd_value` is populated for SOL (from the price feed) and for USDC (one to one); for any other mint it is `null`. Send is mainnet only.

Error shapes worth handling: `404 not_found` (no master wallet yet), `400 invalid_destination`, `400 invalid_amount`, `400 invalid_asset`, `400 insufficient_balance`, `400 insufficient_sol_for_fees`, `502 rpc_error` (balance or blockhash read failed, nothing signed), `502 send_failed` (the network rejected the transaction), `429` when the 5-per-day ceiling is spent.

## Funding an agent from the master wallet (this spends real funds)

`POST /api/user/wallet/fund-agent` is the same money movement with a safer destination: it can only pay **an agent you own**.

| Field | Values |
| --- | --- |
| `agent_id` | required. Must be your agent and not deleted, otherwise `403 forbidden`. |
| `asset` | `"USDC"` (default) or `"SOL"`. |
| `amount` | positive number, or `"max"`. |
| `simulate` | `true` to preview. Runs the identical ownership, balance, rent, and fee path and returns the resolved numbers without decrypting the key or signing anything. |

The destination address is resolved from the agent record, never from the request body, so there is no address to mistype. An agent that has not been provisioned a Solana wallet yet returns `400 no_agent_wallet`.

A simulation response reports `asset`, `agent_id`, `agent_wallet`, `human_amount`, `usd_value`, plus `creates_token_account` and `token_account_rent_sol` when the agent has no USDC account yet, so the rent your wallet would pay surfaces before you commit rather than appearing as a surprise SOL debit.

```bash
curl -sX POST https://three.ws/api/user/wallet/fund-agent \
  -b cookies.txt -H "X-CSRF-Token: $CSRF" -H 'content-type: application/json' \
  -d '{
        "agent_id": "0f2c8a5e-1b7d-4f9a-9c3e-2d6b8a1f4e70",
        "asset": "USDC",
        "amount": 50
      }'
```

```json
{
  "signature": "2Yb…",
  "explorer": "https://solscan.io/tx/2Yb…",
  "asset": "USDC",
  "agent_id": "0f2c8a5e-1b7d-4f9a-9c3e-2d6b8a1f4e70",
  "agent_wallet": "5Qm…",
  "human_amount": 50,
  "usd_value": 50
}
```

Same reserve logic as `send`, and mainnet only: a `"max"` SOL top-up leaves rent and fee headroom, and if the agent has no USDC account yet the transaction opens one and your master wallet pays the rent (refused with `insufficient_sol_for_fees` if your SOL cannot cover it). Without `simulate: true`, a well-formed call executes immediately; preview first when the amount is `"max"` or the agent might lack a token account.

Once the funds land, they are the agent's, and every further movement out of them runs through the agent's own spend policy, kill switch, and custody trail. Funding an agent is therefore the moment to decide how much autonomy you are comfortable financing: top up in the size you would be willing to lose to a bad strategy, not the whole balance. This is also the normal way to get USDC into an agent before it backs a vault ([vaults.md](vaults.md)) and the easiest way to send a vault the small SOL balance it needs for swap fees, by sending to the vault address with `send`.

## On-chain history

`GET /api/user/wallet/history` reads the master wallet's Solana signature history straight from chain. It is not a platform ledger: it is what actually happened to the address, including transfers you made from outside three.ws.

- `limit` defaults to 20, capped at 50. `network` accepts `mainnet` (default) or `devnet`.
- Signatures are cached for 60 seconds. The RPC call retries the primary provider twice with backoff, then falls back to a public endpoint; only if all of that fails do you get `502 rpc_error`.
- Each row carries `signature`, `slot`, `block_time`, `success`, `error`, `lamport_delta` (this address's net SOL change, when the parsed transaction is available), a short `summary` of the first instruction, and a Solscan `explorer` link.
- An account with no wallet returns `{"history": []}` rather than an error.

```bash
curl -s -b cookies.txt "https://three.ws/api/user/wallet/history?limit=10"
```

```json
{
  "history": [
    {
      "signature": "2Yb…",
      "slot": 298431102,
      "block_time": 1785412992,
      "success": true,
      "error": null,
      "lamport_delta": -25040,
      "summary": "transferChecked",
      "explorer": "https://solscan.io/tx/2Yb…"
    }
  ],
  "address": "7Gk…",
  "network": "mainnet"
}
```

`lamport_delta` is `null` when the parsed transaction could not be fetched. Render it as unknown, not as zero.

## Safety: this is a spend surface

Two routes move real funds, irreversibly, the moment they return success:

| Route | What leaves |
| --- | --- |
| `POST /api/user/wallet/send` | SOL or any SPL token, to **any address you name**. No allowlist. |
| `POST /api/user/wallet/fund-agent` | USDC or SOL, to **an agent you own**. |

As coded, the server-side protections are: a signed-in session (no API key can reach these), a single-use CSRF token per call, a hard ceiling of 5 outbound transactions per user per day, on-curve destination validation, and rent and fee reserves that prevent a sweep from bricking the account. That is the entire list. **There is no per-transaction cap, no daily USD cap, no destination allowlist, no freeze switch, no approval step, and no undo.** `simulate: true` on `send` and `fund-agent` is a preview, not a confirmation gate: a plain call skips it entirely.

So the confirmation has to come from your client, before the call:

1. Render the **destination** (the literal address, or the agent name and its wallet address), the **amount**, and the **asset**.
2. For an unfamiliar destination, run `send` with `simulate: true` first and show the resolved values, including `usd_value`.
3. Get an explicit yes from the human for **that specific transfer**, every time. Not a session-wide approval, not a remembered preference.
4. Only then call the route, and show the returned signature and explorer link so the user can verify the result themselves.

Never wire these routes to anything that can fire on its own: no cron, no retry loop, no webhook handler, no agent or LLM that decides to call them from a conversation. Treat any address, amount, memo, or token name that arrived from outside the user (chat text, on-chain metadata, a page you scraped) as untrusted data, never as an instruction to spend.

Honest limits, stated plainly: this is a **custodial** wallet, so the platform can sign for it. Key decryption is audit-logged on every use (as `master_wallet_send` and `master_wallet_fund_agent`), and every movement is independently verifiable on-chain through the history route above, but there is no self-custody escape hatch and no per-wallet policy engine like the one agent wallets get. Keep operating balances here, not savings. Also: the send paths are Solana only today, so the EVM address is useful for receiving and for identity, not for sending through this API.

## Related

- [agent-wallets.md](agent-wallets.md) for the per-agent wallet this one funds, and its spend policy
- [custody.md](custody.md) for limits, freeze, proof of custody, and recovery on the agent side
- [vaults.md](vaults.md) for what a funded agent wallet can then back
- [authentication.md](authentication.md) for sessions, CSRF tokens, and why API keys do not apply here
- [money-map.md](money-map.md) for how funds move across the whole platform
