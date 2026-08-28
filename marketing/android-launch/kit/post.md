# Android launch post

Attach the four tiles from `images/` in the order in `IMAGE-ORDER.md`. Getting
the order wrong reassembles the composition scrambled.

## The thread

Ten posts, written for someone who has never used a crypto app and does not want
to. No jargon, no version numbers, no acronyms: the specifics live in the
optional replies below and in the GitHub release, and nobody needs them to
understand what this is. Post 1 carries the four images; 2 through 10 are
replies in order. Counts are X's own arithmetic, where a URL costs 23 characters
however long it is, and all ten fit inside 280 without Premium.

**1**, 216 characters. Attach the four tiles here, in the order in `IMAGE-ORDER.md`.

```
three.ws is an Android app now.

Point the camera at your face and get back a 3D character of yourself. Or just describe something and watch it get built.

Free. No account. No crypto needed.

github.com/nirholas/three.ws/releases/tag/v1.0.0
```

**2**, 230 characters

```
Most people never make it into web3 because step one is: install an extension, write down twelve secret words, buy something.

Nobody does that for fun.

So we moved step one somewhere else. Make something you actually want first.
```

**3**, 242 characters

```
What you can do in the app right now, with no wallet and no account:

Take one selfie, get a 3D character of yourself
Describe an object, get a real 3D model
Give your character a personality and a voice
Talk to it
Stand it in your room in AR
```

**4**, 237 characters

```
Your character does not stay stuck in the app.

One link puts it on your website, in your Telegram, in your posts, where it walks and talks and answers questions.

Everything you make is a real 3D file you can download and open anywhere.
```

**5**, 261 characters

```
If you ever want the crypto part, it is one tap, and it is optional.

Your character becomes something you own on Solana, held in your own wallet. On a Solana Seeker phone the signature happens inside the phone itself. Nothing to install, nothing to write down.
```

**6**, 254 characters

```
That is the whole idea.

Nobody joins web3 for a wallet. They join for something they wanted to make anyway.

Give people that first, make ownership a one-tap upgrade later, and the next million arrive without ever being asked to care about the plumbing.
```

**7**, 201 characters

```
For our community: every new person in the app is another creator in the same economy, and agents here can be paid for what they do.

$THREE is how you move up in it. Not by spending it. By holding it.
```

**8**, 193 characters

```
Your holding sets your tier: free limits multiply and compute costs drop.

Bronze 2x and 5% off. Genesis 10x and 30% off. Hold, do not burn.

$THREE
FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump
```

**9**, 242 characters

```
Generation is free here for a reason, and it is not generosity.

three.ws is an NVIDIA Inception member, an OpenAI Select Partner, and runs on a Google for Startups Web3 cloud grant. That is what pays for the GPUs behind every model you make.
```

**10**, 210 characters

```
The same app is in review for the Solana dApp Store, so before long it installs straight onto a Seeker.

Until then it is one link. 3.95 MB, Android 6 and up, open source top to bottom.

github.com/nirholas/three.ws/releases/tag/v1.0.0
```

Every claim above is checkable: the tier numbers are the live ladder in
[`docs/hold-to-access.md`](../../../docs/hold-to-access.md), the partnerships are
[`docs/nvidia-inception.md`](../../../docs/nvidia-inception.md), the OpenAI Select
Partner status announced on 2026-07-15, and the Google for Startups Web3 cloud
grant that funds the GPU fleet.

Two lines that must not drift when someone edits this:

- Post 8 says holding, never spending or burning. Hold-to-access is the whole
  mechanism, and a post that implies a burn describes a different product.
- Post 10 says the dApp Store listing is **in review**. It is not live. Saying
  otherwise ages badly in public, and it is the first thing a reviewer would see.

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
