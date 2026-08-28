# Android launch post

Attach the four tiles from `images/` in the order in `IMAGE-ORDER.md`. Getting
the order wrong reassembles the composition scrambled.

## The thread

Five posts. 1 carries the four images; the rest are replies in order. Every count
below is X's own arithmetic, where a URL costs 23 characters however long it is.

**1**, 218 characters. Attach the four tiles here, in the order in `IMAGE-ORDER.md`.

```
three.ws is now an Android app.

Take a selfie, get back a rigged 3D avatar. Or describe an object and get a textured 3D model. Both on your phone, both yours.

Free. Open source. Android 6.0+.

github.com/nirholas/three.ws/releases/tag/v1.0.0
```

**2**, 269 characters

```
It is a Trusted Web Activity: the real three.ws running full screen, no address bar, and three.ws links open in the app instead of the browser.

The signing certificate is published at three.ws/.well-known/assetlinks.json. Android checks it. If the two disagree, the app is not ours.
```

**3**, 252 characters

```
No wallet needed. Creating models, chatting with agents and browsing are free and touch no chain at all.

Connect one only if you want to deploy an agent on Solana as an asset you hold. Signing happens in your own wallet app; three.ws never sees a key.
```

**4**, 150 characters

```
The Android packaging, the Mobile Wallet Adapter integration and the whole release pipeline are open source under Apache 2.0.

github.com/nirholas/three.ws/tree/main/solana-mobile
```

**5**, 162 characters

```
The same build is in review for the Solana dApp Store, so it will install straight onto a Seeker before long.

Until then the APK in the first post is the way in.
```

Posts 2 through 5 stand alone, so any of them can be dropped without leaving a gap.
Post 5 is the one that must not be reworded into a claim that the listing is live:
it is in review, and saying otherwise ages badly in public.

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
