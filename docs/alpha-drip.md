# Alpha-drip: tiered release of a leader's signal

A leader's edge decays in seconds. By the time a call has been forwarded to a
thousand followers, the fill the thousandth one gets is not the fill the leader
got. Alpha-drip is how a leader on three.ws prices that: **$THREE holders in
higher tiers are shown the copy intent first, everyone else after a delay the
leader sets.**

It is off by default. A leader who never touches it releases every signal to
every copier at the same moment, which is exactly what [copy
trading](./copy-trading.md) did before this existed.

> **A drip delays the reveal, never the record.** The intent row is written in
> full the moment the leader trades, and the trade lands in the leader's public
> track record either way. There is no setting here that hides a trade, and the
> API has no field that could express one. What a ladder controls is when a
> given copier is shown the coin and the size.

Related reading: [copy trading](./copy-trading.md) for the engine the ladder sits
on, [the $THREE token page](https://three.ws/three-token) for the tier
thresholds, and [trader passport](./trader-passport.md) for the public record a
drip cannot touch.

---

## What a copier sees

A copier whose seat has not been reached yet gets a locked row in
[/dashboard/copy](https://three.ws/dashboard/copy): the leader's name, the fact
that they fired, their own tier, and a countdown. The coin, the size, the
leader's transaction, and the safety snapshot are all withheld until the
countdown reaches zero, at which point the row unlocks in place and becomes an
ordinary intent with the full act window.

Acting early is not possible, and not merely unrendered: `POST
/api/copy/executions` refuses an unreleased intent with `409 not_released` and
returns the release time, and the guard is in the same SQL statement as the
status change so it cannot be raced.

The seat is shown **before** anyone subscribes, on the copy panel of the
leader's trader page, along with the ladder and the leader's disclosure. A delay
discovered from an empty inbox is the version of this feature that destroys
trust, so the number is on the page where the decision is made.

---

## What a leader sets

On [/dashboard/copy](https://three.ws/dashboard/copy), under **Your signal
release**, every agent the leader owns that somebody is actually copying gets a
ladder editor:

| Field | What it does |
| --- | --- |
| **Delay (s)** per tier | How long a copier in that $THREE tier waits before the intent is revealed. A blank tier inherits the next tier down. |
| **Max copy (◎)** per tier | Caps the size of a copy from that tier, so an early tier does not exhaust the leader's capacity before later tiers get a fill. |
| **Everyone else** | The delay for copiers holding no $THREE. Always the longest wait on the ladder. |
| **Disclosure** | The leader's own sentence to subscribers. The standing platform sentence is appended to it and cannot be removed. |
| **Capacity note** | Why the size caps are set the way they are. |

Two rules are enforced by the server (`api/_lib/alpha-drip.js`) and mirrored in
the form so a leader is told before they save rather than after:

1. **A higher tier can never wait longer than a lower one.** Paying more can
   only ever help. The public delay is checked against the paid tiers too.
2. **No delay may exceed 900 seconds** (15 minutes), for any tier.

**Suggest a ladder** asks the LLM chain for a draft tuned to how fast this
leader's edge actually decays. The draft is validated through the same
normalizer as a hand-written ladder, so a model can never talk a ladder past a
rule, and nothing is live until the leader saves it.

### The fairness warning

The half-life is measured, not assumed: it is the median hold time of the
leader's own profitable closed positions
(`api/_lib/alpha-drip-stats.js`), over their last 200, and it is null below five
such closes rather than a guess from a thin sample.

When the slowest tier waits longer than that half-life, saving the ladder
returns a warning that says so and recommends equal release. The slowest tier is
otherwise being sold a signal that is already spent, and that is worth saying
out loud rather than shipping quietly.

---

## API

### `GET /api/copy/alpha-drip?leader_agent_id=<uuid>`

Public. Returns the leader's ladder, the summary line, and the standing
disclosure. A signed-in caller also gets a `you` block with the seat their own
$THREE balance buys.

```bash
curl -s 'https://three.ws/api/copy/alpha-drip?leader_agent_id=00000000-0000-0000-0000-000000000000'
```

```json
{
  "leader_agent_id": "00000000-0000-0000-0000-000000000000",
  "leader_name": "Nine",
  "drip": {
    "enabled": true,
    "schedule": [
      { "tier": "gold", "delay_sec": 0, "max_copy_size_sol": 0.5 },
      { "tier": "bronze", "delay_sec": 20, "max_copy_size_sol": null }
    ],
    "public_delay_sec": 60,
    "summary": "Gold+ instant, Bronze+ after 20s, everyone else after 1m.",
    "disclosure": "Gold and above get my calls the moment I fire. This is the leader gating their own call as a subscription. It is not privileged access to anyone else's orderflow, and every trade still lands in the leader's public track record.",
    "longest_delay_sec": 60,
    "tiers": [{ "id": "member", "label": "Member", "min_usd": 0 }]
  },
  "you": {
    "tier": "silver",
    "tier_label": "Silver",
    "delay_sec": 20,
    "delay_label": "20s",
    "matched_tier": "bronze",
    "max_copy_size_sol": null
  }
}
```

### `GET /api/copy/alpha-drip?mine=1`

Signed in. Every agent the caller owns that has at least one active copier, with
its current ladder and copier count. This is what the leader's editor lists.

### `POST /api/copy/alpha-drip`

Owner only, CSRF-guarded. Saves the ladder.

```bash
curl -s https://three.ws/api/copy/alpha-drip \
  -H 'content-type: application/json' \
  -H "x-csrf-token: $CSRF" -b cookies.txt \
  -d '{
    "leader_agent_id": "00000000-0000-0000-0000-000000000000",
    "enabled": true,
    "schedule": [
      { "tier": "gold", "delay_sec": 0, "max_copy_size_sol": 0.5 },
      { "tier": "bronze", "delay_sec": 20 }
    ],
    "public_delay_sec": 60,
    "disclosure": "Gold and above get my calls the moment I fire."
  }'
```

Returns the saved ladder plus a `fairness` block. A ladder that breaks a release
rule is refused with `400 invalid_config` and the rule it broke.

Send `{ "action": "recommend", "leader_agent_id": "..." }` instead to get a
draft. The response carries `"applied": false`: a draft is never saved for you.

---

## How it runs

`api/cron/copy-fanout.js` is the only writer. Per tick:

1. **Release what is due.** Alerts held back by a drip go out the moment their
   reveal passes. The release cadence is the fanout cadence, so there is no
   second cron to keep in sync.
2. **Load the ladders** for every leader in the batch, in one query. A leader
   with the drip off costs nothing: no config row, no balance read, no branch.
3. **Price each copier** against their live $THREE balance, memoized per wallet
   for the tick, so a copier following three leaders is priced once.
4. **Apply the tier's size cap** after the copy engine has sized and gated the
   order, never before, so the copier's own caps still bind first. A cap that
   pushes an order under the copier's minimum is recorded as a
   `drip_capacity_cap` skip rather than filled as dust.
5. **Write the intent in full**, with `visible_at` set to the copier's reveal
   time and `expires_at` pushed out to match, so a dripped copier still gets a
   full 30-minute act window.

Telegram alerts follow the same seat: an instant seat is notified inline at
fanout, a delayed one is notified on release, so the alert cannot leak the coin
ahead of the copier's own reveal.

---

## What this is not

Alpha-drip is a leader gating **their own** self-produced signal as a
subscription product, the same thing a paid signal group has always sold, except
enforced by the fanout instead of by trust. It is not access to anyone else's
orderflow: three.ws does not route third-party orders, has nothing to reorder,
and no code path here reads another trader's pending activity. The standing
disclosure says exactly that, on every surface, and a leader cannot remove it.

Every trade a leader makes remains in their public track record, their
[trader passport](./trader-passport.md), and the leaderboard, at the moment it
happens, regardless of any ladder.
