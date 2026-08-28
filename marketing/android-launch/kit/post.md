# Android launch post

Attach the four tiles from `images/` in the order in `IMAGE-ORDER.md`. Getting
the order wrong reassembles the composition scrambled.

## The thread

Eleven posts, written for someone who has never used a crypto app and had no
plans to. No jargon, no version numbers, no acronyms: the specifics live in the
replies below, and nobody needs them to understand what this is or to want it.

The register is confident and grateful, never explanatory and never defensive.
This community built the thing being launched, and the thread says so early, in
post 2, before it asks anyone for anything. Post 1 carries the four images; 2
through 11 are replies in order. Counts are X's own arithmetic, where a URL
costs 23 characters however long it is, and all eleven fit inside 280 without
Premium.

**1**, 212 characters. Attach the four tiles here, in the order in `IMAGE-ORDER.md`.

```
three.ws is an Android app.

Point your phone at your face and get back a 3D character of yourself. Say what you want and watch it get built.

Free. No account. No crypto needed to start.

github.com/nirholas/three.ws/releases/tag/v1.0.0
```

**2**, 190 characters

```
To everyone who has been building here with us: this one is yours.

You made agents nobody asked you to make. You found the bugs at 3am. You held.

Today the whole thing fits in your pocket.
```

**3**, 224 characters

```
Here is why crypto keeps losing normal people at the door.

Step one, install an extension. Step two, write down twelve secret words. Step three, buy something, before you have made anything at all.

We threw that order out.
```

**4**, 234 characters

```
Open the app and you can:

Turn one selfie into a 3D character of yourself
Describe an object and get a real 3D model
Give your character a voice and a personality
Talk to it
Stand it in your room in AR

No wallet. No signup. No cost.
```

**5**, 225 characters

```
And it does not stay locked in the app.

One link puts your character on your site, in your Telegram, in your posts, where it moves and talks and answers for you.

Everything you make is a real file. Download it. It is yours.
```

**6**, 220 characters

```
Want to own it on-chain? One tap.

Your character becomes an asset in your own wallet on Solana. On a Seeker phone the signing happens inside the phone itself.

Nothing to install. Nothing to write down. No twelve words.
```

**7**, 246 characters

```
This is how the next million people arrive.

Not through an exchange signup. Through something they wanted to make anyway, with the ownership waiting underneath for the day they care about it.

Give people magic first. The wallet can come second.
```

**8**, 196 characters

```
And to our holders: every new person who opens this app lands in the economy you have been building.

$THREE is how you move up in it. You never spend it. You hold it, and your tier does the work.
```

**9**, 179 characters

```
Bronze doubles your free limits and takes 5% off compute. Genesis multiplies them by 10 and takes 30% off.

Hold, do not burn.

$THREE
FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

**10**, 239 characters

```
Generation is free here because serious people backed us early.

NVIDIA Inception. OpenAI Select Partner. A Google for Startups Web3 cloud grant paying for the GPU fleet behind every model you make.

Thank you. We are just getting started.
```

**11**, 220 characters

```
The same build is in review for the Solana dApp Store, so soon it installs straight onto a Seeker.

Until then: one link, 3.95 MB, Android 6 and up, open source top to bottom.

Go make something.

github.com/nirholas/three.ws/releases/tag/v1.0.0
```

Every claim is checkable: the tier numbers are the live ladder in
[`docs/hold-to-access.md`](../../../docs/hold-to-access.md), the memberships are
[`docs/nvidia-inception.md`](../../../docs/nvidia-inception.md) and the OpenAI
Select Partner status announced on 2026-07-15, and the Google for Startups Web3
cloud grant is what funds the GPU fleet.

Three lines that must not drift when someone edits this:

- Post 8 and 9 say holding, never spending or burning. Hold-to-access is the
  whole mechanism, and copy implying a burn describes a different product.
- Post 9 quotes tier numbers. If the ladder in `docs/hold-to-access.md` moves,
  this moves with it.
- Post 11 says the dApp Store listing is **in review**. It is not live. Claiming
  otherwise ages badly in public, and a reviewer would see it first.

Nothing in the thread is apologetic, explains an absence, or answers a critic.
Gratitude here is confidence, not a concession, and there is no version of this
launch that opens by defending anything.

## Replies for anyone who asks the specifics

Not part of the thread. Keep them for the replies, where the people who want
them will ask.

```
It is a Trusted Web Activity: the real three.ws running full screen, no address bar, and three.ws links open in the app instead of the browser.

The signing certificate is published at three.ws/.well-known/assetlinks.json. Android checks it. If the two disagree, the app is not ours.
```

```
No wallet needed. Creating models, chatting with agents and browsing are free and touch no chain at all.

Connect one only if you want to deploy an agent on Solana as an asset you hold. Signing happens in your own wallet app; three.ws never sees a key.
```

```
The Android packaging, the Mobile Wallet Adapter integration and the whole release pipeline are open source under Apache 2.0.

github.com/nirholas/three.ws/tree/main/solana-mobile
```

## Alt text

X takes alt text per image, and the four tiles are read one at a time by a
screen reader, so each describes its own quadrant rather than the whole grid.

| Image | Alt text |
| --- | --- |
| `01-top-left.png` | The three.ws logo above the words "Now an Android app", on a dark blue field. Below: turn a photo or a prompt into 3D models and AI agents you own, on your phone. |
| `02-top-right.png` | An Android phone showing the three.ws create screen, asking "What do you want to create?" with options to build an AI agent, make a 3D avatar, or generate a 3D model. |
| `03-bottom-left.png` | An Android phone showing the three.ws marketplace: a grid of 3D characters and models published by the community, with filters for agents, avatars and scenes. |
| `04-bottom-right.png` | Two Android phones. One shows a rigged 3D character posed mid-animation with its file details; the other shows the selfie-to-avatar capture screen. |

## Before posting

- The Google Play listing is not live yet, so nothing here claims it is. Add the
  Play badge to a follow-up once production access lands.
- Owner approval is required before this goes out. See the external-channel gate
  in [`CLAUDE.md`](../../../CLAUDE.md).
