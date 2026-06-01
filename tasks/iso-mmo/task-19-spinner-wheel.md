# Task 19 — Spinner wheel

## Context

There is no spinner/prize-wheel feature anywhere in the game. The world guide
describes a wheel on the Mainland (near a casino landmark): a 20-segment prize
table, one free spin every 12 hours, and on-demand paid spins costing $3 USD
worth of the game token (50% burned, 50% to treasury). Spinning requires an
average skill level of 5. About 1 in 20 spins awards gold; the rest award wood,
stone, or coal in varying amounts. The paid spin does not consume the free-spin
timer.

## Goal

A complete spinner: a Mainland wheel object that opens a spin UI, with a gated
free spin on a 12h cooldown and paid spins settled on-chain, both drawing from
one server-authoritative prize table.

## What to build

1. **Wheel object + gate.** Place a wheel near the Mainland casino landmark
   (`realms.js`/object table); clicking it opens the spinner UI. Server-side,
   require the player's average skill level ≥ 5 (use the Task 11 average-skill
   helper) to spin; otherwise reject with a clear notice.
2. **Prize table (authoritative).** Define the 20-segment table server-side with
   real probabilities (~1/20 gold; remainder wood/stone/coal in varying amounts).
   The SERVER rolls the outcome — the client animation must land on the
   server-decided segment, never decide the prize itself. Award via
   `_addItem`/gold (respect full-inventory leftover; bag overflow if needed).
3. **Free spin.** One free spin per 12h per account. Track `nextFreeSpinAt` in the
   persisted profile (Task 16); expose it so the client shows a real countdown.
   Reject early free spins server-side.
4. **Paid spin.** Cost = $3 USD worth of token via Task 18 `quoteTokenForUsd`.
   Flow: server issues a quote → client wallet signs one transaction → server
   verifies it (Task 18) with a 50/50 burn/treasury split → only then roll +
   award the prize. The paid spin does NOT alter the free-spin timer. Reject the
   spin if payment verification fails.
5. **Client spinner UI.** A wheel with the 20 segments, a spin animation that
   resolves to the server's chosen segment, the free-spin countdown, and a
   "Paid spin ($3 in token)" button that runs the payment flow with clear pending/
   confirming/success/failure states. Prize result shown honestly (exact item +
   amount). Designed states for: not eligible (avg level < 5, with how-to),
   free-spin-not-ready, wallet/payment errors.

## Definition of done

- Players below average skill level 5 cannot spin (server-enforced).
- The free spin works once per 12h with an accurate countdown and cannot be
  spun early.
- Paid spins require a real verified on-chain payment ($3 in token, 50% burn /
  50% treasury) before awarding; the animation always matches the server outcome;
  the free timer is untouched. Prizes match the table distribution over many
  spins. No console errors.

## Dependencies

Requires Task 11 (average-skill helper), Task 16 (free-spin timer persistence),
and Task 18 (token quote + verified payment + split).

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
