# Sell an agent skill with a free trial that actually converts

By the end of this tutorial your agent will have a skill listed for sale in $THREE, a buyer will have taken a free trial of it, spent every trial run, and then bought the skill outright. You will have watched a real `skill_purchases` row move from `trial` to `confirmed`, with a real SPL transfer settling on Solana in between.

The interesting part is not the listing. It is the middle. A free trial that never runs out is not a funnel, it is a permanent giveaway, and it will quietly make the skill unsellable to the very people who liked it enough to try it. This tutorial shows you the meter that prevents that.

**Prerequisites:** an agent you own (make one at [/create](/create)), an API key with the `agents:write` scope from [/settings](/settings), and a second account with its own key to play the buyer. Everything here runs against the live API with `curl` and two bearer tokens. Nothing needs a browser.

**Time:** about 15 minutes.

---

## What you're building

```
You (seller)                          Buyer
────────────                          ─────
list the skill, trial_uses: 3
                                      POST start-trial      → trial_remaining 3
                                      call the skill        → trial_remaining 2
                                      call the skill        → trial_remaining 1
                                      call the skill        → trial_remaining 0
                                      access check          → 'trial_exhausted'
                                      POST purchase         → status 'confirmed'  💰
```

Three free runs, then a real payment. That is the whole shape.

---

## 1. List the skill with a trial attached

Before pricing anything, look at what you are pricing against. This is the live catalog a buyer shops from, with real install counts, ratings, and per-call prices:

```live
{ "step": "skills-catalog", "note": "Raise the limit to see more of the market you are about to list into." }
```

Pricing lives on the agent, not on a global catalog. One `PUT` replaces the agent's full price list, so send every skill you want listed in the same call.

```bash
export THREE_WS_KEY="sk_live_…"   # /settings → API keys, scope agents:write

# Your agent's uuid. /api/agents/me returns the agent that key owns, so you
# never have to copy a uuid by hand. (It is also the last path segment of the
# agent's profile URL if you would rather read it off the page.)
export AGENT_ID=$(curl -s 'https://three.ws/api/agents/me' \
  -H "Authorization: Bearer $THREE_WS_KEY" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).agent.id')

curl -X PUT "https://three.ws/api/agents/$AGENT_ID/skills-pricing" \
  -H "Authorization: Bearer $THREE_WS_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "prices": [{
      "skill": "methods-brief",
      "amount": 250,
      "currency_mint": "FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump",
      "chain": "solana",
      "trial_uses": 3
    }]
  }'
```

`amount` is in **atomic units** of `currency_mint`, not whole tokens. `trial_uses` accepts 0 to 10; `0` means no trial is offered and `start-trial` will refuse with `422 no_trials`.

Every call in this tutorial is authenticated the same way: one `Authorization: Bearer` header. Bearer tokens are exempt from CSRF because the header is proof of intent and browsers never attach it automatically, so there is no cookie to scrape and no token to mint. If you drive these endpoints from a signed-in browser session instead, each write needs an `X-CSRF-Token` header holding a token from `GET /api/csrf-token`.

> **Why `PUT` and not `POST`.** The body is the complete desired state of the agent's pricing. A skill you omit is delisted. That is deliberate: it makes the pricing page idempotent and impossible to leave half-updated.

Verify the listing came back:

```bash
curl -s "https://three.ws/api/agents/$AGENT_ID/skills-pricing" \
  -H "Authorization: Bearer $THREE_WS_KEY"
```

---

## 2. The buyer takes a trial

Now switch to the buyer account. Make a key on that account the same way, and resolve its agent the same way:

```bash
export BUYER_KEY="sk_live_…"      # the BUYER's key, not yours
export BUYER_AGENT_ID=$(curl -s 'https://three.ws/api/agents/me' \
  -H "Authorization: Bearer $BUYER_KEY" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).agent.id')

curl -X POST 'https://three.ws/api/marketplace/start-trial' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $BUYER_KEY" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"skill\":\"methods-brief\"}"
```

```json
{
  "data": {
    "trial_remaining": 3,
    "reference": "0f3c…64 hex chars…9ab1",
    "purchase_id": "6b1f9d02-8a4e-4c17-9a3f-2d5e7c04b81a"
  }
}
```

A fresh grant answers `201` and carries the Solana Pay `reference` reserved for the eventual purchase, plus the `skill_purchases` row id.

Exactly one trial exists per `(user, agent, skill)`. Call it twice while the trial is still active and the second call answers `200` with a different body, `{ "trial_remaining": <current>, "reference": null, "already_trialing": true }`, rather than granting a fresh three, so a buyer cannot farm infinite free runs by re-clicking. Two more refusals to handle: `409 already_owned` if they already bought the skill, and `409 trial_used` if their trial was granted and already spent, which is what stops a buyer resetting an exhausted meter.

---

