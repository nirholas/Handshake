# Feature 24: dance-off rounds on the synced floor

The dance floor already syncs everyone to a server beat with rotating clips, and an x402 dance-tip endpoint already exists. What is missing is the game: scheduled dance-off rounds where the floor becomes a competition, the crowd votes, and the winner gets a spotlight moment. This is the recurring beat that gives an event crowd something to gather around every few minutes.

## Where the code lives

- The floor today: the beat broadcast in `multiplayer/src/rooms/WalkRoom.js` (`floor:beat`) and the client sync in `src/game/coincommunities.js`
- Round-machine precedent: King of the Totem in `WalkRoom.js` (phase, timer, leaderboard, winner) and its HUD panel in `src/game/coincommunities-ui.js`; copy that shape, it is already proven
- Crowd input: the reaction bar (6 emoji) in `src/game/coincommunities-ui.js` and the reaction relay in `WalkRoom.js`
- Tips: `api/x402/dance-tip.js`
- Winner reward: the cosmetics ownership path (`multiplayer/src/cosmetics-ownership.js`, `api/cosmetics/`); celebration feel: `src/game/hud/game-feel.js`; feed: `multiplayer/src/feed.js`

## What to build

1. **The round machine.** Server-side dance-off rounds on the existing floor, in the King of the Totem shape: idle, a join window announced in-world, a performance phase (60 to 90 seconds, contestants are the players on the floor when it starts), a vote tally, a winner moment, cooldown, repeat. During the event window (`public/event.json`) rounds run frequently; outside it, occasionally or on demand.
2. **Performing.** Contestants dance with the existing synced clips; let a contestant switch clips mid-round through the emote wheel so there is actual expression involved. Contestants get a subtle floor highlight so the crowd knows who is in.
3. **Voting.** The crowd votes with the existing reaction bar targeted at a contestant (nearest-aim or a tap on the contestant's nameplate); one counted vote per voter per round, tallied server-side, spam beyond the first vote is just cosmetic confetti. Contestants cannot vote for themselves.
4. **Winning.** Spotlight beam, confetti, jumbotron feature with name and avatar snapshot, a feed event, and a small cosmetic or title through the existing ownership path, granted idempotently. Tips: the winner moment surfaces the dance-tip action for the crowd (x402 spend: recipient and amount rendered, explicit confirmation, every time).
5. **Fairness and failure.** A round with fewer than two contestants dissolves quietly. Disconnecting mid-round removes the contestant and their votes. Ties resolve by earliest-to-threshold. Nothing about a round can strand the floor: the beat and free dancing always come back.

## Verify

- Three browsers on `npm run dev`: two contestants, one voter; a full round end to end including the winner moment, the grant appearing in the winner's wardrobe exactly once across repeat wins, and the feed event.
- Solo-contestant round dissolves; mid-round disconnect handled; the floor returns to its normal beat after every path.
- Event window on and off changes the cadence as designed. `npm test` green with unit tests on the tally (one vote per voter, no self-votes, tie rule).

## Report format

Files shipped, the round timings chosen, the vote targeting rule, the reward and its grant path, and the `data/changelog.json` entry.
