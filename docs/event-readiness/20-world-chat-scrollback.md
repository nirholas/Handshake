# Feature 20: chat scrollback and a persistent world record

In-world chat is a pure relay: the server broadcasts and forgets, so everyone who joins the event late sees an empty chat and no evidence anything is happening. Meanwhile `api/community/messages.js` persists a per-coin message stream that the 3D world never reads. Give the world a memory: late joiners get scrollback, and the room's page-level community feed and the in-world chat stop being strangers.

## Where the code lives

- The relay today: the chat handler in `multiplayer/src/rooms/WalkRoom.js` (700ms cooldown and slur gate already enforced there; keep both)
- Persisted community chat (separate system): `api/community/messages.js`
- Chat UI: the chat bar and message list in `src/game/coincommunities-ui.js`, styles in `src/game/coincommunities.css`
- Name safety: `multiplayer/src/display-name-safety.js`
- Storage precedents: Upstash Redis usage in `api/play/builds.js` and `multiplayer/src/social-hub.js`

## What to build

1. **Server-side scrollback.** Persist relayed chat per world (coin plus tier) in a capped Redis list (on the order of 200 messages with a TTL of a few days; pick values and state them). Write on relay, trim on write. On join, the room sends the recent tail so a new arrival scrolls up into the last stretch of conversation instead of a void.
2. **Rendered as history.** Scrollback renders visually distinct from live messages (muted, timestamped, a "you're caught up" divider), loads without jank, and never steals focus or scroll position from someone mid-conversation.
3. **One bridge, chosen deliberately.** Surface the persisted community stream (`api/community/messages.js`) inside the world as a read tab or pinned-board view, so page-side conversation is visible in-world. Decide whether in-world chat also writes into that stream; whichever way you choose, record the decision and the privacy reasoning in the report. Do not silently merge two systems with different expectations.
4. **Privacy and safety.** Scrollback stores display names as rendered (already passed through name safety), never wallet addresses or session identifiers. The existing slur gate applies to everything stored. A player's messages disappear from scrollback when trimmed; no long-term archive is being built here.
5. **Event-night behavior.** Under load the tail send must be one batched message on join, not N replays; the client renders it in one frame's worth of DOM work (build off-screen, attach once).

## Verify

- Two browsers on `npm run dev`: chat in one, join late with the other, and see the tail with the divider; live messages continue seamlessly after it.
- Cooldown and slur gate confirmed still enforced on the stored path.
- Refresh mid-conversation: scrollback plus live picks up without duplicates (dedupe by message id, not text).
- The bridge tab shows real persisted community messages for the $THREE coin. `npm test` green, with a unit test for trim and dedupe logic.

## Report format

Files shipped, the cap and TTL chosen, the bridge decision and why, join-time payload size for a full tail, and the `data/changelog.json` entry.
