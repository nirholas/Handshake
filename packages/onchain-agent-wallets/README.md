# onchain-agent-wallets

**Give an AI agent a real Solana wallet without giving it your money.**

An MCP server that hands any agent a spending allowance instead of a private key. The funds stay in an account you own. The agent gets a delegation the SPL Token program caps on-chain, plus guardrails you control, plus the ability to pay x402 APIs out of that allowance. You can revoke it in one instruction, and take the money back without asking the agent.

Nothing here is mocked: real SPL Token delegations, real Solana, real x402 settlement.

**[Read the overview](https://nirholas.github.io/onchain-agent-wallets/)** · [npm](https://www.npmjs.com/package/@three-ws/onchain-agent-wallets)

## The problem this solves

Every "agent wallet" today works the same way: you generate a keypair, you hand it to the agent, and now the agent has everything in it. There is no ceiling, no allowlist, no expiry, and no way to take it back short of racing the agent to move the funds. People solve this by keeping almost nothing in the wallet, which means the agent cannot do anything useful.

An allowance is the older, better answer. The money never moves to the agent. The agent gets permission to spend a slice of it, and the chain enforces the slice.

## How it works

```
   YOU (Phantom, Solflare, Ledger)
    │  owns the vault, holds the money, can revoke or withdraw at any time
    ▼
  ┌──────────────────────────────────────────┐
  │  vault token account                     │   derived from your address:
  │  owner    = you                          │   createWithSeed(you, "oaw1:<agent>")
  │  balance  = 500 USDC                     │
  │  delegate = the agent  ← capped at 100   │   SPL Token enforces this number
  └──────────────────────────────────────────┘
    ▲
    │  may spend up to the cap, and not one unit more
   AGENT (its own keypair, holds only fee SOL)
```

Two independent layers protect you:

1. **On-chain.** The SPL Token program checks every agent-signed transfer against `delegated_amount` and decrements it on each spend. Our code cannot raise it. A single `revoke` sets it to zero. This is a stock token program feature, not a new contract to trust.
2. **Local.** Before this server signs anything it applies your rules: per-transaction cap, rolling 24-hour cap, recipient allowlist, x402 host allowlist, expiry, pause, and a confirm-above-this threshold that forces a human yes.

The agent's own keypair holds nothing but a little SOL for fees. If it leaks, the blast radius is the remaining allowance, and `revoke_agent_wallet` closes it in one transaction.

## Install

```bash
npm install -g @three-ws/onchain-agent-wallets
# or run it ad hoc
npx -y @three-ws/onchain-agent-wallets
```

## Setup

Claude Code:

```bash
claude mcp add onchain-agent-wallets -- npx -y @three-ws/onchain-agent-wallets
```

Cursor, or any MCP client (`mcp.json`):

```json
{
	"mcpServers": {
		"onchain-agent-wallets": {
			"command": "npx",
			"args": ["-y", "@three-ws/onchain-agent-wallets"],
			"env": {
				"OAW_NETWORK": "mainnet"
			}
		}
	}
}
```

No key is required to start. Owner actions come back as an unsigned transaction for your wallet to sign, which `send_signed_transaction` then broadcasts. If you would rather this server sign for you, set `OWNER_SECRET_KEY`.

| Variable | Default | What it does |
| --- | --- | --- |
| `OWNER_SECRET_KEY` | unset | Owner key, base58 or a JSON byte array. Optional: without it, you sign in Phantom. |
| `OAW_NETWORK` | `mainnet` | `mainnet` or `devnet`. State is kept per network. |
| `SOLANA_RPC_URL` | public endpoint | Your own RPC. The public one rate-limits hard. Must be https. |
| `OAW_STATE_DIR` | `~/.onchain-agent-wallets` | Where agent keypairs, guardrails, and the spend ledger live (0600 in a 0700 dir). |
| `REQUIRE_CONFIRM` | `true` | Every value-moving tool refuses to broadcast without `confirm:true`. |

## Quickstart

Give a research agent 100 USDC of spending power, capped at 5 per transaction and 20 per day, and only for one API:

```
create_agent_wallet
  id: "researcher"
  allowance: "100"
  per_tx: "5"
  daily: "20"
  allow_hosts: ["api.example.com"]
  confirm: true

fund_agent_wallet  id: "researcher"  amount: "500"  sol: "0.02"  confirm: true
```

The agent now spends on its own:

```
pay_x402  id: "researcher"  url: "https://api.example.com/premium"  confirm: true
agent_pay id: "researcher"  to: "<address>"  amount: "2.50"  confirm: true
```

And you stay in control:

```
agent_wallet_status  id: "researcher"      # live balances, remaining allowance, warnings
spend_log            id: "researcher"      # every spend AND every refusal, with reasons
set_guardrails       id: "researcher"  paused: true      # instant, free, no transaction
revoke_agent_wallet  id: "researcher"  withdraw: true  confirm: true   # on-chain kill switch
```

A refusal tells you exactly which rule fired:

```json
{
	"ok": false,
	"error": "over_daily",
	"message": "20.5 would exceed the 20 daily cap (18 already spent)",
	"checks": [
		{ "check": "per_tx", "ok": true, "detail": "2.5 is within the 5 per-transaction cap" },
		{ "check": "daily", "ok": false, "detail": "20.5 would exceed the 20 daily cap (18 already spent)" }
	]
}
```

## Tools

**Custody (you sign)**

| Tool | What it does |
| --- | --- |
| `create_agent_wallet` | Generate the agent's keypair, create the vault, delegate a capped allowance, set guardrails. One call. |
| `fund_agent_wallet` | Move tokens into the vault, and SOL to the agent for its fees. |
| `approve_agent_allowance` | Raise, lower, or refill the on-chain ceiling. Replaces the previous allowance. |
| `withdraw_from_vault` | Take funds back. Works with or without a live delegation. |
| `revoke_agent_wallet` | The kill switch. Optionally sweeps the balance home in the same transaction. |
| `send_signed_transaction` | Broadcast a transaction your wallet signed. |

**Guardrails**

| Tool | What it does |
| --- | --- |
| `set_guardrails` | per_tx, daily, allow_recipients, allow_hosts, expires_at, confirm_over, paused. Instant, free, no transaction. |

**Spending (the agent signs)**

| Tool | What it does |
| --- | --- |
| `agent_pay` | Send tokens to a recipient, inside the limits. |
| `pay_x402` | Call an x402 API, paying from the allowance. |

**Visibility**

| Tool | What it does |
| --- | --- |
| `agent_wallet_status` | Live on-chain state, guardrails, 24h and 7d totals, and warnings. |
| `list_agent_wallets` | Every agent, with live balances. |
| `spend_log` | The audit trail, refusals included. |

**Deployment**

| Tool | What it does |
| --- | --- |
| `deploy_agent_onchain` | Mint the agent a Metaplex Agent Registry identity with its payment address in the on-chain attributes. |
| `export_agent_runtime` | The mcp.json and identity card needed to run this agent somewhere else. |

## Guardrails

| Rule | Effect | Enforced by |
| --- | --- | --- |
| allowance | Total the agent may ever spend before a new approval | SPL Token program, on-chain |
| vault balance | The agent cannot spend what is not there | SPL Token program, on-chain |
| `per_tx` | Maximum single spend | this server |
| `daily` | Maximum per rolling 24 hours, computed from the local ledger | this server |
| `allow_recipients` | Only these addresses may receive funds. Empty means unrestricted | this server |
| `allow_hosts` | Only these hosts may be paid over x402. Subdomains inherit. Empty means unrestricted | this server |
| `expires_at` | Every spend refused after this timestamp | this server |
| `confirm_over` | Spends above this need an explicit `confirm:true` | this server |
| `paused` | Everything refused, instantly and for free | this server |

The distinction matters when it goes wrong. If this machine is compromised, the local rules can be bypassed, and the on-chain allowance still cannot. That is why the allowance should be the smallest number that lets the agent work, topped up as needed, rather than the whole balance.

## x402

`pay_x402` probes the endpoint unpaid first, so the price is known before anything moves and the guardrails see the real number. Then it tops the agent up for exactly that amount out of the vault, pays, and leaves the agent empty again.

It refuses to pay:

- on a chain other than Solana (`no_solana_option`)
- on the wrong cluster, for instance a mainnet price from a devnet wallet (`wrong_cluster`)
- in a token the allowance is not denominated in (`asset_mismatch`)
- above `max_price`, a per-call ceiling independent of the standing guardrails (`over_max_price`)

If the endpoint is not charging, the content comes back and nothing is spent.

## What the agent cannot do

- Spend more than the allowance, however it is prompted. The token program decides that, not the model.
- Move the vault, close it, or change its owner. It is not the owner.
- Stop you withdrawing, or stop a revoke.
- Raise its own allowance. Only an owner-signed `approve` does that.
- Touch anything else in your wallet. The vault is a separate account holding only what you put in it.

Proven in [`test/token-delegation.test.mjs`](test/token-delegation.test.mjs), which runs the real SPL Token program in process and asserts that a spend of 61 against a remaining allowance of 60 fails on-chain, with 460 sitting in the vault.

## Rehearse for free on devnet

```bash
OAW_NETWORK=devnet npx -y @three-ws/onchain-agent-wallets
```

State is kept per network, so a devnet rehearsal never touches your mainnet agents.

## Use it as a library

The custody model is plain `@solana/web3.js` and `@solana/spl-token`, usable without MCP:

```js
import { createVaultInstructions, readVault, spendableUnits } from '@three-ws/onchain-agent-wallets/lib/vault';

const { vault, instructions } = await createVaultInstructions({
	connection,
	owner: ownerPubkey,
	agentId: 'researcher',
	mint: usdcMint,
	delegate: agentPubkey,
	allowance: 100_000_000n, // 100 USDC
	decimals: 6,
});
// sign `instructions` with the owner, then:
const state = await readVault({ connection, vault });
console.log(spendableUnits(state)); // what the agent may spend right now
```

`@three-ws/onchain-agent-wallets/lib/policy` exports the guardrail engine on its own, if you want the same rules in a different runtime.

## Tests

```bash
npm test
```

Runs the guardrail unit tests, the x402 selection tests, and the delegation integration test against the real SPL Token program.

## Related

- [`@three-ws/metaplex-agent-mcp`](https://github.com/nirholas/metaplex-agent-mcp) mints agent identities into the Metaplex Agent Registry. `deploy_agent_onchain` uses it as a library, and its `prepare_agent_mint` is the browser-wallet path for minting.
- [three.ws](https://three.ws) is where these agents get faces, avatars, and a home.

## License

See [LICENSE](LICENSE).