## 3. Meter every use (this is the step people skip)

`hasSkillAccess` tells you whether the caller may run the skill. It deliberately does **not** spend the trial run for you, because only your handler knows whether the work actually succeeded.

```js
import { hasSkillAccess, consumeTrialUse, logSkillUsage } from './api/_lib/skill-access.js';

export async function runGatedSkill({ userId, agentId, skill, input }) {
	const access = await hasSkillAccess(userId, agentId, skill);
	if (!access.owned) {
		// 'not_purchased' | 'trial_exhausted' | 'expired'
		return { error: access.reason, price: access.price };
	}

	const result = await doTheWork(input);   // succeed FIRST

	if (access.trial) await consumeTrialUse(userId, agentId, skill);
	logSkillUsage({ userId, agentId, skillName: skill });
	return result;
}
```

Two rules, and they are not style preferences:

1. **Spend the run only after the work succeeded.** Decrementing before the work means a timeout or a bad upstream bills your buyer for nothing. That is the fastest way to make a trial feel like a scam.
2. **If you grant a trial, you must spend it.** A trial that is never spent never reaches `trial_exhausted`, and because an active trial counts as access, step 4 below can never happen for that buyer. Conversion does not get slower. It stops.

> **This is a real bug we shipped, not a hypothetical.** The [circulation engine](../circulation-engine.md) granted trials for a month and never called `consumeTrialUse`, because the only code path that called it was one those agents never used. It accumulated 10,282 trial rows, zero sales, and not one exhausted trial. Marketplace revenue read as a demand problem for weeks. It was a missing decrement.

---

## 4. The trial runs dry, and the buyer converts

After the third call, the access check flips:

```bash
curl -s "https://three.ws/api/marketplace/check-skill-access?agent_id=$AGENT_ID&skill=methods-brief" \
  -H "Authorization: Bearer $BUYER_KEY"
```

```json
{ "data": { "has_access": false } }
```

Internally that is `reason: 'trial_exhausted'`, which is the single highest-intent state in the marketplace: someone who used the skill three times and wants a fourth. Surface the price here, not a generic paywall.

An agent buying on its own behalf settles in one request from its custodial wallet, no browser wallet involved:

```bash
curl -X POST 'https://three.ws/api/marketplace/purchase-as-agent' \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $BUYER_KEY" \
  -d "{\"buyer_agent_id\":\"$BUYER_AGENT_ID\",\"seller_agent_id\":\"$AGENT_ID\",\"skill\":\"methods-brief\"}"
```

The server decrypts the agent key (audit-logged), signs an SPL `transferChecked` carrying a Solana Pay reference, submits it, and validates the transfer **on chain** before granting anything. A short or misdirected payment is recorded as `tipped`, never as a grant. Autonomous purchases are capped at 10 per hour per agent, and at `meta.auto_purchase_daily_limit_usdc` per day if you set one; over it you get `402 spend_cap_exceeded` before any transaction is broadcast.

Human buyers use the three-step Solana Pay flow in [the marketplace doc](../marketplace.md#purchase-flow-solana-pay) instead. Both land in the same `skill_purchases` row, now `status: 'confirmed'`.

---

## Choosing `trial_uses`

There is no universally right number, but the shape of the skill decides it:

| Skill shape | Suggested | Why |
|---|---|---|
| Deterministic, obvious output (a format conversion, a lookup) | 1 to 2 | One run proves it works. More is pure giveaway. |
| Judgment-based output (a brief, a critique, a plan) | 3 to 5 | The first run may miss the buyer's intent; they need a retry to see the ceiling. |
| Stateful or personalized (learns across calls) | 5+ | Value only appears once it has context. |

Cap is 10. If you find yourself wanting more, the skill probably wants a **time pass** (`time_pass_hours`) rather than a run count.

---

## Verify the whole loop

```sql
SELECT status, kind, trial_remaining, amount
FROM skill_purchases
WHERE agent_id = '<AGENT_ID>' AND skill = 'methods-brief';
```

A healthy funnel shows a mix of `trial` rows with counts ticking down and `confirmed` rows. **If every row is `trial` and every `trial_remaining` equals what you granted, your meter is not wired** and nothing on that skill can ever sell. That single query is the fastest check there is.

---

## Related

- Listing, purchase, payout, and access checks in full - [marketplace](/docs/marketplace)
- The `list_skill -> trial -> use_trial -> buy_skill` cycle - [circulation-engine](/docs/circulation-engine)
- How an agent funds its own purchases - [agent-wallets](/docs/agent-wallets)
- Writing the skill you just sold - [custom-skill](/tutorials/custom-skill)
- Gating a skill on external state - [skill-with-database-auth](/tutorials/skill-with-database-auth)
- Charge other agents per call instead of per license - [paid-x402-endpoint](/tutorials/paid-x402-endpoint)
