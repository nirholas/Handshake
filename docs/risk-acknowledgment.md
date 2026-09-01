# The real-funds risk acknowledgment

Every feature on three.ws that can move real money is gated behind a one-time,
versioned risk acknowledgment. Before a user's first real-funds action — a
trade, a sniper arm, a withdrawal, a swap, a token launch, an x402 payment, a
fiat onramp — a dialog asks them to read and accept the
[Risk Disclosure](https://three.ws/legal/risk): three.ws is experimental
software, losses can be total, autonomous agents act without asking again, and
they use real funds entirely at their own risk. Decline and the money action
simply doesn't run; everything else on the platform keeps working.

## How it behaves

- **Once per browser.** Acceptance is stored in `localStorage` under
  `threews:risk-ack` as `{ version, acceptedAt, context }`. Every gated surface
  shares the same record — accepting in the trade tab also satisfies the swap
  modal, the launcher, and every other gate.
- **Versioned.** The current disclosure version is `RISK_ACK_VERSION` in
  [`public/risk-ack.js`](../public/risk-ack.js). If the disclosure changes
  materially, bump that constant (and the version line on
  [`public/legal/risk.html`](../public/legal/risk.html)) — every user is then
  re-prompted before their next real-funds action. Stored acceptances with an
  older version no longer count.
- **Recorded server-side.** On accept, the client fires
  `POST /api/legal/risk-ack` ([`api/legal/risk-ack.js`](../api/legal/risk-ack.js)),
  which writes a `risk-ack-accept` row into `audit_log`: user id when signed
  in (null otherwise), disclosure version, the feature context, path, IP, and
  user agent. The handler awaits that write and answers
  `200 { ok: true, recorded }`, where `recorded` says whether the row actually
  landed; a dropped write still answers 200 because the user did accept. It
  imports `RISK_ACK_VERSION` from the client gate and rejects any `version`
  outside `1..RISK_ACK_VERSION` with `400 invalid_version`, so nobody can
  record acceptance of a revision that does not exist yet; an unreadable body
  gets its real cause (`413 payload_too_large`, `415 unsupported_media_type`,
  or `400 bad_request`) instead of a version complaint. The
  `audit-log-cleanup` cron prunes `audit_log` at 365 days but exempts
  `risk-ack-accept` (and `tos-accept`) rows, so acceptance records persist
  indefinitely. The client's call is fire-and-forget (`keepalive`, errors
  swallowed): a failed network call never blocks the user's accepted state.
- **Devnet stays friction-free.** Surfaces that know their network only gate
  when it isn't `devnet`. Simulation modes (e.g. Oracle arm's simulate mode)
  are never gated.
- **Fails closed on "no", degrades gracefully on breakage.** If the user never
  accepts, `ensureRiskAck()` resolves `false` and the caller must abort the
  money action. But the gate machinery itself can never brick a feature:
  `ensureRiskAck()` **never rejects**. If `/risk-ack.js` fails to load (broken
  deploy, blocked request) or the `<dialog>` can't open (unsupported browser),
  the gate degrades to a native `confirm()` carrying the same core
  acknowledgment text — the user is still asked, the feature still works. The
  x402 embed loads the gate lazily for the same reason: a gate failure must
  never take the payment modal down with it. A failed `POST` to the recording
  endpoint never blocks an accepted state. Verified in-browser: blocked module,
  throwing `showModal`, and a 500ing endpoint all leave every feature usable.

## Wiring a new money surface

Any new feature that commits real funds MUST call the gate before executing.
From bundled app code (`src/`):

```js
import { ensureRiskAck } from './shared/risk-ack.js'; // adjust the relative path

async function onConfirm() {
	if (!(await ensureRiskAck({ context: 'my-feature' }))) return; // declined
	// … move real funds …
}
```

From plain `public/` scripts or third-party embeds:

```js
import { ensureRiskAck } from './risk-ack.js'; // resolves on the three.ws origin
```

`context` is a short kebab-case slug of the gated action (`trade`, `snipe`,
`withdraw`, `swap`, `launch`, `x402-pay`, `onramp`, …). It is stored with the
acceptance record so the audit trail shows which feature prompted it. The call
is idempotent — once accepted it resolves `true` instantly, so gating multiple
layers of the same flow costs nothing.

The canonical implementation lives in [`public/risk-ack.js`](../public/risk-ack.js)
(dependency-free, served at `/risk-ack.js`); [`src/shared/risk-ack.js`](../src/shared/risk-ack.js)
is a thin wrapper for bundled code. Pure logic (`parseAckRecord`,
`isAckCurrent`) is covered by [`tests/risk-ack.test.js`](../tests/risk-ack.test.js).

## Currently gated surfaces

| Surface | Entry point | Context |
|---|---|---|
| Agent wallet — trade | `src/agent-wallet-hub/tabs/trade.js` | `trade` |
| Agent wallet — withdraw | `src/agent-wallet-hub/tabs/withdraw.js` | `withdraw` |
| Agent wallet — give | `src/agent-wallet-hub/tabs/give.js` | `give` |
| Agent wallet — arm sniper | `src/agent-wallet-hub/tabs/snipe.js` | `snipe` |
| Agent wallet — arm autopilot | `src/agent-wallet-hub/tabs/autopilot.js` | `autopilot` |
| Agent wallet — x402 pay | `src/agent-wallet-hub/tabs/pay.js` | `x402-pay` |
| Oracle arm (live mode only) | `src/arm.js` | `oracle-arm` |
| Jupiter swap modal | `src/swap-jupiter.js` | `swap` |
| pump.fun token launch | `src/pump/launch-token-modal.js` | `launch` |
| Agent-home pump.fun buy/sell | `src/agent-home-pumpfun.js` | `pump-trade` |
| pump.fun x402 access payment | `src/pump/pump-modals.js` | `x402-pay` |
| Skill purchase modal | `src/payment-modal.js` | `skill-purchase` |
| $THREE token payments | `src/token-pay.js` | `token-pay` |
| Forge pay-per-generation | `src/forge-pay.js` | `forge-pay` |
| Add funds / Coinbase onramp | `src/shared/add-funds.js` | `onramp` |
| Drop-in x402 modal (incl. merchant embeds) | `public/x402.js` | `x402-pay` |

If you add a surface, add its row here and its gate call in the code — both in
the same change.

Known gap: the master-wallet page ([/wallet](https://three.ws/wallet),
`src/master-wallet.js`) moves real funds through its send and fund-agent flows
but does not call `ensureRiskAck()` yet; it relies on its own simulate-then-
confirm step instead. Wiring it through the gate is an open task, per the rule
above.

## Related

- [Risk Disclosure](https://three.ws/legal/risk) — the full legal text users accept
- [Custody you can verify](./custody.md) — the spend-limit and freeze controls that bound what agents can do after acceptance
- [Terms of Service](https://three.ws/legal/tos) — §8 Limitation of Liability, which this acknowledgment supplements
