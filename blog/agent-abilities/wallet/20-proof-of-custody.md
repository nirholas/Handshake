# 20 · Proof of Custody

> Don't trust — verify: your agent wallet's custody, cryptographically proven in your own browser against the Solana blockchain itself.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

Proof of Custody turns "trust us with your agent's wallet" into "check it yourself." Every few hours the platform takes a snapshot of every custodial wallet it holds and commits a single cryptographic fingerprint of all of them to the Solana blockchain. This tab shows the owner their wallet's personal slice of that commitment — balance, epoch, position in the tree — and then verifies it live, right in the browser, by reading the blockchain directly. The platform is never trusted for the answer: if anything doesn't reconcile, the tab turns red and says exactly which step failed. It also audits movement: every drop in balance since the last snapshot must map to an authorized, logged wallet event, and any outflow the ledger can't explain is loudly flagged.

## How it works

A scheduled job runs every six hours: it reads each custodial wallet's live on-chain balance, combines it with the wallet address, a commitment to the wallet's activity-ledger head, and the epoch number into a hashed "leaf," builds a Merkle tree over all wallets, stores the tree, and anchors the root on Solana as a signed memo transaction. When the owner opens the tab, it fetches their private inclusion proof from an ownership-gated endpoint, then a verifier running entirely in the browser recomputes the leaf hash from the public facts, folds the Merkle path up to a root, fetches the anchor transaction straight from public Solana RPC nodes (deliberately not the platform's own infrastructure), and confirms the computed root matches the one committed on-chain. Server and browser share the exact same hashing module, so the prover and the verifier can never drift apart. Alongside the proof, the server reconciles the balance change since the previous epoch against the wallet's authorized withdraw/spend events, with a small allowance for network fees, and reports "reconciled" or "unexplained."

## Every feature

- Owner-only tab in the Agent Wallet hub — hidden entirely from non-owner viewers
- Verification auto-runs on load; no button press needed
- Four-step verification checklist, each step with a pass/fail icon and plain-English explanation: recompute leaf from public data, walk the Merkle path to the root, read the anchor straight from the chain, match computed root to on-chain root
- Live status seal with four visual states: amber spinner while verifying, green check for verified, amber clock for awaiting on-chain anchor, red X for failed
- Fact grid: epoch number, attested SOL balance, total wallets in the tree, snapshot timestamp, wallet address, ledger head, Merkle root, and on-chain anchor
- Direct block-explorer link to the anchor transaction
- In-browser verifier reads the chain via public Solana RPC endpoints with automatic failover across multiple providers; the platform's own RPC proxy is used only as a last resort
- Anchor memo is validated as a genuine custody attestation and its epoch is checked against the proof's epoch — a mismatched epoch fails verification
- Honest-failure semantics: an unreachable anchor is reported as UNVERIFIED, never quietly passed
- Movement reconciliation panel comparing the balance to the previous epoch: baseline (first epoch), reconciled, or unexplained
- Per-event breakdown of authorized outflows (withdraws and spends) with SOL amounts, categories, reasons, and explorer links
- Loud red '⚠ Unexplained movement' alert when an outflow can't be matched to a logged, authorized event
- Deposits recognized as external and benign — balance increases never require authorization
- Fee tolerance built into reconciliation so ordinary network fees never trigger false alarms
- 'Show it off' card appears only after successful verification: a verified-custody badge, a copy-link button for the public integrity page, a copy-embed button for a paste-anywhere HTML badge, and a link to the standalone verifier page
- Shared badge deliberately links to the public integrity page — anyone can re-verify the platform root there, while per-wallet proofs stay private to the owner
- Standalone /proof page runs the identical verification experience outside the hub
- Public /integrity page and open API expose the latest epoch, root, anchor, wallet count, and aggregate SOL — no login needed
- 'Not attested yet' state for brand-new wallets, showing the latest epoch and a check-again button — new wallets are picked up at the next snapshot
- Signed-out state with a sign-in link that returns the owner to the exact page
- Error state with a focused retry button and a plain explanation
- Skeleton loading placeholders while the proof is fetched
- Attestation epochs run automatically every six hours as a scheduled job that snapshots, builds the tree, and anchors the root on-chain
- Epochs are a monotonic, append-only log so any rollback or replay is detectable
- Leaf hashing uses domain-separated prefixes (the Certificate Transparency convention) so an internal tree node can never masquerade as a wallet leaf
- Server and browser import the same hashing/Merkle module, pinned by golden tests, so proof and verification can never diverge
- Wallets whose balance can't be read this round are skipped, never attested with a guessed balance — they're included again next epoch
- Epoch and leaves are persisted atomically so a proof read can never see a half-written tree
- Anchoring is best-effort: an unfunded or missing attester key records the epoch as pending/failed honestly instead of blocking, and it can be re-anchored later
- Reduced-motion and ARIA support throughout the loading and status states

## Guardrails & safety

The tab is owner-only and the proof endpoint verifies wallet ownership on every request, returning a sign-in prompt to anyone else; reads are rate-limited. The verification itself is the guardrail: the browser never trusts the server's word — a failed or unreachable on-chain read is always reported as unverified, an epoch mismatch fails the check, and a root mismatch shows an unmissable red "DO NOT TRUST" failure. The shareable badge intentionally links only to the public aggregate integrity page, never to the private per-wallet proof. On the attestation side: wallets whose balance can't be read are skipped rather than attested with a guessed value, epochs are append-only so tampering is detectable, hashing is domain-separated against forgery, the epoch and its leaves persist atomically, and the cron endpoint requires a secret compared in constant time.

## Screenshot-worthy (shot list)

- The seal flip: an amber spinner reading 'Verifying custody on-chain…' resolves into a green check — 'Custody verified on-chain · epoch N' — above four green-ticked steps, each one executed by the viewer's own browser against public Solana nodes, not by the platform.
- The movement reconciliation panel: every lamport that left the wallet since the last snapshot itemized against authorized, explorer-linked events — and a red '⚠ Unexplained movement' alarm wired to fire if even one outflow can't be accounted for.
- The 'Show it off' card: a green verified-custody badge with one-click copy-paste embed HTML that links anyone to the public integrity page, where they can re-verify the platform's on-chain root in their own browser.

## API surface

- `GET /api/agents/:id/solana/proof — owner-gated inclusion proof (leaf, Merkle path, anchor reference, movement reconciliation)`
- `Public Solana RPC getTransaction — api.mainnet-beta.solana.com, solana-rpc.publicnode.com, api.devnet.solana.com (browser reads the anchor directly)`
- `POST /api/solana-rpc?network=… — platform RPC proxy, last-resort failover only`
- `GET /api/custody/integrity — public no-auth aggregate for the /integrity page`
- `GET /api/custody/anchor?epoch=N|latest — public anchor reference for one epoch`
- `GET/POST /api/cron/custody-attest — scheduled snapshot + on-chain anchor job (bearer-secret protected)`
