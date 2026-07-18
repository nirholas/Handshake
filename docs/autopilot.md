# Coin Autopilot: hands-off buyback and holder rewards

Coin Autopilot is the control cockpit for a coin you launched through three.ws. You set the rules once (when to buy back and burn, when to distribute creator fees to holders, the floors that gate each), flip the switches you want, and the platform's crons run the coin autonomously. Your agent narrates every on-chain move in plain language on a live feed, so the coin does not just run itself, it tells you what it did.

Page: [/autopilot](https://three.ws/autopilot)
API: `GET/POST /api/pump/autopilot`

## Why it exists

A coin launched from an agent is not a static token, it is a small business: creator fees flow in, and something has to decide what to do with them. Left to a human, that decision is a chore that gets skipped. Autopilot turns the two most valuable of those decisions, buying the token back to make supply scarcer and paying accumulated fees out to holders, into rules the platform enforces on a schedule.

The design goal is control without babysitting. You should be able to set a floor ("only buy back once at least 50 USDC of fees have piled up"), pause a coin with one tap, and otherwise never touch it, while still seeing every move it makes narrated by the agent that owns it. That is the difference between an autonomous coin and an abandoned one.

## How it works

Autopilot is a thin, owner-facing policy layer over crons that already run. Every coin you launched has a policy row (`pump_autopilot`) that gates two existing crons:

- `run-buyback` reads your buyback rule and, when the buyback vault clears your floor, spends collected creator fees to buy the token back and burn it. With `buyback_full_swap` on, fees are swapped into the token before the burn; off, the burn is direct.
- `run-distribute-payments` reads your distribute rule and, when the payment vault clears your floor, pushes accumulated fees out to your configured shareholders.

A coin with no policy row keeps the legacy always-on behavior. Writing a row (which the page does the moment you touch a control) lets you tune or pause it. The API reports the effective runtime state either way, with a `configured` flag so the UI can tell an explicit setting from an inherited default.

Thresholds are shown in USDC and stored as atomic units (6 decimal places). The page converts on the way in and out, so you type `50` and the server stores `50000000`.

### The data path

`GET /api/pump/autopilot` is scoped to coins you own (`pump_agent_mints.user_id`). It joins each mint to its agent identity, its live stats (graduation, bonding-curve progress), and its policy row, then rolls up recent autonomous actions from `pump_buyback_runs` and `pump_distribute_runs` and payment totals from `pump_agent_payments`. The response is your coins, their per-coin policy, per-coin totals (burned, distributions, fees in, payment count), and a merged newest-first activity feed.

`POST /api/pump/autopilot` upserts one coin's policy. It is a merge, not a replace: only the fields you send change, so toggling one switch never clobbers your thresholds. The write is validated (zod) and re-scoped to your ownership before it touches the table.

Auth is a session cookie or a bearer token. Every read and write is rate-limited per authenticated IP.

## Walkthrough

1. Launch a coin for one of your agents (from the dashboard). Until you have at least one launched coin, the page shows a designed empty state pointing you to the launcher.
2. Open [/autopilot](https://three.ws/autopilot). Each coin renders as a card with its image, graduation or bonding-curve progress, and lifetime totals.
3. Use the master switch on a card to turn Autopilot on or off for that coin. "Autopilot on" means its rules run; "Paused" means the crons skip it.
4. Set the **Buyback and burn** rule: toggle it on, set a minimum USDC floor, and choose whether fees are swapped into the token before burning or burned directly.
5. Set the **Distribute to holders** rule: toggle it on and set its minimum USDC floor. Enable "Narrate this coin's actions on the live feed" to have the agent speak its moves.
6. Every change autosaves (checkboxes immediately, number fields after a short debounce). A toast confirms "Autopilot updated".
7. Watch the activity feed and the narrator. As fees accumulate past your thresholds, the crons act, and each buyback or distribution appears with its status and a Solscan link to the on-chain transaction.

## Examples

Read your coins and their policy from the command line:

```bash
curl -s https://three.ws/api/pump/autopilot \
  -H 'authorization: Bearer YOUR_TOKEN' | jq '.coins[] | {symbol, policy, totals}'
```

Set a buyback floor of 50 USDC and turn on full-swap-then-burn for one coin:

```bash
curl -s https://three.ws/api/pump/autopilot \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -d '{
    "mint": "YOUR_MINT_ADDRESS",
    "network": "mainnet",
    "buyback_enabled": true,
    "buyback_min_atomics": "50000000",
    "buyback_full_swap": true
  }'
```

Pause a coin entirely without losing its thresholds:

```bash
curl -s https://three.ws/api/pump/autopilot \
  -H 'authorization: Bearer YOUR_TOKEN' \
  -H 'content-type: application/json' \
  -d '{ "mint": "YOUR_MINT_ADDRESS", "network": "mainnet", "enabled": false }'
```

A confirmed buyback narrates as: "Bought back and burned $120 of $YOURCOIN. Supply just got scarcer." A confirmed distribution: "Distributed $80 in creator fees to $YOURCOIN holders." Queued and failed actions narrate their own status, including the error text on a failure.

## Guardrails, states, and limits

- **Ownership scoped.** Every read and write is filtered to coins whose `user_id` is yours. Posting a policy for a mint you do not own returns `404 not_found`.
- **Floors are the safety valve.** A buyback or distribution only fires once the relevant vault clears the USDC floor you set. Set a floor to zero and it acts whenever the vault is non-empty; raise it to batch actions.
- **Merge semantics.** Partial POSTs only change the fields present. A missing policy row reports legacy defaults (everything enabled, zero floors, narrate on) with `configured: false`.
- **Signed out** renders a "Sign in to manage autopilot" state; `GET` returns `401` and the page routes you to the dashboard.
- **Empty state** appears when you own no coins, pointing you to the launcher rather than showing a blank void.
- **Error and retry.** A network or server error renders an inline "Couldn't load" card with a Retry button; a transient poll failure keeps the last good render and retries on the next tick.
- **Live refresh** polls every 20 seconds and only refreshes the activity feed and narrator, never the control inputs you may be editing, so a poll can never overwrite your keystrokes.
- **Atomics are integers.** Thresholds are clamped to non-negative integer atomic strings server-side; a decimal is truncated, a negative or non-numeric value falls back to zero.
- **On-chain actions are the crons', not the page's.** The console never signs a transaction. It only writes policy rows; the buyback and distribute crons are what move funds, on their own schedule, within the vault floors you set.

## Related

- [Custody you can verify](./custody.md) - the spend limits, freeze switch, and audit trail every agent wallet runs under
- [Financial controls](./financial-controls.md) - plain-English spend rules layered on the same enforcement point
- [Oracle](./oracle.md) - the conviction engine and the agent action loop that arms an agent to trade autonomously
- [/dashboard](https://three.ws/dashboard) - launch a coin for an agent, the prerequisite for Autopilot
- [/launches](https://three.ws/launches) - the public feed of coins launched through three.ws
