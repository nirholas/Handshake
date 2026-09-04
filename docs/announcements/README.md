# Announcement packs

One file per feature we are announcing, plus the exact bytes that get posted.

three.ws has shipped 430 surfaces and posted about roughly 50. The other 320 are not a roadmap,
they are inventory that already works, and the audit that established this lives in
[announcement-coverage.md](../announcement-coverage.md). Working that backlog down is what this
directory is for.

## How a pack gets made

```bash
npm run announce:rank                 # what to announce next, and why
npm run announce:media                # capture the frames from the live product
npm run check:announce                # gate the pack before anyone reads it
```

1. **Rank.** [`scripts/announce-rank.mjs`](../../scripts/announce-rank.mjs) re-derives the
   inventory from `data/pages.json`, `packages/`, `workers/` and `services/`, reads the announced
   status out of the coverage audit, probes each route, scores what is left, and writes
   [`data/announcements.json`](../../data/announcements.json). The score's weights come from the
   engagement archive, not from taste; the sources are named in
   [announce-voice.md](../announce-voice.md).
2. **Capture.** Add a shot to [`data/announce-media.json`](../../data/announce-media.json) and run
   `npm run announce:media`. It drives the real route in a real Chromium and writes to
   `public/announce/img/` with provenance (route, commit, time, sha256) beside the pixels. Shots
   marked `auth` sign in with the QA account so the frame shows the working product rather than
   its sign-in gate.
3. **Write.** One `<slug>.md` pack and one `<slug>.post.txt` holding the post itself. The `.txt`
   exists so the bytes the gate checks are the bytes `post-tweet.mjs` sends; a post quoted only
   in prose drifts from the file that ships.
4. **Gate.** `npm run check:announce` enforces media, alt text, length, voice, cross-pack
   uniqueness, and the coin gate.

**Ranking is a hypothesis; the capture is the test.** Two of the first batch's highest-scoring
surfaces were deferred once their frames were looked at: `/genome` sells an empty stud market and
`/portfolio` is an address input with nothing in it. The reasons are recorded on their entries in
the ledger, which is why the capture step comes before the writing step.

## The coin gate

A frame captured from a live trading surface bakes whatever tickers were on screen into a
committed file, and the operating rules require owner approval before committing anything that
references a crypto project other than `$THREE`. `check:announce` fails such a pack, and the
affected files are kept out of the tree by `.gitignore` until approval is recorded on the shot as
`thirdPartyMarketDataApproved`.

## Posting

Nothing here posts. Publishing to an external channel is owner-gated every time. A finished pack
means the owner runs one command:

```bash
node scripts/post-tweet.mjs --file docs/announcements/<slug>.post.txt --dry-run
```

## Packs

| Pack | Surface | Stage |
|---|---|---|
| [genesis.md](./genesis.md) | [`/genesis`](https://three.ws/genesis) | drafted, awaiting approval to post |
| [open-source-friday.md](./open-source-friday.md) | [`/rig-doctor`](https://three.ws/rig-doctor) | drafted, awaiting approval to post |
