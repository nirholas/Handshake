# Feature 21: party system, because nobody attends an event alone

Friends exist (drawer, presence, DMs) but group play does not: two friends in the same world cannot find each other without describing scenery over chat, and there is no way to move through the event as a crew. Build parties: form one, see your people, get to them, and talk to them.

## Where the code lives

- Friends and presence: `src/game/friends-panel.js`, `api/friends/` (`presence-ticket`, `search`, `messages`), cross-realm presence in `multiplayer/src/social-hub.js` (Upstash Redis with TTL self-healing)
- Room state and messaging: `multiplayer/src/rooms/WalkRoom.js`, client in `src/game/community-net.js`
- Minimap blips: `src/game/hud/minimap.js`; HUD composition: `src/game/hud/world-hud.js`
- Inspect panel (the "I" overlay on another avatar): in `src/game/coincommunities-ui.js`, a natural invite surface
- Chat channels: the chat bar in `src/game/coincommunities-ui.js`

## What to build

1. **Form and manage.** Create a party, invite from the friends drawer or from inspecting a nearby player, accept or decline with a toast, leave anytime, party dissolves when empty. Cap it (8 is plenty) and say so in the UI. Party state lives server-side (social hub Redis alongside presence, TTL-guarded so a crashed session cannot leave a ghost party).
2. **See your people.** Party members get a distinct nameplate accent and dedicated minimap blips; members beyond the minimap edge get a screen-edge direction chip with name and distance. All of it cheap: update on the existing peer-sync cadence, no extra per-frame work.
3. **Get to your people.** A "go to" action per member. Same world and tier: a server-validated teleport to a safe offset near them, with a cooldown and a brief arrival effect. Different world: a designed handoff that deep-links to their world carrying full coin identity, keeping the party intact across the transition (this is the cross-realm case social-hub presence exists to answer).
4. **Talk to your people.** A party channel in the chat bar, toggle between world and party scope, party messages styled distinctly. Delivery rides the friends messaging path or a party-scoped room relay, whichever is less new code; state the choice.
5. **Event glue.** If Feature 13's quest line landed, quests that say "with another player" should count party members preferentially. If Feature 16's invite sheet landed, an invite accepted from a party member's link should offer to join their party on arrival.

## Verify

- Two browsers, two accounts on `npm run dev`: full lifecycle (invite, accept, blips, edge chips, party chat, go-to teleport, leave). Then the cross-world case: member in a different coin world, handoff follows them, party survives.
- Kill one session hard (close the tab): the ghost clears from the other client within the presence TTL.
- Declines, full-party invites, and inviting someone already partied all produce designed feedback, not silence. `npm test` green with a test on party state transitions.

## Report format

Files shipped, where party state lives and its TTL, the teleport validation rule, the chat delivery choice, and the `data/changelog.json` entry.
