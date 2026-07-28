# Pump Agent

An example agent manifest that composes all four production pump.fun skills
into one 3D trading agent: swap, coin creation, creator-fee collection, and
token payments. Where [coach-leo](../coach-leo/) shows the smallest possible
agent, this one shows an agent whose entire purpose is a skill stack.

## Files

| File | Role |
|---|---|
| [manifest.json](./manifest.json) | Agent definition (`agent-manifest/0.1`): Mixamo-rigged GLB body, Anthropic brain, browser voice, four pump.fun skills, local memory. |
| [instructions.md](./instructions.md) | System prompt: the agent builds transactions server-side and always confirms amounts, mints, and wallet addresses with the user before building anything. |

## Installed skills

All four resolve to [pump-fun-skills/](../../pump-fun-skills/):

- [`swap`](../../pump-fun-skills/swap/): buy and sell on the bonding curve or AMM.
- [`create-coin`](../../pump-fun-skills/create-coin/): launch a coin with an optional initial buy.
- [`coin-fees`](../../pump-fun-skills/coin-fees/): collect and distribute creator fees.
- [`tokenized-agents`](../../pump-fun-skills/tokenized-agents/): charge users for agent actions with on-chain token payments.

## The transaction model

Per [instructions.md](./instructions.md), every skill call returns a
base64-encoded `VersionedTransaction` built server-side. The agent never holds
keys and never signs: the user's wallet must sign and submit each transaction.
The prompt also forbids assuming defaults for amounts or mints, so every trade
is explicitly confirmed.

## Run it

From the repo root:

```bash
npm run dev
```

Then point any agent host at the manifest:

```html
<agent-3d manifest="/examples/pump-fun-agent/manifest.json"></agent-3d>
```

Ask it to quote a swap or inspect creator fees; it routes each request through
the matching skill's tools (documented in each skill's `SKILL.md`).
