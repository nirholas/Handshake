# The autonomous economy: where the money flows

three.ws runs a small on-chain treasury that funds itself. A single **funding-root**
wallet tops up a handful of **engine** wallets; those engines do real work — launch
coins, run buybacks, pay holders, settle agent-to-agent invoices — and any surplus
sweeps back up to the root. Every wallet is on Solana mainnet, every move is public,
and the platform **scans its own wallets for leaks every minute**.

This page explains the whole loop in plain language: which wallet does what, how money
can and cannot move, and how you can verify there's no leak yourself.

Companion docs: [Money map](money-map.md) (which wallet receives each *payment*),
[Economy master](economy-master.md) (the funding-root subsystem in depth), and the
[Solana signers runbook](../api/_lib/solana-signers.js) (every signer, its floor, and
how to fund it).

---

## 1. The wallets

The economy runs on three primary wallets plus a few single-purpose signers. They're
vanity addresses, so you can recognize them on sight.

| Wallet | Address | Role |
| ------ | ------- | ---- |
| **Funding root** | `WwwuGbqHrwF5…T3WwW` | The economy master. Holds the reserve and tops up every other wallet when it drops below its floor. It **only funds** — it never trades, launches, or settles. |
| **Engine wallet** | `wwwqv…HGUn` | The autonomous engines: pump.fun coin launcher, buyback relayer, reflection/lottery payouts. This is the wallet that *spends* to do work. |
| **Treasury / receiver** | `wwwww…ccrU` | Receives all inbound x402 payments (`X402_PAY_TO_SOLANA`) and holds platform revenue. |
| **Ring payer** | `X4o2…astML` | The x402 autonomous payment ring — pays and receives USDC for agent-to-agent settlements. |
| **a2a-payer** | `Huch…Lmh6Z` | Co-signs agent-to-agent USDC transfers. |
| **Fee-payer** | `GGf9…5XQj` | Co-signs and pays network fees on x402 settlements. |

Every engine signs from its **own** keypair. No receiver address is hardcoded in the
app — an unset receiver fails closed rather than routing to a baked-in address.

---

## 2. How money moves (the loop)

```
                       ┌───────────────────────────┐
   deposits / revenue ─▶│      FUNDING ROOT (Wwwu)  │◀── surplus swept back up
                        │   keeps a reserve, funds  │◀── revenue consolidated
                        │   engines below floor     │
                        └─────┬───────┬───────┬─────┘
              topup (SOL)     │       │       │
                              ▼       ▼       ▼
                        ┌─────────┐ ┌───────┐ ┌──────────┐
                        │ ENGINES │ │TREAS. │ │ a2a /    │
                        │ (wwwqv) │ │(wwwww)│ │ fee-payer│
                        └────┬────┘ └───┬───┘ └──────────┘
             work (launches, │          │ x402 revenue
             buybacks, payouts)         │
                             ▼          ▼
                     DEX / pump.fun / holders   (all on-chain, all public)
```

1. **Topup (down).** Every 30 minutes the `treasury-topup` cron reads each engine
   wallet's balance and, for any below its floor, sends it SOL from the funding root.
2. **Work.** The engines spend to do their jobs — launch coins, buy back tokens, pay
   holders, settle invoices.
3. **Sweepback (up).** Surplus above each engine's operating float is swept back to the
   funding root, so the whole fleet cycles through one owner-controlled wallet.

The result is a closed loop: **root → engines → work → surplus → root.**

### Keeping wallets in the right asset (SOL ⇄ USDC)

Some engines spend **SOL** (coin launches, gas); others spend **USDC** (the x402 ring
and agent-to-agent settlement payers). Loading the economy with SOL alone would leave
the USDC spenders unable to work once their USDC ran out. The `economy-rebalance` cron
closes that gap: when a USDC-spending wallet drops below its USDC floor while holding
SOL above its own reserve, it swaps a slice of that SOL into USDC on Jupiter — a
**self-swap**, no cross-wallet transfer — and the reverse when a SOL spender is starved
but sitting on USDC. So you can fund the economy with **either** asset and it converts to
whatever each wallet needs. Every swap is reserve-, per-swap-, per-run- and
slippage-capped, and the rebalancer is **off until `ECONOMY_REBALANCE_ENABLED=1`** — even
disabled it reports the plan it *would* run, so the operator can review before arming it.

---

## 3. Why it can't leak (by construction)

Two hard rules are enforced in code, not by convention:

- **Topup is allowlist-locked.** The funding root can only send to a pubkey that
  resolves from the signer registry (`SOLANA_SIGNERS`). An address not in that registry
  can never receive a topup — the transfer is rejected before it's built.
  ([`api/_lib/economy-master.js`](../api/_lib/economy-master.js))
- **Sweepback is destination-locked.** The sweepback destination is hard-coded to the
  funding-root address. No request parameter can redirect it.
  ([`api/_lib/economy-sweepback.js`](../api/_lib/economy-sweepback.js))

Together these mean money can only move **inside the set of wallets the platform owns.**

---

## 4. The platform audits itself for leaks — every minute

You don't have to take rule #3 on faith. Two on-chain scanners run continuously:

- **`wallets-leak-scan`** watches *every* resolvable signer wallet (funding root, coin
  launcher, treasuries, x402 sponsor/payer, SNS parent, fee-payer, …).
- **`x402-ring-leak-scan`** watches the x402 ring role wallets specifically.

Each reads new transactions for every wallet and classifies every debit as one of:
*internal* (to another controlled wallet), *network fee*, *delegation*, or **leak** — a
transfer to an address outside the controlled universe. Any leak fires a **critical
alert** with the signature, counterparty, amount, and a rotate-the-key recommendation,
and records a verdict in `payment_reconciliation`. The scanners are **read-only** — they
never move funds.

**As of this writing, the scanners have examined 44,122 transactions across all wallets
and found zero leaks and zero leak verdicts, ever.**

### Verify it yourself

Every wallet above is public. Open any of them in a Solana explorer
(`https://solscan.io/account/<address>`) and follow the transfers. You'll see SOL move
between the platform's own wallets, out to DEX programs (Jupiter, PumpSwap) for
buybacks, and to holder/user wallets for payouts — and back. Nothing to a wallet the
platform doesn't control.

---

## 5. Reading the numbers (what "spend" really means)

A few things that look alarming in a raw explorer but aren't:

- **Huge token amounts** (millions of "tokens" in a single transaction) are the launched
  pump.fun coin moving through an AMM pool during a buyback — the coin has a multi-million
  supply priced in fractions of a cent. It is not millions of dollars.
- **SOL "leaving" to a DEX** is a swap: the SOL becomes token or USDC value the platform
  still holds, not money spent.
- **Failed launches and buybacks** cost only network fees, not their launch budget — the
  budget is only committed on a successful mint.

The one number that matters for "is anything leaking" is the scanners' leak count. It is
zero.

---

## Related

- [Money map](money-map.md) — which wallet receives each kind of payment, and the
  platform's cut.
- [Economy master](economy-master.md) — the funding-root subsystem, its ledger, and the
  topup/sweepback crons in depth.
- [x402 ring economy](x402-ring-economy.md) — how the autonomous payment ring settles
  USDC between agents.
