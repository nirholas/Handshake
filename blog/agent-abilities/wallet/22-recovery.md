# 22 · Recovery

> Lose your login — or go silent forever — and your funded agent wallet still finds its way home: guardians, a beneficiary, and a dead-man's switch that only fires when you truly can't stop it.

## What it does

Recovery is the agent wallet's answer to the oldest problem in crypto: what happens to a funded wallet when its owner loses access or is gone for good. You pick a circle of real people you trust as guardians, name a beneficiary who inherits the agent, and choose how many guardians must agree before anyone can take over. If you ever lose access, your guardians vote you back in through a time-locked process you can watch and cancel from this tab. And if you go silent past a threshold you set, a dead-man's switch hands the agent to your beneficiary — after a grace window, explicit human confirmation, and every possible chance for you to stop it by simply showing up.

## How it works

The tab reads and writes a single owner-gated recovery API for the agent: one call loads the full state (guardian roster, threshold, beneficiary, dead-man status, any live process), one saves the configuration, one records an "I'm here" check-in, and one cancels an active process. Guardians and beneficiaries act from a separate guardian console backed by their own approve/decline/confirm endpoints, so a recovery needs a threshold of other people's votes plus a 48-hour time-lock before anything moves. A daily server job measures the owner's real activity — logins, trades, custody events, explicit check-ins — arms an inheritance only after the owner-set inactivity threshold is crossed, sends warnings a week before, and completes a hand-off only after the grace window elapses with confirmation. Crucially, no private key is ever exported or decrypted: recovery atomically reassigns who owns the agent in the database, and the same server-held key keeps signing for the new owner. Every step lands in the custody trail and audit log, the wallet's autonomous spending is frozen for the duration of any contested process, and the transfer itself is guarded so it applies exactly once and aborts if ownership changed mid-flight.

## Every feature

- Guardian roster: add trusted people by @username or email (Enter-to-add supported), up to 10 guardians
- Guardian cards showing avatar, name, 'trusted' badge, and the date they were added
- One-click guardian removal with a confirmation prompt
- Configurable approval threshold — an 'M of N' dropdown (appears once you have 2+ guardians); defaults to a sensible 2-of-N
- Beneficiary designation by @username or email, displayed with a green 'heir' badge
- Beneficiary removal auto-disables the dead-man's switch (with confirmation explaining exactly that)
- Dead-man's switch on/off toggle — locked until a beneficiary is set, with inline guidance telling you why
- Inactivity threshold control: 7–365 days of silence before the switch arms (default 90)
- Grace + confirmation window control: 1–90 days after arming before control can pass (default 14)
- Live inactivity progress bar that shifts from green to danger colors once you pass 70% of the threshold
- Plain-language countdown: 'You've been quiet for 12d of the 90d threshold — inheritance would arm in 78d if you stay away'
- 'I'm here — reset the clock' one-tap check-in button that resets the dead-man timer
- A check-in instantly aborts any in-flight inheritance — the switch is always defeatable by being alive
- Activity is auto-detected from real signals (logins, trades, custody events, agent usage, explicit check-ins), so a quiet-but-active owner is never falsely declared gone
- Active-process card with a 4-step visual timeline: request opened → guardian approvals → safety time-lock / grace window → control transfers
- Live guardian approval counter (e.g. 'Guardian approvals (1/2)') with threshold-met state
- In-character narration: the agent itself describes what's happening in first person during a recovery or inheritance
- Live countdown on the 48-hour safety time-lock, refreshed by 15-second polling that only runs while a process is live and pauses when the tab is hidden
- One-click abort buttons: 'Stop this recovery — it's not me' and 'I'm here — cancel inheritance', each with a confirmation
- Final-step danger warning when a transfer is imminent, telling you it's your last chance to cancel
- 48-hour anti-takeover time-lock opens automatically the moment the guardian threshold is reached
- Recovery attempts that never gather enough approvals auto-expire after 14 days, and the wallet unfreezes
- Wallet auto-freeze during any contested process: autonomous spending stops so funds can't be drained mid-recovery, while the owner's own withdrawals stay open
- The requester of a recovery can never approve their own takeover — approvals must come from other guardians
- Only one active recovery or inheritance per agent — duplicate or contested attempts are rejected, not raced
- No key export ever: recovery transfers who owns the agent; the encrypted signing key never leaves the server
- Standalone guardian console (/guardian) where guardians and beneficiaries approve, decline, or confirm across every agent they protect
- Guardian votes are recounted live against the current roster — approvals from since-removed guardians stop counting
- No-guardian inheritances require the beneficiary's explicit confirmation — control never passes purely on a timer
- Daily automated sweep: expires stale requests, arms eligible inheritances, warns owners 7 days before arming (at most once per window), and completes hand-offs only after grace plus confirmation
- Notifications to every party at every step: recovery requested, time-lock started, switch armed, approaching-threshold reminders, transfer completed
- Every action written to the agent's custody trail and the platform audit log
- Atomic, idempotent ownership transfer that refuses to fire if the owner changed mid-process, and moves the agent's linked avatar to the new owner too
- Privacy by design: non-owners see a redacted view, emails are masked, and only members of the recovery circle can read the status at all
- Owner-only tab — invisible to anyone else viewing the wallet
- Polished states throughout: skeleton loading shimmer, error state with retry, empty-roster guidance, and reduced-motion accessibility support

## Guardrails & safety

Owner-only tab; every write requires a fresh CSRF token and is rate-limited. Only the owner configures the circle; you can't be your own guardian or beneficiary; guardian count capped at 10; threshold clamped to the roster size. A recovery needs a threshold of OTHER guardians' approvals (self-approval is blocked) plus a 48-hour time-lock the owner can cancel at any point; requests expire after 14 days if approvals never arrive. Inactivity is bounded to 7–365 days and grace to 1–90 days, validated on both client and server. The dead-man's switch can't even be enabled without a beneficiary, warns the owner a week before arming, opens a grace window instead of transferring, and is cancelled by any sign of life — a login, a trade, or one tap of 'I'm here'. During any contested process the wallet's autonomous spending is frozen (owner withdrawals stay open), only one process can exist per agent at a time, the final transfer is atomic, idempotent, and aborts if ownership changed underneath it, and the private key is never exported, copied, or decrypted at any step. Destructive UI actions (remove guardian, remove beneficiary, cancel process) all require explicit confirmation, and everything is logged to the custody trail and audit log.

## Screenshot-worthy (shot list)

- The agent narrates its own recovery in first person — during a live process the card reads: 'Someone is trying to recover me. My guardians are weighing in, and a safety window is running. If this isn't you, you have until it ends to shut it down.'
- The dead-man's switch card: a live inactivity bar that turns red as you approach the threshold, a countdown to arming, and a single glowing button — '✋ I'm here — reset the clock.'
- The 4-step recovery timeline with a ticking 48-hour countdown and the big red 'Stop this recovery — it's not me' abort button — a screenshot that says 'your wallet can defend itself.'

## API surface

- `GET /api/agents/:id/recovery`
- `PUT /api/agents/:id/recovery`
- `POST /api/agents/:id/recovery/checkin`
- `POST /api/agents/:id/recovery/requests/:rid/cancel`
- `POST /api/agents/:id/recovery/requests (+ /approve, /decline, /confirm, /complete — guardian console side)`
- `GET /api/agents/recovery-inbox (guardian console)`
- `GET /api/cron/dead-man-switch (daily sweep, secret-gated)`
