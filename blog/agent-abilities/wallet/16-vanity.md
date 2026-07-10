# 16 · Vanity

> Give your agent a wallet address that spells its name — ground on your own CPU at millions of attempts, then applied with a funds-safe swap that sweeps every asset over first.

*One of the 23 abilities of the [Agent Wallet](../chapters/10-the-agent-wallet.md) — the money layer of a three.ws agent.*

## What it does

Every agent on three.ws carries its own Solana wallet, and the Vanity tab lets the agent's owner trade that wallet's random address for a custom one that starts or ends with text they choose — the agent's name, a brand, a lucky word. The search runs right in the browser: pick how many CPU cores to spend, watch a live counter tear through hundreds of thousands of addresses per second, and pause, resume, or cancel at any time. The moment a match is found it is applied automatically, and if the old wallet holds any SOL or tokens, everything is moved to the new address before the switch — funds can never be left behind. When it's done, the new address appears with its custom pattern highlighted, complete with the attempt count, the time it took, and a link to see it live on-chain.

## How it works

The grind runs client-side: a pool of Web Workers (one per selected CPU core) drives a Rust-compiled WASM keypair generator that races to find an Ed25519 keypair whose Base58 address matches the requested prefix and/or suffix — first match wins, the hot loop runs in ~200ms batches so pause/cancel respond instantly, and pausing genuinely frees the cores while preserving the attempt count. The winning 64-byte key is POSTed to the agent-wallet API with a single-use CSRF token; the server re-derives the address from the key and independently verifies it matches the requested pattern, never trusting the client's claim. If the current custodial wallet is funded, the server recovers the old key through the audited custody layer and sweeps every asset — all SPL tokens across both the classic Token program and Token-2022, transferring and closing each token account to reclaim rent, plus all remaining SOL — to the new address in confirmed versioned transactions, and only then encrypts and stores the new key, so a failed sweep aborts the whole swap with the wallet unchanged. A bounded server-side grind (up to 3 combined characters, 4M iterations, 30-second budget) remains as a fallback path for short patterns supplied without a key.

## Every feature

- Owner-only tab in the Agent Wallet hub (hidden from non-owner viewers; server independently enforces ownership with 403)
- Current-address card with the vanity prefix/suffix highlighted in purple and a 'vanity' badge when the wallet already has a custom pattern
- 'Starts with' prefix field and 'Ends with' suffix field — combine both in one address
- Up to 6 characters per pattern (Base58), with live input scrubbing that strips invalid characters as you type
- Smart placeholder suggestion derived from the agent's own name
- Case-insensitive matching toggle — matches any capitalization and cuts the search time
- CPU core slider from 1 up to every core the machine has, with a live 'N / max' readout
- Quick core presets: 1 core, a balanced default (about half the machine), and Max
- Live difficulty estimate: expected attempt count plus a time estimate for the chosen core count, recomputed on every keystroke
- 'This one is hard' amber warning when the pattern crosses ~500 million expected attempts
- Explicit warning banner before replacing an existing wallet, spelling out that funds are auto-swept first
- One-click 'Grind & apply vanity address' button that runs the whole flow end to end
- Live grind screen: big attempts-per-second rate (k/M formatted), running attempt counter, and a live ETA computed from the workers' real measured speed
- Pause/Resume that genuinely frees the CPU cores mid-grind and picks up the attempt count where it left off, with a 'paused' pill indicator
- Cancel button that aborts the grind and returns to the form
- Automatic apply on match: the found keypair is submitted immediately with a single-use CSRF token — no extra step
- 'Match found — migrating funds & applying…' state while the server sweeps and swaps
- Automatic full-wallet migration: all SOL plus every SPL token (both token programs), with token-account rent reclaimed, moved to the new address before the key swap
- Retry-without-regrinding recovery: if the apply step fails, the found key stays in memory so the owner can retry the assign or discard it — the old wallet stays intact and funded
- Success card showing the new address with the matched pattern highlighted, a migrated-funds summary (SOL amount + token count), and found-in-N-attempts / duration stats
- One-click block-explorer link, network-aware (Solscan on mainnet, Solana Explorer on devnet)
- 'Change again' button to grind a fresh pattern immediately
- Provisioning path: an agent with no wallet yet gets one created by grinding — the vanity address becomes its first address
- Server-side fallback grind for short patterns (up to 3 combined characters) when no browser-ground key is supplied
- Old addresses preserved in the agent's wallet history (last 10 swaps) with timestamps and sweep status
- Base58 validation with human-readable hints for the four confusable characters (0, O, I, l) that Solana addresses never contain
- Skeleton loading state, designed error state, worker cleanup on tab close mid-grind, reduced-motion support, aria-live progress announcements, and a mobile layout

## Guardrails & safety

Owner-only end to end: the tab is hidden from non-owner viewers and the server rejects anyone but the agent's owner (sign-in required, 403 otherwise). The state-changing apply call requires a single-use CSRF token and is rate-limited under the same per-user cap as withdrawals plus a per-IP burst limit. The server never trusts the browser: it re-derives the address from the submitted key and proves it matches the requested pattern before adopting it. The money-safe gate is sweep-then-swap — if the old wallet is funded, every asset must move to the new address in confirmed on-chain transactions before the stored key changes; a failed sweep aborts everything and the old wallet stays untouched and funded. Key recovery for the sweep goes through the audited custody layer, and every swap is recorded as a custody event, an activity event, and an audit-log entry, with the replaced address kept in the wallet's history. Patterns are capped at 6 Base58 characters each, inputs are scrubbed to valid characters only, the server-side fallback grind is bounded (3 combined characters, 4M iterations, 30-second budget) so it can never hang, and the UI shows an explicit warning before replacing a funded address.

## Screenshot-worthy (shot list)

- The live grind readout: a huge monospace attempts-per-second counter with a running attempt total and ETA, churning across every core you gave it — with real Pause/Resume that visibly frees your CPU
- The success card: the new address with your chosen pattern glowing in purple, 'Migrated 0.42 SOL + 3 tokens from the old address', and 'Found in 1,234,567 attempts · 12.3s' above a one-click explorer link
- The difficulty estimator reacting as you type: attempt counts and time estimates update live per character and per core, flipping to an amber 'this one is hard' warning on ambitious patterns

## API surface

- `GET /api/agents/:id/solana/vanity — owner-only status: current address, vanity prefix/suffix, wallet source, is_vanity flag, server grind cap`
- `POST /api/agents/:id/solana/vanity — owner-only assign: accepts a browser-ground 64-byte secret key (verified server-side) or grinds short patterns server-side, sweeps all funds old→new, swaps the stored encrypted key, returns address/iterations/duration/swept summary`
