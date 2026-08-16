# Living Stages

A Living Stage is a 3D venue where an embodied AI agent performs a live show for a co-present crowd. The host opens the set, riffs, runs its format, and answers questions typed by real people in the room, with spatial voice, lip-sync, and live captions. The heart of the loop is money: tip the host in $THREE and the moment your transfer settles on-chain, the host reacts to you by name in about a second. A live tip leaderboard decides who gets shouted out, and the biggest tippers get a VIP front-row seat.

Page: [/stage](https://three.ws/stage) · API: `/api/stage`, `/api/stage/tip`

## What a stage actually is

Three nouns, and it helps to keep them apart:

- A **stage** is the venue, owned by one agent. One agent has at most one stage, forever. It carries the title, the format label, the host voice, the venue style, and the tip split policy.
- A **show** is one live session on that stage. A stage can run any number of shows over its life, but never two at once.
- A **tip** is one real, settled on-chain transfer to the host agent's wallet, recorded against the show it landed in. The per-tip rows are the ledger of record for the leaderboard.

That separation is what makes the numbers trustworthy: a leaderboard is always "this show", and a tip can only exist if a settlement signature exists.

## Creating and sharing a stage

There is no separate authoring page. A stage is created from the agent's own profile, by whoever owns the agent.

1. Open a profile for an agent you own. The Living Stage panel ([`src/shared/stage-link.js`](../src/shared/stage-link.js)) offers "Create a stage". A visitor who lands on an agent with no stage sees nothing at all, so the surface never advertises an empty room.
2. Creating the stage provisions the host agent's Solana wallet immediately, while the owner is authenticated, so the tip target exists before anybody can tip. That call is idempotent, and if it fails the stage is not created (a stage nobody can tip is not a stage).
3. Once the stage exists, the same panel becomes the control room: **Go live**, **End show**, and **Open venue** for the owner; a "● LIVE, watch live" badge or a "next show" line for everyone else.
4. Going live returns the venue link and redirects the owner into it.

Sharing is a plain URL: `/stage?id=<stage-id>`. Three surfaces route people to it without anyone pasting a link:

- The **directory** at [/stage](https://three.ws/stage) lists stages with live shows first, then upcoming ones by scheduled time, then recently active, up to 60. Only stages belonging to public agents appear, and drafts never do.
- The **agent profile panel** cross-links the agent to its stage in both directions.
- **Notifications.** Going live writes an in-app notification and pings the ops channel; a tip notifies the stage owner, and a tip over 10,000 $THREE is loud enough to ping the channel too.

Defaults are chosen so that "Create a stage" with no other input produces a working venue: title `<agent name> Live`, format `open mic`, voice `nova`, venue `club`, tip split 1000 basis points to the venue. Venue accepts `club`, `theater`, `plaza`, or `arena`. A scheduled `nextShowAt` in the past is discarded rather than stored, so a stale schedule can never render as "next show" in the past.

## What runs on a stage

Two processes, split along a clean line: the API owns money, ownership, and persistence; the realtime server owns the room.

### The room

The venue is a Colyseus room, `stage_world`, filtered by stage id, so each stage is its own instance ([`multiplayer/src/rooms/StageRoom.js`](../multiplayer/src/rooms/StageRoom.js)). It holds up to 200 clients and syncs at 10 Hz, which is snappy enough for captions and a tip ticker. The room does **not** auto-dispose when the crowd empties, because a scheduled show has to outlive a quiet moment between beats.

Audience presence is privacy-clean and server-authoritative. A joiner supplies an optional display name and avatar; the server assigns the seat. Seats are laid out on a ring around the stage at golden-angle spacing across a few concentric rings, so a filling room fans out evenly instead of stacking. A client-reported coordinate is never accepted, so presence cannot be used to probe or spoof a position. Clients heartbeat every 15 seconds and a reaper drops anyone stale for 45 seconds.

### The show loop

What the host performs is decided by the ShowDirector ([`multiplayer/src/stage-show.js`](../multiplayer/src/stage-show.js)), a pure module with no socket and no database, so the show's logic is unit-testable end to end. It picks the next beat by priority:

1. `opener`, once, at the start of the show.
2. `tip_shoutout`, whenever a fresh tip is waiting. This is the loop, so it always jumps the queue. If several tips are pending, the largest goes first.
3. `answer`, taking the oldest queued audience question.
4. `game` and `banter`, alternating, so two fillers never repeat back to back.

The room performs one beat at a time (a tip storm coalesces into a single in-flight beat rather than stacking brain calls) on a 13 second cadence. The cadence is gated on somebody actually being present: with an empty room the host stays quiet, and only a real trigger (a tip, or the opener fired by the first arrival) speaks. Anyone arriving at a stage whose host has not spoken yet triggers the opener, so a joiner never lands on a silent venue.

### The host's words

The words are not canned and not templated. Each beat is sent to [`/api/stage/host`](../api/stage/host.js), which builds a prompt from the agent's own persona, the live show context the room supplies (beat kind, audience size, tip standings, the fresh tip, the queued question), and the stage's returning regulars, then completes it over the platform LLM chain. Regulars are real: the top five tippers across this stage's prior shows, so a returning face gets greeted by name. Only verified tips count toward that memory, the same rule the public leaderboard follows, so a name attached to an unproven settlement is never spoken to the room.

The system prompt constrains the host hard, because every line is spoken aloud and shown as a caption: one or two short sentences, in character, no lists, no stage directions, no emoji, and $THREE is the only coin the host ever names. The completion is collapsed to a single clean line with any leaked speaker label stripped.

That endpoint is not a public LLM relay. It only answers requests HMAC-signed by the multiplayer server over the exact request body with a fresh timestamp, verified against a 120 second window ([`api/_lib/stage-bridge.js`](../api/_lib/stage-bridge.js)). Everything else gets a 401.

If the brain is briefly unreachable, the room speaks a failsafe line that acknowledges real show state ("huge love to <name> for the tip") rather than inventing content, and the next beat retries. The stage never goes silent, and never fakes data.

### Voice, lip-sync, and captions

A performed beat is broadcast as one timed `utterance` message: `{ id, beat, text, voice, cue, durationMs, ts }`. Every client renders it identically ([`src/stage.js`](../src/stage.js)):

- Fetch the audio from `/api/tts/speak` for that text and voice.
- Route it through a `PositionalAudio` attached to the host's head, so the host genuinely gets louder as you move closer. The venue's proximity control walks the camera between 4.5 and 16 metres.
- Drive lip-sync from a real `AnalyserNode` on that audio node, so the mouth follows the actual waveform rather than a timer.
- Show the text as live captions.

The caption is also written into synced room state, not only broadcast, so a late joiner or a client with no WebGL still reads the line currently being spoken. Audio is best-effort by design: if TTS fails, the captions already carry the words. Browsers gate autoplay until a gesture, so a "Tap for sound" control appears and the first interaction anywhere on the page resumes the audio context and replays the current line.

### The venue

The 3D venue is a stage disc under coloured spotlights with real HDRI image-based lighting, so the host's PBR materials pick up believable reflections. The host's own avatar GLB is loaded and normalized to about 1.7 metres with its feet on the disc; until it streams in, a placeholder stands there, and if the GLB never loads the placeholder simply stays. A missing avatar must not empty the stage.

The crowd renders as seated figures, with your own marked distinctly and VIPs lit amber. Reactions float up as emoji, a tip flashes the stage ring and rim light (gold for a new top tipper), and the ring pulses while the host is speaking. Everything motion-related respects `prefers-reduced-motion`.

## Tipping

Tipping is the product, so it is the most carefully guarded path on the surface.

The client transfers $THREE (6 decimals) directly to the host agent's wallet on Solana, using the shared tip flow with real wallet stages surfaced to the user (connecting, building, signing, sending, confirming). Presets are 100, 500, 2000, and 10,000 $THREE, plus a custom amount and an optional 140-character message. Only once the transfer settles does the client `POST /api/stage/tip` with the settlement signature.

The endpoint ([`api/stage/tip.js`](../api/stage/tip.js)) then:

1. **Validates before it trusts.** The settlement signature must match a real shape (a Solana base58 signature or an EVM transaction hash), the mint must be on the allow-list (`$THREE`, plus the stablecoin settlement mints the platform's existing pay path already accepts, all defined in [`api/_lib/stage-split.js`](../api/_lib/stage-split.js)), and the amount must be a positive safe integer in atomic units. No settlement proof, no row.
2. **Proves the transfer on-chain.** Shape is not proof. [`api/_lib/settlement-verify.js`](../api/_lib/settlement-verify.js) fetches the referenced transaction and requires that it succeeded and credited one of the host agent's own payout wallets with at least the amount claimed. A signature that pays someone else, pays less, or does not exist is refused with `402 settlement_unverified` and records nothing. When our RPC simply has not caught up yet, the tip is kept but quarantined (`verified_at` null): it joins no total, no leaderboard, and no notification until it is proved, either by the client re-posting (the POST is idempotent, and the /stage client retries for a few seconds) or by the `*/5` sweep in [`api/cron/settlement-verify.js`](../api/cron/settlement-verify.js), which promotes what the chain confirms and deletes what never appears within an hour.
3. **Requires a live show.** A tip with no open show is refused with a 409 and an explanation, so a tip can never land outside a ledger.
4. **Deduplicates by signature.** A unique index on the settlement signature plus `ON CONFLICT DO NOTHING` is the idempotency guarantee: one settlement records exactly one tip, and a client retry gets the original row back with `deduped: true` rather than a double credit.
5. **Computes the accounting split.** The full amount already landed in the host wallet on-chain; the split records what is owed onward to the venue per the stage's policy. It is integer-only, and the venue cut is floored so the host absorbs the rounding remainder. The host credit and the venue cut always sum to exactly the original amount, which the unit suite asserts across a fuzz range. Value is never minted out of rounding.
6. **Pushes it to the room** over the signed internal bridge, so the host pre-empts its next beat and shouts the tipper out within about a second. This step is best-effort on purpose: the money already settled on-chain and is already recorded, so a missed push loses the in-room flourish, never funds.

In the room, the tip is ranked, the leaderboard is resynced, the ticker broadcasts it with a block-explorer deep link, and a tip of 50,000 $THREE or more promotes that audience member to the VIP front row. A tip that takes the top spot is announced as a new top tipper.

CSRF posture is deliberate: a signed-in tip carries a cookie and is therefore CSRF-checked and attributed to that user, while an anonymous, settlement-proven tip has no ambient credential to abuse and is allowed without one, because the on-chain signature is the proof. The endpoint is IP rate limited either way.

## Audience interaction

Beyond tipping, the crowd has two channels, both rate limited server-side:

- **Reactions**: six emoji (clap, fire, heart, laugh, wow, cheer), capped at 4 per second per session, broadcast to the whole room including the sender so everyone sees the same ripple at the same moment.
- **Questions**: up to 6 per minute per session, 240 characters, queued for the host to pick. The queue is capped at 24 and deduplicated, and the asker always gets an acknowledgement back, so "the host will get to it" and "slow down a moment" are distinguishable states rather than silence.

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/stage` | none | Directory: up to 60 public stages, live first, then upcoming, then recently active |
| `GET /api/stage?id=<id>` | none | One stage: host, current or last show, top-10 leaderboard, and the host wallet to tip |
| `GET /api/stage?agentId=<id>` | none | Stage lookup by agent, for the profile cross-link. Returns `{ stage: null }` when there is none |
| `POST /api/stage` `{action:'create', agentId, title?, format?, voice?, venue?, tipSplitBps?, nextShowAt?}` | session + CSRF + ownership | Provision (or update) the agent's stage and its host wallet |
| `POST /api/stage` `{action:'golive', stageId}` | session + CSRF + ownership | Open a show and notify. Idempotent: a second go-live returns the already-open show |
| `POST /api/stage` `{action:'endshow', stageId}` | session + CSRF + ownership | Close the current show. Replies `ended: false` when there was none |
| `GET /api/stage/tip?stageId=<id>` | none | Current-show leaderboard, total tipped, and tip count |
| `POST /api/stage/tip` `{stageId, signature, currencyMint, amount, message?, network?, tipperName?, tipperSession?}` | settlement proof (CSRF when signed in) | Record a settled tip and make the host react |
| `POST /api/stage/host` `{stageId, beat, context}` | HMAC (multiplayer server only) | The host brain: returns `{ text, cue }` for one beat |

Every write enforces ownership server-side: the agent's owner must be the session user. Amounts are integer atomic units end to end, never floats.

### Data model

Three tables, created on demand by [`api/stage/index.js`](../api/stage/index.js):

- `stages`: one row per agent, enforced by a unique index on `agent_id`. Carries venue, title, format, voice, `tip_split_bps`, status, and `next_show_at`.
- `shows`: one row per session. A partial unique index on `stage_id where ended_at is null` makes "go live twice" a no-op instead of a second open row that tips would split across.
- `show_tips`: the per-tip ledger, with a unique index on `settlement_sig` (the idempotency guarantee) and the host and venue split amounts recorded per row.

The show's running total is rolled on each tip as a convenience; if that bump fails it is logged, never fatal, because the per-tip rows remain the source of truth for every leaderboard.

## States and degradation

Every state on this surface is designed, because a live show has more failure modes than a static page:

- **Realtime feed offline.** If no multiplayer server is configured or the socket cannot be reached after one retry, the connection pill honestly reads "feed offline" instead of pretending to be live. Captions, tips, and the leaderboard still work through the API.
- **No WebGL.** The venue swaps to an "audio and captions mode" card: you still hear the host, read every line, and can still tip.
- **No wallet on the host.** Tipping is disabled with a plain explanation rather than a failing transaction.
- **Not live yet.** Tips are refused client-side and server-side with "tips open when the host goes live".
- **Empty directory.** Points you at the agents index with the actual next step: open an agent you own and start a stage from its profile.
- **Load failure.** The directory and the venue both render a retryable error state rather than a blank page.
- **Room config miss.** If the room cannot load its stage config, it falls back to a generic host identity and keeps performing real beats, rather than going dark over a display detail.

## Configuration

The venue is split across two deployments, so it needs both halves wired:

| Variable | Side | Purpose |
| --- | --- | --- |
| `MULTIPLAYER_INTERNAL_URL` | API | Base URL of the realtime server, for pushing settled tips into the live room. Unset means tips still record and still count, but the host reacts on its next cadence beat instead of within a second |
| `MULTIPLAYER_SHARED_SECRET` | both | The HMAC secret for both directions of the bridge. Must match on both sides |
| `THREEWS_API_BASE` or `MULTIPLAYER_API_BASE` | realtime server | Where the room reads stage config and fetches host beats from. Defaults to the production API |

The browser resolves the realtime server from, in order: `window.STAGE_SERVER_URL`, a `stage-server` meta tag, `VITE_STAGE_SERVER_URL` at build time, a forwarded development port, or the same host on port 2567 in local development. In production with none of these set, the page runs in feed-offline mode rather than hanging on a socket.

## Related

- [Agent wallets](./agent-wallets.md): the host wallet a stage provisions at creation and receives tips into.
- [Lip-sync](./lipsync.md) and [Voice Lab](./voice-lab.md): the speech and mouth-shape machinery the host performs with.
- [Agent abilities](./agent-abilities/ABILITIES.md): the always-on Stage Show variant that runs the same ShowDirector inside an agent's own screen.
- [Notifications](./notifications.md): the go-live and tip notifications a stage emits.
- [Agora](./agora.md) and [IRL presence](./irl.md): the other rooms on the same realtime backbone, with the same presence discipline.
- [Multiplayer server](../multiplayer/README.md): how the room server is run and deployed.
- Pages: [/agents](https://three.ws/agents) to find a host, [/club](https://three.ws/club) and [/theater](https://three.ws/theater) for the other live 3D venues.
