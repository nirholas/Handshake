# Task 17 — Wallet sign-in & token-balance gate

## Context

The `/play` entry (`public/play.html`) lets anyone in — there is no sign-in and
no account identity beyond an ephemeral Colyseus session id. The platform already
has wallet plumbing (`src/wallet-auth.js`, `src/wallet.js`, `src/solana.js`) and
the multiplayer server has a holder-gate secret pattern (`HOLDER_PASS_SECRET` in
`index.js`, `multiplayer/src/holder-pass.js`). The world guide specifies: sign in
with a Solana wallet (the wallet address IS the account; no email/password), and
hold at least 1 unit of the game token in the connected wallet to play.

## Goal

Gate `/play` behind a wallet sign-in that produces a verified account identity,
and require a minimum token balance to enter, with the wallet address used as the
persistence/account key everywhere.

## What to build

1. **Sign-in flow (client).** On `/play`, require connecting a Solana wallet and
   signing a login message (reuse `src/wallet-auth.js`/`wallet.js`). Sign a
   server-issued nonce so the signature can't be replayed. Surface connect /
   signing / signed states clearly; never ask for a seed phrase.
2. **Signature verification (server/api).** Verify the signed nonce server-side
   to authenticate the wallet address. Issue a short-lived token/session the game
   server trusts (extend the existing holder-pass signing approach so the
   standalone Colyseus process can validate it — it already refuses to boot in
   prod without `HOLDER_PASS_SECRET`). The Colyseus `onAuth`/join must validate
   this and bind the verified wallet address to the session.
3. **Token-balance gate.** Read the connected wallet's balance of the game token
   from a real Solana RPC (use the platform's existing RPC config). Require
   ≥ 1 token to play. Enforce on the server at join (not just client UI) so the
   gate can't be bypassed. Re-check on a sensible cadence, not just once, if you
   want to drop players who offload below the threshold — document the policy.
4. **Account binding.** Pass the verified wallet address into the game as the
   account id, which Task 16 uses as the persistence key and Task 15 uses for the
   social graph. The displayed name maps to this account.
5. **States.** Designed screens for: wallet not installed, not connected,
   signature rejected, balance too low (with a clear path to acquire the token /
   link to funding), and verifying. Honest errors, no dead ends.

## Definition of done

- Reaching `/play` requires connecting + signing; an unsigned or forged session
  cannot join the game room (server-enforced).
- A wallet holding < 1 token is refused with a clear, actionable message; ≥ 1
  token gets in.
- The verified wallet address is the account id used for persistence and friends.
  Balance is read from real RPC, not assumed. No console errors.

## Dependencies

Foundation for Task 16 (account key), Task 18 (token), and Task 15 (account
identity). Reuses existing wallet/Solana modules + holder-pass secret.

---
Build to the standards in [README.md](./README.md): real data, server-authoritative, fully wired end-to-end, every state designed, no shortcuts.
