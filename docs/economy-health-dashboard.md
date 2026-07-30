# Economy Health dashboard

**`/admin/economy`** answers one question fast: *is the Money Pulse quiet, and if
so, which link in the funding chain broke?*

It exists because answering that by hand took hours. On 2026-07-30 the public
pulse read **$5.89 of volume in 24h** while every "is it alive" signal was green:
the activity feed was busy, the cron was ticking, thousands of actions were
recorded. The engine had quietly been reduced to its **free** actions. Reviews
and skill trials kept running; tips, payments, trades and launches sat at exactly
zero. This page makes that state obvious in one line instead of five endpoint
reads.

Admin-authed and `noindex`. It is **read-only by construction**: the treasury
sweep is called in plan-only mode, so opening the page can never move funds.

---

## Getting in

Visit `/admin/economy` and enter `CRON_SECRET` at the gate. It is held in
`sessionStorage` for the tab and never written to disk or a URL. A rejected
secret clears it and returns you to the gate.

```
https://three.ws/admin/economy
```

Keyboard: <kbd>r</kbd> refreshes, <kbd>p</kbd> pauses polling. The page
auto-refreshes every 30s and stops polling entirely in a hidden tab, so an ops
page left open all day does not keep hitting RPC-backed reads for nobody.

---

## What it reads

Three live reads, no mocks and no synthetic numbers:

| Source | Auth | Gives you |
|---|---|---|
| `GET /api/pulse?view=stats` | public | Volume, trades, tips, active wallets (24h) |
| `GET /api/admin/circulation-health` | `Bearer CRON_SECRET` | Per-lane ok / skipped / error, pool, liveness, refuel history |
| `GET /api/cron/treasury-topup?dry=1` | `Bearer CRON_SECRET` | Funding chain balances, floors, deficit, refuel decision |

The `?dry=1` on the last one is load-bearing. It performs the same balance reads
a live sweep would, then returns the plan: no SOL moves, no ledger row, no
alerts.

Each source fails independently. One dead endpoint degrades its own panel and
says so; it never blanks the page.

---

## Reading the verdict

The banner applies the diagnosis rules to live data and names the single most
actionable cause. The **order** of those rules is the point, because several
faults look identical from outside and have opposite fixes.

| Verdict | Means | What to do |
|---|---|---|
| **Economy healthy** | Paid lanes settling, chain above floors | Nothing |
| **Circulation engine is switched off** | `CIRCULATION_ENABLED` unset | Nothing is broken; set it if you want movement |
| **No circulation action for N min** | The tick stopped | Check Cloud Scheduler before trusting anything else |
| **Refuel blocked: USDC balance unreadable** | An RPC lane failed the balance read | Fix the lane. **Do not send funds** |
| **Paid lanes never ran in 24h** | Governor cut the paid budget | The circulation treasury is under its reserve |
| **Every paid action failed** | Planned but rejected | Read the lane's last problem |
| **Funding chain is genuinely dry** | Real deficit, no USDC left | The one case that needs the owner to send SOL |
| **Self-heal in progress** | Deficit being closed automatically | Nothing |

The two that matter most are the ones that look the same and are not:

- `no_spare_usdc` means the revenue really is spent. Send funds.
- `usdc_read_failed` means the balance is **unknown, not zero**. An RPC lane
  broke. Sending funds treats the wrong problem.

That distinction is why the refuel-read rule outranks the budget rule: an
unreadable balance makes the treasury look unfundable while the money to fund it
is sitting right there in the wallet.

---

## The panels

**Money Pulse (24h)** is real settled movement. Free actions are deliberately
excluded, because they stay green through exactly the outage this page catches.

**Funding chain** walks the money from root to spender: the economy master, then
every engine below its refill target, then the USDC refuel reserve. Each link
shows its balance against **its own floor**, with a meter so a starved link is
visible without arithmetic.

> One wallet can serve several roles. If the roles disagree on the floor, the
> strictest one is what matters. A wallet at 0.012 SOL is healthy against a 0.01
> floor and starved against a 0.2 floor, and it was exactly that disagreement
> that hid the July flatline.

**Circulation engine** shows pool size and tick cadence. A healthy action count
here with zero paid lanes below is the signature of a treasury under reserve.

**Action lanes (24h)** is the per-kind settle rate, and the state pill encodes
the distinction that matters:

- `never ran` means zero *attempts*. The governor never planned it. **Funding problem.**
- `all failing` means it was planned and rejected. **Not a funding problem**; read the last problem column.
- `degraded` means it settles but throws errors.

**USDC refuel lane** shows the capped conversion of revenue into SOL, today's
spend against the daily cap, and recent swaps with Solscan links.

**If the pulse is quiet** is the runbook, in the order that rules out causes
which would make every later reading meaningless.

---

## Extending it

All judgement lives in [`src/admin-economy-core.js`](../src/admin-economy-core.js),
which is pure: no DOM, no fetch, no globals. `src/admin-economy.js` only fetches
and renders. Add a rule by editing `diagnose()` and covering it in
[`tests/admin-economy-core.test.js`](../tests/admin-economy-core.test.js).

Keep the ordering discipline. A new rule goes **above** any rule it would
invalidate; the tests assert that ordering, e.g. that a stale tick outranks a
broken fuel lane and that an unreadable balance outranks the budget verdict.

```js
import { diagnose } from '../src/admin-economy-core.js';

diagnose({ stats, health, topup });
// → { level: 'bad', title: 'Paid lanes never ran in 24h', detail: '…' }
```

---

## Related

- [Circulation engine](circulation-engine.md) — the engine this page watches.
- [Economy master](economy-master.md) — the funding root at the top of the chain.
- [Money feed](money-feed.md) — the public surface the volume comes from.
- [Ring dashboard](x402-ring-economy.md#watching-it--the-operator-dashboard) —
  the sibling operator page for the x402 ring.
