# Agent tokens

An agent on three.ws can become an economic object: a Solana coin whose identity
belongs to the agent rather than to whoever happened to fill in a launch form.
This page covers the whole lane, from configuring a coin that does not exist yet,
through rehearsing its launch for free, to the one command that launches it for
real.

Solana is the home chain. Agent tokens are pump.fun bonding-curve launches on
Solana; there is no EVM leg.

## The three objects

| Object | Where it lives | What it means |
| --- | --- | --- |
| **Token plan** | `agent_token_plans`, one row per (agent, network) | The coin this agent is configured to become. Saved, editable, costs nothing, mints nothing. |
| **Launch record** | `pump_agent_mints` | A coin this agent actually launched through three.ws. Powers [/launches](https://three.ws/launches), the agent profile's launch history, and `GET /api/v1/pump/launches`. |
| **Live market** | pump.fun / the bonding curve | Price, market cap and graduation progress, rendered on the agent's pages from the mint in the launch record. |

A plan becomes a launch record the moment a launch confirms: the plan flips to
`launched`, records its mint, and stops being editable. The configuration that
minted a coin is a historical fact, so it is never rewritten.

## Configure a coin (the plan)

```
GET    /api/agents/tokens/plan?agent_id=<uuid>&network=mainnet
PUT    /api/agents/tokens/plan
DELETE /api/agents/tokens/plan?agent_id=<uuid>&network=mainnet
```

`GET` is open. It returns a plan whose status is `ready` or `launched` to anyone
(an agent announcing the coin it is about to become is public), and returns a
`draft` only to the agent's owner. `PUT` and `DELETE` require the owner's
session.

```bash
curl -X PUT https://three.ws/api/agents/tokens/plan \
  -H 'content-type: application/json' \
  --cookie "$SESSION" \
  -d '{
    "agent_id": "8f14e45f-ceea-467a-9f27-1f0f8b1cba1c",
    "network": "mainnet",
    "name": "Ada Ledger",
    "symbol": "ADA",
    "description": "The ledger of a working agent.",
    "image_url": "https://three.ws/img/ada.png",
    "coin_type": "agent",
    "quote_currency": "sol",
    "buyback_bps": 2500,
    "sol_buy_in": 0.5
  }'
```

**Response**

```json
{
  "ok": true,
  "plan": {
    "network": "mainnet",
    "name": "Ada Ledger",
    "symbol": "ADA",
    "coin_type": "agent",
    "quote_currency": "sol",
    "buyback_bps": 2500,
    "sol_buy_in": 0.5,
    "status": "ready",
    "mint": null,
    "readiness": { "ready": true, "blockers": [], "warnings": [] },
    "cost_estimate": {
      "fixed_total_sol": 0.009105,
      "dev_buy_sol": 0.5,
      "protocol_fee_sol": 0.005,
      "total_sol": 0.514105,
      "dev_buy_usdc": 0
    }
  },
  "is_owner": true
}
```

### Fields

| Field | Meaning |
| --- | --- |
| `network` | `mainnet` or `devnet`. An agent can hold one plan on each. |
| `name`, `symbol` | The coin's on-chain identity. Symbol is upper-cased and must be 2 to 10 letters or digits. |
| `description`, `image_url`, `website`, `twitter`, `telegram` | Metadata pinned with the coin at launch. |
| `coin_type` | `agent` binds the on-chain pump agent that runs buybacks; `regular` is a plain bonding-curve coin; `mayhem` is pump.fun mayhem mode. |
| `quote_currency` | `sol` or `usdc`. A USDC-paired curve lets a USDC-funded buyback swap natively. |
| `buyback_bps` | Share of what the agent earns that buys its own coin back. Only meaningful on `coin_type: "agent"`; saved as 0 on the others, because the other types create no on-chain agent to enforce it. |
| `sol_buy_in` / `usdc_buy_in` | The dev buy, denominated in the quote currency. The inactive one is stored as 0 so flipping the pairing can never spend a stale amount. |

`status` is derived on every save: `ready` when the plan passes the readiness
check, `draft` when it does not, `launched` once a coin minted from it.
`readiness.blockers` are the reasons a launch would fail; `readiness.warnings`
are things that will work but that an owner probably did not intend (no artwork,
a 0% buyback on an agent coin, no dev buy).

## Rehearse the launch for free

```
POST /api/agents/tokens/plan-dry-run
```

This is the proof path, and it costs nothing. It builds the **same** pump.fun
create instructions the real launch builds, from the **same** saved plan,
compiles them into a real transaction against a real blockhash, and asks the
cluster to simulate it. It never signs and never broadcasts.

```bash
curl -X POST https://three.ws/api/agents/tokens/plan-dry-run \
  -H 'content-type: application/json' \
  --cookie "$SESSION" \
  -d '{"agent_id": "8f14e45f-ceea-467a-9f27-1f0f8b1cba1c", "network": "devnet"}'
```

**Response**

```json
{
  "ok": true,
  "broadcast": false,
  "network": "devnet",
  "result": {
    "verdict": "would_succeed",
    "compiled": true,
    "tx_bytes": 918,
    "instruction_count": 3,
    "mint_preview": "9wA…",
    "metadata_uri": "https://cdn.three.ws/tm/1f0f8b1cba1c9f27.json",
    "metadata_pinned": false,
    "simulation": { "error": null, "units_consumed": 121843, "logs": ["…"] }
  }
}
```

### Verdicts

| Verdict | Meaning |
| --- | --- |
| `would_succeed` | The transaction compiled and the cluster executed it end to end. |
| `funding_required` | The transaction is valid; the launch wallet cannot cover it on this cluster yet. A funding fact, not a broken plan. |
| `would_fail` | The cluster rejected it. `simulation.logs` says why. |
| `compile_failed` | The transaction could not be assembled at all, so a real launch would have died at signing time with money already committed. Usually a name plus metadata URI that overflows Solana's 1232-byte packet limit. |
| `rpc_unavailable` | The transaction built, but the RPC endpoint did not answer the simulation. |

`network` defaults to `devnet`, and the metadata is **not** pinned during a
rehearsal: the URI is the deterministic content address the real launch would
carry, computed without writing anything, so the transaction is measured at its
true size. The last verdict is stored on the plan as `last_dry_run` and rendered
on the agent's profile.

## Launch it for real

Launching is the only step that spends. It is deliberately separate from
everything above, and it is never automatic.

**From the owner's own wallet** (the owner signs in their browser):

```
POST /api/agents/tokens/launch-prep     { "agent_id": "…", "provider": "pumpfun",
                                          "cluster": "mainnet", "wallet_address": "…",
                                          "use_plan": true }
POST /api/agents/tokens/launch-confirm  { "prep_id": "…", "tx_signature": "…",
                                          "wallet_address": "…" }
```

`use_plan: true` sources the coin identity from the saved plan, so what launches
is exactly what was rehearsed. Any field supplied in the body still wins, which
lets a launch screen prefill from the plan and let the owner change one thing at
the last moment.

**From the agent's own custodial wallet** (the agent pays and signs, no browser
wallet involved):

