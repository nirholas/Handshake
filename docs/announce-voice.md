# The announcement voice

**Status:** the contract every announcement pack in [`docs/announcements/`](./announcements/) is written and
checked against. **Last measured against the archive:** 2026-09-04.

three.ws has shipped 430 surfaces and posted about roughly 50 of them. The backlog is inventory,
not a roadmap, and working it down means writing a lot of announcements. The failure mode that
threatens is not running out of features. It is that 300 posts written quickly all start to sound
like the same machine wrote them, and an audience that smells a template stops reading the ones
that matter.

So this file is the anti-template. Everything in it is derived from two sources on disk, and it
names them so a claim here can be re-checked rather than believed:

- [`data/x-archive/trythreews-2026-08-14.json`](../data/x-archive/trythreews-2026-08-14.json), 359
  scraped posts, 214 of them ours.
- [`data/x-archive/analysis/trythreews-engagement.json`](../data/x-archive/analysis/trythreews-engagement.json),
  the engagement report over the 158 of those with usable metrics.

---

## What the numbers actually say

Median engagement lift by signal, from the engagement report. "Lift" is the signal's median against
the account's overall median of 12.

| Signal | Lift | Sample | What it means for a draft |
|---|---|---|---|
| $THREE / token topic | **13.3x** | 4 | The token is not a side note. When a feature genuinely touches it, lead with that. |
| Mentions an account | **4.5x** | 21 | Tag the partner a feature really runs on. Never tag one it does not. |
| 100-179 characters | **3.0x** | 17 | The best band reachable in a single post. This is the default. |
| 180-279 characters | 1.67x | 17 | Fine when the mechanism genuinely needs the room. |
| Has an image | **2.3x** | 14 | Non-negotiable. See below. |
| Contains a link | 1.5x | 18 | The link is how anyone gets to the thing. Always include it. |
| **1-99 characters** | **0.83x** | **121** | The account's single biggest problem. |
| **Text only** | **0.875x** | **132** | The second biggest. |
| Has a video | 0.71x | 6 | An uploaded video underperformed a still. Prefer an animated WebP or a real screenshot. |

Read the last three rows together: **121 of 158 measured posts were one-liners and 132 carried no
media at all.** They are the bulk of the account's output and they are the bottom of its
performance. Nothing in this document matters more than not writing another one.

## The five rules

1. **Every post ships an image.** Not a stock graphic: a frame of the real product, captured by
   `npm run announce:media` from the live route. A pack with no media is not finished and the
   gate fails it.
2. **100 characters is the floor and 179 is the target ceiling.** Under 100 a draft is missing the
   mechanism: say how the thing works, not that it exists. Above 179 the measured lift halves.
   The hard wall is 280 weighted characters, which `scripts/post-tweet.mjs` enforces and which a
   URL costs 23 of no matter its real length. The archive's 280-499 band (4.75x over 3 posts) is
   real but not reachable in a single post; that shape is a thread or the Telegram register.
   Check every draft with `node scripts/post-tweet.mjs --file <pack>.post.txt --dry-run`, which
   prints the weighted count and refuses anything over the wall.
3. **One claim, and it has to be checkable.** Every number in a post comes from the captured
   frame or a linked page. If the media says 86% win rate, the post may say 86% win rate. If
   nothing on screen supports a number, it does not go in.
4. **Tag only what is true.** `@solana` when it settles on Solana. `@AnthropicAI` when it is an
   MCP server. `@IBM` when it runs on watsonx. A tag we cannot defend costs more than the 4.5x
   is worth.
5. **Link the surface.** One link, to the page the post is about.

## How this account already sounds

Measured across the 214 posts we have written, not asserted:

- **0 hashtags.** Never add one.
- **0 emoji.** Never add one.
- **2 em-dashes**, and the house style bans the character outright. Use a period, a comma, a
  colon, or parentheses.
- **1 post out of 214 opened with "Introducing".** That is the existing voice and it is a good
  one. Keep it.

## Banned openings

These are the tells that make a post read as generated. None of them appear in our best posts and
the gate rejects all of them:

> Introducing. We're excited to announce. We're thrilled. Say hello to. Meet the new. Big news.
> Today we're launching. Ever wondered. What if you could. Imagine a world where. Game-changer.
> Revolutionary. Seamless. Unlock the power of. Take your X to the next level. The future of X is
> here. And the best part? Let that sink in. Here's the kicker.

Also banned as structure, not just as phrases:

- **The rhetorical-question opener.** "What if your agent could trade for you?" Just say what it does.
- **The one-word-sentence drumbeat.** "Fast. Simple. On-chain." It reads as copywriting, and this
  audience discounts copywriting.
- **The thread that withholds.** Do not make the first post a teaser for the second. Lead with the
  strongest true statement.
- **Adjective stacking.** "A powerful, seamless, next-generation platform." Cut every adjective
  that a reader could not disagree with.

## What to write instead

Open with the mechanism or the number. The strongest posts in the archive do exactly this: they
state a specific, surprising, checkable fact in the first line and let the reader decide it is
impressive.

Three patterns that fit the measured bands:

**The number lead** (100-179 chars). Open on a figure the screenshot proves.

> Seven autonomous agents have scored 832,142 pump.fun launches on three.ws. 86% win rate on the
> top one. Every trade on the floor is live: three.ws/activity

**The mechanism lead** (100-179 chars). Open on how it works, because the how is the interesting part.

> A sentence or a selfie becomes a rigged 3D agent holding its own custodial @solana wallet, a
> persona, and a voice. It walks and emotes on arrival: three.ws/genesis

**The correction lead**, for a feature that contradicts an assumption the reader holds.

> Most "AI agent wallets" are a key in someone's env file. Guardian makes an agent wallet
> recoverable and inheritable: name a guardian, set the timelock, and the wallet survives the
> agent. three.ws/guardian

## Uniqueness, enforced

Announcing 300 features means 300 posts that must not blur together. Two mechanical checks in
`npm run check:announce`:

- **No opening clause is reused.** The first eight words of every pack are compared against every
  other pack. A repeat fails.
- **No pack reuses another pack's lead structure twice in a row.** The pattern (number lead,
  mechanism lead, correction lead) rotates.

Neither check can make a post good. Both stop the corpus from converging on one shape, which is
what makes a run of announcements read as automated.

## The pack

One file per feature in `docs/announcements/<slug>.md`, holding everything a post needs and
nothing it does not. See [`genesis.md`](./announcements/genesis.md) for the worked example. Every
pack carries:

- **The claim**, and the evidence for it, with a link to where it can be checked.
- **The post**, inside the length band, in this voice.
- **The media**, by shot id from [`data/announce-media.json`](../data/announce-media.json), with
  its alt text. Alt text is a requirement, not a courtesy: a post whose whole payload is an image
  is unreadable to a screen reader without it.
- **The Telegram variant.** The community channel takes plain text and a different register: more
  detail, no character ceiling worth worrying about, no tagging.
- **The changelog entry**, ready to paste into `data/changelog.json`.
- **Its state**, mirrored in [`data/announcements.json`](../data/announcements.json).

## What this file does not decide

Posting. Publishing to an external channel is an owner-gated action under the operating rules,
every time, and nothing in this pipeline posts anything. A finished pack is a finished pack: the
owner runs the one command.
