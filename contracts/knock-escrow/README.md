# `knock_escrow`

Escrowed, refundable payments for a **knock**: a priced message to a person that
pays out only against a reply.

Program id: `uVX46U6sGUs6PD3339ZXbTpMyhZwkQhBLPxnvRX9ps7` (Solana, Anchor 0.31.1)

## Why this exists

The live knock product settles the sender's payment straight to the owner's
wallet the moment it clears. That works between people who already trust each
other and fails in an open market: the sender pays first and unconditionally, so
an owner can bank every knock and answer none. At volume the price signal stops
meaning anything, because paying a stranger stops being rational.

This program makes the money conditional. A knock parks the payment in a vault
owned by the knock's own PDA, and exactly three things can happen to it:

| Outcome | Who triggers it | Where the money goes |
| --- | --- | --- |
| **Answer** | the door's owner, inside the reply window | owner, minus the protocol fee |
| **Refuse** | the door's owner, inside the reply window | sender, in full, **no fee taken** |
| **Reclaim** | anyone, once the window has closed | sender, in full |

There is no fourth path. The `Config` authority sets the fee and treasury for
knocks made *after* it acts; it cannot touch a vault, answer on an owner's
behalf, or stop a refund. A sender's worst case is that their money is locked
until the window they agreed to expires.

Message bodies never touch the chain. A knock stores the SHA-256 of the message
and an answer stores the SHA-256 of the reply, so either side can later prove
what was sent without publishing a private message to a public ledger.

## Instructions

| Instruction | Signer | Effect |
| --- | --- | --- |
| `initialize(treasury, fee_bps)` | authority | Creates the singleton `Config` PDA. |
| `set_config(treasury?, fee_bps?, authority?)` | authority | Repoints fee, treasury, or authority for future knocks only. |
| `open_door(door_id, price, reply_window)` | owner | Opens a priced door for one SPL mint. |
| `set_door(price?, reply_window?, open?)` | owner | Reprices, retimes, or shuts a door. Knocks already in flight are untouched. |
| `knock(nonce, message_hash)` | sender | Moves `price` into the knock's vault and records the knock. |
| `answer(reply_hash)` | owner | Pays the owner, sends the fee to the treasury, closes the vault. |
| `refuse()` | owner | Refunds the sender in full and closes the vault. |
| `reclaim()` | anyone | After expiry, refunds the sender in full and closes the vault. |

`door_id` is a 32-byte client-chosen id (the product uses the SHA-256 of the
owner's username), so one wallet can run several doors without a second signer.
`nonce` lets one sender knock the same door repeatedly.

## Guarantees enforced in code

- **Fee ceiling.** `fee_bps` can never exceed 1000 (10%). An unbounded fee is a
  rug, so the bound lives in the program, not in an operator's discipline.
- **Fee snapshot.** A `KnockRecord` stores the fee that was in force when it was
  made, so an authority cannot reprice escrowed money after the fact.
- **Refusing is free.** `refuse` takes no fee. Declining to read something is
  not a service.
- **Terminal states are terminal.** A knock leaves `Pending` exactly once, into
  `Answered`, `Refused`, or `Refunded`.
- **Bounded windows.** A reply window is between 1 hour and 30 days, and a price
  is between 1 and 1_000_000_000 base units.
- **Checked math.** Fee and payout arithmetic returns `MathOverflow` rather than
  wrapping.

## State and events

Accounts: `Config` (singleton), `Door` (per owner + `door_id`, with lifetime
`knocks` / `answered` / `refunded` / `earned` counters), and `KnockRecord` (per
escrowed knock, alongside its vault token account).

Events: `Knocked`, `Answered`, and `Refunded` (whose `refused` flag separates an
owner declining from a window lapsing), so an indexer can rebuild door history
without polling accounts.

## Build

```bash
cd contracts/knock-escrow
cargo-build-sbf
```

The crate declares its own `[workspace]` so `cargo-build-sbf` never walks up
into an unrelated parent workspace. Build output lands in `target/deploy/` and is
gitignored, along with the program keypair.

Shared LiteSVM helpers for exercising a compiled program against the real SPL
Token and Associated Token Account programs live in
[`../program-tests/`](../program-tests).