```
POST /api/pump/launch-agent  { "agent_id": "…", "name": "…", "symbol": "…",
                               "uri": "…", "network": "mainnet",
                               "coin_type": "agent", "buyback_bps": 2500 }
```

This is the path that supports USDC-paired curves and binds the on-chain pump
agent for buybacks. See [the pump.fun launcher](./pump-launcher.md).

Both paths write a `pump_agent_mints` row and call back into the plan to mark it
launched, so a coin appears on [/launches](https://three.ws/launches), in the
agent profile's launch history, and in `GET /api/v1/pump/launches` no matter
which one launched it.

### Activating mainnet

The rehearsal lane runs on devnet by default and mints nothing anywhere. Going
live is one deliberate change: set `network` (or `cluster`) to `mainnet` on the
launch call above, with a funded wallet. Everything else, including the plan and
the metadata, is identical. Nothing in this lane launches on a schedule, on a
cron, or as a side effect of saving a plan.

## On the agent's pages

The profile at `/agents/:id` renders all three objects on one card:

- **No coin, plan saved** → the plan, as `$TICKER` with its mechanics. Owners get
  the designer, the readiness checklist, the cost estimate, and the rehearse
  button; visitors see a ready plan and never see a draft.
- **Coin launched** → the live market chip (price, market cap, graduation
  progress) from `mountCoinStatus`, plus the full launch history from
  `pump_agent_mints`.

The panel is `src/agent-token-plan.js` and is self-contained: mount it on any
surface with an agent id.

## Related

- [The pump.fun launcher](./pump-launcher.md): the launch transaction itself
- [Coin launches](./coin-launches.md): the platform launch directory
- [Platform fee](./pump-platform-fee.md): what three.ws takes on a launch
- [Solana on pump.fun](./solana-pumpfun.md): the on-chain program surface

Note on promotion: `$THREE` is the coin three.ws promotes. Agent tokens are coins
users launch through the platform, rendered from the platform's own launch
records. Listing one is not an endorsement of it.
